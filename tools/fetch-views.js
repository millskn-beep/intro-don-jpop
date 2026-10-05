// 各曲の YouTube の再生回数・チャンネル名を取得して songs.json に入れる（知名度の分類の目安にする）。
// yt-dlp で動画の情報だけを取る（ダウンロードしない）。まとめて取得し、まとまりごとに保存するので途中で止めても続きから。
//
// 使い方: node tools/fetch-views.js [--all]   （--all：取得済みの曲も取り直す）
// 必要なもの: python -m yt_dlp
// 保存: 手元のサーバー（http://localhost:3000）が動いていればその API で、止まっていれば songs.json に直接書く

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SONGS_PATH = path.join(__dirname, '..', 'data', 'songs.json');
const SERVER = 'http://localhost:3000';
const BATCH = 25;          // 1回の yt-dlp で調べる曲数（起動の時間を減らすため）
const WAIT_MS = 2000;      // まとまりごとの間
const YTDLP_OPTS = ['--compat-options', 'no-certifi', '--js-runtimes', 'node'];
const KEYS = ['views', 'channel', 'viewsAt'];

const ALL = process.argv.includes('--all');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function infos(ids) {
  return new Promise(resolve => {
    execFile('python', ['-m', 'yt_dlp', ...YTDLP_OPTS, '-j', '--skip-download', '--no-warnings', '--ignore-errors',
      ...ids.map(id => `https://www.youtube.com/watch?v=${id}`)],
      { timeout: 600000, maxBuffer: 256 * 1024 * 1024 },
      (err, out) => {
        const got = new Map();
        for (const line of String(out || '').split('\n')) {
          if (!line.trim()) continue;
          try { const j = JSON.parse(line); got.set(j.id, { views: j.view_count ?? null, channel: j.channel || j.uploader || '' }); } catch (e) {}
        }
        resolve(got);
      });
  });
}

async function save(list) {
  try {
    const res = await fetch(`${SERVER}/api/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ songs: list }) });
    if (res.ok) return 'api';
    throw new Error((await res.json()).error);
  } catch (e) {
    const all = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
    const byId = new Map(all.map(s => [s.id, s]));
    for (const s of list) { const cur = byId.get(s.id); if (cur) for (const k of KEYS) if (k in s) cur[k] = s[k]; }
    fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH);
    return 'file';
  }
}

(async () => {
  const targets = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8')).filter(s => s.embeddable !== false && (ALL || !s.viewsAt));
  console.log(`再生回数を調べる曲: ${targets.length} 曲`);
  let done = 0, ok = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const part = targets.slice(i, i + BATCH);
    const got = await infos(part.map(s => s.id));
    // 最新の内容に結果だけ重ねて保存（ほかの項目は消さない）
    const fresh = new Map(JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8')).map(s => [s.id, s]));
    const today = new Date().toISOString().slice(0, 10);
    const list = part.map(s => fresh.get(s.id)).filter(Boolean).map(s => {
      const g = got.get(s.id);
      if (g) ok++;
      return g ? { ...s, views: g.views, channel: g.channel, viewsAt: today } : { ...s, viewsAt: today };
    });
    await save(list);
    done += part.length;
    console.log(`${done}/${targets.length}（取得できた ${ok}）`);
    await sleep(WAIT_MS);
  }
  console.log(`終わり：${ok}/${targets.length} 曲の再生回数を取得`);
})();
