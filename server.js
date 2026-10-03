// アニソンイントロクイズ対戦サーバー（v1）
// Express で public/ を配信し、同じポートで Socket.IO を動かす。
// 進行のタイミング（イントロ→サビ→答え合わせ）と採点はすべてサーバーが決める。

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const fs = require('fs');
const { isCorrectText, shortForm } = require('./lib/normalize');

const PORT = process.env.PORT || 3000;
const SONGS_PATH = path.join(__dirname, 'data', 'songs.json');
const DECOYS = require('./data/decoys.json');

// 出題に使う曲（再生できないと分かった曲は除く）。曲チェック画面で保存すると読み直す
let ALL_SONGS = [], SONGS = [];
function loadSongs() {
  ALL_SONGS = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
  SONGS = ALL_SONGS.filter(s => s.id && s.embeddable !== false);
}
loadSongs();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));

// ── 曲データ API（曲チェック画面用）──
// 書き込みは、このPCから開いたとき（localhost）か、環境変数 ADMIN_KEY と同じキーを付けたときだけ許可
function canEdit(req) {
  if (process.env.ADMIN_KEY) return req.get('x-admin-key') === process.env.ADMIN_KEY;
  // Render などの公開サーバーでは、外からのアクセスも中継（プロキシ）経由で 127.0.0.1 に見える。
  // そのため、公開サーバー上や、中継を通ってきたアクセスは常に保存不可にする。
  if (process.env.RENDER || req.get('x-forwarded-for') || req.get('forwarded')) return false;
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
// ファイルを直接編集・取り込みした内容も反映されるよう、毎回読み直す
app.get('/api/songs', (req, res) => { loadSongs(); res.json({ songs: ALL_SONGS, canEdit: canEdit(req) }); });
app.post('/api/songs', (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: '保存する権限がありません' });
  const list = req.body?.songs;
  const valid = Array.isArray(list) && list.every(s =>
    s && typeof s.id === 'string' && /^[\w-]{11}$/.test(s.id) &&
    Number.isFinite(s.intro) && Number.isFinite(s.chorus));
  if (!valid) return res.status(400).json({ error: '曲データの形式が正しくありません' });

  // 画面で編集する項目だけを曲IDごとに上書きする（画面を開いた後にCSVから取り込んだ曲を消さないため）
  const EDITABLE = ['intro', 'chorus', 'aliases', 'embeddable', 'error', 'checkedAt', 'checkedOrigin'];
  loadSongs();
  const byId = new Map(ALL_SONGS.map(s => [s.id, s]));
  let changed = 0;
  for (const s of list) {
    const cur = byId.get(s.id);
    if (!cur) continue;
    for (const k of EDITABLE) {
      if (k in s) cur[k] = s[k]; else delete cur[k];
    }
    changed++;
  }
  const tmp = SONGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ALL_SONGS, null, 2) + '\n');
  fs.renameSync(tmp, SONGS_PATH);
  loadSongs();
  res.json({ ok: true, total: ALL_SONGS.length, playable: SONGS.length, changed });
});
const server = http.createServer(app);
const io = new Server(server);

// ── 設定 ──
const OPTIONS = {
  introLen: [3, 5, 10, 15],
  hintAt: [5, 10, 15, 20],
  chorusLen: [10, 15, 20],
  questions: [5, 10, 20, 30],
  mode: ['score', 'buzz'],
  answerMode: ['choice', 'input'],
  clues: [true, false],
  lifelines: [true, false],
  theme: ['random', 'neon', 'studio', 'pop', 'retro'],
};
const THEMES = ['neon', 'studio', 'pop', 'retro'];
const randomTheme = () => THEMES[crypto.randomInt(THEMES.length)];
// 設定が「ランダム」ならゲームごとに選び直す。固定テーマならそれを使う
function pickTheme(room) { room.theme = room.settings.theme === 'random' ? randomTheme() : room.settings.theme; }
const DEFAULTS = { introLen: 5, hintAt: 10, chorusLen: 15, choices: 8, mode: 'score', questions: 10, maxPlayers: 12,
                   yearFrom: 1980, yearTo: 2029, answerMode: 'choice', clues: true, lifelines: true, theme: 'random' };
