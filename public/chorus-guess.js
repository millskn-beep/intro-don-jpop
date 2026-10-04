// サビの位置が分からない曲は、動画の長さから推定する。
// TVサイズ（約90秒）なら真ん中あたり、フルサイズなら最初のサビが来やすい 1/4 あたり（最大90秒）
export function guessChorus(intro, duration) {
  intro = intro || 0;
  if (!(duration > 0)) return intro + 50;
  if (duration <= 110) return Math.round(Math.max(intro + 20, duration * 0.5));
  return Math.round(Math.max(intro + 30, Math.min(duration * 0.27, 90)));
}
