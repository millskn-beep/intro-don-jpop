// アニソンモノポリー（play monopoly）。仕様は docs/monopoly-spec.md
// server.js から盤づくり・ターン・答え合わせ・順位の時だけ呼ばれる
const crypto = require('crypto');

const START_PTS = 1500, CARD_PTS = 250, SELL_PTS = 125, GO_PTS = 200, FIRST_LAP_PTS = 300;
const FASTEST_PTS = 100, EARLY_SEC = 5, LAND_PTS = 100; // 正解の報酬はカード1枚。点は最速だけ（試算：docs/monopoly-spec.md）
const STEP_MS = 170, STAGGER_MS = 350; // コマが1マス進む時間・次の人が動き出すまで（public/monopoly.js と同じ値）
const DICE_MS = 2000, REVEAL_MS = 3000, ACT_LONG = 10, ACT_SHORT = 5, TRADE_EXTRA = 8; // 15問で約15分になるように
const COLORS = ['#8b4a2b', '#7fc8ee', '#d42f8c', '#f28c13', '#e0262e', '#f2d21b', '#17a554', '#1f5fbf'];
const CARDS_OF = [1, 1, 2, 2, 2, 3, 3, 4]; // 高い国ほど、買うのに必要なカードが多い
const BASE_RENT = [120, 180, 270, 360, 480, 600, 750, 1050];
const HOUSE_MULT = [1, 3, 5, 8, 11], MAX_HOUSE = 4;
const RAIL_PTS = 500, RAIL_RENT = [0, 300, 600, 1200, 2400], UTIL_PTS = 400, UTIL_MULT = [0, 60, 180];
// マスの並び（本物と同じ40マス）。数字は国の番号
const LAYOUT = [
  's:go', 0, 's:chest', 0, 's:tax1', 's:rail0', 1, 's:chance', 1, 1,
  's:jail', 2, 's:util0', 2, 2, 's:rail1', 3, 's:chest', 3, 3,
  's:shop', 4, 's:chance', 4, 4, 's:rail2', 5, 5, 's:util1', 5,
  's:gojail', 6, 6, 's:chest', 6, 's:rail3', 's:chance', 7, 's:tax2', 7];
const JAIL_POS = 10;
const RAILS = ['秋葉原線', '池袋線', '日本橋線', '中野線'], UTILS = ['配信サービス', 'ライブ会場'];
const TAX = { tax1: ['円盤代', 200], tax2: ['遠征費', 100] };
const SPECIAL = { go: ['スタート', '🏁'], jail: ['刑務所（面会）', '🚔'], shop: ['取引所', '🏦'], gojail: ['刑務所へ', '👮'], chance: ['チャンス', '❓'], chest: ['グッズ箱', '🎁'] };
const CHANCE = [
  { t: 'ライブの物販が大当たり', pts: 300 }, { t: 'チケットの抽選に外れた', pts: -200 }, { t: 'カードを拾った', card: 1 },
  { t: '布教に成功。全員から', all: 100 }, { t: 'スタートへ進む', go: true }, { t: '刑務所へ', jail: true }, { t: '次の問題の国を選べる', pick: true }];
const CHEST = [
  { t: 'おこづかい', pts: 100 }, { t: 'CDを高く売れた', pts: 200 }, { t: 'カードパックを開けた', card: 2 },
  { t: '限定グッズを買った', pts: -100 }, { t: '全員におごる', all: -50 }];

const TEAM_NAME = { red: '赤チーム', blue: '青チーム' }, TEAM_COLOR = { red: '#ff5a5f', blue: '#4f8dff' };
const pick = a => a[crypto.randomInt(a.length)];
const die = () => 1 + crypto.randomInt(6);

