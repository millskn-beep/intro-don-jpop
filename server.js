// アニソンイントロクイズ対戦サーバー（v1）
// Express で public/ を配信し、同じポートで Socket.IO を動かす。
// 進行のタイミング（イントロ→サビ→答え合わせ）と採点はすべてサーバーが決める。

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const fs = require('fs');
const { isCorrectText, isAlmostText, shortForm } = require('./lib/normalize');

const PORT = process.env.PORT || 3000;
const SONGS_PATH = path.join(__dirname, 'data', 'songs.json');
const DECOYS = require('./data/decoys.json');

// 出題に使う曲（再生できないと分かった曲は除く）。曲チェック画面で保存すると読み直す
let ALL_SONGS = [], SONGS = [];
function loadSongs() {
  ALL_SONGS = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
  SONGS = ALL_SONGS.filter(s => s.id && s.embeddable !== false);
  buildSeries();
}

// ── お題：ジャンル（data/genres.json）と作品（シリーズ）──
const GENRES = Object.fromEntries(Object.entries(require('./data/genres.json')).filter(([k]) => !k.startsWith('_')));
const GENRE_KEYS = Object.keys(GENRES);
const genresOf = song => GENRE_KEYS.filter(k => GENRES[k].keywords.some(w => String(song.work).includes(w)));
// 知名度（ジャンルとは別の分類）。曲データの fame。未設定の曲は「普通」
const FAME = [['top', '超有名'], ['famous', '有名'], ['normal', '普通'], ['minor', 'マイナー'], ['otaku', 'オタク']];
const FAME_KEYS = FAME.map(([k]) => k);
const fameOf = song => (FAME_KEYS.includes(song.fame) ? song.fame : 'normal');
const inTopic = (song, S) => {
  const topic = S.topic || 'all';
  if (topic === 'all') { // 「全部」のときだけ、除外にチェックしたジャンルの曲を外す（お題で選んだときはそのまま）
    const ex = S.excludeGenres || [];
    return !ex.length || !genresOf(song).some(k => ex.includes(k));
  }
  if (topic === 'series') return SERIES_OF.get(song.id) === S.series;
  return GENRES[topic] ? genresOf(song).includes(topic) : true;
};