const LIFELINES = ['fifty', 'audience', 'phone', 'replay']; // 50:50 / オーディエンス / テレフォン / もう一度聴く
const NEAR_YEARS = 5; // 選択肢は、まず出題曲の前後この年数以内の曲から選ぶ
const READY_TIMEOUT = 4000;      // 全員の読み込みを待つ上限
const ROOM_TTL = 10 * 60 * 1000; // 全員いなくなってから部屋を消すまで
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 0/O/1/I/L を除く

function sanitizeSettings(input, base) {
  const s = { ...base };
  if (!input || typeof input !== 'object') return s;
  for (const [k, list] of Object.entries(OPTIONS)) {
    if (list.includes(input[k])) s[k] = input[k];
  }
  const c = parseInt(input.choices, 10);
  if (c >= 2 && c <= 12) s.choices = c;
  const m = parseInt(input.maxPlayers, 10);
  if (m >= 2 && m <= 12) s.maxPlayers = m;
  const yf = parseInt(input.yearFrom, 10), yt = parseInt(input.yearTo, 10);
  if (yf >= 1960 && yf <= 2100) s.yearFrom = yf;
  if (yt >= 1960 && yt <= 2100) s.yearTo = yt;
  if (s.yearFrom > s.yearTo) [s.yearFrom, s.yearTo] = [s.yearTo, s.yearFrom];
  return s;
}

// 部屋の年代設定に合う曲
function poolFor(settings) {
  return SONGS.filter(s => s.year >= settings.yearFrom && s.year <= settings.yearTo);
}

const cleanName = n => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12) || 'ゲスト';
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ── 部屋 ──
const rooms = new Map();

function newCode() {
  let code;
  do { code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: newCode(),
    hostId: null,
    settings: { ...DEFAULTS },
    players: new Map(), // token -> player
    state: 'lobby',     // lobby | playing | over
    game: null,
    emptySince: null,
    theme: randomTheme(),
  };
  rooms.set(room.code, room);
  return room;
}

// 外に出す情報（token は席の鍵なので出さない）
function publicRoom(room) {
  const q = room.game?.q;
  return {
    code: room.code,
    hostId: room.hostId,
    settings: room.settings,
    poolSize: poolFor(room.settings).length,
    theme: room.theme,
    state: room.state,
    phase: q?.phase || null,
    qNo: room.game ? room.game.qi + 1 : 0,
    qTotal: room.game ? room.game.order.length : 0,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected,
      answered: !!q?.answers.has(p.token), inGame: !!q?.participants.has(p.token),
      lifelines: p.lifelines || null,
    })),
  };
}
const broadcastRoom = room => io.to(room.code).emit('room', publicRoom(room));

function connectedPlayers(room) { return [...room.players.values()].filter(p => p.connected); }

function ensureHost(room) {
  const host = [...room.players.values()].find(p => p.id === room.hostId);
  if (host && host.connected) return;
  const next = connectedPlayers(room)[0];
  if (next) room.hostId = next.id;
}

// ── 進行 ──
function clearTimers(room) {
  room.game?.timers.forEach(clearTimeout);
  if (room.game) room.game.timers = [];
}
const later = (room, fn, ms) => room.game.timers.push(setTimeout(fn, ms));

function startGame(room) {
  const pool = poolFor(room.settings);
  if (pool.length === 0) return false;
  const n = Math.min(room.settings.questions, pool.length);
  if (room.settings.theme === 'random') pickTheme(room);
  room.state = 'playing';
  for (const p of room.players.values()) { p.score = 0; p.lifelines = freshLifelines(room.settings); }
  // 曲オブジェクトそのものを持つ（ゲーム中に曲データが保存し直されても影響しないように）
  room.game = { order: shuffle([...pool]).slice(0, n), pool, qi: -1, q: null, timers: [] };
  nextQuestion(room);
  return true;
}

