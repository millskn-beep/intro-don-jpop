// サビの位置が未設定の曲（画面では動画の長さから推定している曲）を、YouTube の「よく再生される部分」から推定し直す。
// yt-dlp で動画の情報（heatmap と長さ）だけを取得する（音声・映像はダウンロードしない）。
// 1曲ごとに保存するので、途中で止めても次は続きから。手で設定した曲・推定済みの曲は触らない。
//
// 使い方: node tools/estimate-chorus.js [--limit 10] [--dry-run]
// 必要なもの: python -m yt_dlp（pip install yt-dlp）
// 保存: 手元のサーバー（http://localhost:3000）が動いていればその API で、止まっていれば songs.json に直接書く

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SONGS_PATH = path.join(__dirname, '..', 'data', 'songs.json');
const SERVER = 'http://localhost:3000';
const WAIT_MS = 1200;   // 1曲ごとの間（YouTube に止められないよう）
// yt-dlp の共通オプション：Windows の証明書を使う／YouTube の確認処理に Node.js を使う
const YTDLP_OPTS = ['--compat-options', 'no-certifi', '--js-runtimes', 'node'];

const args = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : Infinity;
const DRY = args.includes('--dry-run');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// heatmap を見た記録（推定できなかった曲を毎回取り直さないため）
const needsChorus = s => s.embeddable !== false && !(s.chorus > 0) && !s.chorusChecked;

function videoInfo(id) {
  return new Promise((resolve, reject) => {
    execFile('python', ['-m', 'yt_dlp', ...YTDLP_OPTS, '-j', '--skip-download', '--no-warnings', `https://www.youtube.com/watch?v=${id}`],
      { timeout: 90000, maxBuffer: 64 * 1024 * 1024 },
      (err, out, errOut) => err ? reject(new Error((errOut || err.message).trim().split('\n').pop())) : resolve(JSON.parse(out)));
  });
}

// 一番よく再生されている区間の頭をサビとみなす（tools 以前の推定と同じ範囲：20〜130秒、イントロ直後は除く）
function pickChorus(info, intro) {
  const hm = info.heatmap;
  if (!Array.isArray(hm) || !hm.length) return null;
  const lo = Math.max(20, (intro || 0) + 10), hi = Math.min(130, (info.duration || 9999) - 10);
  const c = hm.filter(h => h.start_time >= lo && h.start_time <= hi).sort((a, b) => b.value - a.value)[0];
  return c ? Math.round(c.start_time) : null;
}

async function save(song) {
  try {
    const res = await fetch(`${SERVER}/api/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ songs: [song] }) });
    if (res.ok) return 'api';
    throw new Error((await res.json()).error);
  } catch (e) {
    const all = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
    const cur = all.find(s => s.id === song.id);
    if (!cur) return 'skip';
    for (const k of ['chorus', 'chorusSource', 'chorusChecked', 'embeddable', 'error', 'checkedAt', 'checkedOrigin']) { if (k in song) cur[k] = song[k]; else delete cur[k]; }
    fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH);
    return 'file';
  }
}

(async () => {
  const targets = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8')).filter(needsChorus).slice(0, LIMIT);
  console.log(`サビを推定する曲: ${targets.length} 曲${DRY ? '（保存しない）' : ''}`);
  let done = 0, set = 0, none = 0, failed = 0;
  for (const s of targets) {
    done++;
    const label = `[${done}/${targets.length}] ${s.title}（${s.work}）`;
    try {
      const info = await videoInfo(s.id);
      const t = pickChorus(info, s.intro);
      const fresh = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8')).find(x => x.id === s.id);
      if (!fresh || fresh.chorus > 0) { console.log(`${label} → ほかで設定済みなので飛ばす`); continue; }
      const song = { ...fresh, chorusChecked: true };
      if (t) { song.chorus = t; song.chorusSource = 'heatmap'; set++; console.log(`${label} → ${t} 秒`); }
      else { none++; console.log(`${label} → よく再生される部分のデータなし（長さからの推定のまま）`); }
      if (!DRY) await save(song);
    } catch (e) {
      failed++;
      // 見られない動画は自動では外さず、一覧に出すだけ（取得の不具合で出ることもあるため。チェック画面で確かめる）
      if (/not available|unavailable|private video|has been removed|terminated/i.test(e.message)) console.log(`${label} → 動画が見られない（要確認・チェック画面で再生を確かめてください）`);
      else console.log(`${label} → 失敗: ${e.message}`);
    }
    await sleep(WAIT_MS);
  }
  console.log(`終わり：推定できた ${set} 曲、データなし ${none} 曲、失敗 ${failed} 曲`);
})();