// 作品名からシリーズ名を作る（「進撃の巨人 The Final Season」→「進撃の巨人」、「ONE PIECE FILM RED」→「ONE PIECE」）。
// さらに、名前が別のシリーズ名で始まるものはまとめる（「ラブライブ!サンシャイン!!」→「ラブライブ!」）
const MIN_SERIES_SONGS = 5;
let SERIES_OF = new Map(), SERIES_LIST = [];
const seriesKey = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}ー〜～]/gu, '').replace(/(第?\d+期|ii+|iii|iv|\d)$/, '');
function seriesName(work) {
  let w = String(work).normalize('NFKC').replace(/^(劇場版|新劇場版|映画|劇場総集編|TVアニメ|SPECIAL EDITED VERSION)\s*/, '').trim();
  if (/^[\x00-\x7f]/.test(w)) {
    const m = w.match(/^(.+?)(?=\s+(FILM|STAMPEDE|HEROINES|Season|season|The\s|THE\s|\d+(st|nd|rd|th)|第|[^\x00-\x7f]))/);
    return (m ? m[1] : w.split(/\s+[-〜]/)[0]).trim();
  }
  return w.split(/\s|〜|～| -/)[0].trim();
}
function buildSeries() {
  const groups = new Map(); // key -> { name, ids }
  for (const s of SONGS) {
    const name = seriesName(s.work), key = seriesKey(name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { name, ids: [] });
    const g = groups.get(key);
    if (name.length < g.name.length) g.name = name;
    g.ids.push(s.id);
  }
  // 長い名前のシリーズを、それで始まる短い名前のシリーズにまとめる
  const keys = [...groups.keys()].sort((a, b) => a.length - b.length);
  for (const k of keys) {
    const parent = keys.find(p => p !== k && p.length >= 3 && k.startsWith(p) && groups.has(p));
    if (parent && groups.has(k)) { groups.get(parent).ids.push(...groups.get(k).ids); groups.delete(k); }
  }
  // 「マクロス7」「マクロスF」などをまとめたときは、末尾の番号を落とした名前で表示する
  for (const g of groups.values()) {
    const names = new Set(g.ids.map(id => seriesName(SONGS.find(s => s.id === id).work)));
    if (names.size > 1) g.name = g.name.replace(/\s*(\d+|[IVX]+|[ⅡⅢⅣⅤ])$/, '');
  }
  SERIES_OF = new Map();
  for (const g of groups.values()) for (const id of g.ids) SERIES_OF.set(id, g.name);
  SERIES_LIST = [...groups.values()].filter(g => g.ids.length >= MIN_SERIES_SONGS)
    .map(g => ({ name: g.name, count: g.ids.length })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
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
// 待機画面のお題の選択肢（ジャンルと、曲が5曲以上ある作品）
app.get('/api/topics', (req, res) => res.json({
  genres: GENRE_KEYS.map(k => ({ key: k, label: GENRES[k].label, count: SONGS.filter(s => genresOf(s).includes(k)).length })),
  series: SERIES_LIST,
  fame: FAME.map(([k, label]) => ({ key: k, label, count: SONGS.filter(s => fameOf(s) === k).length })),
}));
app.get('/api/songs', (req, res) => { loadSongs(); res.json({ songs: ALL_SONGS, canEdit: canEdit(req) }); });
app.post('/api/songs', (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: '保存する権限がありません' });
  const list = req.body?.songs;
  const valid = Array.isArray(list) && list.every(s =>
    s && typeof s.id === 'string' && /^[\w-]{11}$/.test(s.id) &&
    Number.isFinite(s.intro) && Number.isFinite(s.chorus));
  if (!valid) return res.status(400).json({ error: '曲データの形式が正しくありません' });

  // 画面で編集する項目だけを曲IDごとに上書きする（画面を開いた後にCSVから取り込んだ曲を消さないため）
  const EDITABLE = ['intro', 'chorus', 'aliases', 'embeddable', 'error', 'checkedAt', 'checkedOrigin', 'introMeasured', 'chorusSource', 'chorusChecked', 'introMethod', 'introUnsure', 'fame', 'views', 'channel', 'viewsAt'];
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
  typingExtra: [5, 10, 15, 20, 30],
  questions: [5, 10, 20, 30],
  mode: ['score', 'buzz'],
  answerMode: ['choice', 'input'],
  clues: [true, false],
  lifelines: [true, false],
  quizType: ['intro', 'sabimae', 'mix'], // イントロ／サビ前／1問ごとにランダム
  leadSec: [3, 5, 10],                   // サビ前：サビの何秒前から流すか
  autoNext: [8, 12, 0],                  // 答え合わせから自動で次へ進むまでの秒数（0 は自動で進まない）
  bonus: [true, false],                  // 連続正解ボーナス・最終問題2倍
  topic: ['all', 'series', ...GENRE_KEYS], // お題：全部／作品を選ぶ／ジャンル（data/genres.json）
  introPlays: [1, 2, 3],                 // イントロを流す回数（わからなかったときのため、頭から流し直す）
};

const AVATARS = 12; // 席ごとに割り当てるアバター画像の数（public/assets/glass/avatar-1〜12）
const DEFAULTS = { introLen: 5, hintAt: 10, chorusLen: 15, choices: 8, mode: 'score', questions: 10, maxPlayers: 12,
                   yearFrom: 1980, yearTo: 2029, answerMode: 'choice', clues: true, lifelines: false, typingExtra: 10,
                   quizType: 'intro', leadSec: 5, autoNext: 8, bonus: true, topic: 'all', introPlays: 1 };
// 新しい部屋で最初から除外しておくジャンル（アニソン以外）
const DEFAULT_EXCLUDE = ['vocaloid', 'jpop']; // ライフラインは使わない（画面からも外した）
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
  if (SERIES_LIST.some(x => x.name === input.series)) s.series = input.series;
  if (s.topic === 'series' && !SERIES_LIST.some(x => x.name === s.series)) s.series = SERIES_LIST[0]?.name || '';
  const c = parseInt(input.choices, 10);
  if (c >= 2 && c <= 12) s.choices = c;
  const m = parseInt(input.maxPlayers, 10);
  if (m >= 2 && m <= 12) s.maxPlayers = m;
  const yf = parseInt(input.yearFrom, 10), yt = parseInt(input.yearTo, 10);
  if (yf >= 1960 && yf <= 2100) s.yearFrom = yf;
  if (yt >= 1960 && yt <= 2100) s.yearTo = yt;
  // 知名度（チェック式・複数）。空なら全部
  if (Array.isArray(input.fame)) {
    const f = [...new Set(input.fame.filter(k => FAME_KEYS.includes(k)))];
    s.fame = f.length ? f : [...FAME_KEYS];
  }
  if (s.yearFrom > s.yearTo) [s.yearFrom, s.yearTo] = [s.yearTo, s.yearFrom];
  return s;
}

// 部屋の年代設定に合う曲
function poolFor(settings) {
  // 知名度はお題に関係なく、チェックした段階の曲だけにする（難しさの調整）
  const fame = Array.isArray(settings.fame) && settings.fame.length ? settings.fame : FAME_KEYS;
  return SONGS.filter(s => s.year >= settings.yearFrom && s.year <= settings.yearTo && inTopic(s, settings) && fame.includes(fameOf(s)));
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

// パスワードはそのまま持たず、部屋ごとの塩を混ぜたハッシュだけを持つ
const hashPassword = (salt, pw) => crypto.createHash('sha256').update(salt + '\u0000' + pw).digest('hex');
const cleanRoomName = n => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20);
const cleanPassword = p => String(p || '').slice(0, 32);

