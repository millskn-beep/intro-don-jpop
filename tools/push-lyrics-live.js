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
const check = readJson(path.join(ROOT, 'data', 'lyric-check.json'), {}); // 字幕と比べた結果（tools/check-subs-lyrics.js）
const voice = readJson(path.join(ROOT, 'data', 'lyric-offsets.json'), {}); // 歌声から求めたずれ（tools/align_lyrics.py）
const VOICE_OK = v => v && v.score >= 0.5 && v.margin >= 0.05; // 長さが合う曲で確かめて、9割以上が合っていた目安

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
  const all = {}, shifted = { subs: 0, voice: 0 }; let bad = 0;
  for (const s of songs) {
    if (s.retired) continue;
    let f = path.join(DIR, s.id + '.lrc'); if (!fs.existsSync(f)) f = path.join(DIR, s.id + '.txt');
    if (!fs.existsSync(f)) continue;
    const c = check[s.id];
    if (c?.verdict === 'mismatch') { bad++; continue; } // 動画の字幕と中身が違う＝別の曲の歌詞
    const lines = parse(fs.readFileSync(f, 'utf8')); if (lines.length < 6) continue;
    const yd = scan[s.id]?.dur, ad = apple[s.id]?.dur, lrc = f.endsWith('.lrc');
    // sync：歌詞の時刻が動画と合う（曲を流す問題に使える）。字幕で分かったずれ → 長さが同じ → 歌声で求めたずれ の順
    let off = 0, sync = false;
    if (lrc && c?.off != null) { off = c.off; sync = true; shifted.subs++; }
    else if (yd && ad && Math.abs(yd - ad) <= 2) sync = true;
    else if (lrc && VOICE_OK(voice[s.id])) { off = voice[s.id].off; sync = true; shifted.voice++; }
    if (off) for (const x of lines) if (x.t != null) x.t = Math.round((x.t + off) * 100) / 100;
    all[s.id] = { lines, sync };
  }
  const ids = Object.keys(all);
  console.log(`歌詞のある曲 ${ids.length} 曲（曲を流す問題に使える ${ids.filter(i => all[i].sync).length} 曲。字幕でずれを直した ${shifted.subs}・歌声でずれを直した ${shifted.voice}・別の曲の歌詞で外した ${bad}）を送ります`);
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
