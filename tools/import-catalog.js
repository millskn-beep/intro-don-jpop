// data/catalog/*.csv の候補を data/songs.json に取り込む。
// 動画IDのある行だけ追加する。すでにある曲は、秒数・再生チェックの結果・別名を残したまま曲情報だけ更新する。
// 使い方: node tools/import-catalog.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SONGS_PATH = path.join(ROOT, 'data', 'songs.json');
const CATALOG_DIR = path.join(ROOT, 'data', 'catalog');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

const songs = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
const byId = new Map(songs.map(s => [s.id, s]));
let added = 0, updated = 0, skipped = 0;

for (const file of fs.readdirSync(CATALOG_DIR).filter(f => f.endsWith('.csv')).sort()) {
  for (const r of parseCsv(fs.readFileSync(path.join(CATALOG_DIR, file), 'utf8').replace(/^﻿/, ''))) {
    if (!r.videoId) { skipped++; continue; }
    const info = {
      title: r.title, work: r.work, artist: r.artist, year: parseInt(r.year, 10), type: r.type,
      confidence: r.confidence || undefined, source: r.source || undefined,
    };
    const cur = byId.get(r.videoId);
    if (cur) { Object.assign(cur, info); updated++; continue; }
    const song = { id: r.videoId, ...info, intro: 0, chorus: 0, aliases: [], embeddable: null };
    songs.push(song); byId.set(song.id, song); added++;
  }
}

songs.sort((a, b) => (a.year - b.year) || a.title.localeCompare(b.title, 'ja'));
fs.writeFileSync(SONGS_PATH, JSON.stringify(songs, null, 2) + '\n');
console.log(`追加 ${added} 曲 / 更新 ${updated} 曲 / 動画なしで見送り ${skipped} 曲 → 合計 ${songs.length} 曲`);