function createRoom({ roomName, password } = {}) {
  const pw = cleanPassword(password);
  const salt = crypto.randomBytes(8).toString('hex');
  const room = {
    code: newCode(),
    name: cleanRoomName(roomName),
    salt,
    passwordHash: pw ? hashPassword(salt, pw) : null,
    hostId: null,
    settings: { ...DEFAULTS, excludeGenres: DEFAULT_EXCLUDE.filter(k => GENRES[k]), fame: [...FAME_KEYS] },
    players: new Map(), // token -> player
    state: 'lobby',     // lobby | playing | over
    game: null,
    emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}

// ── 部屋一覧（ホーム画面用）。誰もいない部屋は出さない ──
function roomList() {
  return [...rooms.values()]
    .filter(r => connectedPlayers(r).length > 0)
    .map(r => {
      const host = [...r.players.values()].find(p => p.id === r.hostId);
      return {
        code: r.code,
        name: r.name || `${host?.name || 'ゲスト'}の部屋`,
        host: host?.name || '',
        players: connectedPlayers(r).length,
        max: r.settings.maxPlayers,
        state: r.state === 'playing' ? 'playing' : 'lobby',
        locked: !!r.passwordHash,
        yearFrom: r.settings.yearFrom, yearTo: r.settings.yearTo,
        answerMode: r.settings.answerMode, mode: r.settings.mode, questions: r.settings.questions,
      };
    })
    .sort((a, b) => (a.state === 'lobby' ? 0 : 1) - (b.state === 'lobby' ? 0 : 1) || b.players - a.players);
}
let roomListTimer = null;
function pushRoomList() {
  if (roomListTimer) return;
  roomListTimer = setTimeout(() => { roomListTimer = null; io.to('home').emit('rooms', roomList()); }, 300);
}

// 外に出す情報（token は席の鍵なので出さない）
function publicRoom(room) {
  const q = room.game?.q;
  return {
    code: room.code,
    name: room.name,
    locked: !!room.passwordHash,
    hostId: room.hostId,
    settings: room.settings,
    poolSize: poolFor(room.settings).length,
    excluded: room.played?.size || 0,
    paused: !!room.game?.paused,
    state: room.state,
    phase: q?.phase || null,
    qNo: room.game ? room.game.qi + 1 : 0,
    qTotal: room.game ? room.game.order.length : 0,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, score: p.score, streak: p.streak || 0, connected: p.connected,
      answered: !!q?.answers.has(p.token), inGame: !!q?.participants.has(p.token),
      lifelines: p.lifelines || null,
    })),
  };
}
const broadcastRoom = room => { io.to(room.code).emit('room', publicRoom(room)); pushRoomList(); };

// 席のアバター：部屋の中でまだ使われていない番号のうち一番小さいもの（席は token に紐づくので再接続しても変わらない）
function freeAvatar(room) {
  const used = new Set([...room.players.values()].map(p => p.avatar));
  for (let i = 1; i <= AVATARS; i++) if (!used.has(i)) return i;
  return 1 + crypto.randomInt(AVATARS);
}

function connectedPlayers(room) { return [...room.players.values()].filter(p => p.connected); }

function ensureHost(room) {
  const host = [...room.players.values()].find(p => p.id === room.hostId);
  if (host && host.connected) return;
  const next = connectedPlayers(room)[0];
  if (next) room.hostId = next.id;
}

// ── 進行 ──
function clearTimers(room) {
  room.game?.timers.forEach(t => clearTimeout(t.h));
  if (room.game) room.game.timers = [];
}
// 進行のタイマー。一時停止できるよう、いつ何を呼ぶかを覚えておく
function addTimer(room, fn, ms) {
  const t = { fn, due: Date.now() + ms, done: false };
  t.h = setTimeout(() => { t.done = true; fn(); }, ms);
  room.game.timers.push(t);
  return t;
}
const later = (room, fn, ms) => addTimer(room, fn, ms);
const laterAt = later;
const LEAD_MS = 1000; // 選択肢が出てから曲が流れるまでの待ち

// サビの位置が推定済み・手で設定済みの曲（サビ前問題で外れた所から流さないため）
const hasChorus = s => s.chorus > 0;