module.exports = function createMonopoly(d) {
  const R = { fastCard: 0, right: 0, fastest: FASTEST_PTS, rentX: 1, cardEnd: 0, houseAny: 0, catchup: 1, ...d.rules }; // ルールの値（試算で変えられる）
  const { io, later, broadcastRoom, nextQuestion, startQuestion, shuffle, gameWork, gzCatalog, recordPlayed, userCtx, recent, allSongs } = d;
  const players = room => [...room.players.values()];
  const byId = (room, id) => players(room).find(p => p.id === id);
  const ownerOf = (room, p) => (room.settings.teams && p?.team ? p.team : p?.id); // 土地とカードの持ち主：チーム戦ならチーム
  const membersOf = (room, owner) => players(room).filter(p => ownerOf(room, p) === owner);
  const ownerName = (room, owner) => TEAM_NAME[owner] || byId(room, owner)?.name || '';

  // ── 国づくり ──
  function buildCountries(S, pool) {
    const inPool = t => pool.filter(t);
    const cat = gzCatalog().map(c => ({ key: c.key, label: c.label, icon: c.icon, group: c.group, songs: inPool(c.test) })).filter(c => c.songs.length >= 4);
    const genres = cat.filter(c => c.group === 'genre');
    const groupBy = (f, icon, min = 3) => {
      const m = new Map();
      for (const s of pool) { const k = f(s); if (k) (m.get(k) || m.set(k, []).get(k)).push(s); }
      return [...m].filter(([, a]) => a.length >= min).map(([k, a]) => ({ key: icon + k, label: a[0].work && icon === '🎬' ? a[0].work : k, icon, songs: a }));
    };
    const works = () => groupBy(gameWork, '🎬'), artists = () => groupBy(s => s.artist, '🎤');
    let list = [];
    if (S.mpBy === 'work') list = shuffle(works()).slice(0, 8);
    else if (S.mpBy === 'artist') list = shuffle(artists()).slice(0, 8);
    else if (S.mpBy === 'mix') list = [...shuffle(genres.slice()).slice(0, 3), ...shuffle(works()).slice(0, 3), ...shuffle(artists()).slice(0, 2)];
    else if (S.mpBy === 'choose') list = (S.gzPicks || []).map(k => cat.find(c => c.key === k)).filter(Boolean).slice(0, 8);
    else list = shuffle(genres.slice()).slice(0, 8);
    for (const c of shuffle([...genres, ...cat])) { if (list.length >= 8) break; if (!list.some(x => x.key === c.key)) list.push(c); }
    while (list.length < 8) list.push({ key: 'all' + list.length, label: `アニソン${list.length + 1}`, icon: '🎵', songs: pool.length ? pool : allSongs() });
    return shuffle(list).slice(0, 8);
  }
  function citiesOf(c, n) { // 国の中身（作品。作品の国なら曲名）。足りなければ曲名で埋める
    const uniq = a => [...new Set(a.filter(Boolean))];
    const works = uniq(shuffle(c.songs.slice()).map(s => s.work)), titles = uniq(shuffle(c.songs.slice()).map(s => s.title));
    const list = (c.key[0] === '🎬' || works.length < n ? [...titles, ...works] : works).slice(0, n);
    while (list.length < n) list.push(`${c.label}${list.length + 1}`);
    return list;
  }
  function buildBoard(countries) {
    const names = countries.map((c, i) => citiesOf(c, i === 0 || i === 7 ? 2 : 3)), used = countries.map(() => 0);
    let rail = 0, util = 0;
    return LAYOUT.map((x, i) => {
      if (typeof x === 'number') {
        const k = used[x]++, cards = CARDS_OF[x] + (k === names[x].length - 1 && x > 0 ? 1 : 0); // 同じ国でも最後の土地は少し高い
        const base = Math.round(BASE_RENT[x] * (k === names[x].length - 1 ? 1.25 : 1) / 10) * 10;
        return { i, kind: 'city', c: x, name: names[x][k], cards, pts: cards * CARD_PTS, rents: HOUSE_MULT.map(m => m * base), owner: null, lv: 0 };
      }
      const k = x.slice(2);
      if (k.startsWith('rail')) return { i, kind: 'rail', name: RAILS[rail++], pts: RAIL_PTS, rents: RAIL_RENT.slice(1), owner: null };
      if (k.startsWith('util')) return { i, kind: 'util', name: UTILS[util++], pts: UTIL_PTS, rents: UTIL_MULT.slice(1), owner: null };
      if (TAX[k]) return { i, kind: 'tax', name: TAX[k][0], tax: TAX[k][1] };
      return { i, kind: k, name: SPECIAL[k][0], icon: SPECIAL[k][1] };
    });
  }
  function init(room, pool) {
    const countries = buildCountries(room.settings, pool);
    for (const p of players(room)) p.score = START_PTS;
    room.game.mp = { countries, board: buildBoard(countries), step: 'wait', pos: new Map(), laps: new Map(), cards: new Map(), jail: new Set(), dice: new Map(),
                     cur: null, nextC: null, moves: [], moveN: 0, log: [], pick: null, offers: new Map(), half: new Set(), trades: [], ready: new Set(), until: 0, firstLap: 0, built: new Set(), tradeN: 0 };
  }
  const handOf = (mp, id) => mp.cards.get(id) || mp.cards.set(id, Array(8).fill(0)).get(id);
  const say = (mp, msg) => { mp.log.push(msg); if (mp.log.length > 30) mp.log.shift(); };
  const pay = (p, n) => { const v = Math.min(n, Math.max(0, p.score)); p.score -= v; return v; };
  const landOf = (room, mp, owner) => mp.board.filter(b => b.owner === owner).reduce((s, b) => s + (room.settings.mpLand === 'half' ? .5 : 1) * (b.pts + (b.lv || 0) * (b.cards || 0) * CARD_PTS), 0);

  // ── ターン：サイコロ → クイズ ──
  function turn(room) {
    const g = room.game, mp = g.mp;
    mp.step = 'dice'; mp.dice.clear(); mp.moves = []; mp.offers.clear(); mp.half.clear(); mp.trades = []; mp.ready.clear(); mp.built.clear(); mp.pick = null;
    for (const p of players(room)) mp.dice.set(p.id, [die(), die()]);
    mp.cur = mp.nextC ?? crypto.randomInt(8); mp.nextC = null;
    say(mp, `第${g.qi + 1}問の国：${mp.countries[mp.cur].icon}${mp.countries[mp.cur].label}`);
    broadcastRoom(room);
    later(room, () => { if (room.game !== g) return; prepare(room); mp.step = 'quiz'; startQuestion(room, g.order[g.qi]); broadcastRoom(room); }, DICE_MS);
  }
  function prepare(room) { // その国の曲から出す（この試合でまだ出していない曲。ほかの部屋で最近出た曲はなるべく避ける）
    const g = room.game, mp = g.mp, S = room.settings, c = mp.countries[mp.cur], ctx = userCtx(room);
    const used = new Set(g.order.slice(0, g.qi).map(s => s.id)), list = c.songs.filter(s => !used.has(s.id) && !ctx.block.has(s.id));
    const fresh = S.noExclude ? list : list.filter(s => !room.played.has(s.id)), notRecent = fresh.filter(s => !recent.has(s.id));
    const alt = (!S.noExclude && notRecent.length) ? notRecent : fresh.length ? fresh : list;
    if (alt.length) g.order[g.qi] = alt[crypto.randomInt(alt.length)];
    if (!S.noRecord) recordPlayed(room, g.order[g.qi]);
  }

  // ── 答え合わせ：クイズの点を置きかえる。コマは少し見せてから動かす ──
  function reveal(room, q, results) {
    const g = room.game, mp = g.mp, out = [], c = mp.countries[mp.cur];
    const right = results.filter(r => r.correct).sort((a, b) => (a.elapsed ?? 99) - (b.elapsed ?? 99));
    for (const r of results) {
      const p = byId(room, r.id); if (!p) continue;
      const i = right.indexOf(r), own = i === 0 ? R.right + R.fastest : i > 0 ? R.right : 0;
      p.score = Math.max(0, p.score - (r.points || 0) + own); r.points = own;
      if (i >= 0) { const n = i === 0 ? 1 + R.fastCard : 1; handOf(mp, ownerOf(room, p))[mp.cur] += n; out.push(`🃏 ${r.name} ${c.icon}${c.label} カード${n}枚${i === 0 ? '（最速）' : ''}`); }
      if (i >= 0 && (r.elapsed ?? 99) <= EARLY_SEC) {
        const again = [die(), die()], now = mp.dice.get(r.id) || [die(), die()];
        if (again[0] + again[1] > now[0] + now[1]) mp.dice.set(r.id, again);
        r.mpEarly = true; out.push(`⚡ ${r.name} 早耳！ サイコロを振り直し`);
      }
    }
    if (R.catchup) { // 最下位の人に救済のカード
      const owners = [...new Set(results.map(r => ownerOf(room, byId(room, r.id))).filter(Boolean))];
      const worth = owners.map(o => ({ o, v: membersOf(room, o).reduce((s, p) => s + p.score, 0) + mp.board.filter(b => b.owner === o).reduce((s, b) => s + b.pts, 0) })).sort((a, b) => a.v - b.v);
      if (worth.length > 1 && worth[0].v !== worth[worth.length - 1].v) { const c2 = crypto.randomInt(8); handOf(mp, worth[0].o)[c2] += R.catchup; out.push(`🍀 ${ownerName(room, worth[0].o)} 最下位の救済：${mp.countries[c2].label} カード${R.catchup}枚`); }
    }
    mp.step = 'reveal';
    const order = [...right, ...results.filter(r => !r.correct)];
    later(room, () => { if (room.game === g) move(room, order, right[0]?.id); }, REVEAL_MS);
    return out;
  }

  function goPast(room, mp, p, msgs) { // スタートを通った
    const laps = (mp.laps.get(p.id) || 0) + 1; mp.laps.set(p.id, laps); p.score += GO_PTS; msgs.push(`スタート通過 +${GO_PTS}`);
    if (laps > mp.firstLap) { mp.firstLap = laps; p.score += FIRST_LAP_PTS; msgs.push(`🥇 ${laps}周目一番乗り +${FIRST_LAP_PTS}・次の国を選べる`); mp.pick = { id: p.id, name: p.name }; }
  }
  function rentOf(mp, sq, dice) {
    const own = t => mp.board.filter(b => b.kind === t && b.owner === sq.owner).length;
    if (sq.kind === 'rail') return RAIL_RENT[own('rail')];
    if (sq.kind === 'util') return UTIL_MULT[own('util')] * (dice || 7);
    const set = mp.board.filter(b => b.c === sq.c && b.kind === 'city').every(b => b.owner === sq.owner);
    return sq.rents[sq.lv] * (set && !sq.lv ? 2 : 1);
  }
  function giveCards(mp, id, c, n) { handOf(mp, id)[c] += n; return `${mp.countries[c].icon}${mp.countries[c].label} カード${n}枚`; }
  function land(room, mp, p, sq, dice, msgs, taken) {
    if (sq.kind === 'city' || sq.kind === 'rail' || sq.kind === 'util') {
      if (sq.owner && sq.owner !== ownerOf(room, p)) {
        const v = pay(p, Math.round(rentOf(mp, sq, dice) * R.rentX / 10) * 10), all = membersOf(room, sq.owner), on = all.filter(x => x.connected), to = on.length ? on : all;
        const first = to.find(x => x.id === sq.by) || to[0], share = Math.floor(v / Math.max(1, to.length) / 10) * 10; // 味方で等分。端数は買った人に
        for (const x of to) x.score += share;
        if (first) first.score += v - share * to.length;
        mp.rent = v > 0 && first ? { to: first.id, pts: v } : null;
        msgs.push(`🏠 ${sq.name}：${ownerName(room, sq.owner)}に家賃 ${v}点`);
        return;
      }
      if (sq.kind === 'city') {
        if (crypto.randomInt(2)) { p.score += LAND_PTS; msgs.push(`${sq.name}：+${LAND_PTS}点`); } else msgs.push(`${sq.name}：${giveCards(mp, ownerOf(room, p), sq.c, 1)}`);
      } else msgs.push(sq.name);
      if (!sq.owner && !taken.has(sq.i)) { taken.add(sq.i); mp.offers.set(p.id, sq.i); }
    } else if (sq.kind === 'chance' || sq.kind === 'chest') {
      const e = pick(sq.kind === 'chance' ? CHANCE : CHEST); let m = `${SPECIAL[sq.kind][1]} ${e.t}`;
      if (e.pts > 0) { p.score += e.pts; m += ` +${e.pts}点`; }
      if (e.pts < 0) m += ` -${pay(p, -e.pts)}点`;
      if (e.card) m += `：${giveCards(mp, ownerOf(room, p), crypto.randomInt(8), e.card)}`;
      if (e.all > 0) { let sum = 0; for (const o of players(room)) if (ownerOf(room, o) !== ownerOf(room, p)) sum += pay(o, e.all); p.score += sum; m += ` ${e.all}点ずつ（+${sum}点）`; }
      if (e.all < 0) { for (const o of players(room)) if (ownerOf(room, o) !== ownerOf(room, p)) o.score += pay(p, -e.all); m += ` 1人${-e.all}点`; }
      if (e.pick) mp.pick = { id: p.id, name: p.name };
      msgs.push(m);
      if (e.go) { mp.pos.set(p.id, 0); goPast(room, mp, p, msgs); }
      if (e.jail) { mp.pos.set(p.id, JAIL_POS); mp.jail.add(p.id); }
    } else if (sq.kind === 'tax') msgs.push(`💸 ${sq.name} -${pay(p, sq.tax)}点`);
    else if (sq.kind === 'shop') { mp.half.add(p.id); msgs.push('🏦 取引所：このターン、カードが半額'); }
    else if (sq.kind === 'gojail') { mp.pos.set(p.id, JAIL_POS); mp.jail.add(p.id); msgs.push('👮 刑務所へ！ 次は1回休み'); }
  }
  function move(room, order, fastest) {
    const g = room.game, mp = g.mp, taken = new Set(); mp.moves = []; mp.moveN++;
    for (const r of order) {
      const p = byId(room, r.id); if (!p) continue;
      const msgs = [], dd = mp.dice.get(r.id) || [die(), die()], n = dd[0] + dd[1], from = mp.pos.get(r.id) || 0;
      if (mp.jail.has(r.id)) {
        mp.jail.delete(r.id);
        if (r.id !== fastest) { msgs.push('🚔 刑務所で1回休み'); mp.moves.push({ id: r.id, name: r.name, from, steps: 0, to: from, msg: msgs.join(' ／ ') }); say(mp, `${r.name} ${msgs[0]}`); continue; }
        msgs.push('🔓 最速の正解で出所');
      }
      const to = (from + n) % 40; if (from + n >= 40) goPast(room, mp, p, msgs);
      mp.pos.set(r.id, to);
      mp.rent = null; land(room, mp, p, mp.board[to], n, msgs, taken);
      const text = `${n}マス → ${msgs.join(' ／ ') || mp.board[to].name}`;
      mp.moves.push({ id: r.id, name: r.name, from, steps: n, to: mp.pos.get(r.id), msg: text, rent: mp.rent });
      say(mp, `🎲 ${r.name} ${text}`);
    }
    mp.step = 'move';
    broadcastRoom(room);
    later(room, () => { if (room.game === g) startAct(room); }, Math.max(0, ...mp.moves.map((m, k) => k * STAGGER_MS + m.steps * STEP_MS)) + 1400); // 画面でコマが歩き終わるまで
  }
  function startAct(room) {
    const g = room.game, mp = g.mp; mp.step = 'act';
    const sec = mp.offers.size || mp.pick ? ACT_LONG : ACT_SHORT;
    mp.until = Date.now() + sec * 1000; mp.actId = (mp.actId || 0) + 1; const id = mp.actId;
    later(room, () => { if (room.game === g && mp.actId === id && mp.step === 'act') endAct(room); }, sec * 1000);
    broadcastRoom(room);
  }
  function extend(room, sec) { // 申し込みがあったら、返事の時間をのばす
    const g = room.game, mp = g.mp;
    if (mp.until - Date.now() >= sec * 1000) return;
    mp.until = Date.now() + sec * 1000; mp.actId++; const id = mp.actId;
    later(room, () => { if (room.game === g && mp.actId === id && mp.step === 'act') endAct(room); }, sec * 1000);
  }
  function endAct(room) {
    const mp = room.game.mp; mp.step = 'wait'; mp.offers.clear(); mp.trades = [];
    if (mp.pick) { mp.nextC = crypto.randomInt(8); mp.pick = null; }
    if (room.settings.autoNext > 0) nextQuestion(room); else broadcastRoom(room);
  }
  const busy = room => { const s = room.game.mp.step; return s !== 'wait'; };

  // ── 行動（行動タイムのあいだだけ）──
  function act(room, player, type, a) {
    const g = room?.game, mp = g?.mp; if (!mp || !player || mp.step !== 'act') return;
    const id = player.id, own = ownerOf(room, player), hand = handOf(mp, own), c = Number(a?.c);
    if (type === 'buy') {
      const i = mp.offers.get(id); if (i == null) return;
      const sq = mp.board[i]; if (sq.owner) return;
      if (sq.kind === 'city') {
        const use = Math.min(hand[sq.c], sq.cards), cost = (sq.cards - use) * CARD_PTS;
        if (player.score < cost) return;
        hand[sq.c] -= use; player.score -= cost;
        say(mp, `🏠 ${player.name} ${sq.name} を購入（カード${use}枚${cost ? `＋${cost}点` : ''}）`);
      } else { if (player.score < sq.pts) return; player.score -= sq.pts; say(mp, `🚃 ${player.name} ${sq.name} を購入（${sq.pts}点）`); }
      sq.owner = own; sq.by = id; mp.offers.delete(id);
    } else if (type === 'skip') mp.offers.delete(id);
    else if (type === 'house') {
      const sq = mp.board[Number(a?.i)]; if (!sq || sq.kind !== 'city' || sq.owner !== own || sq.lv >= MAX_HOUSE || mp.built.has(sq.i)) return;
      if (R.houseAny) { // どの国のカードでも建てられる
        if (hand.reduce((x, y) => x + y, 0) < R.houseAny) return;
        for (let n = R.houseAny; n > 0; n--) hand[hand.indexOf(Math.max(...hand))]--;
      } else { if (hand[sq.c] < sq.cards) return; hand[sq.c] -= sq.cards; }
      sq.lv++; mp.built.add(sq.i); say(mp, `🏘 ${player.name} ${sq.name} に家を建てた（${sq.lv}軒）`);
    } else if (type === 'cardBuy') {
      if (!(c >= 0 && c < 8)) return;
      const price = mp.half.has(id) ? Math.round(CARD_PTS / 2) : CARD_PTS;
      if (player.score < price) return; player.score -= price; hand[c]++;
    } else if (type === 'cardSell') {
      if (!(c >= 0 && c < 8) || hand[c] < 1) return; hand[c]--; player.score += SELL_PTS;
    } else if (type === 'pick') {
      if (mp.pick?.id !== id || !(c >= 0 && c < 8)) return;
      mp.nextC = c; mp.pick = null; say(mp, `🎵 ${player.name} 次の国は ${mp.countries[c].icon}${mp.countries[c].label}`);
    } else if (type === 'trade') {
      const to = byId(room, String(a?.to)), give = Number(a?.give), get = Number(a?.get), pts = Math.max(0, Math.min(5000, Math.floor(Number(a?.pts) || 0)));
      if (!to || ownerOf(room, to) === own || !(get >= 0 && get < 8) || mp.trades.filter(t => t.from === id).length >= 3) return;
      if (give >= 0 ? !(give < 8 && hand[give] > 0) : !(pts > 0 && player.score >= pts)) return;
      mp.trades.push({ n: ++mp.tradeN, from: id, fromName: player.name, to: to.id, toName: to.name, give: give >= 0 ? give : -1, pts: give >= 0 ? 0 : pts, get });
      extend(room, TRADE_EXTRA);
    } else if (type === 'tradeAns') {
      const k = mp.trades.findIndex(t => t.n === Number(a?.n)); if (k < 0) return;
      const t = mp.trades[k]; if (t.to !== id && t.from !== id) return;
      mp.trades.splice(k, 1);
      if (t.to === id && a?.ok) {
        const from = byId(room, t.from), fh = from && handOf(mp, ownerOf(room, from)); if (!from || hand[t.get] < 1) return broadcastRoom(room);
        if (t.give >= 0 ? fh[t.give] < 1 : from.score < t.pts) return broadcastRoom(room);
        hand[t.get]--; fh[t.get]++;
        if (t.give >= 0) { fh[t.give]--; hand[t.give]++; } else { from.score -= t.pts; player.score += t.pts; }
        say(mp, `🤝 ${t.fromName} と ${t.toName} がトレード成立`);
      }
    } else if (type === 'ready') mp.ready.add(id);
    const pending = mp.offers.size || mp.pick || mp.trades.length;
    if (!pending && players(room).filter(p => p.connected).every(p => mp.ready.has(p.id))) { mp.actId++; return endAct(room); }
    broadcastRoom(room);
  }

  function publicState(room) {
    const mp = room.game?.mp; if (!mp || room.state !== 'playing') return null;
    return {
      step: mp.step, until: mp.until, cur: mp.cur, moves: mp.moves, moveN: mp.moveN, log: mp.log.slice(-6), pick: mp.pick, half: [...mp.half], ready: [...mp.ready], trades: mp.trades, built: [...mp.built],
      teams: room.settings.teams ? Object.keys(TEAM_NAME).map(t => ({ id: t, name: TEAM_NAME[t], color: TEAM_COLOR[t], score: membersOf(room, t).reduce((s, p) => s + p.score, 0), land: landOf(room, mp, t) })) : null,
      offers: [...mp.offers], countries: mp.countries.map((c, i) => ({ label: c.label, icon: c.icon, color: COLORS[i] })), board: mp.board,
      prices: { card: CARD_PTS, sell: SELL_PTS }, qNo: room.game.qi + 1, qTotal: room.game.order.length, maxHouse: MAX_HOUSE,
      players: players(room).map(p => ({ id: p.id, name: p.name, owner: ownerOf(room, p), team: room.settings.teams ? p.team || null : null, score: p.score, pos: mp.pos.get(p.id) || 0, laps: mp.laps.get(p.id) || 0, jail: mp.jail.has(p.id), dice: mp.dice.get(p.id) || null, cards: handOf(mp, ownerOf(room, p)) })),
    };
  }
  function finalize(room, ranking) { // 持ち点＋土地（家を含む）＋カード。チーム戦の個人順位は、チームの土地を人数で割って足す
    const mp = room.game.mp;
    for (const r of ranking) {
      const o = ownerOf(room, byId(room, r.id)) ?? r.id, n = Math.max(1, membersOf(room, o).length);
      const land = Math.round(landOf(room, mp, o) / n);
      const cards = Math.round(handOf(mp, o).reduce((a, b) => a + b, 0) * R.cardEnd / n);
      r.mpLand = land; r.mpCards = cards; r.score += land + cards;
    }
    ranking.sort((a, b) => b.score - a.score);
  }
  const teamLand = (room, team) => landOf(room, room.game.mp, team) + handOf(room.game.mp, team).reduce((a, b) => a + b, 0) * R.cardEnd;
  return { init, turn, reveal, busy, act, publicState, finalize, teamLand };
};
