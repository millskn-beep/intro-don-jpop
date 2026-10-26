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
const songs = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'songs.json'), 'utf8')).filter(s => !s.retired).map(s => s.id));

// json3：events[].tStartMs と segs[].utf8。改行は1行にまとめ、♪だけ・空の行は外す
function parse(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const e of j.events || []) {
    const text = (e.segs || []).map(s => s.utf8 || '').join('').replace(/\s*\n\s*/g, ' ').replace(/[♪♫]/g, '').trim();
    if (!text || typeof e.tStartMs !== 'number') continue;
    out.push({ t: Math.round(e.tStartMs / 100) / 10, text });
  }
  return out.sort((a, b) => a.t - b.t);
}

(async () => {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith('.json3')) : [];
  const byId = {};
  for (const f of files) {
    const id = f.slice(0, 11); if (!songs.has(id) || byId[id]) continue; // 1曲に字幕が2つあれば、先に見つけた方
    try { const lines = parse(path.join(DIR, f)); if (lines.length >= 6) byId[id] = { lines }; } catch (e) { /* 読めないファイルは飛ばす */ }
  }
  const ids = Object.keys(byId);
  console.log(`字幕のある曲 ${ids.length} 曲を送ります`);
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
