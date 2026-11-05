// tools/yt-find.js の結果を曲データ（data/songs.json）に足す。作品（work）＝歌手名。
// 足すのは：動画が見つかった曲。同じ動画・同じ曲（曲名と歌手が同じ）がもうあれば足さない。
// 非公式の動画（fan）は再生回数100万回以上のものだけ（yt-find.js がそうしている）。ライブ映像は足さない。
// 足した曲の ID は data/ids-new.txt に書く（測るツールに渡す）。
// 使い方: node tools/add-found.js <結果.json> [<結果.json> ...]
const fs = require('fs');
const path = require('path');
const SONGS = path.join(__dirname, '..', 'data', 'songs.json');
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s!！・〜~～()（）\-♪【】.。,、\/'"「」『』?？&＆*＊☆★♡:：…･]/g, '');
const songs = JSON.parse(fs.readFileSync(SONGS, 'utf8'));
const ids = new Set(songs.map(s => s.id)), keys = new Set(songs.map(s => norm(s.title) + '|' + norm(s.artist)));
// アニメ・声優に縁のある歌手（data/work-genres.json の anime）の曲は入れない（ほぼアニソンになるため。ユーザーの希望 2026-11-05）
const WG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'work-genres.json'), 'utf8'));
const animeArtist = a => (WG[a] || []).includes('anime');
const SRC = { official: '公式MV', topic: '公式音源（Topic）', label: 'レーベル公式', fan: '非公式（再生回数の多い動画）' };
const added = [], skipped = { none: 0, dup: 0, live: 0 };
for (const f of process.argv.slice(2)) {
  for (const r of Object.values(JSON.parse(fs.readFileSync(f, 'utf8')))) {
    const h = r.hit;
    if (!h) { skipped.none++; continue; }
    if (h.live) { skipped.live++; continue; }
    if (animeArtist(r.artist)) { skipped.anime = (skipped.anime || 0) + 1; continue; }
    const k = norm(r.title) + '|' + norm(r.artist);
    if (ids.has(h.id) || keys.has(k)) { skipped.dup++; continue; }
    ids.add(h.id); keys.add(k);
    const s = { id: h.id, title: r.title, work: r.artist, artist: r.artist, year: r.year, type: '', confidence: h.kind === 'fan' ? '低' : '高',
                source: SRC[h.kind], intro: 0, chorus: 0, aliases: [], embeddable: null, channel: h.owner, fameHint: r.fame };
    songs.push(s); added.push(s.id);
  }
}
fs.writeFileSync(SONGS, JSON.stringify(songs, null, 2) + '\n');
fs.writeFileSync(path.join(__dirname, '..', 'data', 'ids-new.txt'), added.join(' '));
console.log(`足した ${added.length} 曲（全 ${songs.length} 曲）。見つからない ${skipped.none}・重なり ${skipped.dup}・ライブ ${skipped.live}・アニメ寄りの歌手 ${skipped.anime || 0}`);
