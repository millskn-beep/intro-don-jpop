// アニソン指パチンコ：浮かんでいる的（選択肢）を、パチンコで撃ち抜いて答える。仕様は docs/sling-spec.md
// 当たり判定はこの画面で行い、サーバーには「どの的に当てたか（会心か）」だけを送る。点数と弾の数はサーバーが決める
// 的の位置は全員同じ（問題ごとの seed と、サーバーの時計で流し始めてからの秒数で決まる）なので、ほかの人の弾の軌跡も同じ画面に重ねられる

const G = 1.15;          // 重力（画面の高さ／秒²）
const VMAX = 2.25;       // 引ききったときの弾の速さ（画面の高さ／秒）
const ASSIST = 1.7;      // 狙いの補助：的のまわりのこの倍率の範囲に入った弾を、少し的へ寄せる
const ASSIST_PULL = 2.4; // 寄せる強さ（画面の高さ／秒²）
const CRIT = 0.32;       // 的の中心からこの割合の内側に当たったら会心
const COLORS = ['#4fc3f7', '#ff8a65', '#aed581', '#ffd54f', '#ce93d8', '#f48fb1', '#80cbc4', '#e0e0e0', '#ff5252', '#7c9cff'];

let ctx = null, cv = null, g2 = null, W = 0, H = 0, dpr = 1;
let q = null, t0 = 0, hintAt = 99, live = false, raf = 0;
let targets = [], shots = [], trails = [], bits = [], drag = null, ammo = 3, done = false, cracked = new Set(), banner = null;
const colorOf = id => COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

// 問題ごとに同じ乱数（seed から）
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function layout() {
  const n = q.choices.length, r = rng(q.slSeed || 1), cols = n <= 4 ? 2 : n <= 6 ? 3 : 4, rows = Math.ceil(n / cols);
  const order = q.choices.map((_, i) => i).sort(() => r() - .5); // 並びは問題ごとに入れ替える（選択肢の順番どおりにしない）
  targets = order.map((ci, k) => {
    const c = k % cols, row = Math.floor(k / cols);
    return { i: ci, title: q.choices[ci].title, bx: (c + .5) / cols, by: .16 + (row + .5) * (.5 / rows), ph: r() * 6.28, ph2: r() * 6.28, w: .6 + r() * .5, w2: .5 + r() * .5 };
  });
}
// 的の今の位置（全員同じ時刻なら同じ位置）。サビに入ると速くなる
function place(tg, sec) {
  const amp = { still: 0, slow: 1, fast: 1.8 }[q.slMove] ?? 1;
  const tt = sec < hintAt ? sec : hintAt + (sec - hintAt) * 1.6;
  const cols = q.choices.length <= 4 ? 2 : q.choices.length <= 6 ? 3 : 4;
  const { rx } = size(), x = (tg.bx + Math.sin(tt * tg.w * amp + tg.ph) * (.32 / cols) * Math.min(1, amp)) * W;
  return { x: Math.max(rx + 4, Math.min(W - rx - 4, x)), y: (tg.by + Math.cos(tt * tg.w2 * amp + tg.ph2) * .04 * Math.min(1, amp)) * H };
}
function size() {
  const cols = q.choices.length <= 4 ? 2 : q.choices.length <= 6 ? 3 : 4;
  const rx = Math.min(W / cols * .42, 120), ry = Math.max(rx * .42, 22);
  return { rx, ry };
}
const now = () => (ctx.serverNow() - t0) / 1000;
const anchor = () => ({ x: W / 2, y: H - Math.max(70, H * .13) });
const maxPull = () => Math.min(W, H) * .24;

