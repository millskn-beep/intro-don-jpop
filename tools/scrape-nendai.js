// 年代流行（nendai-ryuukou.com）のランキングの表から、曲の候補（曲名・歌手・年）を集める。
// ・年ごとのヒット曲（1980/song.html … 2025/song.html。1980〜2000年代は1ページに10年分。年は見出しから読む）
// ・特集ページ（歴代売上・平成の名曲・ドラマ主題歌・卒業ソング など。年は表の発売日・年の列から読む）
// 曲名のリンク先（曲のページ）に YouTube の動画と発売日があるので、それも読む（動画 id は hit に入れて、YouTube の検索を省く）。
// 1980年より前の曲は入れない。曲の候補（JSON）にして、tools/add-found.js に渡す（動画のない曲は tools/yt-find.js で探す）。
// 使い方: node tools/scrape-nendai.js <出力.json>
const fs = require('fs');
const OUT = process.argv[2];
const BASE = 'https://nendai-ryuukou.com/';
const YEAR_PAGES = ['1980/song.html', '1990/song.html', '2000/song.html', ...Array.from({ length: 16 }, (_, i) => `${2010 + i}/song.html`)];
const ARTICLES = ['009', '092', '001', '023', '182', '075', '080', '148', '084', '151', '213', '214', '247', '008'].map(n => `article/${n}.html`);
const ent = s => s.replace(/&rsquo;|&lsquo;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const txt = s => ent(s.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function page(p) {
  const h = await fetch(BASE + p, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text());
  const out = [];
  const urlYear = +(p.match(/^(\d{4})\/song/)?.[1] || 0);
  let headYear = 0;
  // 見出しと表を出てくる順に読む（見出しの年が、そのあとの表の年）
  for (const m of h.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>|<table[\s\S]*?<\/table>/g)) {
    if (m[1] != null) { const y = txt(m[1]).match(/(19[5-9]\d|20[0-2]\d)年/); if (y) headYear = +y[1]; continue; }
    const trs = [...m[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => c[1]));
    const rows = trs.map(r => r.map(txt)), links = trs.map(r => r.map(c => c.match(/href="([^"]+)"/)?.[1] || null));
    if (rows.length < 2) continue;
    const head = rows[0];
    const ti = head.findIndex(c => /曲名|タイトル|曲/.test(c)), ai = head.findIndex(c => /アーティスト|歌手/.test(c)), di = head.findIndex(c => /発売|年/.test(c));
    if (ti < 0 || ai < 0) continue;
    rows.slice(1).forEach((r, i) => {
      const title = r[ti], artist = r[ai]; if (!title || !artist) return;
      const href = links[i + 1]?.[ti] || null; // 曲のページ（相対）
      const y = di >= 0 ? +(String(r[di]).match(/(19|20)\d\d/)?.[0] || 0) : 0;
      const year = y || urlYear || headYear;
      out.push({ title, artist, year, rank: i + 1, src: p, page: href ? new URL(href, BASE + p).href : null });
    });
  }
  return out;
}
(async () => {
  const all = [];
  for (const p of [...YEAR_PAGES, ...ARTICLES]) {
    try { const r = await page(p); all.push(...r); console.log(p, r.length); } catch (e) { console.log('失敗', p, e.message); }
    await new Promise(r => setTimeout(r, 800));
  }
  const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s!！・〜~～()（）\-♪【】.。,、\/'"「」『』?？&＆*＊☆★♡:：…･]/g, '');
  const seen = new Map();
  for (const r of all) {
    if (!r.year || r.year < 1980) continue;
    const k = norm(r.title) + '|' + norm(r.artist);
    const fame = r.rank <= 3 ? 1 : 2;
    const o = seen.get(k);
    if (!o) seen.set(k, { title: r.title, artist: r.artist, year: r.year, fame, page: r.page });
    else { o.fame = Math.min(o.fame, fame); if (!o.year || (r.year && r.year < o.year)) o.year = r.year; o.page = o.page || r.page; }
  }
  const list = [...seen.values()];
  // 曲のページ：YouTube の動画と発売日（年）を読む。途中経過は毎回保存（止まっても続きから）
  const prev = fs.existsSync(OUT) ? new Map(JSON.parse(fs.readFileSync(OUT, 'utf8')).map(x => [norm(x.title) + '|' + norm(x.artist), x])) : new Map();
  let n = 0;
  for (const x of list) {
    const old = prev.get(norm(x.title) + '|' + norm(x.artist));
    if (old && 'video' in old) { x.video = old.video; x.year = old.year; continue; }
    if (!x.page) { x.video = null; continue; }
    try {
      const h = await fetch(x.page, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text());
      x.video = h.match(/youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})/)?.[1] || null;
      const y = txt(h).match(/発売日\s*((?:19|20)\d\d)年/)?.[1]; if (y) x.year = +y;
    } catch (e) { console.log('失敗', x.page, e.message); continue; }
    if (++n % 50 === 0) { fs.writeFileSync(OUT, JSON.stringify(list, null, 1)); console.log(`曲のページ ${n}`); }
    await new Promise(r => setTimeout(r, 400));
  }
  fs.writeFileSync(OUT, JSON.stringify(list, null, 1));
  console.log(`候補 ${list.length} 曲（1980年以降・重なりを除く）。動画あり ${list.filter(x => x.video).length} → ${OUT}`);
})();
