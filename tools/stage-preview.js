// 追加プレビューの一覧（data/preview.json）のうち YouTube が見つかった曲を、「お試し（staged: true）」として data/songs.json に入れる。
// お試しの曲は、ふだんのお題・選択肢には出ず、お題「プレイリスト（お試し）」を選んだときだけ出る。
// ゲーム中の答え合わせで「これはゲームデータに入れる」が押された曲は、tools/pull-promotes.js で staged を外して本採用にする。
// あなたの再生回数（plays）は入れない（曲データは公開されるため）。
// 使い方: node tools/stage-preview.js [--dry-run]

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const P = n => path.join(ROOT, 'data', n);
const DRY = process.argv.includes('--dry-run');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };

const NG_TITLE = /ピアノ|サウンドトラック|オルゴール|instrumental|karaoke|カラオケ|off vocal|アレンジ\]|arrange/i;
const BAD = /MAD|AMV|歌ってみた|cover|カバー|弾いてみた|piano|ピアノ|カラオケ|karaoke|オルゴール|instrumental|nightcore|リミックス|remix|実機|実戦|reaction|ライブ|live|LIVE/;
const OFFICIAL = /- Topic$|公式|official|records|music|ミュージック|entertainment|sony|avex|lantis|victor|king|pony|bandai|nbc|kadokawa|toho|aniplex|warner|universal|columbia/i;
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}ー〜～]/gu, '');

const workOf = r => {
  const m = `${r.album} ${r.title}`.match(/『([^』]+)』/) || `${r.album}`.match(/「([^」]+)」(?:\s*(?:OP|ED|主題歌))/);
  if (m) return m[1].trim();
  if (/^anime$/i.test(r.genre) && r.album && !/- (Single|EP)$|\/|ベスト|サウンドトラック/i.test(r.album) && norm(r.album) !== norm(r.title)) return r.album.trim();
  return 'その他';
};
const typeOf = r => /オープニング|\bOP\b/.test(r.album) ? 'OP' : /エンディング|\bED\b/.test(r.album) ? 'ED' : /挿入歌|劇中歌/.test(r.album) ? '挿入歌' : /主題歌|テーマ/.test(r.album) ? '主題歌' : 'その他';

const songs = readJson(P('songs.json'), []);
const have = new Set(songs.map(s => s.id));
const preview = readJson(P('preview.json'), { rows: [] }).rows;
const state = readJson(P('preview-state.json'), {});
const out = [];
let noVideo = 0, skipped = 0;
for (const r of preview) {
  if (r.noise || state[r.key]) { skipped++; continue; }
  if (NG_TITLE.test(`${r.title} ${r.album}`)) { skipped++; continue; }
  const rank = v => (OFFICIAL.test(v.ch || '') ? 2 : 0) + (norm(v.title).includes(norm(r.title).slice(0, 5)) ? 2 : 0) + Math.log10(1 + (v.views || 0)) / 4;
  const vs = (r.yt || []).filter(v => !BAD.test(v.title) && !have.has(v.id) && (!v.dur || (v.dur >= 60 && v.dur <= 600))).sort((a, b) => rank(b) - rank(a));
  const v = vs[0];
  if (!v) { noVideo++; continue; }
  have.add(v.id);
  out.push({ id: v.id, title: r.title.replace(/\s*\(.*?(?:ピアノ|アレンジ).*?\)\s*$/, ''), work: workOf(r), artist: r.artist || (v.ch || '').replace(/ - Topic$/, ''),
    year: r.year || 2000, type: typeOf(r), confidence: '低', source: 'プレイリスト', intro: 0, chorus: 0, aliases: [], embeddable: null, staged: true, ...(r.year ? {} : { yearGuess: true }) });
}
console.log(`入れる ${out.length} 曲 / 動画なし ${noVideo} / 見送り（ノイズ・済み）${skipped}`);
console.log('作品名が取れた曲', out.filter(s => s.work !== 'その他').length);
if (DRY) { console.log(JSON.stringify(out.slice(0, 5), null, 1)); process.exit(0); }
songs.push(...out);
songs.sort((a, b) => (a.year - b.year) || a.title.localeCompare(b.title, 'ja'));
fs.writeFileSync(P('songs.json') + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(P('songs.json') + '.tmp', P('songs.json'));
const csv = P('catalog/additions-playlist.csv'), q = v => `"${String(v).replace(/"/g, '""')}"`;
fs.writeFileSync(csv, 'year,title,work,artist,type,confidence,videoId,source,note\n' + out.map(s => [s.year, q(s.title), q(s.work), q(s.artist), q(s.type), '低', s.id, 'プレイリスト', 'お試し'].join(',')).join('\n') + '\n');
console.log('songs.json と', path.basename(csv), 'に書きました');
