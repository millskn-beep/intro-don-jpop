// 曲ごとのサブジャンル（data/song-tags.json：id → [タグ]）を作る。
// ・調べた一覧（JSON：{ タグ: [{ title, artist, year }] }）の曲と、曲データの曲を、曲名（後ろの補足を外した形）と歌手で突き合わせる
// ・youtube（YouTubeで有名）は再生回数で決める（5000万回以上）
// 一覧にあって曲データにない曲は、足す候補として書き出す（tools/yt-find.js に渡せる形）。
// 使い方: node tools/apply-tags.js <足す候補の出力.json> <一覧.json> [<一覧.json> ...]
const fs = require('fs');
const path = require('path');
const [, , MISSING, ...LISTS] = process.argv;
const D = path.join(__dirname, '..', 'data');
const songs = JSON.parse(fs.readFileSync(path.join(D, 'songs.json'), 'utf8')).filter(s => !s.retired);
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s!！・〜~～()（）\-♪【】.。,、\/'"「」『』?？&＆*＊☆★♡:：…･]/g, '');
const base = t => norm(String(t).normalize('NFKC').replace(/\s*[-~〜(（\[].*$/, '')) || norm(t);
// 歌手は「A feat. B」「A×B」の最初の名前でも合えばよい
const art = a => norm(String(a).normalize('NFKC').split(/\s*(?:feat\.?|ft\.|×|&|＆|with|、|,)\s*/i)[0]);
const byTitle = new Map();
for (const s of songs) { const k = base(s.title); if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(s); }
const find = r => {
  const list = byTitle.get(base(r.title)) || []; if (!list.length) return null;
  const a = art(r.artist);
  return list.find(s => art(s.artist) === a) || list.find(s => art(s.artist).includes(a) || a.includes(art(s.artist))) || (list.length === 1 && !r.artist ? list[0] : null);
};
const tags = {}, missing = new Map(), count = {};
const add = (id, t) => { (tags[id] ||= []).includes(t) || tags[id].push(t); count[t] = (count[t] || 0) + 1; };
for (const f of LISTS) {
  for (const [t, rows] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) {
    for (const r of rows || []) {
      if (!r?.title) continue;
      const s = find(r);
      if (s) add(s.id, t);
      else { const k = base(r.title) + '|' + art(r.artist); const m = missing.get(k) || { title: r.title, artist: r.artist, year: r.year || 0, fame: 2, tags: [] }; m.tags.includes(t) || m.tags.push(t); missing.set(k, m); }
    }
  }
}
for (const s of songs) if (s.views >= 5e7) add(s.id, 'youtube'); // YouTubeで有名：5000万回以上
fs.writeFileSync(path.join(D, 'song-tags.json'), JSON.stringify(tags, null, 1) + '\n');
if (MISSING) fs.writeFileSync(MISSING, JSON.stringify([...missing.values()], null, 1));
console.log('タグを付けた曲', Object.keys(tags).length, count);
console.log(`一覧にあって曲データにない曲 ${missing.size} 曲${MISSING ? ' → ' + MISSING : ''}`);
