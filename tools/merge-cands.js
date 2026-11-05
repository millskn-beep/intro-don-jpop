// いろいろな所から集めた曲の候補を1つにまとめる（同じ曲は1つに。もう曲データにある曲・ほかの結果にある曲は除く）。
// 発売年は Spotify（発売日）→ 年代流行（発売日）→ 年間チャートの年 → そのほか の順に信用する。
// 知名度の見立て（fame：1 だれでも知っている／2 広く知られている／3）は、いちばん高いものを使う。
// 動画（年代流行の曲のページに貼ってあるもの）があれば video に入れる（YouTube の検索を省く）。
// 使い方: node tools/merge-cands.js <出力.json> <除く結果.json,...> spotify=<f> nendai=<f> chart=<f> [maxFame=2]
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2), OUT = args[0];
const skipFiles = (args[1] || '').split(',').filter(Boolean);
const opt = Object.fromEntries(args.slice(2).map(a => a.split('=')));
const maxFame = +(opt.maxFame || 2);
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s!！・〜~～()（）\-♪【】.。,、\/'"「」『』?？&＆*＊☆★♡:：…･]/g, '');
const key = (t, a) => norm(t) + '|' + norm(a);
// 曲名の後ろの補足（「〜昔からある場所〜」「- From THE FIRST TAKE」など）は比べるときに外す
const base = t => norm(String(t).normalize('NFKC').replace(/\s*[-~〜(（\[].*$/, '')) || norm(t);
const songs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'songs.json'), 'utf8'));
const have = new Set(songs.map(s => base(s.title) + '|' + norm(s.artist)));
for (const f of skipFiles) for (const r of Object.values(JSON.parse(fs.readFileSync(f, 'utf8')))) have.add(base(r.title) + '|' + norm(r.artist));
const SRC = [['spotify', 3], ['nendai', 2], ['chart', 1]]; // 年の信用の順（大きいほど信用）
const out = new Map();
for (const [name, trust] of SRC) {
  if (!opt[name]) continue;
  for (const r of JSON.parse(fs.readFileSync(opt[name], 'utf8'))) {
    if (!r.title || !r.artist || (r.fame || 3) > maxFame) continue;
    const k = base(r.title) + '|' + norm(r.artist);
    if (have.has(k)) continue;
    const o = out.get(k);
    if (!o) { out.set(k, { title: r.title, artist: r.artist, year: r.year || 0, fame: r.fame || 3, video: r.video || null, yearTrust: r.year ? trust : 0, from: [name] }); continue; }
    o.fame = Math.min(o.fame, r.fame || 3); o.video = o.video || r.video || null; o.from.push(name);
    if (r.year && trust > o.yearTrust) { o.year = r.year; o.yearTrust = trust; }
  }
}
const list = [...out.values()].filter(x => x.year >= 1980).map(({ yearTrust, ...x }) => x);
fs.writeFileSync(OUT, JSON.stringify(list, null, 1));
console.log(`まとめた候補 ${list.length} 曲（動画あり ${list.filter(x => x.video).length}・知名度1 ${list.filter(x => x.fame === 1).length}）→ ${OUT}`);