function startGame(room) {
  const S = room.settings;
  const pool = poolFor(S);
  if (pool.length === 0) return false;
  // サビ前だけの部屋は、サビの位置が確かな曲から出す（足りなければ全部から）
  let candidates = pool;
  if (S.quizType === 'sabimae') {
    const sure = pool.filter(hasChorus);
    if (sure.length >= S.questions) candidates = sure;
  }
  // この部屋で前のゲームに出た曲・貼り付けたログの曲は避ける。足りなければ古く除外した曲から戻して使う
  if (!room.played) room.played = new Set();
  const need = Math.min(S.questions, candidates.length);
  let fresh = candidates.filter(s => !room.played.has(s.id));
  if (fresh.length < need) {
    const byId = new Map(candidates.map(s => [s.id, s]));
    for (const id of room.played) {
      if (fresh.length >= need) break;
      if (byId.has(id)) { fresh.push(byId.get(id)); room.played.delete(id); }
    }
  }
  const n = Math.min(S.questions, fresh.length);
  room.state = 'playing';
  for (const p of room.players.values()) { p.score = 0; p.streak = 0; p.lifelines = freshLifelines(S); }
  // 曲オブジェクトそのものを持つ（ゲーム中に曲データが保存し直されても影響しないように）
  const order = shuffle([...fresh]).slice(0, n);
  order.forEach(s => { room.played.delete(s.id); room.played.add(s.id); }); // 新しく出た曲ほど後ろ（戻すのは古い順）
  room.gameNo = (room.gameNo || 0) + 1; // この部屋で何ゲーム目か（曲ログ用）
  room.game = { order, pool, qi: -1, q: null, timers: [], stats: new Map() }; // stats: token -> 称号用の成績
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
  const S = room.settings;
  // ミックスでも、サビの位置が仮の曲はイントロで出す
  const kind = S.quizType === 'mix' ? (hasChorus(song) && crypto.randomInt(2) ? 'sabimae' : 'intro') : S.quizType;
  // サビ前問題は「サビ − leadSec 秒」から流す（イントロより前にはしない）
  const start = kind === 'sabimae' ? Math.max(song.intro || 0, chorusOf(song) - S.leadSec) : (song.intro || 0);
  const input = S.answerMode === 'input';
  const { choices, correctIndex } = input ? { choices: null, correctIndex: null }
                                          : buildChoices(song, room.settings.choices, g.pool);
  g.q = {
    song, choices, correctIndex, kind, start,
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
    videoId: q.song.id, intro: q.song.intro || 0, start: q.start, kind: q.kind,
    final: room.settings.bonus && isFinalQuestion(room),
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
    socket.emit('go', { intro: q.song.intro || 0, start: q.start, kind: q.kind, hintAt: q.hintAt || S.hintAt,
                        total: q.total || questionTotal(S), offset, introLen: S.introLen, plays: q.plays || 1, gap: INTRO_GAP });
    if (q.phase === 'chorus') socket.emit('hint', { chorus: chorusOf(q.song), known: q.song.chorus > 0, intro: q.song.intro || 0, seek: q.kind !== 'sabimae' });
  }
  q.clues.forEach(c => socket.emit('clue', c));
  (q.lifelineResults.get(token) || []).forEach(r => socket.emit('lifelineResult', r));
  const a = q.answers.get(token);
  if (a) socket.emit('answered', { index: a.index, given: a.given, pass: a.pass });
}

// 1問の制限時間（秒）。入力で答えるときは、ヒント3が出てから最低 typingExtra 秒は答えられるよう延ばす
function questionTotal(S, hintAt = S.hintAt) {
  const base = hintAt + S.chorusLen;
  if (S.answerMode !== 'input' || !S.clues) return base;
  const clue3At = hintAt + S.chorusLen * 2 / 3;
  return Math.max(base, clue3At + S.typingExtra);
}
// イントロを何回か流すときは、流し終わって少し空けてからサビのヒントにする
const INTRO_GAP = 1; // 流し直す前の間（秒）
const introPlaysOf = (S, kind) => (kind === 'sabimae' ? 1 : (S.introPlays || 1));
function hintAtOf(S, kind) {
  const n = introPlaysOf(S, kind);
  // 最後のイントロのあとは 1.5 秒あけてからサビへ
  return n <= 1 ? S.hintAt : Math.max(S.hintAt, n * S.introLen + (n - 1) * INTRO_GAP + 1.5);
}

function chorusOf(song) { return song.chorus > 0 ? song.chorus : (song.intro || 0) + 50; }

function go(room) {
  const q = room.game.q;
  if (q.phase !== 'loading') return;
  clearTimers(room);
  const S = room.settings;
  q.phase = 'intro';
  // 選択肢を見てから1秒後に曲が流れ始める。時間・得点の計算もそこから
  q.t0 = Date.now() + LEAD_MS;
  // 途中で設定が変わっても、この問題は始めた時の設定で進める
  const plays = introPlaysOf(S, q.kind), hintAt = hintAtOf(S, q.kind);
  q.hintAt = hintAt; q.plays = plays; q.total = questionTotal(S, hintAt);
  const sabimae = q.kind === 'sabimae';
  io.to(room.code).emit('go', { intro: q.song.intro || 0, start: q.start, kind: q.kind, hintAt, total: q.total, offset: -LEAD_MS / 1000,
                                introLen: S.introLen, plays, gap: INTRO_GAP });
  const later = (r, fn, ms) => laterAt(r, fn, ms + LEAD_MS);
  // サビ前問題は止めずに流し続ける。イントロは introLen 秒で止め、回数の設定があれば少し空けて頭から流し直す
  if (!sabimae) {
    for (let i = 0; i < plays; i++) {
      const at = i * (S.introLen + INTRO_GAP);
      if (i > 0) later(room, () => { if (q.phase === 'intro') io.to(room.code).emit('restartIntro', { n: i + 1, plays }); }, at * 1000);
      if (at + S.introLen < hintAt) later(room, () => { if (q.phase === 'intro') io.to(room.code).emit('stopIntro'); }, (at + S.introLen) * 1000);
    }
  }
  later(room, () => {
    if (q.phase !== 'intro') return;
    q.phase = 'chorus';
    io.to(room.code).emit('hint', { chorus: chorusOf(q.song), known: q.song.chorus > 0, intro: q.song.intro || 0, seek: !sabimae });
    broadcastRoom(room);
  }, hintAt * 1000);
  if (S.clues) {
    clueList(q.song).forEach((c, i) => later(room, () => {
      if (q.phase !== 'intro' && q.phase !== 'chorus') return;
      q.clues.push(c);
      io.to(room.code).emit('clue', c);
    }, (hintAt + S.chorusLen * i / 3) * 1000));
  }
  later(room, () => reveal(room), q.total * 1000);
  broadcastRoom(room);
}

