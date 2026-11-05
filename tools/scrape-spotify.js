// Spotify のプレイリスト（Jpop Girls のヒット曲プレイリストなど）から曲の候補（曲名・歌手・発売年）を集める。
// 埋め込みプレーヤーのページ（open.spotify.com/embed/...）に曲の一覧（最大100曲）と、曲ごとの発売日がある。
// 途中経過は毎回保存（止まっても続きから）。曲の候補（JSON）にして、tools/yt-find.js に渡す。
// 使い方: node tools/scrape-spotify.js <出力.json> <プレイリストID>...
const fs = require('fs');
const [, , OUT, ...IDS] = process.argv;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36', 'Accept-Language': 'ja' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nextData = h => JSON.parse(h.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)[1]).props.pageProps.state.data.entity;
// 曲名の後ろの「- Remastered 2019」「(2021 Remaster)」「- Single Version」などを外す
const cleanTitle = t => String(t).replace(/\s*[-–]\s*(\d{4}\s*)?(Remaster(ed)?|Single Version|Original Mix|Album Version|Mono|Stereo)[^)]*$/i, '').replace(/\s*\((\d{4}\s*)?(Remaster(ed)?|Single Version|Album Version)[^)]*\)\s*$/i, '').trim();
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s!！・〜~～()（）\-♪【】.。,、\/'"「」『』?？&＆*＊☆★♡:：…･]/g, '');
(async () => {
  const list = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
  const keys = new Set(list.map(x => norm(x.title) + '|' + norm(x.artist)));
  for (const pid of IDS) {
    let e;
    try { e = nextData(await fetch('https://open.spotify.com/embed/playlist/' + pid, { headers: UA }).then(r => r.text())); } catch (err) { console.log('失敗', pid, err.message); continue; }
    let added = 0;
    for (const [i, t] of e.trackList.entries()) {
      const title = cleanTitle(t.title), artist = String(t.subtitle || '').split(/,\s*/)[0];
      const k = norm(title) + '|' + norm(artist); if (keys.has(k)) continue;
      let year = 0;
      try { year = +(nextData(await fetch('https://open.spotify.com/embed/track/' + t.uri.split(':').pop(), { headers: UA }).then(r => r.text())).releaseDate?.isoString || '').slice(0, 4) || 0; } catch (err) { /* 年が取れなくても候補には入れる */ }
      keys.add(k); list.push({ title, artist, year, fame: i < 20 ? 1 : 2, from: e.title });
      added++;
      await sleep(300);
    }
    fs.writeFileSync(OUT, JSON.stringify(list, null, 1));
    console.log(`${e.title}：${e.trackList.length}曲中 新しく ${added}曲`);
  }
  console.log(`候補 ${list.length} 曲 → ${OUT}`);
})();
