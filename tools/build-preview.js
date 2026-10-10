// 追加プレビュー画面（public/preview.html）の元データ data/preview.json を作る。
// iTunes / Apple Music の書き出し（UTF-16 のタブ区切り txt）を読み、カタログ（data/songs.json）にない曲を YouTube で検索して取っておく。
// 検索結果は data/preview-yt.json に溜めるので、途中で止めても続きから再開できる。
//
// 使い方: node tools/build-preview.js <書き出し.txt> [<書き出し2.txt> ...] [--no-search]
//   YouTube の検索には yt-dlp（.venv-embed）を使う。
// 注意: data/preview*.json にはあなたの再生回数が入るので、git には入れない（.gitignore 済み）。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const P = n => path.join(ROOT, 'data', n);
const args = process.argv.slice(2);
const noSearch = args.includes('--no-search');
const seedIdx = args.indexOf('--seed');
const seedFile = seedIdx >= 0 ? args[seedIdx + 1] : null;
const files = args.filter(a => !a.startsWith('--') && a !== seedFile);
const PY = path.join(ROOT, '.venv-embed', 'Scripts', 'python.exe');

const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}ー〜～]/gu, '').replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const writeJson = (p, v) => { fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 1) + '\n'); fs.renameSync(p + '.tmp', p); };

function readTsv(file) {
  const b = fs.readFileSync(file);
  const text = new TextDecoder(b[0] === 0xff ? 'utf-16le' : 'utf-8').decode(b).replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split('\t'), idx = n => head.indexOf(n);
  return lines.slice(1).map(l => {
    const c = l.split('\t'), g = n => (c[idx(n)] || '').trim();
    return { title: g('名前'), artist: g('アーティスト'), album: g('アルバム'), work: g('作品'), genre: g('ジャンル'), sec: +g('時間') || 0, year: +g('年') || 0, plays: +g('再生回数') || 0 };
  }).filter(r => r.title);
}

// 1. 読み込み（ファイルをまたいだ同じ曲はまとめる）
const merged = new Map();
for (const f of files) {
  const name = path.basename(f).replace(/\.txt$/, '');
  for (const r of readTsv(f)) {
    const k = norm(r.title) + '|' + norm(r.artist || r.album).slice(0, 6);
    const cur = merged.get(k);
    if (cur) { cur.plays += r.plays; cur.src = [...new Set([...cur.src, name])]; cur.year ||= r.year; cur.work ||= r.work; continue; }
    merged.set(k, { ...r, src: [name] });
  }
}

// 2. カタログにある曲を除く（曲名が同じでも歌手がちがえば「入っていない」側）
const songs = readJson(P('songs.json'), []);
const byTitle = new Map();
for (const s of songs) for (const t of [s.title, ...(s.aliases || [])]) { const k = norm(t); if (k) (byTitle.get(k) || byTitle.set(k, []).get(k)).push(s); }
const rows = [];
for (const r of merged.values()) {
  const m = byTitle.get(norm(r.title));
  const same = m && r.artist && m.some(s => norm(s.artist).includes(norm(r.artist).slice(0, 4)) || norm(r.artist).includes(norm(s.artist).slice(0, 4)));
  if (m && (same || !r.artist)) continue;
  const noise = r.sec && r.sec < 60 ? 'CMなど短い曲' : /remix|リミックス|instrumental|karaoke|カラオケ|off vocal|director'?s/i.test(r.title) ? 'リミックス・別バージョン' : /babypod|ベスト|best|コンピ|hits/i.test(r.album) && !r.artist ? 'コンピレーション' : '';
  rows.push({ key: norm(r.title) + '|' + norm(r.artist || r.album).slice(0, 8), title: r.title, artist: r.artist || '', album: r.album, work: r.work, year: r.year, sec: r.sec, plays: r.plays,
    src: r.src, noise, similar: m ? m.slice(0, 2).map(s => `${s.title}／${s.artist}（${s.work}）`) : [] });
}
console.log(`書き出し ${merged.size} 曲 → カタログにない ${rows.length} 曲（ノイズ扱い ${rows.filter(r => r.noise).length}）`);

// 3. YouTube を検索（再開できる）。以前の途中結果（drive-yt.json 形式）があれば --seed で取り込む
const cache = readJson(P('preview-yt.json'), {});
if (seedFile) for (const s of Object.values(readJson(seedFile, {}))) if (s.results) cache[norm(s.title) + '|' + norm(s.artist).slice(0, 8)] ||= s.results;
const search = (q, n = 5) => execFileSync(PY, ['-m', 'yt_dlp', '--compat-options', 'no-certifi', '--js-runtimes', 'node', '--flat-playlist', '--no-warnings', '-q',
  '--print', '%(id)s|%(channel)s|%(view_count)s|%(title)s|%(duration)s', `ytsearch${n}:${q}`], { encoding: 'utf8', timeout: 60000 })
  .trim().split('\n').filter(Boolean).map(l => { const [id, ch, v, ...t] = l.split('|'); const dur = Number(t.pop()) || 0; return { id, ch, views: Number(v) || 0, title: t.join('|'), dur }; });
exports.search = search;
if (!noSearch) {
  let n = 0;
  for (const r of rows) {
    if (cache[r.key]) continue;
    try { cache[r.key] = search(`${r.title} ${(r.artist || r.album).split(/[・、(（]/)[0]}`); } catch (e) { continue; }
    if (++n % 5 === 0) writeJson(P('preview-yt.json'), cache);
    console.log(n, r.title);
  }
  writeJson(P('preview-yt.json'), cache);
}
for (const r of rows) r.yt = cache[r.key] || null;
writeJson(P('preview.json'), { builtAt: new Date().toISOString(), rows });
console.log('data/preview.json を書きました');
