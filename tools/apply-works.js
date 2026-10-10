// 調べた作品名（TSV: id, kind, work, type, year, confidence）を data/songs.json に入れる。
// - アニメ・ゲーム・特撮・ドラマ：作品名を入れる（収録済みの作品名と表記がゆれていたら、収録済みの表記にそろえる）
// - jpop：「J-POP（歌手名）」、ボカロ：「ボカロ（作者名）」（kind が vocaloid のとき）
// - unknown：そのまま（作品「その他」）
// 使い方: node tools/apply-works.js <tsv> [<tsv> ...] [--dry-run]
const fs = require('fs');
const path = require('path');
const SONGS_PATH = path.join(__dirname, '..', 'data', 'songs.json');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run'), FORCE = args.includes('--force');
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}ー〜～]/gu, '');
const songs = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
const existing = new Map();
for (const s of songs) if (s.work && s.work !== 'その他' && !/^(J-POP|ボカロ)（/.test(s.work)) { const k = norm(s.work); if (!existing.has(k)) existing.set(k, s.work); }
const byId = new Map(songs.map(s => [s.id, s]));
const stat = { anime: 0, jpop: 0, vocaloid: 0, unknown: 0, miss: 0, canon: 0 };
for (const f of args.filter(a => !a.startsWith('--'))) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const [id, kind, work, type, year] = line.split('\t');
    const s = byId.get(id);
    if (!s) { stat.miss++; continue; }
    if (!FORCE && s.work !== 'その他' && !s.yearGuess) continue; // 手で決めた曲は触らない（--force は、調べ直した結果で作品名を置き換える）
    if (/^(anime|game|tokusatsu|drama)$/.test(kind) && work) {
      const canon = existing.get(norm(work));
      if (canon && canon !== work) stat.canon++;
      s.work = canon || work; s.type = type && type !== 'その他' ? type : s.type || 'その他'; stat.anime++;
    } else if (kind === 'jpop') { s.work = `J-POP（${s.artist.split(/[・、/&＆]/)[0].trim()}）`; s.type = ''; stat.jpop++; }
    else if (kind === 'vocaloid') { s.work = `ボカロ（${s.artist.split(/[・、/&＆]/)[0].trim()}）`; s.type = 'ボカロ'; stat.vocaloid++; }
    else { stat.unknown++; continue; }
    if (+year && s.yearGuess) { s.year = +year; delete s.yearGuess; }
  }
}
console.log(JSON.stringify(stat));
if (!DRY) { fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH); }