// payload は { index }（選択肢）/ { text }（入力）/ { pass: true }（わからない）
function onAnswer(room, player, payload) {
  const q = room.game?.q;
  if (!q || (q.phase !== 'intro' && q.phase !== 'chorus') || room.game.paused) return;
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
    // 惜しい（1文字ちがいなど）ときは回答にせず、本人にだけ知らせて打ち直してもらう（1問2回まで）
    if (!correct && isAlmostText(given, q.song)) {
      q.almost = q.almost || new Map();
      const n = q.almost.get(player.token) || 0;
      if (n < 2) {
        q.almost.set(player.token, n + 1);
        io.to(player.socketId).emit('almost', { text: given, left: 1 - n });
        return;
      }
    }
  } else {
    index = payload?.index;
    if (!Number.isInteger(index) || index < 0 || index >= q.choices.length) return;
    correct = index === q.correctIndex;
  }

  if (Date.now() < q.t0) return; // 曲が流れる前の回答は受け付けない
  const elapsed = (Date.now() - q.t0) / 1000;
  const hint = q.phase === 'chorus';
  let points = 0;
  player.streak = correct ? (player.streak || 0) + 1 : 0;
  if (correct) {
    if (S.mode === 'score') {
      // 早いほど高い（500〜1000点）。サビ（ヒント）が流れてからの正解は ×0.7
      const base = Math.round(500 + 500 * Math.max(0, 1 - elapsed / (q.total || questionTotal(S))));
      points = hint ? Math.round(base * 0.7) : base;
      // 連続正解ボーナス：2連続 ×1.2、3連続以上 ×1.5
      if (S.bonus) points = Math.round(points * (player.streak >= 3 ? 1.5 : player.streak === 2 ? 1.2 : 1));
    } else if (!q.winner) {
      points = hint ? 1 : 2;
      q.winner = player.token;
    }
    if (S.bonus && isFinalQuestion(room)) points *= 2; // 最終問題は得点2倍
  }
  player.score += points;
  q.answers.set(player.token, { index, given, pass, elapsed, correct, points, hint });
  const st = statsOf(room, player);
  if (correct) {
    st.correct++; st.time += elapsed;
    for (const k of genresOf(q.song)) st.genres[k] = (st.genres[k] || 0) + 1;
    if (hint) st.chorus++;
    if (q.song.year < 2000) st.retro++;
    st.maxStreak = Math.max(st.maxStreak, player.streak);
  }

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
  // 答えなかった人は連続正解が途切れる
  for (const t of q.participants) if (!q.answers.has(t)) { const p = room.players.get(t); if (p) p.streak = 0; }
  const results = [...room.players.values()]
    .filter(p => q.participants.has(p.token))
    .map(p => {
      const a = q.answers.get(p.token);
      return { id: p.id, name: p.name, avatar: p.avatar, answered: !!a, index: a ? a.index : null, given: a?.given ?? null,
               pass: !!a?.pass, elapsed: a ? a.elapsed : null,
               correct: !!a?.correct, points: a ? a.points : 0, hint: !!a?.hint };
    })
    .sort((a, b) => (b.correct - a.correct) || ((a.elapsed ?? 99) - (b.elapsed ?? 99)));
  const last = room.game.qi + 1 >= room.game.order.length;
  const S = room.settings;
  io.to(room.code).emit('reveal', {
    correctIndex: q.correctIndex,
    song: { id: s.id, title: s.title, work: s.work, artist: s.artist, year: s.year, type: s.type },
    log: playedLog(room), // ここまでに出た曲（ページを読み込み直した人も曲ログをコピーできるように）
    intro: s.intro || 0, chorus: chorusOf(s), chorusKnown: s.chorus > 0,
    results,
    highlights: highlightsOf(room, results),
    last,
    autoNext: S.autoNext, // 0 なら自動では進まない
  });
  if (S.autoNext > 0) {
    q.revealAt = Date.now();
    scheduleNext(room, q, Date.now() + S.autoNext * 1000);
  }
  broadcastRoom(room);
}

function statsOf(room, player) {
  const m = room.game.stats;
  if (!m.has(player.token)) m.set(player.token, { correct: 0, time: 0, chorus: 0, retro: 0, maxStreak: 0, genres: {} });
  return m.get(player.token);
}

