// アニソン陣取り（アタック25風）の盤：5×5。board[i] はそのマスを持っている人の id（空きは null）。仕様は docs/panel-spec.md
const N = 5, CENTER = 12;
// 縦・横だけ（斜めでは、挟めない・隣にならない）
const DIRS = [[-1, 0], [0, -1], [0, 1], [1, 0]];
const at = (r, c) => (r >= 0 && r < N && c >= 0 && c < N ? r * N + c : -1);

// idx に me が置いたとき裏返るマス
function flipsOf(board, idx, me) {
  const r0 = Math.floor(idx / N), c0 = idx % N, out = [];
  for (const [dr, dc] of DIRS) {
    const line = [];
    let r = r0 + dr, c = c0 + dc, i;
    while ((i = at(r, c)) >= 0 && board[i] && board[i] !== me) { line.push(i); r += dr; c += dc; }
    if (line.length && i >= 0 && board[i] === me) out.push(...line);
  }
  return out;
}

// 選べるマス（本家どおり）：最初は真ん中だけ。そのあとは、取られているマスの隣の空きマス。
// そのうち挟んで裏返せるマスがあれば、そこからしか選べない
function allowedCells(board, me) {
  if (board.every(x => !x)) return [CENTER];
  const near = [];
  for (let i = 0; i < N * N; i++) {
    if (board[i]) continue;
    const r = Math.floor(i / N), c = i % N;
    if (DIRS.some(([dr, dc]) => { const j = at(r + dr, c + dc); return j >= 0 && board[j]; })) near.push(i);
  }
  const flipping = near.filter(i => flipsOf(board, i, me).length > 0);
  return flipping.length ? flipping : near;
}

// 置く：裏返したマスを返す（盤は書き換える）
function place(board, idx, me) {
  const f = flipsOf(board, idx, me);
  board[idx] = me;
  for (const i of f) board[i] = me;
  return f;
}

// 自動で選ぶ（時間切れ）：いちばん多く裏返せるマス
function autoPick(board, me) {
  const a = allowedCells(board, me);
  return a.reduce((b, i) => (flipsOf(board, i, me).length > flipsOf(board, b, me).length ? i : b), a[0]);
}

// アタックチャンス：ほかの人のパネルなら、どれでも1枚、自分のものにできる（挟んでいなくてよい）
const attackCells = (board, me) => board.map((x, i) => (x && x !== me ? i : -1)).filter(i => i >= 0);
const grab = (board, idx, me) => { board[idx] = me; };

module.exports = { N, CENTER, flipsOf, allowedCells, place, autoPick, attackCells, grab };