function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// 弾を進める（自分の弾は的に寄せる・当たり判定。ほかの人の弾は軌跡だけ）
function step(b, dt, mine, sec) {
  const { rx, ry } = size();
  if (mine && !b.hit) {
    let best = null, bd = 1e9;
    for (const tg of targets) {
      if (cracked.has(tg.i)) continue;
      const p = place(tg, sec), dx = (b.x - p.x) / rx, dy = (b.y - p.y) / ry, d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = { tg, p, d }; }
    }
    if (best && best.d <= 1) { b.hit = best; return; }
    if (best && best.d < ASSIST) { // 狙いの補助
      const ax = best.p.x - b.x, ay = best.p.y - b.y, l = Math.hypot(ax, ay) || 1;
      b.vx += ax / l * ASSIST_PULL * H * dt; b.vy += ay / l * ASSIST_PULL * H * dt;
    }
  }
  b.vy += G * H * dt; b.x += b.vx * dt; b.y += b.vy * dt;
  b.path.push([b.x, b.y]); if (b.path.length > 14) b.path.shift();
  if (b.y < -40 || b.x < -40 || b.x > W + 40 || b.y > H + 40) b.gone = true;
}

function shoot(vx, vy) {
  if (done || ammo <= 0) return;
  const a = anchor();
  shots.push({ x: a.x, y: a.y, vx, vy, path: [] });
  if (Number.isFinite(ammo)) ammo--;
  ctx.socket.emit('slTrail', { x: a.x / W, y: a.y / H, vx: vx / H, vy: vy / H });
}
function hitTarget(b) {
  const { tg, d } = b.hit, crit = d <= CRIT;
  b.gone = true;
  ctx.socket.emit('slShot', { index: tg.i, crit });
  burst(b.x, b.y, crit ? '#ffe066' : '#fff', crit ? 26 : 14);
}
function missed() { if (!done) ctx.socket.emit('slShot', { index: null }); }
function burst(x, y, color, n) { for (let k = 0; k < n; k++) { const a = Math.random() * 6.28, v = 80 + Math.random() * 220; bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: .7, color }); } }

