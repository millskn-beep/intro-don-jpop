// 「あの頃のHIT CHART」（kajiyan-net.jp）の年間チャート（各年 上位100曲）から、曲の候補（曲名・歌手・年）を集める。
// ページは Shift_JIS。曲名・歌手の全角英数字は半角に、漢字・かなの名前の間の空白（「宇多田 ヒカル」）は詰める。
// 年はチャートの年。知名度の見立て：20位まで 1、50位まで 2、それより下 3。1980年より前は入れない。
// 使い方: node tools/scrape-kajiyan.js <出力.json>
const fs = require('fs');
const OUT = process.argv[2];
const BASE = 'https://www.kajiyan-net.jp/';
const get = u => fetch(BASE + u, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.arrayBuffer()).then(b => new TextDecoder('shift_jis').decode(Buffer.from(b)));
const txt = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// 全角英数字→半角。日本語どうしの間の空白は詰める（英語の名前の空白は残す）
const fix = s => String(s).normalize('NFKC').replace(/(?<=[^\x00-\x7f])\s+(?=[^\x00-\x7f])/g, '').trim();
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s!！・〜~～()（）\-♪【】.。,、\/'"「」『』?？&＆*＊☆★♡:：…･]/g, '');
(async () => {
  const menu = await get('years.htm');
  const pages = [...new Set([...menu.matchAll(/href=["']?(nenkan\/(\d{4})nenkan\.html?)/gi)].map(m => m[1]))].filter(p => +p.match(/(\d{4})/)[1] >= 1980);
  const seen = new Map();
  for (const p of pages) {
    const year = +p.match(/(\d{4})/)[1];
    let h; try { h = await get(p); } catch (e) { console.log('失敗', p, e.message); continue; }
    const rows = [...h.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => txt(c[1])));
    const head = rows.find(r => r.some(c => /タイトル|曲名/.test(c)) && r.some(c => /アーティスト|歌手/.test(c))) || [];
    const ri = head.findIndex(c => /順位/.test(c)), ti = head.findIndex(c => /タイトル|曲名/.test(c)), ai = head.findIndex(c => /アーティスト|歌手/.test(c));
    if (ti < 0 || ai < 0) { console.log('表が見つからない', p); continue; }
    let n = 0;
    for (const r of rows) {
      const rank = +String(r[ri] ?? '').replace(/[^0-9]/g, ''); if (!rank) continue;
      const title = fix(r[ti] || ''), artist = fix(r[ai] || ''); if (!title || !artist) continue;
      const k = norm(title) + '|' + norm(artist), fame = rank <= 20 ? 1 : rank <= 50 ? 2 : 3;
      const o = seen.get(k);
      if (!o) seen.set(k, { title, artist, year, fame }); else { o.fame = Math.min(o.fame, fame); o.year = Math.min(o.year, year); }
      n++;
    }
    console.log(p, n);
    await new Promise(r => setTimeout(r, 700));
  }
  const list = [...seen.values()];
  fs.writeFileSync(OUT, JSON.stringify(list, null, 1));
  console.log(`候補 ${list.length} 曲（1980年以降・重なりを除く）→ ${OUT}`);
})();
