// アニソンモノポリー：盤面の画面（クイズと答え合わせのあいだだけ隠す）。仕様は docs/monopoly-spec.md
const STEP_MS = 170, STAGGER_MS = 350; // monopoly.js（サーバー）と同じ値
const arrived = new Map(); // 到着したばかりのマス → 人
let ctx = null, tab = 'hand', deed = null, shownPos = new Map(), lastMove = 0, animating = false, tick = null, built = '';
const trade = { to: '', give: '0', get: '0', pts: 300 };
const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const P_COLORS = ['#4fc3f7', '#ff8a65', '#aed581', '#ffd54f', '#ce93d8', '#f48fb1', '#80cbc4', '#e0e0e0', '#ff5252', '#7c9cff'];
const pColor = id => P_COLORS[Math.max(0, room?.monopoly?.players.findIndex(p => p.id === id) ?? 0) % P_COLORS.length]; // 人ごとに別の色（参加順）

// 40マスの場所（0＝右下のスタート、左回りではなく本物と同じ時計回り）
function gridOf(i) {
  if (i <= 10) return [11, 11 - i];
  if (i <= 20) return [11 - (i - 10), 1];
  if (i <= 30) return [1, 1 + (i - 20)];
  return [1 + (i - 30), 11];
}
const sideOf = i => (i % 10 === 0 ? 'corner' : i < 10 ? 'b' : i < 20 ? 'l' : i < 30 ? 't' : 'r');
const iconOf = sq => sq.icon || { rail: '🚃', util: sq.name === 'ライブ会場' ? '🎤' : '📡', tax: '💸' }[sq.kind] || '';

export function initMonopoly(c) {
  ctx = c;
  const s = ctx.$('mpScreen');
  s.addEventListener('click', e => {
    const b = e.target.closest('[data-mp]');
    if (b) {
      const a = b.dataset.mp;
      if (a === 'tab') { tab = b.dataset.t; return render(); }
      if (a === 'deedClose') { deed = null; return render(); }
      if (a === 'next') return ctx.socket.emit('next');
      if (a === 'trade') return ctx.socket.emit('mpAct', 'trade', { to: trade.to, give: trade.give === 'pts' ? -1 : +trade.give, get: +trade.get, pts: +trade.pts });
      return ctx.socket.emit('mpAct', a, { c: b.dataset.c, i: b.dataset.i, n: b.dataset.n, ok: b.dataset.ok === '1' });
    }
    const cell = e.target.closest('.mp-cell');
    if (cell) { deed = +cell.dataset.i; render(); }
  });
  s.addEventListener('change', e => { const k = e.target.dataset?.tf; if (k) { trade[k] = e.target.value; render(); } });
}
let room = null;
export function renderMonopoly(r) { room = r; render(); }

