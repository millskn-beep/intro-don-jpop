// サビの位置が怪しい曲を、直す順に一覧にする（docs/chorus-review.md）。
// 目安（data/scan-videos.json・data/scan-flags.json は tools/scan_videos.py が作る）：
//   ・音から推定したサビ（est）と、いまのサビの位置が 20 秒以上ちがう
//   ・サビの位置が静か（chorusRank が低い＝曲の中で音が小さい所）
//   ・サビの位置が曲の長さを超える／イントロより前
// 直す順：知名度の高い曲（よく出る曲）→ ずれの大きい曲。手で直した曲（chorusChecked）は除く。
// 使い方: node tools/chorus-review.js
const fs = require('fs');
const path = require('path');
const D = path.join(__dirname, '..', 'data');
const songs = JSON.parse(fs.readFileSync(path.join(D, 'songs.json'), 'utf8'));
const scan = JSON.parse(fs.readFileSync(path.join(D, 'scan-videos.json'), 'utf8'));
const flags = JSON.parse(fs.readFileSync(path.join(D, 'scan-flags.json'), 'utf8'));
const FAME = { top: 0, famous: 1, normal: 2, minor: 3, otaku: 4 };
const mmss = t => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
const rows = [];
for (const s of songs) {
  if (s.retired || s.chorusChecked) continue;
  const v = scan[s.id]; if (!v) continue;
  const why = [];
  const gap = v.est != null && s.chorus > 0 ? Math.abs(v.est - s.chorus) : 0;
  if (gap >= 20) why.push(`音から推定したサビ ${mmss(v.est)} と ${Math.round(gap)} 秒ちがう`);
  if (v.chorusRank != null && v.chorusRank < 0.3) why.push(`サビの位置が静か（${Math.round(v.chorusRank * 100)}%）`);
  if (v.dur && s.chorus >= v.dur - 5) why.push('サビの位置が曲の終わりより後ろ');
  if (s.chorus > 0 && s.chorus <= (s.intro || 0)) why.push('サビの位置がイントロより前');
  if (!s.chorus) why.push('サビの位置が決まっていない');
  for (const f of flags[s.id] || []) if (!why.some(w => w.slice(0, 6) === f.slice(0, 6))) why.push(f);
  if (!why.length) continue;
  rows.push({ s, why, gap, fame: FAME[s.fame] ?? 2 });
}
rows.sort((a, b) => a.fame - b.fame || b.gap - a.gap);
const famJ = { top: '超有名', famous: '有名', normal: '普通', minor: 'マイナー', otaku: 'オタク' };
const md = [
  '# サビの見直し一覧', '',
  `サビの位置が怪しい曲 ${rows.length} 曲（全 ${songs.length} 曲）。知名度の高い曲（よく出る曲）から順に並べています。`,
  '収録曲一覧（/songs.html）で曲を開いて、サビの位置を聴いて直してください。直した曲はこの一覧から消えます（作り直すと）。', '',
  '| # | 曲 | 歌手 | 知名度 | いまのサビ | 気になるところ |', '|---|---|---|---|---|---|',
  ...rows.map((r, i) => `| ${i + 1} | ${r.s.title} | ${r.s.artist} | ${famJ[r.s.fame] || '普通'} | ${r.s.chorus ? mmss(r.s.chorus) : '—'} | ${r.why.join('・')} |`),
  '',
];
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'chorus-review.md'), md.join('\n'));
console.log(`サビが怪しい曲 ${rows.length} 曲 → docs/chorus-review.md`);
