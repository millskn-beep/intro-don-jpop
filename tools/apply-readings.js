// data/readings.json の読みがな・略称を曲データに取り込む（ひらがな・カタカナ・略称でも正解にするため）。
//   曲名 → aliases（手で足した別名もここ）／作品名 → workAliases／歌手名 → artistAliases
// 取り込むとき、ほかの曲・作品・歌手の名前や別名と同じになってしまう略称は外して報告する
// （「〇〇の曲なのに別の曲の名前を書いても正解」にならないように）。確認用に data/aliases.csv を書き出す。
// 使い方: node tools/apply-readings.js

const fs = require('fs');
const path = require('path');
const { normalize, shortForm } = require('../lib/normalize');

const ROOT = path.join(__dirname, '..');
const SONGS_PATH = path.join(ROOT, 'data', 'songs.json');
const { titles = {}, works = {}, artists = {} } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'readings.json'), 'utf8'));
const songs = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));

const stripPrefix = w => String(w).normalize('NFKC').replace(/^(劇場版|映画)\s*/, '');
// 作品名に一番長く一致するキーを使う（「ドラゴンボールZ」は「ドラゴンボール」より優先）
const workKeys = Object.keys(works).sort((a, b) => b.length - a.length);
const workKeyOf = song => workKeys.find(k => stripPrefix(song.work).startsWith(k.normalize('NFKC')));
const ok = a => [...normalize(a)].length >= 2;

// ── 名前そのもの（そろえた形）→ 持ち主。略称がほかの持ち主の名前と同じなら外す ──
const owner = { title: new Map(), work: new Map(), artist: new Map() };
const own = (kind, name, who) => { const n = normalize(name); if (n && !owner[kind].has(n)) owner[kind].set(n, who); };
for (const s of songs) {
  own('title', s.title, s.title); own('title', shortForm(s.title), s.title);
  own('work', s.work, workKeyOf(s) || s.work); own('work', shortForm(stripPrefix(s.work)), workKeyOf(s) || s.work);
  own('artist', s.artist, s.artist);
}
const dropped = [];
// 別名のうち、ほかの持ち主の名前と同じもの・同じ種類のほかの持ち主の別名と重なるものを外す
const aliasOwners = { title: new Map(), work: new Map(), artist: new Map() };
function claim(kind, list, who) {
  for (const a of list) {
    const n = normalize(a);
    if (!aliasOwners[kind].has(n)) aliasOwners[kind].set(n, new Set());
    aliasOwners[kind].get(n).add(who);
  }
}
for (const s of songs) {
  const workAl = works[workKeyOf(s)] || [];
  claim('title', [...(titles[s.title] || [])], s.title);
  claim('work', workAl, workKeyOf(s) || s.work);
  claim('artist', artists[s.artist] || [], s.artist);
}
function clean(kind, list, who, label) {
  const out = [], seen = new Set();
  for (const a of list) {
    const n = normalize(a);
    if (!ok(a) || seen.has(n)) continue;
    // 答えはいま流れている曲とだけ比べるので、ほかの曲・作品・歌手と読みが重なっても外さない（数だけ報告する）。
    // 同じシリーズ・同じ人（ドラえもん／STAND BY ME ドラえもん、荒井由実／松任谷由実）や、同じ読みの別の曲（Hibana／ヒバナ）は重なるのがふつう
    const other = owner[kind].get(n);
    if (other && other !== who && !dropped.includes(`${label}「${who}」の「${a}」（「${other}」と同じ読み）`)) dropped.push(`${label}「${who}」の「${a}」（「${other}」と同じ読み）`);
    seen.add(n); out.push(a);
  }
  return out;
}

let titleN = 0, workN = 0, artistN = 0;
for (const s of songs) {
  const workAl = clean('work', works[workKeyOf(s)] || [], workKeyOf(s) || s.work, '作品');
  const workSet = new Set((works[workKeyOf(s)] || []).map(normalize));
  // 前の形では作品名の読みも aliases に入っていたので、作品の分は workAliases へ移す（手で足した曲名の別名は残す）
  const manual = (s.aliases || []).filter(a => !workSet.has(normalize(a)) && !(titles[s.title] || []).some(t => normalize(t) === normalize(a)));
  s.aliases = [...manual, ...clean('title', titles[s.title] || [], s.title, '曲名')]
    .filter((a, i, arr) => arr.findIndex(b => normalize(b) === normalize(a)) === i);
  s.workAliases = workAl;
  s.artistAliases = clean('artist', artists[s.artist] || [], s.artist, '歌手');
  if (!s.workAliases.length) delete s.workAliases;
  if (!s.artistAliases.length) delete s.artistAliases;
  titleN += s.aliases.length; workN += (s.workAliases || []).length; artistN += (s.artistAliases || []).length;
}
fs.writeFileSync(SONGS_PATH, JSON.stringify(songs, null, 2) + '\n');

// 確認用CSV（Excelで開けるようにBOM付き）
const q = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
const rows = ['year,title,title_aliases,work,work_aliases,artist,artist_aliases', ...songs.map(s =>
  [s.year, s.title, (s.aliases || []).join(' / '), s.work, (s.workAliases || []).join(' / '), s.artist, (s.artistAliases || []).join(' / ')].map(q).join(','))];
fs.writeFileSync(path.join(ROOT, 'data', 'aliases.csv'), '﻿' + rows.join('\n') + '\n');

const noTitle = songs.filter(s => !titles[s.title]).length, noWork = songs.filter(s => !workKeyOf(s)).length, noArtist = songs.filter(s => !artists[s.artist]).length;
console.log(`別名：曲名 ${titleN}・作品名 ${workN}・歌手名 ${artistN}（読みの未登録：曲名 ${noTitle} 曲・作品名 ${noWork} 曲・歌手名 ${noArtist} 曲）`);
console.log(`ほかの曲・作品・歌手と同じ読みの別名 ${dropped.length} 件（外していない。確認用）`);
