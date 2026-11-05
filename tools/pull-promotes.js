// 公開サイトで「これはゲームデータに入れる」が押されたお試しの曲を取り込み、本採用にする（staged を外す）。
// 反映（再起動）の前に必ず行う。再起動すると公開側の記録は消えるため。
// 使い方: node tools/pull-promotes.js [--dry-run]
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SONGS_PATH = path.join(ROOT, 'data', 'songs.json');
const LOCAL_PATH = path.join(ROOT, 'data', 'promotes.json');
const SITE = 'https://intro-don-jpop.onrender.com';
const DRY = process.argv.includes('--dry-run');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };

(async () => {
  let remote = {};
  try { remote = (await (await fetch(`${SITE}/api/promotes`)).json()).promotes || {}; } catch (e) { console.log('公開サイトから読めませんでした（手元の記録だけ使います）'); }
  const local = Object.fromEntries(Object.entries(readJson(LOCAL_PATH, {})).map(([id, e]) => [id, { title: e.title, votes: (e.votes || []).length }]));
  const ids = new Set([...Object.keys(remote), ...Object.keys(local)]);
  const songs = readJson(SONGS_PATH, []);
  let n = 0;
  for (const id of ids) {
    const s = songs.find(x => x.id === id);
    if (!s || !s.staged) continue;
    console.log(`本採用: ${s.title}／${s.artist}（${(remote[id]?.votes || 0) + (local[id]?.votes || 0)}人）`);
    if (!DRY) { delete s.staged; s.confidence = '中'; }
    n++;
  }
  console.log(`本採用 ${n} 曲`);
  if (DRY || !n) return;
  fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH);
  fs.writeFileSync(LOCAL_PATH, '{}\n');
})();
