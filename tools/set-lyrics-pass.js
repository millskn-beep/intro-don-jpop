// 歌詞クイズの「歌詞の合言葉」を決める。合言葉そのものは .lyrics-pass（git に入れない）に、SHA-256 だけを data/lyrics-pass.sha256 に書く。
// 本番に効かせるには、このあと「反映して」で出す（data/lyrics-pass.sha256 が本番に届く）。
// 使い方: node tools/set-lyrics-pass.js <合言葉>   （省略すると、ランダムな合言葉を作る）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const pass = (process.argv[2] || 'kashi-' + crypto.randomBytes(3).toString('hex')).trim();
if (pass.length < 6) { console.log('合言葉は6文字以上にしてください'); process.exit(1); }
fs.writeFileSync(path.join(ROOT, '.lyrics-pass'), pass + '\n');
fs.writeFileSync(path.join(ROOT, 'data', 'lyrics-pass.sha256'), crypto.createHash('sha256').update(pass).digest('hex') + '\n');
console.log(`歌詞の合言葉を「${pass}」にしました（.lyrics-pass に控え。本番には反映のあとから効きます）`);