function render() {
  const s = ctx.$('mpScreen'), m = room?.monopoly;
  const quiz = !m || m.step === 'quiz' || m.step === 'reveal' || room.paused;
  s.hidden = quiz; document.body.classList.toggle('mp-board', !quiz);
  if (!m) { prev = null; fxMove = 0; built = ''; shownPos.clear(); lastMove = 0; deed = null; clearInterval(tick); tick = null; return; }
  if (quiz) return;
  const sig = m.board.map(b => b.name).join();
  if (built !== sig) { built = sig; s.innerHTML = '<div class="mp-board-grid" id="mpGrid"></div>'; shownPos = new Map(m.players.map(p => [p.id, p.pos])); }
  const g = ctx.$('mpGrid');
  const keep = new Map([...g.querySelectorAll('.mp-token')].map(t => [t.dataset.id, t]));
  const mid = g.querySelector('.mp-mid'), sc = mid?.querySelector('.mp-tabbody')?.scrollTop || 0;
  g.innerHTML = m.board.map(b => cellHtml(m, b)).join('') + `<div class="mp-mid">${midHtml(m)}</div>`;
  const body = g.querySelector('.mp-tabbody'); if (body) body.scrollTop = sc;
  for (const p of m.players) { const t = keep.get(p.id) || mkToken(p); g.appendChild(t); }
  if (m.step === 'dice' && diceAt !== m.qNo) { diceAt = m.qNo; sound('dice'); }
  animate(m); place(m); effects(m);
  if (!tick) tick = setInterval(() => { const el = ctx.$('mpLeft'), mm = room?.monopoly; if (el && mm) el.textContent = Math.max(0, Math.ceil((mm.until - Date.now()) / 1000)); }, 300);
}
const ownerInfo = (m, id) => { const t = m.teams?.find(x => x.id === id); if (t) return t; const p = m.players.find(x => x.id === id); return p && { id, name: p.name, color: pColor(id) }; }; // 土地の持ち主：チームか人
function mkToken(p) { const t = document.createElement('i'); t.className = 'mp-token'; t.dataset.id = p.id; t.style.background = pColor(p.id); if (p.team) t.style.borderColor = ownerInfo(room.monopoly, p.owner).color; t.title = p.name; t.textContent = [...p.name].slice(0, 4).join(''); return t; }
function place(m) { // コマをマスの上に置く（同じマスの人は少しずらす）
  const g = ctx.$('mpGrid'); if (!g) return;
  const count = new Map();
  for (const p of m.players) {
    const pos = shownPos.get(p.id) ?? p.pos, cell = g.querySelector(`.mp-cell[data-i="${pos}"]`), t = g.querySelector(`.mp-token[data-id="${CSS.escape(p.id)}"]`);
    if (!cell || !t) continue;
    const k = count.get(pos) || 0; count.set(pos, k + 1);
    t.style.left = `${cell.offsetLeft + cell.offsetWidth / 2}px`; t.style.top = `${cell.offsetTop + cell.offsetHeight - 2 - k * (t.offsetHeight - 3)}px`;
    t.classList.toggle('me', p.id === ctx.getMe());
  }
}
function animate(m) { // 1マスずつ進める（速い人から順に、少しずらして）
  if (m.moveN === lastMove) { if (!animating) shownPos = new Map(m.players.map(p => [p.id, p.pos])); return; }
  lastMove = m.moveN; animating = true;
  let longest = 0;
  m.moves.forEach((mv, k) => {
    shownPos.set(mv.id, mv.from);
    longest = Math.max(longest, k * STAGGER_MS + mv.steps * STEP_MS);
    for (let n = 1; n <= mv.steps; n++) setTimeout(() => { const at = (mv.from + n) % 40; shownPos.set(mv.id, at); sound('step'); const mm = room?.monopoly; if (mm) place(mm); hop(mv.id, at); }, k * STAGGER_MS + n * STEP_MS);
    setTimeout(() => {
      shownPos.set(mv.id, mv.to); const mm = room?.monopoly; if (mm) place(mm);
      if (mv.steps) arrive(mv, mv.to);
    }, k * STAGGER_MS + mv.steps * STEP_MS + 120);
  });
  setTimeout(() => { animating = false; }, longest + 1400);
}
// ── 効果音（音のファイルなしで鳴らす）──
let ac = null;
function tone(f, at, len, type = 'sine', vol = .16) { const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + at; o.type = type; o.frequency.value = f; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.001, t + len); o.connect(g).connect(ac.destination); o.start(t); o.stop(t + len); }
function sound(kind) {
  try {
    ac = ac || new AudioContext(); if (ac.state === 'suspended') ac.resume();
    if (kind === 'coin') { tone(1319, 0, .12, 'square', .07); tone(1976, .08, .35, 'square', .07); }
    else if (kind === 'card') { tone(600, 0, .05, 'triangle'); tone(900, .05, .05, 'triangle'); tone(1300, .1, .14, 'triangle'); }
    else if (kind === 'buy') [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * .09, .4, 'triangle', .14));
    else if (kind === 'rent') { [988, 880, 784, 659].forEach((f, i) => tone(f, i * .07, .16, 'square', .06)); for (let i = 0; i < 8; i++) tone(1800 + i * 60, .1 + i * .07, .06, 'square', .03); }
    else if (kind === 'lose') { tone(392, 0, .16, 'sawtooth', .07); tone(262, .13, .3, 'sawtooth', .07); }
    else if (kind === 'dice') for (let i = 0; i < 9; i++) tone(180 + Math.random() * 500, i * .07, .05, 'square', .05);
    else if (kind === 'step') tone(700, 0, .04, 'sine', .05);
  } catch (e) { /* 音が出ない端末では鳴らさない */ }
}
// ── 派手な演出：点の増減・カードの獲得・土地の購入を、前の状態との差から出す ──
let prev = null, fxMove = 0, diceAt = 0;
function spot(id) { const t = document.querySelector(`.mp-token[data-id="${CSS.escape(id)}"]`), r = t?.getBoundingClientRect(); return r ? [r.left + 8, r.top + 8] : [innerWidth / 2, innerHeight / 2]; }
function pop(cls, html, x, y, ms = 1800) {
  const el = document.createElement('div'); el.className = 'mpfx ' + cls; el.innerHTML = html;
  el.style.left = Math.min(innerWidth - 100, Math.max(100, x)) + 'px'; el.style.top = Math.min(innerHeight - 30, Math.max(40, y)) + 'px';
  ctx.$('mpFx').appendChild(el); setTimeout(() => el.remove(), ms); return el;
}
function coins(fromId, toId, pts) { // 家賃：コインが相手まで飛ぶ
  const [a, b] = spot(fromId), [c, d] = spot(toId);
  for (let i = 0; i < 12; i++) setTimeout(() => { const e = pop('coin', '🪙', a, b, 800); e.animate([{ left: a + 'px', top: b + 'px', transform: 'translate(-50%,-50%) scale(1)' }, { left: (a + c) / 2 + 'px', top: Math.min(b, d) - 90 + 'px', transform: 'translate(-50%,-50%) scale(1.8) rotate(360deg)' }, { left: c + 'px', top: d + 'px', transform: 'translate(-50%,-50%) scale(.8) rotate(720deg)' }], { duration: 700, easing: 'ease-in-out', fill: 'forwards' }); }, i * 60);
  pop('banner rent', `💸 家賃 ${pts}点！`, innerWidth / 2, innerHeight / 2, 1700); sound('rent');
}
function burst(x, y, list = ['✨', '💰', '🎉', '⭐']) { for (let i = 0; i < 14; i++) { const e = pop('spark', list[i % list.length], x, y, 900), a = i / 14 * 6.28, r = 60 + Math.random() * 70; e.animate([{ transform: 'translate(-50%,-50%) scale(.5)', opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(a) * r}px), calc(-50% + ${Math.sin(a) * r}px)) scale(1.5)`, opacity: 0 }], { duration: 850, easing: 'ease-out', fill: 'forwards' }); } }
function effects(m) {
  const cur = { score: new Map(m.players.map(p => [p.id, p.score])), cards: new Map(m.players.map(p => [p.id, p.cards.slice()])), owner: new Map(m.board.filter(b => b.pts).map(b => [b.i, b.owner])), lv: new Map(m.board.filter(b => b.kind === 'city').map(b => [b.i, b.lv])) };
  const was = prev; prev = cur; if (!was) return;
  const delayOf = id => { if (m.step !== 'move' || fxMove === m.moveN) return 0; const k = m.moves.findIndex(x => x.id === id); return k < 0 ? 0 : k * STAGGER_MS + m.moves[k].steps * STEP_MS + 350; };
  const seenHand = new Set(); // カードの演出はチームで1回（自分がいれば自分のコマに）
  for (const p of [...m.players].sort((a, b) => (b.id === ctx.getMe()) - (a.id === ctx.getMe()))) {
    const wait = delayOf(p.id), dv = p.score - (was.score.get(p.id) ?? p.score), wc = was.cards.get(p.id) || [];
    if (dv) setTimeout(() => { const [x, y] = spot(p.id); pop('money ' + (dv > 0 ? 'up' : 'down'), `${dv > 0 ? '+' : ''}${dv}点`, x, y - 14); if (dv >= 200) burst(x, y); const row = document.querySelector(`.mp-vault[data-id="${CSS.escape(p.id)}"]`); row?.classList.add(dv > 0 ? 'gain' : 'lose'); if (p.id === ctx.getMe() || dv >= 200) sound(dv > 0 ? 'coin' : 'lose'); }, wait);
    if (seenHand.has(p.owner)) continue; seenHand.add(p.owner);
    p.cards.forEach((n, i) => { const d = n - (wc[i] ?? n); if (d > 0) setTimeout(() => { const [x, y] = spot(p.id), c = m.countries[i]; pop('card', `🃏 ${c.icon}${ctx.esc(c.label)} ×${d}`, x, y - 44).style.setProperty('--c', c.color); sound('card'); }, wait + 200); });
  }
  for (const b of m.board) {
    const o = was.owner.get(b.i);
    const cell = () => document.querySelector(`.mp-cell[data-i="${b.i}"]`)?.getBoundingClientRect();
    if (b.owner && b.owner !== o) { const r = cell(), w = ownerInfo(m, b.owner); if (r) { burst(r.left + r.width / 2, r.top + r.height / 2, ['🏠', '🎉', '✨', '💴']); pop('banner buy', `🏠 ${ctx.esc(w?.name || '')} が「${ctx.esc(b.name)}」を取得！`, innerWidth / 2, innerHeight / 2, 1900); sound('buy'); } }
    if (b.kind === 'city' && b.lv > (was.lv.get(b.i) || 0)) { const r = cell(); if (r) { burst(r.left + r.width / 2, r.top + r.height / 2, ['🏠', '🔨', '✨']); pop('banner buy', `🏘 「${ctx.esc(b.name)}」に家が建った！`, innerWidth / 2, innerHeight / 2, 1700); sound('buy'); } }
  }
  if (m.step === 'move' && fxMove !== m.moveN) {
    fxMove = m.moveN;
    m.moves.forEach((mv, k) => { const wait = k * STAGGER_MS + mv.steps * STEP_MS + 350; if (mv.rent) setTimeout(() => coins(mv.id, mv.rent.to, mv.rent.pts), wait); });
  }
}
function hop(id, at) { // 1マスごとにはねて、通ったマスを光らせる
  const t = document.querySelector(`.mp-token[data-id="${CSS.escape(id)}"]`);
  t?.animate([{ transform: 'translate(-50%, -100%) translateY(0) scale(1)' }, { transform: 'translate(-50%, -100%) translateY(-18px) scale(1.15)', offset: .45 }, { transform: 'translate(-50%, -100%) translateY(0) scale(1, .85)', offset: .85 }, { transform: 'translate(-50%, -100%)' }], { duration: STEP_MS, easing: 'ease-out' });
  document.querySelector(`.mp-cell[data-i="${at}"]`)?.animate([{ boxShadow: `inset 0 0 0 3px ${pColor(id)}, 0 0 14px ${pColor(id)}` }, { boxShadow: 'none' }], { duration: 500 });
}
function arrive(mv, at) { // 到着：マスを人の色で光らせ、札を大きくはねさせ、名前を出す
  arrived.set(at, mv.id);
  const cell = document.querySelector(`.mp-cell[data-i="${at}"]`), t = document.querySelector(`.mp-token[data-id="${CSS.escape(mv.id)}"]`), b = room?.monopoly?.board[at];
  if (cell) { cell.classList.add('arrived'); cell.style.setProperty('--hl', pColor(mv.id)); }
  t?.animate([{ transform: 'translate(-50%, -100%) scale(1)' }, { transform: 'translate(-50%, -100%) translateY(-26px) scale(1.5)', offset: .35 }, { transform: 'translate(-50%, -100%) scale(1.25, .8)', offset: .7 }, { transform: 'translate(-50%, -100%) scale(1)' }], { duration: 650, easing: 'ease-out' });
  const r = cell?.getBoundingClientRect();
  if (r && b) pop('arrive', `${ctx.esc(mv.name)} → ${ctx.esc(b.name)}`, r.left + r.width / 2, r.top - 12, 2200).style.setProperty('--hl', pColor(mv.id));
  sound('card');
  setTimeout(() => { if (arrived.get(at) === mv.id) { arrived.delete(at); document.querySelector(`.mp-cell[data-i="${at}"]`)?.classList.remove('arrived'); } }, 4000);
}
function cellHtml(m, b) {
  const [row, col] = gridOf(b.i), side = sideOf(b.i), c = b.c != null ? m.countries[b.c] : null, owner = b.owner && ownerInfo(m, b.owner);
  const price = b.kind === 'city' ? '🃏'.repeat(Math.min(b.cards, 5)) : b.pts ? `${b.pts}` : b.tax ? `-${b.tax}` : '';
  const here = animating ? null : m.players.find(p => p.pos === b.i && p.id === ctx.getMe()) || m.players.find(p => p.pos === b.i), hl = arrived.get(b.i);
  const house = b.lv ? '🏠'.repeat(Math.min(b.lv, 4)) : '';
  return `<div class="mp-cell ${side} k-${b.kind}${m.cur === b.c && c ? ' cur' : ''}${m.offers.some(o => o[1] === b.i) ? ' offer' : ''}${here ? ' here' : ''}${hl ? ' arrived' : ''}" data-i="${b.i}" style="grid-area:${row}/${col}${owner ? `;--own:${owner.color}` : ''}${here ? `;--here:${pColor(here.id)}` : ''}${hl ? `;--hl:${pColor(hl)}` : ''}">
    ${c ? `<span class="mp-band" style="background:${c.color}">${house}</span>` : ''}
    ${iconOf(b) ? `<em>${iconOf(b)}</em>` : ''}<b>${ctx.esc(b.name)}</b><small>${owner ? ctx.esc(owner.name) : price}</small></div>`;
}
function midHtml(m) {
  const me = ctx.getMe(), my = m.players.find(p => p.id === me), esc = ctx.esc, c = m.cur != null ? m.countries[m.cur] : null;
  const status = { dice: '🎲 サイコロ！ 次はこの国の問題', move: '🎲 コマが進んでいます', act: `行動タイム あと <b id="mpLeft">${Math.max(0, Math.ceil((m.until - Date.now()) / 1000))}</b> 秒`, wait: '次の問題を待っています' }[m.step] || '';
  const offer = m.offers.find(o => o[0] === me), pending = [];
  if (offer && m.step === 'act') {
    const b = m.board[offer[1]], have = b.kind === 'city' ? Math.min(my.cards[b.c], b.cards) : 0, cost = b.kind === 'city' ? (b.cards - have) * m.prices.card : b.pts;
    pending.push(`<div class="mp-offer"><span>${esc(b.name)} を買いますか？ <b>${b.kind === 'city' ? `カード${have}枚${cost ? `＋${cost}点` : ''}` : `${cost}点`}</b></span><button class="btn-main" data-mp="buy"${my.score < cost ? ' disabled' : ''}>買う</button><button class="btn-sub" data-mp="skip">見送る</button></div>`);
  }
  if (m.pick?.id === me && m.step === 'act') pending.push(`<div class="mp-offer pick"><span>🎵 次の問題の国を選べます</span>${m.countries.map((x, i) => `<button class="mp-chip" style="--c:${x.color}" data-mp="pick" data-c="${i}">${x.icon}${esc(x.label)}</button>`).join('')}</div>`);
  for (const t of m.trades) if (t.to === me) pending.push(`<div class="mp-offer"><span>🤝 ${esc(t.fromName)}：${t.give >= 0 ? esc(m.countries[t.give].label) : t.pts + '点'} と、あなたの ${esc(m.countries[t.get].label)} を交換</span><button class="btn-main" data-mp="tradeAns" data-n="${t.n}" data-ok="1"${my.cards[t.get] < 1 ? ' disabled' : ''}>受ける</button><button class="btn-sub" data-mp="tradeAns" data-n="${t.n}">断る</button></div>`);
  const players = [...m.players].sort((a, b) => b.score - a.score).map(p => vaultHtml(m, p, me)).join('');
  const tabs = [['hand', m.teams ? '🃏 チームのカード' : '🃏 自分のカード'], ['shop', '🏦 取引所'], ['trade', '🤝 トレード'], ['log', '📜 記録']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-mp="tab" data-t="${k}">${l}</button>`).join('');
  const body = tab === 'hand' ? handHtml(m, my) : tab === 'shop' ? shopHtml(m, my) : tab === 'trade' ? tradeHtml(m, my) : `<ul class="mp-log">${[...m.log].reverse().map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
  const footer = m.step === 'act' ? `<button class="btn-main mp-ok" data-mp="ready"${m.ready.includes(me) ? ' disabled' : ''}>${m.ready.includes(me) ? '待っています' : 'OK（次へ）'}</button>` : m.step === 'wait' && room.hostId === me ? '<button class="btn-main mp-ok" data-mp="next">次の問題へ</button>' : '';
  return `<div class="mp-head"><strong>アニソン<span>モノポリー</span></strong><small>第${m.qNo}/${m.qTotal}問</small><span class="mp-status">${status}</span>${c ? `<span class="mp-chip now" style="--c:${c.color}">${c.icon}${esc(c.label)}</span>` : ''}${footer}</div>
    <div class="mp-last">${esc(m.log[m.log.length - 1] || '')}</div>
    ${m.step === 'dice' && my?.dice ? `<div class="mp-bigdice">${my.dice.map(n => `<span>${DIE[n]}</span>`).join('')}<b>${my.dice[0] + my.dice[1]}</b></div>` : ''}
    ${pending.join('')}
    ${m.teams ? teamBarHtml(m, my) : ''}<div class="mp-vaults">${players}</div><div class="mp-panel"><div class="mp-tabs">${tabs}</div><div class="mp-tabbody">${body}</div></div>
    ${deed != null ? deedHtml(m, m.board[deed]) : ''}`;
}
function teamBarHtml(m, my) { // チーム戦：チームの合計と共有カード
  return `<div class="mp-teams">${m.teams.map(t => { const hand = m.players.find(p => p.owner === t.id)?.cards || []; return `<div class="mp-teamrow${my?.owner === t.id ? ' me' : ''}" style="--t:${t.color}"><b>${t.name}</b><span>${t.score + t.land}<small>点（土地${t.land}）</small></span><div class="mp-stacks">${hand.map((k, i) => k ? `<span class="mp-stack" style="--c:${m.countries[i].color}" title="${ctx.esc(m.countries[i].label)} ${k}枚">${'<i></i>'.repeat(Math.min(k, 8))}<small>${k}</small></span>` : '').join('')}</div></div>`; }).join('')}</div>`;
}
function vaultHtml(m, p, me) { // 金貨は100点で1枚、10枚で1本の塔。カードは国の色で積む
  const esc = ctx.esc, n = Math.min(80, Math.ceil(Math.max(0, p.score) / 100)), towers = [];
  for (let i = 0; i < n; i += 10) towers.push(`<span class="mp-tower">${'<i></i>'.repeat(Math.min(10, n - i))}</span>`);
  const stacks = m.teams ? '' : p.cards.map((k, i) => k ? `<span class="mp-stack" style="--c:${m.countries[i].color}" title="${esc(m.countries[i].label)} ${k}枚">${'<i></i>'.repeat(Math.min(k, 8))}<small>${k}</small></span>` : '').join('');
  return `<div class="mp-vault${p.id === me ? ' me' : ''}" data-id="${esc(p.id)}"${p.team ? ` style="border-top:3px solid ${ownerInfo(m, p.owner).color}"` : ''}><header><i style="background:${pColor(p.id)}"></i><span>${esc(p.name)}${p.jail ? '🚔' : ''}${m.ready.includes(p.id) ? ' ✓' : ''}</span>${p.dice ? `<em>${DIE[p.dice[0]]}${DIE[p.dice[1]]}</em>` : ''}<b>${p.score}</b></header><div class="mp-where" style="--c:${pColor(p.id)}">📍${esc(m.board[p.pos]?.name || '')}</div><div class="mp-piles"><div class="mp-coins">${towers.join('')}</div><div class="mp-stacks">${stacks}</div></div></div>`;
}
function handHtml(m, my) {
  if (!my) return '';
  const can = m.step === 'act';
  const rows = m.countries.map((c, i) => {
    const mine = m.board.filter(b => b.c === i && b.kind === 'city' && b.owner === my.owner);
    const lands = mine.map(b => `<span class="mp-land">${ctx.esc(b.name)}${b.lv ? ' ' + '🏠'.repeat(b.lv) : ''}${can && b.lv < m.maxHouse && !m.built.includes(b.i) && my.cards[i] >= b.cards ? `<button data-mp="house" data-i="${b.i}">🏠+（🃏${b.cards}）</button>` : ''}</span>`).join('');
    return `<div class="mp-card${my.cards[i] || mine.length ? '' : ' none'}"><header style="background:${c.color}"><span>${c.icon}${ctx.esc(c.label)}</span><b>×${my.cards[i]}</b></header>${lands}</div>`;
  }).join('');
  const others = m.board.filter(b => b.owner === my.owner && b.kind !== 'city').map(b => `<span class="mp-land">${iconOf(b)} ${ctx.esc(b.name)}</span>`).join('');
  return `<div class="mp-cards">${rows}${others ? `<div class="mp-card"><header style="background:#555"><span>公共</span></header>${others}</div>` : ''}</div>`;
}
function shopHtml(m, my) {
  if (!my) return '';
  const price = m.half.includes(my.id) ? Math.round(m.prices.card / 2) : m.prices.card, can = m.step === 'act';
  return `<p class="mp-note">買う ${price}点${m.half.includes(my.id) ? '（半額！）' : ''}／売る ${m.prices.sell}点　※行動タイムのあいだ</p><div class="mp-cards">${m.countries.map((c, i) => `<div class="mp-card"><header style="background:${c.color}"><span>${c.icon}${ctx.esc(c.label)}</span><b>×${my.cards[i]}</b></header><div class="mp-btns"><button data-mp="cardBuy" data-c="${i}"${!can || my.score < price ? ' disabled' : ''}>買う</button><button data-mp="cardSell" data-c="${i}"${!can || !my.cards[i] ? ' disabled' : ''}>売る</button></div></div>`).join('')}</div>`;
}
function tradeHtml(m, my) {
  if (!my) return '';
  const others = m.players.filter(p => p.owner !== my.owner);
  if (!others.length) return '<p class="mp-note">相手がいません</p>';
  if (!others.some(p => p.id === trade.to)) trade.to = others[0].id;
  const esc = ctx.esc, opt = (v, cur, l) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(l)}</option>`;
  const giveOpts = m.countries.map((c, i) => opt(i, trade.give, `${c.label}（${my.cards[i]}枚）`)).join('') + opt('pts', trade.give, 'ポイント');
  const partner = others.find(p => p.id === trade.to);
  const mine = m.trades.filter(t => t.from === my.id).map(t => `<li>${esc(t.toName)} に申し込み中 <button data-mp="tradeAns" data-n="${t.n}">取り消す</button></li>`).join('');
  return `<div class="mp-trade"><label>相手<select data-tf="to">${others.map(p => opt(p.id, trade.to, p.name)).join('')}</select></label>
    <label>渡す<select data-tf="give">${giveOpts}</select></label>
    ${trade.give === 'pts' ? `<label>点数<select data-tf="pts">${[100, 300, 500, 1000].map(n => opt(n, trade.pts, n + '点')).join('')}</select></label>` : ''}
    <label>もらう<select data-tf="get">${m.countries.map((c, i) => opt(i, trade.get, `${c.label}（相手${partner.cards[i]}枚）`)).join('')}</select></label>
    <button class="btn-main" data-mp="trade"${m.step === 'act' ? '' : ' disabled'}>申し込む</button><ul>${mine}</ul></div>`;
}
function deedHtml(m, b) { // 権利書
  const esc = ctx.esc, c = b.c != null ? m.countries[b.c] : null, owner = b.owner && ownerInfo(m, b.owner);
  let rows = '';
  if (b.kind === 'city') rows = `<tr><td>家賃</td><td>${b.rents[0]}点</td></tr>${b.rents.slice(1).map((r, i) => `<tr><td>家${i + 1}軒</td><td>${r}点</td></tr>`).join('')}<tr><td>購入</td><td>🃏${b.cards}枚（なければ1枚${m.prices.card}点）</td></tr><tr><td>家を建てる</td><td>🃏${b.cards}枚</td></tr><tr><td colspan="2">同じ国を全部持つと、家なしの家賃は2倍</td></tr>`;
  else if (b.kind === 'rail') rows = b.rents.map((r, i) => `<tr><td>${i + 1}路線持ち</td><td>${r}点</td></tr>`).join('') + `<tr><td>購入</td><td>${b.pts}点</td></tr>`;
  else if (b.kind === 'util') rows = b.rents.map((r, i) => `<tr><td>${i + 1}つ持ち</td><td>サイコロの目×${r}点</td></tr>`).join('') + `<tr><td>購入</td><td>${b.pts}点</td></tr>`;
  else rows = `<tr><td colspan="2">${esc({ go: '通過で +200点。各周の一番乗りは、さらに +300点と次の国を選ぶ権利', jail: '止まるだけなら何もなし', shop: '止まったターンは、カード購入が半額', gojail: '刑務所へ。次のターンは進めない（最速の正解で出られる）', chance: 'チャンス：点の増減、カード、次の国を選ぶ権利など', chest: 'グッズ箱：点の増減やカード', tax: `${b.tax}点を払う` }[b.kind] || '')}</td></tr>`;
  return `<div class="mp-deed"><header style="background:${c ? c.color : '#555'}">${c ? `<small>${c.icon}${esc(c.label)}</small>` : ''}<b>${iconOf(b)} ${esc(b.name)}</b></header><table>${rows}</table><p>${owner ? `持ち主：${esc(owner.name)}${b.lv ? `（家${b.lv}軒）` : ''}` : b.pts ? '持ち主なし' : ''}</p><button class="btn-sub" data-mp="deedClose">閉じる</button></div>`;
}