// ライフラインは1ゲームにつき各1回（部屋設定で無しにもできる）
function freshLifelines(settings) {
  return Object.fromEntries(LIFELINES.map(k => [k, settings.lifelines ? 1 : 0]));
}

// 選択肢は「出題曲に年が近い曲」→「同じ年代設定の曲」→「それ以外の曲」→「ダミー」の順に選ぶ。
// 年代がばらばらだと、知らなくても消去法で当たってしまうため。
function buildChoices(song, count, pool) {
  const near = s => Math.abs(s.year - song.year) <= NEAR_YEARS;
  const toChoice = s => ({ title: s.title, work: s.work });
  const others = SONGS.filter(s => s !== song);
  const candidates = [
    ...shuffle(pool.filter(s => s !== song && near(s))).map(toChoice),
    ...shuffle(pool.filter(s => s !== song && !near(s))).map(toChoice),
    ...shuffle(others.filter(s => !pool.includes(s))).map(toChoice),
    ...shuffle(DECOYS.map(([title, work]) => ({ title, work }))),
  ];
  const seen = new Set([song.title]);
  const picks = [];
  for (const c of candidates) {
    if (picks.length >= count - 1) break;
    if (seen.has(c.title)) continue;
    seen.add(c.title); picks.push(c);
  }
  const choices = shuffle([{ title: song.title, work: song.work }, ...picks]);
  return { choices, correctIndex: choices.findIndex(c => c.title === song.title) };
}

function nextQuestion(room) {
  clearTimers(room);
  const g = room.game;
  g.qi++;
  if (g.qi >= g.order.length) return endGame(room);

  const song = g.order[g.qi];
  const input = room.settings.answerMode === 'input';
  const { choices, correctIndex } = input ? { choices: null, correctIndex: null }
                                          : buildChoices(song, room.settings.choices, g.pool);
  g.q = {
    song, choices, correctIndex,
    phase: 'loading', t0: 0,
    ready: new Set(),
    answers: new Map(), // token -> { index, given, pass, elapsed, correct, points, hint }
    participants: new Set(connectedPlayers(room).map(p => p.token)),
    winner: null,
    clues: [],          // 出したヒント（再接続した人に送り直す）
    lifelineResults: new Map(), // token -> [{ type, ... }]（再接続した人に送り直す）
  };
  // 途中参加した人にもライフラインを持たせる
  for (const p of room.players.values()) if (!p.lifelines) p.lifelines = freshLifelines(room.settings);
  io.to(room.code).emit('question', questionPayload(room));
  broadcastRoom(room);
  later(room, () => go(room), READY_TIMEOUT);
}

function questionPayload(room) {
  const g = room.game, q = g.q;
  return {
    qNo: g.qi + 1, qTotal: g.order.length,
    videoId: q.song.id, intro: q.song.intro || 0,
    answerMode: room.settings.answerMode,
    choices: q.choices, settings: room.settings,
  };
}