// 最終結果の称号。条件を満たした一番の人に1つずつ
function titlesOf(room) {
  const list = [...room.game.stats.entries()].map(([t, s]) => ({ p: room.players.get(t), s })).filter(x => x.p);
  const pick = (x, title, why) => ({ id: x.p.id, name: x.p.name, avatar: x.p.avatar, title, why });
  const top = (score, min, title, why) => {
    const c = list.filter(x => score(x.s) >= min).sort((a, b) => score(b.s) - score(a.s))[0];
    return c ? pick(c, title, why(c.s)) : null;
  };
  // 最速王は正解したときの平均時間で決める（2問以上正解した人がいればその中から）
  const avg = s => s.time / s.correct;
  const minCorrect = list.some(x => x.s.correct >= 2) ? 2 : 1;
  const fastest = list.filter(x => x.s.correct >= minCorrect).sort((a, b) => avg(a.s) - avg(b.s))[0];
  // ジャンル別マスター：そのジャンルで2問以上正解した中でいちばん多い人（正解が多いジャンルから最大3つ）
  const genreTitles = GENRE_KEYS
    .map(k => ({ k, best: list.filter(x => (x.s.genres[k] || 0) >= 2).sort((a, b) => b.s.genres[k] - a.s.genres[k])[0] }))
    .filter(x => x.best).sort((a, b) => b.best.s.genres[b.k] - a.best.s.genres[a.k]).slice(0, 3)
    .map(({ k, best }) => pick(best, `${GENRES[k].label.replace(/（.*）/, '')}マスター`, `${GENRES[k].label}を ${best.s.genres[k]}問正解`));
  return [
    fastest && pick(fastest, '最速王', `平均 ${avg(fastest.s).toFixed(2)}秒（${fastest.s.correct}問）`),
    top(s => s.maxStreak, 3, '連続正解王', s => `${s.maxStreak}連続正解`),
    top(s => s.chorus, 2, 'サビ頼み', s => `サビで ${s.chorus}問正解`),
    top(s => s.retro, 2, 'レトロマスター', s => `2000年より前の曲を ${s.retro}問正解`),
    top(s => s.correct, 1, '正解数王', s => `${s.correct}問正解`),
    ...genreTitles,
  ].filter(Boolean);
}

// 答え合わせから次の問題へ進む時刻を決める（「サビを聞く」で延ばせる）
function scheduleNext(room, q, at) {
  if (q.nextTimer) clearTimeout(q.nextTimer.h);
  q.nextAt = at;
  q.nextTimer = addTimer(room, () => { if (room.game?.q === q && q.phase === 'reveal') nextQuestion(room); }, Math.max(0, at - Date.now()));
}
const LISTEN_SEC = 10;        // 「サビを聞く」で、押した時点から最低この秒数は次へ進まない
const LISTEN_PER_PLAYER = 2;  // 1問で1人が押せる回数
const LISTEN_MAX_EXTRA = 30;  // 1問あたり延ばせる合計の秒数

const isFinalQuestion = room => room.game.qi + 1 >= room.game.order.length && room.game.order.length > 1;

// 答え合わせで出す一言（最速・全員正解・ひとりだけ・連続正解など）
function highlightsOf(room, results) {
  const out = [];
  const ok = results.filter(r => r.correct);
  if (results.length >= 2 && ok.length === results.length) out.push('全員正解！');
  else if (results.length >= 2 && ok.length === 1) out.push(`正解は ${ok[0].name} さんだけ！`);
  else if (results.length >= 1 && ok.length === 0) out.push('正解者なし…');
  if (ok.length && results.length >= 2) {
    const f = ok.reduce((a, b) => (a.elapsed <= b.elapsed ? a : b));
    out.push(`最速 ${f.name}（${f.elapsed.toFixed(2)}秒）`);
  }
  for (const r of ok) {
    const p = [...room.players.values()].find(x => x.id === r.id);
    if (p?.streak >= 3) out.push(`${r.name} ${p.streak}連続正解！`);
  }
  return out;
}

function skipQuestion(room, reason) {
  io.to(room.code).emit('notice', reason);
  nextQuestion(room);
}

// ── 一時停止（ホストが「設定を変える」）。変えた設定は次の問題から ──
const poolKey = S => JSON.stringify([S.topic, S.series, S.yearFrom, S.yearTo, S.excludeGenres, S.quizType, S.fame]);
function pauseGame(room, auto = false) {
  const g = room.game, q = g?.q;
  if (room.state !== 'playing' || !g || g.paused || !q) return false;
  if (q.phase === 'loading' || (q.t0 && Date.now() < q.t0)) return false; // 曲が流れ始める直前は止めない
  g.paused = { at: Date.now(), poolKey: poolKey(room.settings), questions: room.settings.questions, auto };
  for (const t of g.timers) if (!t.done) { clearTimeout(t.h); t.left = Math.max(0, t.due - Date.now()); }
  io.to(room.code).emit('paused');
  broadcastRoom(room);
  return true;
}
function resumeGame(room) {
  const g = room.game;
  if (!g?.paused) return;
  const d = Date.now() - g.paused.at, q = g.q;
  if (q) { if (q.t0) q.t0 += d; if (q.nextAt) q.nextAt += d; if (q.revealAt) q.revealAt += d; }
  const old = g.timers; g.timers = [];
  for (const t of old) {
    if (t.done) continue;
    const n = addTimer(room, t.fn, t.left);
    if (q?.nextTimer === t) q.nextTimer = n;
  }
  // お題・年代・問題数が変わったら、残りの問題を入れ替える（今の問題はそのまま）
  const S = room.settings, poolChanged = poolKey(S) !== g.paused.poolKey;
  if (poolChanged || S.questions !== g.paused.questions) {
    const done = g.order.slice(0, g.qi + 1), rest = g.order.slice(g.qi + 1);
    const pool = poolChanged ? poolFor(S) : g.pool;
    if (pool.length) g.pool = pool;
    const need = Math.max(0, S.questions - done.length);
    const keep = poolChanged ? [] : rest.filter(s => g.pool.includes(s));
    const fresh = shuffle(g.pool.filter(s => !done.includes(s) && !keep.includes(s) && !room.played.has(s.id)));
    const reuse = shuffle(g.pool.filter(s => !done.includes(s) && !keep.includes(s) && room.played.has(s.id)));
    const next = [...keep, ...fresh, ...reuse].slice(0, need);
    rest.forEach(s => { if (!next.includes(s)) room.played.delete(s.id); }); // 出さなくなった曲は除外の記録から外す
    next.forEach(s => { room.played.delete(s.id); room.played.add(s.id); });
    g.order = [...done, ...next];
  }
  g.paused = null;
  io.to(room.code).emit('resumed', { ms: d, qTotal: g.order.length });
  broadcastRoom(room);
}
// ホストが「ルームに戻る」：ゲームを途中でやめる。まだ出ていない曲は除外の記録から外す
function abortGame(room) {
  const g = room.game;
  if (room.state !== 'playing' || !g) return;
  clearTimers(room);
  saveHistory(room);
  g.order.slice(g.qi + 1).forEach(s => room.played.delete(s.id));
  g.q = null; g.paused = null;
  room.state = 'lobby';
  io.to(room.code).emit('aborted');
  broadcastRoom(room);
}

