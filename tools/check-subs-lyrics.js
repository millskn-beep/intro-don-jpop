// 歌詞クイズ用：YouTube の手動字幕（anison-drive の data/yt-subs）と、前に取った歌詞（data/lyrics-id）を比べる。
// 結果は data/lyric-check.json に、曲ごとの判定とずれ（数字だけ。歌詞の中身は書かない）。
//   verdict: same（同じ）／extra（字幕に訳などの行が足されている）／partial（字幕が一部だけ）／translated（字幕は日本語訳・歌詞は英語）
//            romaji（字幕は英語・ローマ字・歌詞は日本語）／mismatch（中身が違う＝どちらかが別の曲）／nolyrics（歌詞がない）
//   off: 字幕の時刻 − 歌詞の時刻（秒。LRC で、行の6割以上が同じずれのとき）
// push-lyrics-live.js（ずれを直す・別の曲の歌詞を外す）と push-subs-live.js（訳・ローマ字の字幕を外す）が使う。
// 使い方: node tools/check-subs-lyrics.js
const fs = require('fs'), path = require('path');
const SUBS = 'D:/AI/anison-drive/data/yt-subs', LY = 'D:/AI/anison-drive/data/lyrics-id';
const OUT = path.join(__dirname, '..', 'data', 'lyric-check.json');
const CREDIT = /作詞|作曲|編曲|作編曲|^\s*(歌|唄|歌唱|vocals?|vo\.?|lyrics?|music|composed?|arrange(d|ment)?|written|composition|lyricist|composer)\s*(by\b|[:：／\/])/i;
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s\p{P}\p{S}]/gu, '');
const bi = s => { const o = new Set(); for (let i = 0; i + 1 < s.length; i++) o.add(s.slice(i, i + 2)); if (s.length === 1) o.add(s); return o; };
const sim = (A, B) => { let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.max(1, Math.min(A.size, B.size)); };
const jp = s => { const a = [...String(s).replace(/\s/g, '')]; return a.filter(c => /[\u3040-\u30ff\u4e00-\u9fff]/.test(c)).length / Math.max(1, a.length); };

// 字幕の行（push-subs-live.js と同じ読み方）
function subLines(f) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8')), out = [];
  for (const e of j.events || []) {
    const text = (e.segs || []).map(s => s.utf8 || '').join('').replace(/[♪♫]/g, '').trim();
    if (!text) continue;
    for (const part of text.split('\n')) if (part.trim()) out.push({ t: (e.tStartMs || 0) / 1000, text: part.trim() });
  }
  return out;
}
function lyLines(f) {
  const out = [];
  for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const tags = [...l.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)], text = l.replace(/\[[^\]]*\]/g, '').trim();
    if (!text || CREDIT.test(text)) continue;
    if (tags.length) for (const x of tags) out.push({ t: +x[1] * 60 + +x[2], text }); else out.push({ t: null, text });
  }
  return out;
}

const out = {}, seen = new Set();
for (const f of fs.readdirSync(SUBS).filter(f => f.endsWith('.json3'))) {
  const id = f.slice(0, 11); if (seen.has(id)) continue; seen.add(id);
  const S = subLines(path.join(SUBS, f)).filter(x => !CREDIT.test(x.text) && norm(x.text).length >= 2);
  if (S.length < 6) continue;
  let lf = path.join(LY, id + '.lrc'); if (!fs.existsSync(lf)) lf = path.join(LY, id + '.txt');
  if (!fs.existsSync(lf)) { out[id] = { verdict: 'nolyrics', subJp: +jp(S.map(x => x.text).join('')).toFixed(2) }; continue; }
  const L = lyLines(lf).filter(x => norm(x.text).length >= 2);
  const Sb = S.map(x => bi(norm(x.text))), Lb = L.map(x => bi(norm(x.text)));
  // 字幕の行ごとに、いちばん近い歌詞の行（同じくらいなら時刻が近いほう）
  let hitS = 0; const ds = [];
  S.forEach((x, i) => {
    let best = 0, bj = -1;
    Lb.forEach((b, j) => { const v = sim(Sb[i], b); if (v > best || (v === best && bj >= 0 && L[j].t != null && Math.abs(L[j].t - x.t) < Math.abs(L[bj].t - x.t))) { best = v; bj = j; } });
    if (best >= 0.6) { hitS++; if (L[bj].t != null) ds.push(x.t - L[bj].t); }
  });
  let hitL = 0; Lb.forEach(b => { if (Sb.some(a => sim(a, b) >= 0.6)) hitL++; });
  // 時刻のずれ：繰り返しの行で取り違えるので、いちばん多いずれ（前後1秒）を見る
  let off = null, agree = 0;
  if (ds.length >= 5) {
    let bestN = 0; for (const c of ds) { const n = ds.filter(d => Math.abs(d - c) <= 1).length; if (n > bestN) { bestN = n; off = c; } }
    const near = ds.filter(d => Math.abs(d - off) <= 1); off = near.reduce((a, b) => a + b, 0) / near.length; agree = near.length / ds.length;
  }
  const a = jp(S.map(x => x.text).join('')), b = jp(L.map(x => x.text).join('')), cs = hitS / S.length, cl = hitL / L.length;
  const verdict = cs >= 0.5 && cl >= 0.5 ? 'same' : cl >= 0.85 ? 'extra' : cs >= 0.85 ? 'partial' : a > 0.3 && b < 0.15 ? 'translated' : a < 0.15 && b > 0.3 ? 'romaji' : 'mismatch';
  out[id] = { verdict, covS: +cs.toFixed(2), covL: +cl.toFixed(2), ...(off != null && agree >= 0.6 && lf.endsWith('.lrc') ? { off: +off.toFixed(2) } : {}) };
}
fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
const c = {}; for (const r of Object.values(out)) c[r.verdict] = (c[r.verdict] || 0) + 1;
console.log(`字幕のある曲 ${Object.keys(out).length}`, c, `ずれが分かった曲 ${Object.values(out).filter(x => x.off != null).length}`);
