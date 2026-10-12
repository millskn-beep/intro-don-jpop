// アニソン年表（ヒットスター風）：年表（年の古い順）の slot 番目（0＝いちばん前、length＝いちばん後ろ）に置いたとき、合っているか。
// 同じ年どうしはどちらに置いても正解。仕様は docs/nenpyo-spec.md
function fits(years, slot, year) {
  if (!Number.isInteger(slot) || slot < 0 || slot > years.length) return false;
  return (slot === 0 || years[slot - 1] <= year) && (slot === years.length || year <= years[slot]);
}
// 年表に入れる（年の古い順を保つ）
function insert(timeline, card) {
  const i = timeline.findIndex(c => c.year > card.year);
  if (i < 0) timeline.push(card); else timeline.splice(i, 0, card);
  return timeline;
}
module.exports = { fits, insert };