function draw(ts) {
  raf = requestAnimationFrame(draw);
  if (!live || !q) return;
  const sec = now(), dt = Math.min(.05, (ts - (draw.last || ts)) / 1000); draw.last = ts;
  g2.clearRect(0, 0, W, H);
  const { rx, ry } = size();
  // 的
  for (const tg of targets) {
    if (tg.gone) continue;
    const p = place(tg, sec);
    g2.save(); g2.translate(p.x, p.y);
    g2.beginPath(); g2.ellipse(0, 0, rx, ry, 0, 0, 6.28);
    g2.fillStyle = cracked.has(tg.i) ? 'rgba(60, 20, 30, .78)' : 'rgba(18, 16, 40, .82)'; g2.fill();
    g2.lineWidth = 2; g2.strokeStyle = cracked.has(tg.i) ? '#ff5d7a' : 'rgba(190, 170, 255, .9)'; g2.stroke();
    g2.beginPath(); g2.ellipse(0, 0, rx * CRIT, ry * CRIT, 0, 0, 6.28); g2.strokeStyle = 'rgba(255, 224, 102, .35)'; g2.lineWidth = 1; g2.stroke(); // 会心の範囲
    if (cracked.has(tg.i)) { g2.strokeStyle = '#ff5d7a'; g2.lineWidth = 2; g2.beginPath(); g2.moveTo(-rx * .5, -ry * .6); g2.lineTo(-rx * .1, 0); g2.lineTo(-rx * .3, ry * .5); g2.moveTo(-rx * .1, 0); g2.lineTo(rx * .4, -ry * .3); g2.stroke(); }
    label(tg.title, rx, ry);
    g2.restore();
  }
  // ほかの人の弾の軌跡
  for (const b of trails) { step(b, dt, false, sec); line(b.path, b.color, .55); }
  trails = trails.filter(b => !b.gone);
  // 自分の弾
  for (const b of shots) {
    step(b, dt, true, sec);
    line(b.path, '#fff', .9);
    if (b.hit) hitTarget(b); else if (b.gone) missed();
  }
  shots = shots.filter(b => !b.gone);
  // かけら
  for (const p of bits) { p.vy += 500 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; g2.globalAlpha = Math.max(0, p.life / .7); g2.fillStyle = p.color; g2.fillRect(p.x, p.y, 4, 4); }
  g2.globalAlpha = 1; bits = bits.filter(p => p.life > 0);
  // パチンコと狙いの線
  const a = anchor();
  g2.fillStyle = '#c9a24a'; g2.fillRect(a.x - 34, a.y - 4, 6, 50); g2.fillRect(a.x + 28, a.y - 4, 6, 50);
  if (drag && !done) {
    const pv = pullOf(drag), bx = a.x - pv.dx, by = a.y - pv.dy;
    g2.strokeStyle = '#e8d3a0'; g2.lineWidth = 3; g2.beginPath(); g2.moveTo(a.x - 31, a.y); g2.lineTo(bx, by); g2.lineTo(a.x + 31, a.y); g2.stroke();
    g2.fillStyle = '#fff'; g2.beginPath(); g2.arc(bx, by, 8, 0, 6.28); g2.fill();
    // 狙いの点線（最初の少しだけ）
    let x = a.x, y = a.y, vx = pv.vx, vy = pv.vy; g2.fillStyle = 'rgba(255, 255, 255, .6)';
    for (let k = 0; k < 14; k++) { for (let s = 0; s < 3; s++) { vy += G * H * .012; x += vx * .012; y += vy * .012; } g2.beginPath(); g2.arc(x, y, 2.5, 0, 6.28); g2.fill(); }
  } else if (!done) { g2.strokeStyle = '#e8d3a0'; g2.lineWidth = 3; g2.beginPath(); g2.moveTo(a.x - 31, a.y); g2.lineTo(a.x + 31, a.y); g2.stroke(); }
  // 弾の数
  g2.font = '700 15px "Zen Kaku Gothic New", sans-serif'; g2.textAlign = 'center'; g2.fillStyle = '#fff';
  g2.fillText(done ? '' : Number.isFinite(ammo) ? `弾 ${'●'.repeat(Math.max(0, ammo))}${'○'.repeat(Math.max(0, (q.slAmmo === '1' ? 1 : 3) - ammo))}` : '弾 ∞', a.x, a.y + 66);
  if (banner && performance.now() < banner.until) {
    g2.textAlign = 'center'; g2.font = `900 ${Math.min(64, W / 9)}px "Zen Kaku Gothic New", sans-serif`;
    g2.lineWidth = 6; g2.strokeStyle = 'rgba(0, 0, 0, .6)'; g2.strokeText(banner.text, W / 2, H * .72); g2.fillStyle = banner.color; g2.fillText(banner.text, W / 2, H * .72);
  }
}
function line(path, color, alpha) {
  if (path.length < 2) return;
  g2.globalAlpha = alpha; g2.strokeStyle = color; g2.lineWidth = 3; g2.beginPath(); g2.moveTo(...path[0]); for (const p of path) g2.lineTo(...p); g2.stroke(); g2.globalAlpha = 1;
}
function label(text, rx, ry) {
  g2.fillStyle = '#fff'; g2.textAlign = 'center'; g2.textBaseline = 'middle';
  let fs = Math.max(10, Math.min(16, rx / 5)); g2.font = `700 ${fs}px "Zen Kaku Gothic New", sans-serif`;
  const chars = [...text], lines = [];
  let cur = '';
  for (const ch of chars) { if (g2.measureText(cur + ch).width > rx * 1.6 && cur) { lines.push(cur); cur = ch; } else cur += ch; }
  if (cur) lines.push(cur);
  const show = lines.slice(0, 3); if (lines.length > 3) show[2] = show[2].slice(0, -1) + '…';
  show.forEach((l, k) => g2.fillText(l, 0, (k - (show.length - 1) / 2) * fs * 1.15));
}
function pullOf(d) {
  const a = anchor();
  let dx = a.x - d.x, dy = a.y - d.y; const l = Math.hypot(dx, dy), m = maxPull();
  if (l > m) { dx *= m / l; dy *= m / l; }
  const k = Math.min(1, Math.hypot(dx, dy) / m);
  // 引いた向きと反対に飛ぶ（引いた分だけ速い）
  return { dx: -dx, dy: -dy, vx: dx / (m || 1) * VMAX * H * k ** .2, vy: dy / (m || 1) * VMAX * H * k ** .2 };
}

