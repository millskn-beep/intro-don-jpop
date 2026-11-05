// J-POP 版：全曲に知名度（超有名・有名・普通・マイナー・オタク）を割り振る。
// 公式MVの再生回数はアニソンより桁が多いので、決まった回数ではなく、J-POP の曲の中での順位（割合）で分ける。
//   上位 15% 超有名／次の 25% 有名／次の 30% 普通／次の 20% マイナー／残り 10% オタク（とても古い・動画が少ない曲）
// 動画の種類（公式MV・Topic の音源）ごとに比べる（Topic は少なく出るため）。
// 曲集めのときの見立て（fameHint：1 だれでも知っている／2 広く知られている）があれば、それより下にはしない。
// 手で変えた曲（fameManual: true）は触らない。
//
// 使い方: node tools/assign-fame.js [--dry-run]

const fs = require('fs');
const path = require('path');

const SONGS_PATH = path.join(__dirname, '..', 'data', 'songs.json');
const DRY = process.argv.includes('--dry-run');
const songs = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));

const LEVELS = ['top', 'famous', 'normal', 'minor', 'otaku'];
const CUTS = [0.85, 0.60, 0.30, 0.10]; // 順位（0〜1、1がいちばん多い）がこれ以上なら、その段階
const classOf = s => (/- Topic$/i.test(s.channel || '') || s.source === 'Topic' ? 'topic' : 'video');

const groups = new Map();
for (const s of songs) if (!s.retired && s.views > 0) { const k = classOf(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
const pct = new Map();
for (const g of groups.values()) {
  g.sort((a, b) => a.views - b.views);
  g.forEach((s, i) => pct.set(s.id, g.length > 1 ? i / (g.length - 1) : 0.5));
}

let changed = 0;
const count = Object.fromEntries(LEVELS.map(l => [l, 0]));
for (const s of songs) {
  if (s.retired) continue;
  if (!s.fameManual) {
    const p = pct.get(s.id);
    let i = p == null ? 2 : CUTS.findIndex(c => p >= c); if (i < 0) i = 4;
    if (s.fameHint === 1) i = Math.min(i, 1); else if (s.fameHint === 2) i = Math.min(i, 2);
    if (s.fame !== LEVELS[i]) { s.fame = LEVELS[i]; changed++; }
  }
  count[s.fame || 'normal']++;
}
console.log(LEVELS.map(l => `${l} ${count[l]}`).join(' / '), `（変更 ${changed} 曲）`);
if (!DRY) fs.writeFileSync(SONGS_PATH, JSON.stringify(songs, null, 2) + '\n');