// このゲームでここまでに出題した曲（曲ログ用）
function playedLog(room) {
  const g = room.game;
  return g.order.slice(0, g.qi + 1).map(s => ({ id: s.id, title: s.title, work: s.work, artist: s.artist, year: s.year, type: s.type }));
}

// ゲームが終わったら（途中でやめたときも）、出た曲をこの部屋の履歴に残す
function saveHistory(room) {
  if (!room.game || room.game.saved) return;
  room.game.saved = true;
  room.history = room.history || [];
  room.history.push(...playedLog(room).map(s => ({ ...s, game: room.gameNo || 1 })));
  if (room.history.length > 3000) room.history = room.history.slice(-3000);
}

function endGame(room) {
  saveHistory(room);
  clearTimers(room);
  room.state = 'over';
  room.game.q = null;
  const ranking = [...room.players.values()]
    .map(p => {
      // ふりかえり用：正解数・正解したときの平均タイム・いちばん長い連続正解
      const s = room.game.stats.get(p.token);
      return { id: p.id, name: p.name, avatar: p.avatar, score: p.score,
               correct: s?.correct || 0, avg: s?.correct ? Math.round(s.time / s.correct * 100) / 100 : null, maxStreak: s?.maxStreak || 0 };
    })
    .sort((a, b) => b.score - a.score);
  io.to(room.code).emit('gameover', { total: room.game.order.length, ranking, titles: titlesOf(room), log: playedLog(room), roomLog: room.history });
  broadcastRoom(room);
}

// ── 接続 ──
// 画面の版。新しい版をデプロイすると変わるので、古いページを開いたままの人に再読み込みしてもらう
const APP_VERSION = process.env.RENDER_GIT_COMMIT || String(Date.now());