export function initSling(c) {
  ctx = c;
  cv = ctx.$('slCanvas'); g2 = cv.getContext('2d');
  addEventListener('resize', () => { if (live) resize(); });
  cv.addEventListener('pointerdown', e => {
    if (!live || done || ammo <= 0) return;
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    drag = { x: e.offsetX, y: e.offsetY }; document.body.classList.add('sl-drag');
  });
  cv.addEventListener('pointermove', e => { if (drag) { e.preventDefault(); drag = { x: e.offsetX, y: e.offsetY }; } });
  const release = e => {
    if (!drag) return;
    const pv = pullOf(drag); drag = null; document.body.classList.remove('sl-drag');
    if (Math.hypot(pv.dx, pv.dy) > maxPull() * .15) shoot(pv.vx, pv.vy); // 少し引いただけなら撃たない
    e?.preventDefault?.();
  };
  cv.addEventListener('pointerup', release); cv.addEventListener('pointercancel', () => { drag = null; document.body.classList.remove('sl-drag'); });
  ctx.$('slPass').onclick = () => { if (!done) { done = true; ctx.pass(); banner = { text: 'パス', color: '#ccc', until: performance.now() + 1200 }; } };
  ctx.socket.on('slResult', r => {
    if (!q) return;
    if (r.miss) { if (r.left != null) ammo = r.left; if (r.done) { done = true; banner = { text: '弾切れ…', color: '#ccc', until: performance.now() + 1500 }; ctx.onDone(null); } return; }
    if (r.ok) {
      done = true; const tg = targets.find(t => t.i === r.index); if (tg) tg.gone = true;
      const p = tg ? place(tg, now()) : { x: W / 2, y: H / 2 }; burst(p.x, p.y, r.crit ? '#ffe066' : '#9ff', r.crit ? 60 : 36);
      banner = { text: r.crit ? '会心！ 正解！' : '正解！', color: r.crit ? '#ffe066' : '#7fffd4', until: performance.now() + 1800 };
      ctx.onDone(r.index);
    } else {
      cracked.add(r.index); ammo = r.left ?? ammo;
      banner = { text: r.pen ? `はずれ −${r.pen}` : 'はずれ', color: '#ff7a90', until: performance.now() + 1200 };
      if (r.done) { done = true; ctx.onDone(r.index); }
    }
  });
  ctx.socket.on('slTrail', t => { if (live) trails.push({ x: t.x * W, y: t.y * H, vx: t.vx * H, vy: t.vy * H, path: [], color: colorOf(t.id) }); });
  raf = requestAnimationFrame(draw);
}
// 出題：的を並べる（流れ始めるまでは撃てない）
export function slingQuestion(question) {
  q = question; live = false; done = false; cracked = new Set(); shots = []; trails = []; bits = []; banner = null; drag = null;
  ammo = q.slAmmo === '1' ? 1 : q.slAmmo === 'inf' ? Infinity : 3;
  ctx.$('slScreen').hidden = false; resize(); layout();
  ctx.$('slPass').hidden = false;
}
export function slingGo(start, hint) { if (!q) return; t0 = start; hintAt = hint; live = true; resize(); }
export function slingStop() { live = false; q = null; drag = null; if (cv) g2.clearRect(0, 0, W, H); ctx?.$('slScreen') && (ctx.$('slScreen').hidden = true); }
