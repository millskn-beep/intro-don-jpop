// 歌手名の書き方のゆれ・打ち間違いを、正しい書き方にそろえる（曲データの artist と work）。
// 直し方の一覧は data/artist-fix.json（{ "まちがい": "正しい" }）。曲を足したあとに毎回流す。
// 使い方: node tools/fix-artists.js
const fs = require('fs');
const path = require('path');
const D = path.join(__dirname, '..', 'data');
const FIX = JSON.parse(fs.readFileSync(path.join(D, 'artist-fix.json'), 'utf8'));
const songs = JSON.parse(fs.readFileSync(path.join(D, 'songs.json'), 'utf8'));
let n = 0;
for (const s of songs) {
  const to = FIX[s.artist];
  if (!to) continue;
  if (s.work === s.artist) s.work = to;
  s.artist = to; n++;
}
fs.writeFileSync(path.join(D, 'songs.json'), JSON.stringify(songs, null, 2) + '\n');
console.log(`歌手名を直した曲 ${n} 曲`);
