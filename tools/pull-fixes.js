// 収録曲一覧から送られた「イントロ・サビ位置の修正」を公開サイトから取り込み、曲データ（data/songs.json）に入れる。
// 反映（再起動）の前に必ず行う。再起動すると公開側の修正待ちは消えるため。取り込んだら data/fixes.json は空に戻す。
// 使い方: node tools/pull-fixes.js [--dry-run]

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SONGS_PATH = path.join(ROOT, 'data', 'songs.json');
const FIXES_PATH = path.join(ROOT, 'data', 'fixes.json');
const SITE = 'https://anison-intro-vs.onrender.com';
const DRY = process.argv.includes('--dry-run');

(async () => {
  let fixes = {};
  try { fixes = JSON.parse(fs.readFileSync(FIXES_PATH, 'utf8')); } catch (e) { fixes = {}; }
  const res = await fetch(`${SITE}/api/fixes`);
  if ((res.headers.get('content-type') || '').includes('json')) {
    const remote = (await res.json()).fixes || {};
    for (const [id, f] of Object.entries(remote)) if (!fixes[id] || fixes[id].at < f.at) fixes[id] = f; // 新しい方を使う
  } else console.log('公開サイトにはまだ修正の受け付けがありません');
  const songs = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
  const byId = new Map(songs.map(s => [s.id, s]));
  let n = 0;
  for (const [id, f] of Object.entries(fixes)) {
    const s = byId.get(id);
    if (!s) { console.log(`  （曲が見つからない）${id}`); continue; }
    const before = `イントロ ${s.intro || 0} / サビ ${s.chorus || 0}`;
    if (f.intro !== (s.intro || 0)) { s.intro = f.intro; s.introMeasured = false; delete s.introMethod; delete s.introUnsure; } // 手で直した印（チェック画面と同じ）
    if (f.chorus !== s.chorus) { s.chorus = f.chorus; s.chorusSource = 'manual'; }
    console.log(`  ${s.title}（${s.work}）: ${before} → イントロ ${f.intro} / サビ ${f.chorus}${f.count > 1 ? `（${f.count}回送信）` : ''}`);
    n++;
  }
  console.log(`修正 ${n} 曲${DRY ? '（保存しない）' : ''}`);
  if (DRY || !n) return;
  fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH);
  fs.writeFileSync(FIXES_PATH, '{}\n');
  console.log('songs.json に入れて、修正待ちを空にしました');
})().catch(e => { console.error('取り込めませんでした:', e.message); process.exit(1); });
