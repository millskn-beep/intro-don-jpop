// iTunes（ミュージック）のプレイリスト書き出し（UTF-16 のタブ区切り）から、カップリング曲を見つける
//   node tools/itunes-couplings.js <書き出し.txt> [...]  … 結果を表示するだけ（曲データは変えない）
//   node tools/itunes-couplings.js --apply <書き出し.txt> [...] … 見つかった曲に coupling:true を付ける
// 見分け方（表題曲・両A面を外すため、曲名がアルバム名に入っている曲と、コレクション・ベスト等のアルバムは除く）：アルバム名が「○○ - Single」「○○ - EP」「○○ - シングル」で、トラック番号が2以上、トラック数が6以下 → シングルのB面（カップリング）
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), apply = args[0] === '--apply', files = args.filter(a => a !== '--apply');
const P = path.join(__dirname, '..', 'data', 'songs.json');
const songs = JSON.parse(fs.readFileSync(P, 'utf8'));
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\-‐ー〜~・･!！?？'’"“”.,，、。()（）\[\]【】]/g, '');
const idx = new Map();
for (const s of songs) { const k = norm(s.title); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(s); }
const out = [];
for (const f of files) {
  const lines = fs.readFileSync(f).toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const head = lines[0].split('\t'), col = n => head.indexOf(n);
  const [cT, cA, cAl, cTn, cTc] = ['名前', 'アーティスト', 'アルバム', 'トラック番号', 'トラック数'].map(col);
  for (const l of lines.slice(1)) {
    const c = l.split('\t'), title = c[cT], artist = c[cA], album = c[cAl] || '', tn = +c[cTn] || 0, tc = +c[cTc] || 0;
    const isSingle = /\s-\s(Single|EP|シングル)\s*$/i.test(album) || /(\s|^)(Single|シングル)$/i.test(album);
    // 曲名がアルバム名に入っている（表題曲・両A面）、「コレクション」「Theme Song」の寄せ集めは、カップリングとは見なさない
    const base = norm(String(title).replace(/[（(][^）)]*[）)]/g, ''));
    const titled = base && norm(album).includes(base), compil = /collection|コレクション|theme song|best|ベスト|サウンドトラック|soundtrack/i.test(album);
    const cw = isSingle && tn >= 2 && (tc === 0 || tc <= 6) && !titled && !compil;
    const hit = (idx.get(norm(title)) || []).filter(s => !s.retired);
    // 歌手が近いものを優先（なければ同名の曲が1つだけのときだけ）
    const near = hit.filter(s => norm(s.artist).includes(norm(artist).slice(0, 4)) || norm(artist).includes(norm(s.artist).slice(0, 4)) || norm(s.work).includes(norm(artist).slice(0, 4)));
    const m = near.length ? near : (hit.length === 1 ? hit : []);
    out.push({ title, artist, album, tn, tc, cw, ids: m.map(s => s.id), file: path.basename(f) });
  }
}
const cws = out.filter(o => o.cw);
console.log(`曲 ${out.length}／アルバム情報から カップリング曲 ${cws.length}（曲データに見つかった ${cws.filter(o => o.ids.length).length}）`);
for (const o of cws) console.log(`  ${o.ids.length ? '●' : '○'} ${o.title}｜${o.artist}｜${o.album}｜${o.tn}/${o.tc}`);
if (apply) {
  const by = new Map(songs.map(s => [s.id, s])); let n = 0;
  for (const o of cws) for (const id of o.ids) { const s = by.get(id); if (!s.coupling && !s.couplingNo) { s.coupling = true; s.couplingOf = o.album.replace(/\s-\s(Single|EP|シングル)\s*$/i, ''); n++; } }
  fs.writeFileSync(P + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(P + '.tmp', P);
  console.log(`${n} 曲に印を付けました`);
}
