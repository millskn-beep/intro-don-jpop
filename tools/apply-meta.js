// AIが調べたメタ情報（読み・ジャンル・歌手の声・シリーズ）を data/ に足す。既存の値は消さない（足すだけ）。
// 使い方: node tools/apply-meta.js <フォルダ> [--dry-run]
//   フォルダの中身: t-out-*.json（曲名の読み）、wa-out-*.json（作品・歌手の読み）、g-out-*.json（作品のジャンル）、
//                   gender-out.json（歌手の声）、fr-out.json（シリーズ）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const D = args => path.join(ROOT, 'data', args);
const dir = process.argv[2];
const DRY = process.argv.includes('--dry-run');
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const files = re => fs.readdirSync(dir).filter(f => re.test(f)).sort().map(f => readJson(path.join(dir, f)));
const out = (p, v, indent) => { if (!DRY) fs.writeFileSync(p, JSON.stringify(v, null, indent) + '\n'); };
const uniq = a => [...new Set(a.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))];

// 読み
const rd = readJson(D('readings.json'));
let nt = 0, nw = 0, na = 0;
const mergeList = (obj, k, list) => { const before = obj[k] || []; const after = uniq([...before, ...list]); if (after.length > before.length || !(k in obj)) { obj[k] = after; return true; } return false; };
for (const t of files(/^t-out-\d+\.json$/)) for (const [k, v] of Object.entries(t)) if (mergeList(rd.titles, k, v)) nt++;
for (const wa of files(/^wa-out-\d+\.json$/)) {
  for (const [k, v] of Object.entries(wa.works || {})) if ([...k.normalize('NFKC')].length >= 3 && mergeList(rd.works, k, v)) nw++; // 先頭一致で使うので、1〜2文字の作品名（C・Fなど）は入れない
  for (const [k, v] of Object.entries(wa.artists || {})) if (mergeList(rd.artists, k, v)) na++;
}
out(D('readings.json'), rd, 1);

// ジャンル（pachislot・lol・vocaloid・jpop は付けない）
const KEYS = new Set(['jump', 'game', 'galge', 'ghibli', 'theater', 'movie', 'sports', 'isekai', 'romcom', 'nichijou', 'idol', 'robot', 'sf', 'kids']);
const wg = readJson(D('work-genres.json'));
let ng = 0;
for (const g of files(/^g-out-\d+\.json$/)) for (const [k, v] of Object.entries(g)) if (!(k in wg)) { wg[k] = v.filter(x => KEYS.has(x)); ng++; }
out(D('work-genres.json'), wg, 1);

// 歌手の声
const ag = readJson(D('artist-gender.json'));
let nga = 0;
const unsure = [];
const g = fs.existsSync(path.join(dir, 'gender-out.json')) ? readJson(path.join(dir, 'gender-out.json')) : {};
for (const [k, v] of Object.entries(g)) {
  if (k in ag || !/^(f|m|mix)$/.test(v[0])) continue;
  ag[k] = [v[0], v[1] === 'sure' ? 'sure' : 'unsure']; nga++;
  if (ag[k][1] === 'unsure') unsure.push([k, { f: '女性', m: '男性', mix: '男女' }[v[0]]]);
}
out(D('artist-gender.json'), ag, 1);
if (!DRY && unsure.length) {
  const p = D('artist-gender-unsure.csv');
  fs.appendFileSync(p, unsure.map(([a, v]) => `"${a.replace(/"/g, '""')}",${v}`).join('\n') + '\n');
}

// シリーズ（franchises.json は書式を保つため、読み込んで同じ書式（2スペース）で書き直す）
const FR = D('franchises.json');
const fr = readJson(FR);
let nf = 0, nfw = 0;
if (fs.existsSync(path.join(dir, 'fr-out.json'))) {
  const f = readJson(path.join(dir, 'fr-out.json'));
  const nameOf = new Map(Object.keys(fr).map(k => [k.normalize('NFKC'), k]));
  for (const [w, name] of Object.entries(f.assign || {})) {
    const k = nameOf.get(name.normalize('NFKC'));
    if (k && !fr[k].works.includes(w)) { fr[k].works.push(w); nfw++; }
  }
  for (const [name, v] of Object.entries(f.newFranchises || {})) {
    if (nameOf.has(name.normalize('NFKC'))) { const k = nameOf.get(name.normalize('NFKC')); for (const w of v.works) if (!fr[k].works.includes(w)) { fr[k].works.push(w); nfw++; } continue; }
    fr[name] = { aliases: uniq(v.aliases), works: uniq(v.works) }; nf++;
  }
}
out(FR, fr, 2);
console.log(JSON.stringify({ titles: nt, works: nw, artists: na, workGenres: ng, genders: nga, unsure: unsure.length, newFranchises: nf, franchiseWorks: nfw }));
