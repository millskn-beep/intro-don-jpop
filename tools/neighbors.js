// 曲を追加したあと、その「まわり」（同じ作品・シリーズ、同じアーティスト）でまだ入っていない曲を探すためのチェックリストを出す。
// 新しく追加した曲（カタログのファイル、または動画ID）ごとに、作品とアーティストの今の登録曲を並べる。
// これを見て、各作品の他の期・劇場版の OP/ED/挿入歌、各アーティストのタイアップ曲で抜けているものを調べて追加する。
// 使い方: node tools/neighbors.js data/catalog/additions-xxx.csv   または   node tools/neighbors.js <動画ID> <動画ID> ...

const fs = require('fs');
const path = require('path');

const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'songs.json'), 'utf8'));
const args = process.argv.slice(2);
let ids = args;
if (args[0]?.endsWith('.csv')) ids = fs.readFileSync(args[0], 'utf8').split(/\r?\n/).slice(1).map(l => l.split(',')[6]).filter(Boolean);
const added = songs.filter(s => ids.includes(s.id));
if (!added.length) { console.log('対象の曲が見つかりません'); process.exit(0); }

// 作品は「第2期」「劇場版」などを外したシリーズ名でまとめる
const series = w => String(w).replace(/[\s　]*(第?\d+期|\d+(st|nd|rd|th) season|season ?\d+|劇場版|映画|THE MOVIE|続|完結編|新章|2nd|3rd)[\s　]*/gi, '').replace(/[（(].*?[)）]/g, '').trim();
const artistsOf = a => String(a).split(/[・、\/&]| feat\. | x | × /).map(x => x.replace(/[（(].*?[)）]/g, '').trim()).filter(x => x.length > 1);

const works = new Map(), artists = new Map();
for (const s of added) {
  works.set(series(s.work), true);
  for (const a of artistsOf(s.artist)) artists.set(a, true);
}
console.log(`■ 作品・シリーズ（${works.size}）：他の期・劇場版の OP/ED/挿入歌で抜けているものを探す`);
for (const w of works.keys()) {
  const have = songs.filter(s => series(s.work) === w || s.work.includes(w));
  console.log(`  ${w}（登録 ${have.length}曲）: ${have.map(s => `${s.title}〔${s.type || ''}〕`).join(' / ')}`);
}
console.log(`\n■ アーティスト（${artists.size}）：アニメ・映画・ゲームのタイアップ曲で抜けているものを探す`);
for (const a of artists.keys()) {
  const have = songs.filter(s => s.artist.includes(a));
  console.log(`  ${a}（登録 ${have.length}曲）: ${have.map(s => `${s.title}〔${s.work}〕`).join(' / ')}`);
}
