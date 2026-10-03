// data/readings.json の読みがな・略称を data/songs.json の aliases に取り込む。
// 取り込んだあと、1つの答えが「別の作品」の曲でも正解になってしまう組み合わせを報告し、
// 確認用に data/aliases.csv を書き出す。
// 使い方: node tools/apply-readings.js

const fs = require('fs');
const path = require('path');
const { normalize, acceptedAnswers } = require('../lib/normalize');

const ROOT = path.join(__dirname, '..');
const SONGS_PATH = path.join(ROOT, 'data', 'songs.json');
const { titles, works } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'readings.json'), 'utf8'));
const songs = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));

const stripPrefix = w => String(w).normalize('NFKC').replace(/^(劇場版|映画)\s*/, '');
// 作品名に一番長く一致するキーを使う（「ドラゴンボールZ」は「ドラゴンボール」より優先）
const workKeys = Object.keys(works).sort((a, b) => b.length - a.length);
const workKeyOf = song => workKeys.find(k => stripPrefix(song.work).startsWith(k.normalize('NFKC')));

let added = 0, noTitle = 0;
for (const s of songs) {
  const before = new Set((s.aliases || []).map(normalize));
  const extra = [...(titles[s.title] || []), ...(works[workKeyOf(s)] || [])];
  if (!titles[s.title]) noTitle++;
  const list = [...(s.aliases || [])];
  for (const a of extra) {
    const n = normalize(a);
    if ([...n].length < 2 || before.has(n)) continue;
    before.add(n); list.push(a); added++;
  }
  s.aliases = list;
}
fs.writeFileSync(SONGS_PATH, JSON.stringify(songs, null, 2) + '\n');

// 衝突チェック：同じ答えで、作品のちがう曲が両方正解になるもの
const playable = songs.filter(s => s.embeddable !== false);
const owners = new Map();
for (const s of playable) {
  for (const a of acceptedAnswers(s)) {
    if (!owners.has(a)) owners.set(a, new Set());
    owners.get(a).add(workKeyOf(s) || s.work);
  }
}
const collisions = [...owners].filter(([, w]) => w.size > 1).map(([a, w]) => `${a} → ${[...w].join(' / ')}`);

// 確認用CSV（Excelで開けるようにBOM付き）
const q = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
const rows = ['year,title,work,aliases', ...playable.map(s => [s.year, s.title, s.work, (s.aliases || []).join(' / ')].map(q).join(','))];
fs.writeFileSync(path.join(ROOT, 'data', 'aliases.csv'), '﻿' + rows.join('\n') + '\n');

const noWork = playable.filter(s => !workKeyOf(s)).map(s => s.work);
console.log(`別名を ${added} 件追加（曲名の読み未登録 ${noTitle} 曲）`);
console.log(`作品名の読み未登録: ${noWork.length ? [...new Set(noWork)].join(' / ') : 'なし'}`);
console.log(`別作品と重なる答え: ${collisions.length ? '\n  ' + collisions.join('\n  ') : 'なし'}`);
