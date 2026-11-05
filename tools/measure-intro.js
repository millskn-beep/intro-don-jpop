// 画面を開かずに、イントロの「音楽が鳴り始める秒数」を裏で計測する（チェック画面の「無音カット」と同じ判定）。
// 各曲の最初の RECORD_SEC 秒の音声だけを yt-dlp + ffmpeg で読み込み、その場で解析する（ファイルは残さない）。
// 1曲ごとに保存するので、途中で止めても次は続きから。計測済み（introMethod: 'v2'）の曲は飛ばす。
//
// 使い方: node tools/measure-intro.js [--limit 10] [--dry-run]
// 必要なもの: python -m yt_dlp（pip install yt-dlp）と ffmpeg
// 保存: 手元のサーバー（http://localhost:3002）が動いていればその API で、止まっていれば songs.json に直接書く

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SONGS_PATH = path.join(__dirname, '..', 'data', 'songs.json');
const SERVER = 'http://localhost:3002';

// ── 判定の設定（public/check.html と同じ値）──
const RECORD_SEC = 20;
const BIN = 0.25;
const LOUD_DB = 10;
const KEEP_DB = 16;
const SUSTAIN_SEC = 2;
const ATTACK_DB = 22;
const ONSET_MARGIN = 0.3;
const SILENT_DB = -50;

// yt-dlp の共通オプション：Windows の証明書を使う／YouTube の確認処理に Node.js を使う
const YTDLP_OPTS = ['--compat-options', 'no-certifi', '--js-runtimes', 'node'];
const RATE = 8000;          // 解析用に読み込むサンプリング周波数
const WAIT_MS = 1500;       // 1曲ごとの間（YouTube に止められないよう）

const args = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : Infinity;
const DRY = args.includes('--dry-run') || args.includes('--compare');
// --compare: ブラウザで計測済みの曲を測り直して、結果を比べるだけ（保存しない）
const COMPARE = args.includes('--compare');

const needsMeasure = s => s.embeddable !== false && s.introMethod !== 'v2' && (s.introMeasured || !(s.intro > 0));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 最初の RECORD_SEC 秒を、BIN 秒ごとの平均音量(dB)にする。
// yt-dlp に音声を読ませて ffmpeg に流し、RECORD_SEC 秒ぶん読んだら両方止める（配信 URL を直接開くと 403 になることがあるため）
function recordLevels(id) {
  return new Promise((resolve, reject) => {
    const yt = spawn('python', ['-m', 'yt_dlp', ...YTDLP_OPTS, '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio', '-o', '-', '--no-warnings', '--no-part', '-q', `https://www.youtube.com/watch?v=${id}`]);
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-t', String(RECORD_SEC), '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1']);
    yt.stdout.pipe(ff.stdin);
    ff.stdin.on('error', () => {}); yt.stdout.on('error', () => {});
    const chunks = [];
    ff.stdout.on('data', c => chunks.push(c));
    let errText = '';
    yt.stderr.on('data', c => { errText += c; });
    ff.stderr.on('data', c => { errText += c; });
    const timer = setTimeout(() => { ff.kill(); yt.kill(); }, 120000);
    ff.on('close', () => {
      clearTimeout(timer);
      yt.kill(); // 20秒ぶん読めたので、残りは取得しない
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 4);
      if (!n) return reject(new Error(errText.trim().split('\n').pop() || '音声を読めませんでした'));
      const per = Math.round(RATE * BIN), db = [];
      for (let i = 0; i < n; i += per) {
        let sum = 0, cnt = 0;
        for (let j = i; j < Math.min(n, i + per); j++) { const v = buf.readFloatLE(j * 4); sum += v * v; cnt++; }
        db.push(10 * Math.log10(sum / cnt + 1e-12));
      }
      resolve(db);
    });
  });
}

