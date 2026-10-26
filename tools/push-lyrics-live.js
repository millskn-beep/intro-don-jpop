// 歌詞クイズ用に、このPCの歌詞ファイル（anison-drive の data/lyrics-id/ID.lrc|.txt）を本番サーバーのメモリに送る。
// 本番ではファイル・git・記録（data-log）には書かず、メモリにだけ置く（再起動で消える → 遊ぶ前にまた送る）。
// 歌詞を使えるのは、歌詞の合言葉で作った非公開の部屋だけ。鍵は tools/push-live.js と同じ .live-key。
// 使い方: node tools/push-lyrics-live.js      （試すときは LIVE_SITE=http://localhost:3001）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = process.env.LIVE_SITE || 'https://anison-intro-vs.onrender.com';
const DIR = process.env.LYRICS || 'D:/AI/anison-drive/data/lyrics-id';
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const key = fs.readFileSync(path.join(ROOT, '.live-key'), 'utf8').trim();
const songs = readJson(path.join(ROOT, 'data', 'songs.json'), []);
const scan = readJson(path.join(ROOT, 'data', 'scan-videos.json'), {});
const apple = readJson('D:/AI/anison-drive/data/apple-map.json', {});

function parse(txt) { // [{ t: 秒, text }]（時刻のない .txt は t: null）
  const out = [];
  for (const l of txt.split(/\r?\n/)) {
    const tags = [...l.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = l.replace(/\[[^\]]*\]/g, '').trim();
    if (!text || /作詞|作曲|編曲|作編曲|^\s*(歌|唄|歌唱|vocals?|vo\.?|lyrics?|music|composed?|arrange(d|ment)?|written|composition|lyricist|composer)\s*(by\b|[:：／\/])/i.test(text)) continue; // 作詞・作曲などのクレジットの行は外す
    if (tags.length) for (const x of tags) out.push({ t: Math.round((+x[1] * 60 + +x[2]) * 100) / 100, text }); else out.push({ t: null, text });
  }
  return out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

(async () => {
  const all = {};
  for (const s of songs) {
    if (s.retired) continue;
    let f = path.join(DIR, s.id + '.lrc'); if (!fs.existsSync(f)) f = path.join(DIR, s.id + '.txt');
    if (!fs.existsSync(f)) continue;
    const lines = parse(fs.readFileSync(f, 'utf8')); if (lines.length < 6) continue;
    const yd = scan[s.id]?.dur, ad = apple[s.id]?.dur;
    all[s.id] = { lines, sync: !!(yd && ad && Math.abs(yd - ad) <= 2) }; // sync：動画と同じ音源（曲を流す問題に使える）
  }
  const ids = Object.keys(all);
  console.log(`歌詞のある曲 ${ids.length} 曲（曲を流す問題に使える ${ids.filter(i => all[i].sync).length} 曲）を送ります`);
  // 1回の大きさに上限があるので、小分けにして送る（最初の回で前の分を消す）
  let sent = 0;
  for (let i = 0; i < ids.length; i += 150) {
    const part = Object.fromEntries(ids.slice(i, i + 150).map(id => [id, all[id]]));
    const res = await fetch(`${SITE}/api/live/lyrics`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-live-key': key }, body: JSON.stringify({ songs: part, reset: i === 0 }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { console.log(`送れませんでした：${j.error || res.status}`); process.exit(1); }
    sent = j.total;
  }
  console.log(`送りました：サーバーの歌詞 ${sent} 曲（メモリだけ。再起動で消えます）`);
})().catch(e => { console.error('送れませんでした:', e.message); process.exit(1); });