// 時間で増えるヒント：サビに入ってから 年 → 歌手 → 作品名の頭文字
function clueList(song) {
  const work = shortForm(String(song.work).replace(/^(劇場版|映画)\s*/, '')).replace(/^[【「『\[（(<〈]+/, '');
  return [
    { level: 1, label: '年', text: `${song.year}年の曲` },
    { level: 2, label: '歌手', text: song.artist },
    { level: 3, label: '作品', text: `「${[...work][0]}」から始まる作品` },
  ];
}

// 出題中に再接続した人へ、いまの問題と進み具合を送り直す
function resendQuestion(room, socket, token) {
  const q = room.game?.q;
  if (!q || !q.participants.has(token) || q.phase === 'reveal') return;
  const S = room.settings;
  socket.emit('question', questionPayload(room));
  if (q.phase === 'intro' || q.phase === 'chorus') {
    const offset = (Date.now() - q.t0) / 1000;
    socket.emit('go', { intro: q.song.intro || 0, hintAt: S.hintAt, total: S.hintAt + S.chorusLen, offset,
                        introLen: S.introLen });
    if (q.phase === 'chorus') socket.emit('hint', { chorus: chorusOf(q.song) });
  }
  q.clues.forEach(c => socket.emit('clue', c));
  (q.lifelineResults.get(token) || []).forEach(r => socket.emit('lifelineResult', r));
  const a = q.answers.get(token);
  if (a) socket.emit('answered', { index: a.index, given: a.given, pass: a.pass });
}

function chorusOf(song) { return song.chorus > 0 ? song.chorus : (song.intro || 0) + 50; }

function go(room) {
  const q = room.game.q;
  if (q.phase !== 'loading') return;
  clearTimers(room);
  const S = room.settings;
  q.phase = 'intro';
  q.t0 = Date.now();
  io.to(room.code).emit('go', { intro: q.song.intro || 0, hintAt: S.hintAt, total: S.hintAt + S.chorusLen });
  if (S.introLen < S.hintAt) later(room, () => { if (q.phase === 'intro') io.to(room.code).emit('stopIntro'); }, S.introLen * 1000);
  later(room, () => {
    if (q.phase !== 'intro') return;
    q.phase = 'chorus';
    io.to(room.code).emit('hint', { chorus: chorusOf(q.song) });
    broadcastRoom(room);
  }, S.hintAt * 1000);
  if (S.clues) {
    clueList(q.song).forEach((c, i) => later(room, () => {
      if (q.phase !== 'intro' && q.phase !== 'chorus') return;
      q.clues.push(c);
      io.to(room.code).emit('clue', c);
    }, (S.hintAt + S.chorusLen * i / 3) * 1000));
  }
  later(room, () => reveal(room), (S.hintAt + S.chorusLen) * 1000);
  broadcastRoom(room);
}

// payload は { index }（選択肢）/ { text }（入力）/ { pass: true }（わからない）
function onAnswer(room, player, payload) {
  const q = room.game?.q;
  if (!q || (q.phase !== 'intro' && q.phase !== 'chorus')) return;
  if (!q.participants.has(player.token) || q.answers.has(player.token)) return;

  const S = room.settings;
  let index = null, given = null, pass = false, correct = false;
  if (payload?.pass === true) {
    pass = true;
  } else if (S.answerMode === 'input') {
    if (typeof payload?.text !== 'string') return;
    given = payload.text.trim().slice(0, 50);
    if (!given) return;
    correct = isCorrectText(given, q.song);
  } else {
    index = payload?.index;
    if (!Number.isInteger(index) || index < 0 || index >= q.choices.length) return;
    correct = index === q.correctIndex;
  }

  const elapsed = (Date.now() - q.t0) / 1000;
  const hint = q.phase === 'chorus';
  let points = 0;
  if (correct) {
    if (S.mode === 'score') {
      const base = Math.round(100 + 900 * Math.max(0, 1 - elapsed / (S.hintAt + S.chorusLen)));
      points = hint ? Math.round(base / 2) : base;
    } else if (!q.winner) {
      points = hint ? 1 : 2;
      q.winner = player.token;
    }
  }
  player.score += points;
  q.answers.set(player.token, { index, given, pass, elapsed, correct, points, hint });

  const remaining = [...q.participants].filter(t => room.players.get(t)?.connected && !q.answers.has(t));
  if ((S.mode === 'buzz' && q.winner) || remaining.length === 0) reveal(room);
  else broadcastRoom(room);
}

// ライフラインの効果。使った本人にだけ返す内容を作る
function useLifeline(room, q, player, type) {
  const input = room.settings.answerMode === 'input';
  if (type === 'fifty') {
    if (input) {
      // 入力：曲名の文字数と最初の1文字
      const chars = [...String(q.song.title).normalize('NFKC').replace(/\s/g, '')];
      return { type, length: chars.length, first: chars[0] };
    }
    // 選択肢：不正解を半分消す（8択なら4つ消して4つ残る）
    const wrong = shuffle(q.choices.map((_, i) => i).filter(i => i !== q.correctIndex));
    return { type, hidden: wrong.slice(0, Math.ceil((q.choices.length - 1) / 2)) };
  }
  if (type === 'audience') {
    // 他の人がここまでに答えた内容（作り物の観客は出さない）
    const others = [...q.answers.entries()].filter(([t, a]) => t !== player.token && !a.pass);
    if (input) return { type, answered: others.length, correct: others.filter(([, a]) => a.correct).length };
    const counts = q.choices.map(() => 0);
    others.forEach(([, a]) => counts[a.index]++);
    return { type, answered: others.length, counts };
  }
  if (type === 'phone') {
    // 作品名は入力だとそのまま正解になるので、歌手か年のどちらかだけ
    const pick = crypto.randomInt(2) === 0
      ? `歌っているのは「${q.song.artist}」だと思うよ`
      : `たしか ${q.song.year} 年ごろの曲だったはず`;
    return { type, text: pick };
  }
  if (type === 'replay') return { type, intro: q.song.intro || 0 };
  return null;
}

function reveal(room) {
  const q = room.game.q;
  if (q.phase === 'reveal') return;
  clearTimers(room);
  q.phase = 'reveal';
  const s = q.song;
  const results = [...room.players.values()]
    .filter(p => q.participants.has(p.token))
    .map(p => {
      const a = q.answers.get(p.token);
      return { id: p.id, name: p.name, answered: !!a, index: a ? a.index : null, given: a?.given ?? null,
               pass: !!a?.pass, elapsed: a ? a.elapsed : null,
               correct: !!a?.correct, points: a ? a.points : 0, hint: !!a?.hint };
    })
    .sort((a, b) => (b.correct - a.correct) || ((a.elapsed ?? 99) - (b.elapsed ?? 99)));
  io.to(room.code).emit('reveal', {
    correctIndex: q.correctIndex,
    song: { title: s.title, work: s.work, artist: s.artist, year: s.year, type: s.type },
    intro: s.intro || 0, chorus: chorusOf(s),
    results,
    last: room.game.qi + 1 >= room.game.order.length,
  });
  broadcastRoom(room);
}

function skipQuestion(room, reason) {
  io.to(room.code).emit('notice', reason);
  nextQuestion(room);
}

function endGame(room) {
  clearTimers(room);
  room.state = 'over';
  room.game.q = null;
  const ranking = [...room.players.values()]
    .map(p => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
  io.to(room.code).emit('gameover', { ranking });
  broadcastRoom(room);
}

// ── 接続 ──
io.on('connection', socket => {
  let room = null, player = null;

  function enter(r, token, name) {
    let p = r.players.get(token);
    if (!p) {
      if (r.players.size >= r.settings.maxPlayers) return { ok: false, error: 'この部屋は満員です' };
      p = { token, id: crypto.randomUUID().slice(0, 8), name, score: 0, connected: true, socketId: socket.id };
      r.players.set(token, p);
    }
    p.name = name; p.connected = true; p.socketId = socket.id;
    r.emptySince = null;
    room = r; player = p;
    socket.join(r.code);
    if (!r.hostId) r.hostId = p.id;
    ensureHost(r);
    broadcastRoom(r);
    setImmediate(() => resendQuestion(r, socket, token)); // ack の後に届くように
    return { ok: true, code: r.code, you: p.id, room: publicRoom(r) };
  }

  socket.on('create', ({ token, name } = {}, ack) => {
    if (typeof ack !== 'function' || typeof token !== 'string' || token.length < 8) return;
    ack(enter(createRoom(), token, cleanName(name)));
  });

  socket.on('join', ({ code, token, name } = {}, ack) => {
    if (typeof ack !== 'function' || typeof token !== 'string' || token.length < 8) return;
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return ack({ ok: false, error: '部屋が見つかりません' });
    ack(enter(r, token, cleanName(name)));
  });

  const isHost = () => room && player && room.hostId === player.id;

  socket.on('settings', input => {
    if (!isHost() || room.state === 'playing') return;
    const prevTheme = room.settings.theme;
    room.settings = sanitizeSettings(input, room.settings);
    if (room.settings.theme !== prevTheme) pickTheme(room); // テーマを変えたらすぐ見た目に反映
    broadcastRoom(room);
  });

  socket.on('start', () => {
    if (!isHost() || room.state === 'playing') return;
    if (!startGame(room)) socket.emit('notice', '選んだ年代に出題できる曲がありません。年代の設定を広げてください');
  });

  socket.on('ready', () => {
    const q = room?.game?.q;
    if (!q || q.phase !== 'loading') return;
    q.ready.add(player.token);
    const waiting = [...q.participants].filter(t => room.players.get(t)?.connected && !q.ready.has(t));
    if (waiting.length === 0) go(room);
  });

  socket.on('answer', (payload = {}) => {
    if (room && player) onAnswer(room, player, payload);
  });

  // ライフライン。結果は使った本人にだけ返す
  socket.on('lifeline', ({ type } = {}) => {
    const q = room?.game?.q;
    if (!q || (q.phase !== 'intro' && q.phase !== 'chorus')) return;
    if (!q.participants.has(player.token) || q.answers.has(player.token)) return;
    if (!LIFELINES.includes(type) || !(player.lifelines?.[type] > 0)) return;
    const result = useLifeline(room, q, player, type);
    if (!result) return;
    player.lifelines[type]--;
    if (!q.lifelineResults.has(player.token)) q.lifelineResults.set(player.token, []);
    q.lifelineResults.get(player.token).push(result);
    socket.emit('lifelineResult', result);
    broadcastRoom(room);
  });

  // 埋め込み不可などで再生できない。ホストの再生が失敗したらその問題は飛ばす
  socket.on('playerError', ({ code } = {}) => {
    const q = room?.game?.q;
    if (!q || q.phase === 'reveal') return;
    console.warn(`[${room.code}] 再生エラー ${code} : ${q.song.title} (${q.song.id}) by ${player.name}`);
    if (isHost()) skipQuestion(room, `「再生できない動画」だったので次の問題へ進みます（エラー ${code}）`);
  });

  socket.on('next', () => {
    if (!isHost() || room.state !== 'playing' || room.game.q?.phase !== 'reveal') return;
    nextQuestion(room);
  });

  socket.on('backToLobby', () => {
    if (!isHost() || room.state === 'playing') return;
    room.state = 'lobby';
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    if (!room || !player || player.socketId !== socket.id) return;
    player.connected = false;
    ensureHost(room);
    if (connectedPlayers(room).length === 0) {
      room.emptySince = Date.now();
      clearTimers(room);
      if (room.state === 'playing') { room.state = 'over'; room.game.q = null; }
    } else if (room.game?.q) {
      const q = room.game.q;
      // 抜けた人を待たない
      if (q.phase === 'loading' && [...q.participants].every(t => !room.players.get(t)?.connected || q.ready.has(t))) go(room);
      else if ((q.phase === 'intro' || q.phase === 'chorus') &&
               [...q.participants].every(t => !room.players.get(t)?.connected || q.answers.has(t))) reveal(room);
    }
    broadcastRoom(room);
  });
});

// 空き部屋の掃除
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (r.emptySince && now - r.emptySince > ROOM_TTL) rooms.delete(code);
}, 60 * 1000);

server.listen(PORT, () => console.log(`イントロクイズ対戦サーバー起動: http://localhost:${PORT} （曲 ${SONGS.length} 件）`));
