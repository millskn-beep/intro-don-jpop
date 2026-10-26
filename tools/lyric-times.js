// 歌詞ファイル（anison-drive の data/lyrics-id/ID.lrc、Apple Music 版の時間）から、行が歌われる「時刻」だけを取り出して data/lyric-times.json に書く。
// 歌詞の文字はこのファイルに入れない（公開サイトに歌詞を載せないため）。
// 使うのは、YouTube 動画と Apple Music の曲の長さが同じ（±2秒）＝同じ音源の曲だけ（時刻がそのまま動画の時刻になる）。
// 出力：{ 曲ID: { t: [行の頭の秒…], r: [くり返す行（サビらしい行）なら 1、それ以外 0 …] } }
// 使い方: node tools/lyric-times.js [--drive D:/AI/anison-drive]

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DRIVE = arg('--drive', 'D:/AI/anison-drive');
const DIR = path.join(DRIVE, 'data', 'lyrics-id');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const songs = readJson(path.join(ROOT, 'data', 'songs.json'), []);
const scan = readJson(path.join(ROOT, 'data', 'scan-videos.json'), {});
const apple = readJson(path.join(DRIVE, 'data', 'apple-map.json'), {});

// [mm:ss.xx] の時刻と、その行の中身（くり返しの判定にだけ使い、ファイルには書かない）
function parse(txt) {
  const out = [];
  for (const l of txt.split(/\r?\n/)) {
    const tags = [...l.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const body = l.replace(/\[[^\]]*\]/g, '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
    if (!body || /作詞|作曲|編曲|作編曲|^\s*(歌|唄|歌唱|vocals?|vo\.?|lyrics?|music|composed?|arrange(d|ment)?|written|composition|lyricist|composer)\s*(by\b|[:：／\/])/i.test(l.replace(/\[[^\]]*\]/g, '').trim())) continue; // 作詞・作曲などのクレジットの行は外す
    for (const x of tags) out.push({ t: +x[1] * 60 + +x[2], key: body });
  }
  return out.sort((a, b) => a.t - b.t);
}

const out = {};
let files = 0, sameLen = 0;
for (const s of songs) {
  const f = path.join(DIR, s.id + '.lrc');
  if (!fs.existsSync(f)) continue;
  files++;
  const yd = scan[s.id]?.dur, ad = apple[s.id]?.dur;
  if (!(yd > 0 && ad > 0) || Math.abs(yd - ad) > 2) continue; // 同じ音源の曲だけ
  const L = parse(fs.readFileSync(f, 'utf8')).filter(x => x.t > 0 && x.t < yd - 3);
  if (L.length < 6) continue;
  sameLen++;
  const cnt = new Map(); for (const x of L) cnt.set(x.key, (cnt.get(x.key) || 0) + 1);
  out[s.id] = { t: L.map(x => Math.round(x.t * 10) / 10), r: L.map(x => (cnt.get(x.key) >= 2 && x.key.length >= 4 ? 1 : 0)) };
}
fs.writeFileSync(path.join(ROOT, 'data', 'lyric-times.json'), JSON.stringify(out) + '\n');
console.log(`歌詞ファイル ${files} 曲 → 動画と同じ音源で使える曲 ${sameLen} 曲を data/lyric-times.json に書きました`);
