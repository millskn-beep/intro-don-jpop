// アニソン・ポーカー：トランプのカードで役を判定する。仕様は docs/poker-spec.md
// カード: { id, title, series（作品）, num（1=A〜13=K。同じゲームの中で「同じ数字＝同じ作品」）, suit（0=♠ 1=♥ 2=♦ 3=♣）, fame（0=超有名〜4=オタク）}
// 役は本物のポーカーと同じ。同じ役どうしは、数字が強い方が勝ち（A＞K＞Q＞…＞2。役に使った数字→残りの数字の順に比べる）。

const HANDS = [
  { rank: 10, name: 'ファイブカード', desc: '同じ数字（同じ作品）が5枚' },
  { rank: 9, name: 'ロイヤルストレートフラッシュ', desc: '10・J・Q・K・A が同じマーク' },
  { rank: 8, name: 'ストレートフラッシュ', desc: '数字が5枚連続で、同じマーク' },
  { rank: 7, name: 'フォーカード', desc: '同じ数字（同じ作品）が4枚' },
  { rank: 6, name: 'フルハウス', desc: '同じ数字が3枚＋同じ数字が2枚' },
  { rank: 5, name: 'フラッシュ', desc: '5枚とも同じマーク' },
  { rank: 4, name: 'ストレート', desc: '数字が5枚連続（A-2-3-4-5 〜 10-J-Q-K-A）' },
  { rank: 3, name: 'スリーカード', desc: '同じ数字（同じ作品）が3枚' },
  { rank: 2, name: 'ツーペア', desc: '同じ数字のペアが2組' },
  { rank: 1, name: 'ワンペア', desc: '同じ数字（同じ作品）が2枚' },
  { rank: 0, name: 'ハイカード', desc: '役なし（いちばん強い数字で比べる）' },
];
const NAME = Object.fromEntries(HANDS.map(h => [h.rank, h.name]));

const subsets = (arr, k) => {
  const out = [];
  (function rec(i, cur) {
    if (cur.length === k) return out.push(cur.slice());
    for (let j = i; j < arr.length; j++) { cur.push(arr[j]); rec(j + 1, cur); cur.pop(); }
  })(0, []);
  return out;
};

const val = c => c.num === 1 ? 14 : c.num; // A がいちばん強い
// 5枚以下の手札の役。戻り: { rank, name, score: [rank, 比べる数字…], used: 役に使ったカード }
function evaluate(cards) {
  const n = cards.length;
  const groups = new Map();
  for (const c of cards) { if (!groups.has(c.num)) groups.set(c.num, []); groups.get(c.num).push(c); }
  const gs = [...groups.values()].sort((a, b) => b.length - a.length || val(b[0]) - val(a[0]));
  const kick = gs.flatMap(g => g.map(val)); // 枚数の多い組→数字の強い順
  const sizes = gs.map(g => g.length);
  const nums = cards.map(c => c.num).sort((a, b) => a - b);
  const flush = n === 5 && cards.every(c => c.suit === cards[0].suit);
  const straight = n === 5 && new Set(nums).size === 5 && (nums[4] - nums[0] === 4 || nums.join() === '1,10,11,12,13');
  const wheel = nums.join() === '1,2,3,4,5'; // A-2-3-4-5 は 5 が一番上
  const res = (rank, used) => ({ rank, name: NAME[rank], score: [rank, ...((rank === 4 || rank === 8) && wheel ? [5] : kick)], used });
  if (sizes[0] === 5) return res(10, cards);
  if (straight && flush) return res(nums.join() === '1,10,11,12,13' ? 9 : 8, cards);
  if (sizes[0] === 4) return res(7, gs[0]);
  if (sizes[0] === 3 && sizes[1] === 2) return res(6, cards);
  if (flush) return res(5, cards);
  if (straight) return res(4, cards);
  if (sizes[0] === 3) return res(3, gs[0]);
  if (sizes[0] === 2 && sizes[1] === 2) return res(2, [...gs[0], ...gs[1]]);
  if (sizes[0] === 2) return res(1, gs[0]);
  return res(0, cards);
}
const compare = (a, b) => { for (let i = 0; i < Math.max(a.score.length, b.score.length); i++) { const x = a.score[i] ?? 0, y = b.score[i] ?? 0; if (x !== y) return x - y; } return 0; };

// 手札（6枚以上でもよい）から、いちばん強い5枚の組み合わせ
function bestFive(cards) {
  if (cards.length <= 5) return { cards: cards.slice(), eval: evaluate(cards) };
  let best = null;
  for (const s of subsets(cards, 5)) { const e = evaluate(s); if (!best || compare(e, best.eval) > 0) best = { cards: s, eval: e }; }
  return best;
}

module.exports = { HANDS, evaluate, compare, bestFive };
