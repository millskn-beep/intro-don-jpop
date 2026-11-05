// 曲の候補（JSON：[{title, artist, year, fame}]）から、YouTube で動画を探す。途中経過は出力ファイルに毎回残す（止まっても続きから）
// 選び方：曲名が動画のタイトルに入っているもの。公式（歌手のチャンネル・Official・公式・- Topic）を優先し、同じくらいなら再生回数の多いもの。
// カバー・歌ってみた・カラオケ・ライブ・短い動画などは外す。公式も Topic もなければ、100万回以上の動画だけ（非公式として印を付ける）。
// 使い方: node tools/yt-find.js <候補.json> <結果.json>
const fs = require('fs');
const [, , IN, OUT] = process.argv;
const cand = JSON.parse(fs.readFileSync(IN, 'utf8'));
const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s!！・〜~～()（）\-♪【】.。,、\/'"「」『』?？&＆*＊☆★♡:：…･]/g, '');
const BAD = /カバー|cover|歌ってみた|弾いてみた|叩いてみた|踊ってみた|karaoke|カラオケ|オルゴール|piano ver|ピアノ|instrumental|インスト|remix|リミックス|#shorts|切り抜き|反応|reaction|メドレー|medley|full album|フルアルバム/i;

async function find(c) {
  const h = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(`${c.artist} ${c.title}`), { headers: { 'Accept-Language': 'ja', 'User-Agent': UA }, signal: AbortSignal.timeout(20000) }).then(r => r.text());
  const m = h.match(/var ytInitialData = (\{.*?\});<\/script>/s); if (!m) throw new Error('検索結果なし');
  const vids = []; JSON.stringify(JSON.parse(m[1]), (k, v) => { if (v && v.videoRenderer) vids.push(v.videoRenderer); return v; });
  const T = norm(c.title), A = norm(c.artist);
  const rows = [];
  for (const v of vids.slice(0, 12)) {
    const title = v.title?.runs?.[0]?.text || '', owner = v.ownerText?.runs?.[0]?.text || '';
    const views = +String(v.viewCountText?.simpleText || '').replace(/[^0-9]/g, '') || 0;
    const len = String(v.lengthText?.simpleText || '').split(':').reduce((a, x) => a * 60 + +x, 0);
    if (!len || len < 90 || len > 720 || BAD.test(title)) continue;
    const nt = norm(title), no = norm(owner).replace(/topic$|official$|officialyoutubechannel$|officialchannel$|チャンネル$/, '');
    if (!nt.includes(T.slice(0, 14))) continue; // 曲名が入っていない
    const artistCh = no.length >= 2 && (no.includes(A.slice(0, 6)) || A.includes(no));
    const topic = /- Topic$/.test(owner), label = /official|公式|オフィシャル|records|music|レコード|エンタテインメント|entertainment/i.test(owner);
    const live = /live|ライブ|ライヴ|武道館|ツアー|tour/i.test(title);
    const kind = artistCh ? 'official' : topic && norm(owner).includes(A.slice(0, 6)) ? 'topic' : label ? 'label' : 'fan';
    let sc = { official: 30, topic: 20, label: 15, fan: 0 }[kind] + (live ? -12 : 0) + (/\bmv\b|music video|ミュージックビデオ|\bpv\b/i.test(title) ? 3 : 0);
    if (kind === 'fan' && views < 1e6) continue;
    rows.push({ id: v.videoId, title: title.slice(0, 60), owner, views, len, kind, live, sc });
  }
  rows.sort((a, b) => b.sc - a.sc || b.views - a.views);
  return rows[0] || null;
}
(async () => {
  const todo = cand.map((c, i) => i).filter(i => !(i in res));
  let p = 0, done = 0;
  const save = () => fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (p < todo.length) {
      const i = todo[p++];
      try { res[i] = { ...cand[i], hit: await find(cand[i]).catch(() => find(cand[i])) }; } catch (e) { console.log('失敗', cand[i].title, e.message); continue; } // 失敗したら1回だけやり直す
      if (++done % 20 === 0) { save(); console.log(`${done}/${todo.length}`); }
      await new Promise(r => setTimeout(r, 800));
    }
  }));
  save();
  const all = Object.values(res), hit = all.filter(r => r.hit);
  console.log(`終わり：${all.length}曲中 見つかった ${hit.length}（公式 ${hit.filter(r => r.hit.kind === 'official').length}・Topic ${hit.filter(r => r.hit.kind === 'topic').length}・レーベル ${hit.filter(r => r.hit.kind === 'label').length}・非公式 ${hit.filter(r => r.hit.kind === 'fan').length}）`);
})();
