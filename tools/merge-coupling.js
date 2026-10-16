// 調べたカップリング曲（{ 動画ID: { v: 'coupling'|'not'|'unknown', single, note } } の JSON）を songs.json に印として入れる
//   node tools/merge-coupling.js <file.json> [...]
// coupling が確認できた曲に coupling:true と couplingOf（どのシングルのc/wか）を付ける。確認できなかった曲には付けない
const fs = require('fs'), path = require('path');
const P = path.join(__dirname, '..', 'data', 'songs.json');
const songs = JSON.parse(fs.readFileSync(P, 'utf8')), by = new Map(songs.map(s => [s.id, s]));
let n = 0;
for (const f of process.argv.slice(2)) {
  if (!fs.existsSync(f)) { console.log('（ない：' + f + '）'); continue; }
  for (const [id, r] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) {
    const s = by.get(id);
    if (!s || r.v !== 'coupling' || s.couplingNo) continue; // 管理ページで戻した曲には、また印を付けない
    s.coupling = true; if (r.single) s.couplingOf = r.single; n++;
    console.log(`  ${s.title}（${s.artist}）→ 「${r.single || ''}」のc/w`);
  }
}
fs.writeFileSync(P + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(P + '.tmp', P);
console.log(`${n} 曲にカップリング曲の印を付けました`);
