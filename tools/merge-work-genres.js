// 調べたジャンル（{ 作品: [ジャンル...] } の JSON）を data/work-genres.json に足す（今のジャンルは残して、足りないものを足す）
//   node tools/merge-work-genres.js <file.json> [...]
const fs = require('fs'), path = require('path');
const P = path.join(__dirname, '..', 'data', 'work-genres.json');
const G = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'genres.json'), 'utf8'));
const wg = JSON.parse(fs.readFileSync(P, 'utf8'));
const NO = ['pachislot', 'slot', 'lol', 'other']; // パチスロ・LoL は genres.json の一覧だけで決める
let added = 0, works = 0;
for (const f of process.argv.slice(2)) {
  for (const [w, ks] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) {
    const cur = wg[w] || [], add = ks.filter(k => G[k] && !NO.includes(k) && !cur.includes(k));
    if (!add.length && wg[w]) continue;
    wg[w] = [...cur, ...add]; added += add.length; works++;
  }
}
fs.writeFileSync(P, JSON.stringify(wg, null, 1) + '\n');
console.log(`${works} 作品に ${added} 個のジャンルを足しました`);