io.on('connection', socket => {
  socket.emit('version', APP_VERSION);
  let room = null, player = null;

  function enter(r, token, name) {
    let p = r.players.get(token);
    if (!p) {
      if (r.players.size >= r.settings.maxPlayers) return { ok: false, error: 'この部屋は満員です' };
      p = { token, id: crypto.randomUUID().slice(0, 8), name, avatar: freeAvatar(r), score: 0, connected: true, socketId: socket.id };
      r.players.set(token, p);
    }
    p.name = name; p.connected = true; p.socketId = socket.id;
    r.emptySince = null;
    room = r; player = p;
    // 全員いなくなって止まっていたゲームを、戻ってきた人で再開する
    const g = r.game;
    if (r.state === 'playing' && g) {
      if (g.paused?.auto) resumeGame(r);
      else if (g.restartQuestion && g.q) { // 曲が流れ始める前に止まった問題は、読み込みからやり直す
        g.restartQuestion = false;
        g.q.phase = 'loading'; g.q.ready = new Set(); g.q.participants.add(token);
        later(r, () => go(r), READY_TIMEOUT);
      }
    }
    socket.join(r.code);
    if (!r.hostId) r.hostId = p.id;
    ensureHost(r);
    broadcastRoom(r);
    setImmediate(() => resendQuestion(r, socket, token)); // ack の後に届くように
    return { ok: true, code: r.code, you: p.id, room: publicRoom(r) };
  }

  socket.on('create', ({ token, name, roomName, password } = {}, ack) => {
    if (typeof ack !== 'function' || typeof token !== 'string' || token.length < 8) return;
    socket.leave('home');
    ack(enter(createRoom({ roomName, password }), token, cleanName(name)));
  });

  socket.on('join', ({ code, token, name, password } = {}, ack) => {
    if (typeof ack !== 'function' || typeof token !== 'string' || token.length < 8) return;
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return ack({ ok: false, error: '部屋が見つかりません' });
    // パスワード付きの部屋：一度入った人（同じ席）の再接続は聞き直さない
    if (r.passwordHash && !r.players.has(token)) {
      const pw = cleanPassword(password);
      if (!pw) return ack({ ok: false, needPassword: true, error: 'パスワードを入力してください' });
      if (hashPassword(r.salt, pw) !== r.passwordHash) return ack({ ok: false, needPassword: true, wrongPassword: true, error: 'パスワードが違います' });
    }
    socket.leave('home');
    ack(enter(r, token, cleanName(name)));
  });

  // ホーム画面の部屋一覧
  socket.on('watchRooms', () => { socket.join('home'); socket.emit('rooms', roomList()); });
  socket.on('unwatchRooms', () => socket.leave('home'));

  const isHost = () => room && player && room.hostId === player.id;

  socket.on('settings', input => {
    if (!isHost() || (room.state === 'playing' && !room.game?.paused)) return;
    room.settings = sanitizeSettings(input, room.settings);
    broadcastRoom(room);
  });

  // 前回のログを貼り付け：その曲を出題から外す（参加者だれでも足せる。リセットはホスト）
  socket.on('exclude', ids => {
    if (!room || !player || !Array.isArray(ids)) return;
    const known = new Set(ALL_SONGS.map(s => s.id));
    if (!room.played) room.played = new Set();
    let added = 0;
    for (const id of ids.slice(0, 5000)) {
      if (typeof id === 'string' && known.has(id) && !room.played.has(id)) { room.played.add(id); added++; }
    }
    socket.emit('notice', `${added}曲を出題から外しました（除外中 ${room.played.size}曲）`);
    broadcastRoom(room);
  });
  // 除外するジャンル（チェック式）：参加者だれでも変えられる
  socket.on('excludeGenres', list => {
    if (!room || !player || (room.state === 'playing' && !room.game?.paused) || !Array.isArray(list)) return;
    room.settings = { ...room.settings, excludeGenres: [...new Set(list.filter(k => GENRES[k]))] };
    broadcastRoom(room);
  });
  // 除外中の曲の一覧（ロビーで「除外中の曲をコピー」）
  socket.on('excludedList', ack => {
    if (typeof ack !== 'function' || !room) return;
    const byId = new Map(ALL_SONGS.map(s => [s.id, s]));
    ack([...(room.played || [])].map(id => byId.get(id)).filter(Boolean)
      .map(s => ({ id: s.id, title: s.title, work: s.work, artist: s.artist, year: s.year, type: s.type })));
  });
  socket.on('clearExclude', () => {
    if (!isHost() || room.state === 'playing') return;
    room.played = new Set();
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

  // リアクションスタンプ（部屋の全員に表示。連打は1秒に1回まで）
  const REACTIONS = ['神曲', '知らん', '懐かしい', '惜しい', '草', '天才'];
  let lastReact = 0;
  // 答え合わせで「サビを聞く」：押すたびに、次へ進むまでの時間を LISTEN_SEC 秒ずつ延ばす
  socket.on('listen', () => {
    const q = room?.game?.q;
    if (!q || !player || room.state !== 'playing' || room.game.paused || q.phase !== 'reveal' || !q.nextAt) return;
    q.listens = q.listens || new Map();
    const n = q.listens.get(player.token) || 0;
    if (n >= LISTEN_PER_PLAYER) { socket.emit('listenLeft', 0); return socket.emit('notice', 'サビを聞くのは1問2回までです'); }
    const limit = q.revealAt + (room.settings.autoNext + LISTEN_MAX_EXTRA) * 1000;
    const at = Math.min(limit, Math.max(q.nextAt, Date.now()) + LISTEN_SEC * 1000);
    if (at <= q.nextAt) { socket.emit('listenLeft', 0); return socket.emit('notice', 'これ以上は延ばせません'); }
    q.listens.set(player.token, n + 1);
    socket.emit('listenLeft', LISTEN_PER_PLAYER - n - 1);
    scheduleNext(room, q, at);
    io.to(room.code).emit('nextAt', { seconds: (at - Date.now()) / 1000, by: player.name });
  });

  socket.on('react', kind => {
    if (!room || !player || !REACTIONS.includes(kind)) return;
    const now = Date.now();
    if (now - lastReact < 1000) return;
    lastReact = now;
    io.to(room.code).emit('react', { id: player.id, name: player.name, kind });
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
    if (!isHost() || room.state !== 'playing' || room.game.paused || room.game.q?.phase !== 'reveal') return;
    nextQuestion(room);
  });
  socket.on('pause', () => {
    if (!isHost()) return;
    if (!pauseGame(room)) socket.emit('notice', '曲が流れ始めてから止められます');
  });
  socket.on('resume', () => { if (isHost()) resumeGame(room); });
  socket.on('abort', () => { if (isHost()) abortGame(room); });

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
      // 全員いなくなっても終わらせず止めておく（ページを読み込み直した人が戻ってきたら続きから）
      const g = room.game;
      if (room.state === 'playing' && g && !g.paused && !pauseGame(room, true)) { clearTimers(room); g.restartQuestion = true; }
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
  for (const [code, r] of rooms) if (r.emptySince && now - r.emptySince > ROOM_TTL) { rooms.delete(code); pushRoomList(); }
}, 60 * 1000);

server.listen(PORT, () => console.log(`イントロクイズ対戦サーバー起動: http://localhost:${PORT} （曲 ${SONGS.length} 件）`));
