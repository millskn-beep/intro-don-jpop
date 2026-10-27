// 歌詞クイズ2用に、YouTube の手動の日本語字幕（anison-drive の data/yt-subs/ID.ja*.json3。tools/fetch-yt-subs.js が取る）を本番のメモリに送る。
// 本番ではファイル・git・記録には書かず、メモリにだけ置く（再起動で消える → 反映のあとにまた送る）。
// 字幕の中身は画面に出さない（件数だけ）。鍵は tools/push-live.js と同じ .live-key。
// 使い方: node tools/push-subs-live.js      （試すときは LIVE_SITE=http://localhost:3001）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = process.env.LIVE_SITE || 'https://anison-intro-vs.onrender.com';
const DIR = process.env.SUBS || 'D:/AI/anison-drive/data/yt-subs';
const key = fs.readFileSync(path.join(ROOT, '.live-key'), 'utf8').trim();
const check = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'lyric-check.json'), 'utf8')); } catch (e) { return {}; } })(); // tools/check-subs-lyrics.js の結果
const songs = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'songs.json'), 'utf8')).filter(s => !s.retired).map(s => s.id));

// 字幕に訳などの行が足されている曲（verdict: extra）は、歌詞にある行だけ残す
const LY = 'D:/AI/anison-drive/data/lyrics-id';
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s\p{P}\p{S}]/gu, '');
const bi = s => { const o = new Set(); for (let i = 0; i + 1 < s.length; i++) o.add(s.slice(i, i + 2)); if (s.length === 1) o.add(s); return o; };
const sim = (A, B) => { let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.max(1, Math.min(A.size, B.size)); };
function lyricKeep(id) {
  let f = path.join(LY, id + '.lrc'); if (!fs.existsSync(f)) f = path.join(LY, id + '.txt');
  const L = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => bi(norm(l.replace(/\[[^\]]*\]/g, '')))).filter(b => b.size);
  return part => { const b = bi(norm(part)); return L.some(x => sim(b, x) >= 0.6); };
}

// json3：events[].tStartMs と segs[].utf8。改行は1行にまとめ、♪だけ・空の行は外す（keep があれば、歌詞にある行だけ）
function parse(file, keep) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const e of j.events || []) {
    let raw = (e.segs || []).map(s => s.utf8 || '').join('');
    if (keep) raw = raw.split('\n').filter(keep).join('\n');
    const text = raw.replace(/\s*\n\s*/g, ' ').replace(/[♪♫]/g, '').trim();
    if (!text || typeof e.tStartMs !== 'number') continue;
    out.push({ t: Math.round(e.tStartMs / 100) / 10, text });
  }
  return out.sort((a, b) => a.t - b.t);
}

(async () => {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith('.json3')) : [];
  const byId = {}; let skipped = 0;
  for (const f of files) {
    const id = f.slice(0, 11); if (!songs.has(id) || byId[id]) continue; // 1曲に字幕が2つあれば、先に見つけた方
    // 歌詞と比べて、訳（英語の曲の日本語訳）・ローマ字・別の中身の字幕は使わない。歌詞がない曲は、日本語の字幕だけ
    const c = check[id];
    if (c && (['translated', 'romaji', 'mismatch'].includes(c.verdict) || (c.verdict === 'nolyrics' && c.subJp < 0.3))) { skipped++; continue; }
    try { const lines = parse(path.join(DIR, f), c?.verdict === 'extra' ? lyricKeep(id) : null); if (lines.length >= 6) byId[id] = { lines }; } catch (e) { /* 読めないファイルは飛ばす */ }
  }
  const ids = Object.keys(byId);
  console.log(`字幕のある曲 ${ids.length} 曲を送ります（訳・ローマ字・別の中身の字幕 ${skipped} 曲は外しました。先に node tools/check-subs-lyrics.js）`);
  let first = true, total = 0;
  for (let i = 0; i < ids.length || first; i += 300) {
    const part = Object.fromEntries(ids.slice(i, i + 300).map(id => [id, byId[id]]));
    const res = await fetch(`${SITE}/api/live/subs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-live-key': key }, body: JSON.stringify({ reset: first, songs: part }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { console.log(`送れませんでした：${j.error || res.status}`); process.exit(1); }
    total = j.total; first = false;
    if (!ids.length) break;
  }
  console.log(`送りました：サーバーの字幕 ${total} 曲（メモリだけ。再起動で消えます）`);
})().catch(e => { console.error('送れませんでした:', e.message); process.exit(1); });