// 記録した音量の流れから、音楽が鳴り始めた秒数を探す（public/check.html の findMusicStart と同じ）
function findMusicStart(db) {
  const heard = db.filter(v => v > -100).sort((a, b) => a - b);
  if (!heard.length) return null;
  const ref = heard[Math.floor(heard.length * 0.9)];
  if (ref < SILENT_DB) return null;
  const need = Math.round(SUSTAIN_SEC / BIN);
  let start = -1;
  for (let i = 0; i < db.length; i++) {
    if (db[i] < ref - LOUD_DB) continue;
    const win = db.slice(i, i + need);
    if (win.length < Math.min(need, 4)) break;
    if (win.filter(v => v >= ref - KEEP_DB).length / win.length >= 0.85) { start = i; break; }
  }
  if (start < 0) return { onset: 0, unsure: true };
  let a = start;
  while (a > 0 && start - a < 1.5 / BIN && db[a - 1] >= ref - ATTACK_DB) a--;
  const before = db.slice(0, a);
  const avgBefore = before.length ? 10 * Math.log10(before.reduce((x, v) => x + 10 ** (v / 10), 0) / before.length + 1e-12) : -120;
  const unsure = a * BIN > 1 && avgBefore > ref - 6;
  return { onset: a * BIN, unsure };
}

// 1曲ぶんの結果を保存する。サーバーが動いていれば API（変更した曲だけ送る）、なければファイルに直接
async function save(song) {
  try {
    const res = await fetch(`${SERVER}/api/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ songs: [song] }) });
    if (res.ok) return 'api';
    throw new Error((await res.json()).error);
  } catch (e) {
    const all = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
    const cur = all.find(s => s.id === song.id);
    if (!cur) return 'skip';
    for (const k of ['intro', 'introMeasured', 'introMethod', 'introUnsure']) { if (k in song) cur[k] = song[k]; else delete cur[k]; }
    fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH);
    return 'file';
  }
}

(async () => {
  // 毎回ファイルを読み直して、計測済みは飛ばす
  const all = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
  const targets = (COMPARE ? all.filter(s => s.introMethod === 'v2' && s.introMeasured && s.embeddable !== false).sort(() => Math.random() - 0.5) : all.filter(needsMeasure)).slice(0, LIMIT);
  console.log(`計測する曲: ${targets.length} 曲${DRY ? '（保存しない）' : ''}`);
  let done = 0, changed = 0, failed = 0;
  for (const s of targets) {
    done++;
    const label = `[${done}/${targets.length}] ${s.title}（${s.work}）`;
    try {
      const db = await recordLevels(s.id);
      const r = findMusicStart(db);
      // 最新の内容に結果だけ重ねて保存（ほかの項目は消さない）
      const fresh = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8')).find(x => x.id === s.id);
      if (COMPARE) { const intro = r ? Math.max(0, Math.round((r.onset - ONSET_MARGIN) * 10) / 10) : null; console.log(`${label} → 裏の計測 ${intro} 秒 / ブラウザ ${s.intro} 秒`); await sleep(WAIT_MS); continue; }
      if (!fresh || fresh.introMethod === 'v2') { console.log(`${label} → ほかで計測済みなので飛ばす`); continue; }
      const song = { ...fresh, introMethod: 'v2' };
      if (!r) { song.introUnsure = true; console.log(`${label} → 音を検出できず（要確認）`); }
      else {
        const intro = Math.max(0, Math.round((r.onset - ONSET_MARGIN) * 10) / 10);
        if (intro !== (fresh.intro || 0)) changed++;
        song.intro = intro; song.introMeasured = true;
        if (r.unsure) song.introUnsure = true; else delete song.introUnsure;
        console.log(`${label} → ${intro} 秒${r.unsure ? '（要確認）' : ''}`);
      }
      if (!DRY) await save(song);
    } catch (e) {
      failed++;
      console.log(`${label} → 失敗: ${e.message}`);
    }
    await sleep(WAIT_MS);
  }
  console.log(`終わり：計測 ${done - failed} 曲（イントロ秒が変わった曲 ${changed}）、失敗 ${failed} 曲`);
})();
