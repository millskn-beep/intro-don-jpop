// アニソンイントロクイズ対戦サーバー（v1）
// Express で public/ を配信し、同じポートで Socket.IO を動かす。
// 進行のタイミング（イントロ→サビ→答え合わせ）と採点はすべてサーバーが決める。

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const fs = require('fs');
const { isCorrectText, isAlmostText, shortForm, vocalShort, vocalCombo, normalize: normText } = require('./lib/normalize');
const poker = require('./lib/poker');
const panelLib = require('./lib/panel');
const nenpyo = require('./lib/nenpyo'); // アニソン年表（ヒットスター風） // アニソン陣取り（アタック25風）の盤
const datalog = require('./lib/datalog'); // 受け付けたものを GitHub の data-log ブランチに記録（再起動で消えないように）

const PORT = process.env.PORT || 3000;
const SONGS_PATH = path.join(__dirname, 'data', 'songs.json');
const DECOYS = require('./data/decoys.json');

// 出題に使う曲（再生できないと分かった曲は除く）。曲チェック画面で保存すると読み直す
let ALL_SONGS = [], SONGS = [], STAGED = [];
function loadSongs() {
  ALL_SONGS = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
  try { applyLiveSongs(); } catch (e) { /* 起動直後は何もしない（再起動なしで足した曲） */ }
  try { applyFixes(); } catch (e) { /* 起動直後（修正の一覧を読む前）は何もしない */ }
  try { applyFame(); } catch (e) { /* 同上 */ }
  try { applyInfoFixes(); if (typeof CATS !== 'undefined') CATS = null; } catch (e) { /* 同上（曲の情報の直し） */ }
  const playable = ALL_SONGS.filter(s => s.id && s.embeddable !== false && !s.retired);
  SONGS = playable.filter(s => !s.staged); // staged：プレイリストからの「お試し」の曲。ふだんの出題・選択肢には出さず、お題「プレイリスト」でだけ出す
  STAGED = playable.filter(s => s.staged); // retired：収録曲一覧の「削除を依頼」で出題から外した曲（データは残す）
  buildSeries();
}

// ── お題：ジャンル（data/genres.json）と作品（シリーズ）──
const GENRES = Object.fromEntries(Object.entries(require('./data/genres.json')).filter(([k]) => !k.startsWith('_')));
const GENRE_KEYS = Object.keys(GENRES);
// 作品ごとのジャンル（data/work-genres.json。作品の中身で付けたタグ）があればそれを使う。
// ない作品（ボカロ・J-POP・新しく足した曲など）は、作品名に含まれる言葉（genres.json の keywords）で決める
let WORK_GENRES = new Map();
try { WORK_GENRES = new Map(Object.entries(require('./data/work-genres.json')).filter(([k]) => !k.startsWith('_'))); } catch (e) { /* なくても動く */ }
// ただし「パチスロで有名」は、genres.json に並べた作品（keywords）だけで決める（作品の中身では決まらないので、手で決めた一覧どおり）
const KEYWORD_ONLY = ['pachislot', 'slot']; // slot：パチスロ（超マイナー）。台のための曲（作品名の（パチスロ）（パチンコ）か genres.json の ids）
const byKeywords = song => GENRE_KEYS.filter(k => GENRES[k].keywords.some(w => String(song.work).includes(w)) || (GENRES[k].ids || []).includes(song.id));
// 曲ごとに直したジャンル（収録曲一覧の「ジャンルを直す」。data/song-genres.json：id → { genres, at }）。あればそれを使う
const SONG_GENRES_PATH = path.join(__dirname, 'data', 'song-genres.json');
let SONG_GENRES = {};
try { SONG_GENRES = JSON.parse(fs.readFileSync(SONG_GENRES_PATH, 'utf8')); } catch (e) { SONG_GENRES = {}; }
// どのジャンルにも入らない曲は「その他」（other）。除外にチェックすれば、ジャンル分けされていない作品の曲も出なくなる
const genresOfRaw = song => {
  const own = SONG_GENRES[song.id];
  if (own?.genres) return own.genres.filter(k => GENRES[k]);
  if (!WORK_GENRES.has(song.work)) return byKeywords(song);
  const kw = byKeywords(song).filter(k => KEYWORD_ONLY.includes(k));
  return [...WORK_GENRES.get(song.work).filter(k => GENRES[k] && !KEYWORD_ONLY.includes(k)), ...kw];
};
// ジャンルは曲ごとに何度も聞かれる（一覧の曲数・出題・除外）ので、結果をおぼえておく（曲・作品・手で直したジャンルが変わったら、キーが変わって計算し直す）
const GENRE_MEMO = new Map();
const genresOf = song => {
  const own = SONG_GENRES[song.id], key = song.id + '|' + song.work + '|' + (own ? (own.at || '') + (own.genres ? own.genres.join() : '-') : '');
  let r = GENRE_MEMO.get(key);
  if (!r) { const g = genresOfRaw(song).filter(k => k !== 'other'); r = g.length || !GENRES.other ? g : ['other']; if (GENRE_MEMO.size > 20000) GENRE_MEMO.clear(); GENRE_MEMO.set(key, r); }
  return r;
};
// 知名度（ジャンルとは別の分類）。曲データの fame。未設定の曲は「普通」
const FAME = [['top', '超有名'], ['famous', '有名'], ['normal', '普通'], ['minor', 'マイナー'], ['otaku', 'オタク']];
const FAME_KEYS = FAME.map(([k]) => k);
const fameOf = song => (FAME_KEYS.includes(song.fame) ? song.fame : 'normal');
// 曲ごとに直した知名度（収録曲一覧の「知名度を直す」。data/song-fame.json：id → { fame, at, title }）。曲データの fame を差し替えて使う（元の値は fameAuto に取っておく）
const SONG_FAME_PATH = path.join(__dirname, 'data', 'song-fame.json');
let SONG_FAME = {};
try { SONG_FAME = JSON.parse(fs.readFileSync(SONG_FAME_PATH, 'utf8')); } catch (e) { SONG_FAME = {}; }
function applyFame(list = ALL_SONGS) {
  for (const s of list) {
    const o = SONG_FAME[s.id];
    if (o && FAME_KEYS.includes(o.fame)) { if (s.fameAuto === undefined) s.fameAuto = s.fame; s.fame = o.fame; }
    else if (s.fameAuto !== undefined) { s.fame = s.fameAuto; delete s.fameAuto; }
  }
}
// 知名度が「普通」以下（普通・マイナー・オタク）の曲は、できるだけ続けて出さない。超有名・有名は続いてもよい（並べられなければ、そのまま）
const LOW_FAME = new Set(['normal', 'minor', 'otaku']);
// 普通以下の曲が半分を超えると、続けずに並べられない。超有名・有名の曲が選べるなら、超えた分をそれらに差し替える
function capLowFame(order, pools, from = 0) {
  const low = s => LOW_FAME.has(fameOf(s));
  const limit = Math.ceil(order.length / 2);
  const idx = order.map((s, i) => (i >= from && low(s) ? i : -1)).filter(i => i >= 0);
  let extra = idx.length - limit - order.slice(0, from).filter(low).length;
  if (extra <= 0) return order;
  const used = new Set(order.map(s => s.id));
  const highs = shuffle([...new Set(pools.flat())].filter(s => !low(s) && !used.has(s.id)));
  for (const i of shuffle(idx)) {
    if (extra <= 0 || !highs.length) break;
    order[i] = highs.pop(); extra--;
  }
  return order;
}
function spreadLowFame(order, from = 1) {
  const low = s => !!s && LOW_FAME.has(fameOf(s));
  const pairBad = k => k >= 1 && k < order.length && low(order[k]) && low(order[k - 1]);
  const countBad = () => { let c = 0; for (let k = Math.max(1, from); k < order.length; k++) if (pairBad(k)) c++; return c; };
  // 続いている所を減らす入れ替えを、減らなくなるまで繰り返す（普通以上の曲と入れ替える。並びの総数は変えない）
  for (let round = 0; round < 6 && countBad() > 0; round++) {
    let improved = false;
    for (let i = Math.max(1, from); i < order.length; i++) {
      if (!pairBad(i)) continue;
      const before = countBad();
      for (let j = Math.max(1, from) - 1 < 0 ? 0 : Math.max(0, from); j < order.length; j++) {
        if (j === i || j === i - 1 || low(order[j])) continue;
        [order[i], order[j]] = [order[j], order[i]];
        if (countBad() < before) { improved = true; break; }
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    if (!improved) break;
  }
  return order;
}
// 出題しないジャンル：ボカロ・J-POP・パチスロ（超マイナー）・LoL は「曲の種類」なので、チェックすれば必ず外す。
// それ以外（作品の中身のジャンル）は、曲のジャンルが全部チェックされているときだけ外す（例：ロボットを外しても「パチスロで有名」を残せば、ガンダムSEED は出る）。
// マイページのお気に入りでも外す（除外はいつもそのとおりに効かせる）
const HARD_EX = ['vocaloid', 'jpop', 'slot', 'lol'];
const isExcluded = (song, ex) => {
  if (!ex?.length) return false;
  const gs = genresOf(song);
  if (gs.some(k => HARD_EX.includes(k) && ex.includes(k))) return true;
  const soft = gs.filter(k => !HARD_EX.includes(k));
  return soft.length > 0 && soft.every(k => ex.includes(k));
};
// 選択肢にも、出さないと決めた曲（除外ジャンル・カップリング曲）は使わない
const choiceBlocked = (s, pool) => isExcluded(s, pool.ex) || !!(pool.noCoupling && s.coupling);
const inTopic = (song, S, ctx = {}) => {
  const topic = S.topic || 'all';
  if (topic === 'favorites') return !!ctx.fav?.has(song.id);
  if (topic === 'weak') return !!ctx.weak?.has(song.id);
  if (topic === 'all') return !isExcluded(song, S.excludeGenres); // 「全部」のときだけ、除外にチェックしたジャンルの曲を外す（お題で選んだときはそのまま）
  if (topic === 'series') return SERIES_OF.get(song.id) === S.series;
  if (topic === 'multi') { // 自由に選ぶ：選んだジャンル・作品のどれかに入る曲。そのあと除外のチェックも効く
    const gs = genresOf(song), mg = S.multiGenres || [], ms = S.multiSeries || [];
    if (!(mg.some(k => gs.includes(k)) || ms.includes(SERIES_OF.get(song.id)))) return false;
    return !isExcluded(song, S.excludeGenres);
  }
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
app.use(require('compression')()); // 文字のデータ（画面・スクリプト・曲一覧など）を圧縮して送る（転送量が約1/4〜1/8になる）
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1d' })); // 画像・動画は1日おぼえてもらう
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));
require('./lib/drive')(app, req => `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`, () => { loadSongs(); return ALL_SONGS; }); // ドライブの部屋（車のアプリ＋助手席のスマホ）

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
// ── 再起動なしの反映（tools/push-live.js）：手元で足した曲・計測した曲のデータと、リクエストの状態を、公開サーバーにそのまま送る ──
// 鍵：手元の .live-key（git に入れない）の SHA-256 を data/live-key.sha256 に置き、送るときは x-live-key で鍵を付ける。
// 送られた曲は LIVE_SONGS に入れて記録（data-log）にも残す（反映前の再起動でも消えない）。次の「反映して」で songs.json に入ったら、ファイルの方を使う
let LIVE_HASH = '';
try { LIVE_HASH = fs.readFileSync(path.join(__dirname, 'data', 'live-key.sha256'), 'utf8').trim(); } catch (e) { /* なければ手元からだけ */ }
const liveOk = req => canEdit(req) || (!!LIVE_HASH && crypto.createHash('sha256').update(String(req.get('x-live-key') || '')).digest('hex') === LIVE_HASH);
let LIVE_SONGS = {}; // id → 曲データ
const LIVE_BASE = process.env.RENDER_GIT_COMMIT || ''; // いま動いている版
function applyLiveSongs() {
  const byId = new Map(ALL_SONGS.map((s, i) => [s.id, i]));
  for (const [id, row] of Object.entries(LIVE_SONGS)) {
    if ((row.liveBase || '') !== LIVE_BASE) { delete LIVE_SONGS[id]; continue; } // 送ったあとに反映（新しい版）があった：曲はファイルに入っているので、ファイルの方を使う
    if (byId.has(id)) ALL_SONGS[byId.get(id)] = { ...row }; else ALL_SONGS.push({ ...row });
  }
  for (const s of ALL_SONGS) if (s.dur > 0 && !DURATIONS.has(s.id)) DURATIONS.set(s.id, s.dur);
}
// ファイルを直接編集・取り込みした内容も反映されるよう、毎回読み直す
// 待機画面のお題の選択肢（ジャンルと、曲が5曲以上ある作品）
app.get('/api/topics', (req, res) => res.json({
  genres: GENRE_KEYS.map(k => ({ key: k, label: GENRES[k].label, count: SONGS.filter(s => genresOf(s).includes(k)).length })),
  series: SERIES_LIST,
  fame: FAME.map(([k, label]) => ({ key: k, label, count: SONGS.filter(s => fameOf(s) === k).length })),
  playlist: STAGED.length,
  coupling: SONGS.filter(s => s.coupling).length,
  gzCatalog: gzCatalog().map(({ key, group, icon, label, count }) => ({ key, group, icon, label, count })),
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
  const EDITABLE = ['intro', 'chorus', 'aliases', 'embeddable', 'error', 'checkedAt', 'checkedOrigin', 'introMeasured', 'chorusSource', 'chorusChecked', 'introMethod', 'introUnsure', 'fame', 'fameManual', 'views', 'channel', 'viewsAt'];
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
// ── 自動の解析で直した曲を、聞きながら確かめる画面（review.html。このPCから開いたときだけ）──
// 一覧は data/auto-fixes.json（tools/auto_fix.py が書く）。確かめた結果は data/auto-review.json に書き、
// 「元に戻す」「手で決める」「OK」は正解として data/fix-history.json にも足す（自動の解析が次の合わせ直しで学ぶ）
const AUTO_LOG_PATH = path.join(__dirname, 'data', 'auto-fixes.json');
const AUTO_REVIEW_PATH = path.join(__dirname, 'data', 'auto-review.json');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const writeJson = (p, v) => { fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 1) + '\n'); fs.renameSync(p + '.tmp', p); };
app.get('/api/review', (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'このPCから開いたときだけ使えます' });
  loadSongs();
  const byId = new Map(ALL_SONGS.map(s => [s.id, s]));
  const log = readJson(AUTO_LOG_PATH, {}), reviews = readJson(AUTO_REVIEW_PATH, {});
  const items = [];
  for (const [bucket, list] of [['fixed', log.fixed || []], ['pending', log.pending || []]]) {
    for (const e of list) {
      const s = byId.get(e.id);
      if (!s) continue;
      const kind = e.kind === 'chorus' ? 'chorus' : 'intro';
      const key = `${kind}:${e.id}`;
      items.push({ key, id: e.id, kind, bucket, title: s.title, work: s.work, artist: s.artist, year: s.year,
        before: e.before, after: e.after, now: kind === 'intro' ? s.intro || 0 : s.chorus || 0, intro: s.intro || 0, chorus: s.chorus || 0,
        by: e.by || null, songleBeat: e.songleBeat ?? null, why: e.why || null, at: e.at, review: reviews[key] || null });
    }
  }
  res.json({ items });
});
app.post('/api/review', (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'このPCから開いたときだけ使えます' });
  const { id, kind, action } = req.body || {};
  const value = Number(req.body?.value);
  if (!['intro', 'chorus'].includes(kind) || !['ok', 'revert', 'set'].includes(action)) return res.status(400).json({ error: '内容が正しくありません' });
  if (action === 'set' && !(value >= 0 && value <= 1200)) return res.status(400).json({ error: '秒数が正しくありません' });
  // 自動の解析も同じファイルを書くので、毎回読み直して1曲だけ書き換える
  const songs = readJson(SONGS_PATH, []);
  const s = songs.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: '曲が見つかりません' });
  const log = readJson(AUTO_LOG_PATH, {});
  const entry = [...(log.fixed || []), ...(log.pending || [])].reverse().find(e => e.id === id && (e.kind === 'chorus') === (kind === 'chorus'));
  const autoValue = entry?.after ?? (kind === 'intro' ? s.intro : s.chorus);
  const before = { intro: s.intro || 0, chorus: s.chorus || 0 };
  let final;
  if (kind === 'intro') {
    const orig = s.introBefore ?? entry?.before ?? s.intro;
    final = action === 'ok' ? (entry && !['auto', 'songle'].includes(s.introSource) ? autoValue : s.intro) : action === 'revert' ? orig : value;
    s.intro = Math.round(final * 10) / 10;
    delete s.introSource; delete s.introBefore; delete s.introUnsure;
    if (action !== 'revert') { s.introMeasured = false; delete s.introMethod; } // 耳で確かめた位置＝手で直した扱い
  } else {
    const orig = s.chorusBefore ?? entry?.before ?? s.chorus;
    final = action === 'ok' ? (entry && !['audio2', 'songle'].includes(s.chorusSource) ? autoValue : s.chorus) : action === 'revert' ? orig : value;
    s.chorus = Math.round(final * 10) / 10;
    s.chorusSource = action === 'revert' ? 'audio' : 'manual';
    delete s.chorusBefore;
  }
  fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH);
  loadSongs();
  const reviews = readJson(AUTO_REVIEW_PATH, {});
  reviews[`${kind}:${id}`] = { action, value: kind === 'intro' ? s.intro : s.chorus, auto: autoValue, at: new Date().toISOString() };
  writeJson(AUTO_REVIEW_PATH, reviews);
  // 正解として学ぶ：直す前（自動の値）→ 耳で決めた値
  const hist = readJson(path.join(__dirname, 'data', 'fix-history.json'), []);
  hist.push({ id, title: s.title, work: s.work, channel: s.channel || '', at: new Date().toISOString(), by: 'review',
              before: { intro: kind === 'intro' ? autoValue : s.intro || 0, chorus: kind === 'chorus' ? autoValue : s.chorus || 0 },
              after: { intro: s.intro || 0, chorus: s.chorus || 0 } });
  writeJson(path.join(__dirname, 'data', 'fix-history.json'), hist);
  res.json({ ok: true, intro: s.intro, chorus: s.chorus, was: before });
});

// ── AI の修正案（ai-suggest.html。このPCから開いたときだけ）：サビの位置を、いまの値・学習で選んだ値・構造解析AIの値で聴き比べて決める ──
// 一覧は data/ai-suggest.json（tools/ai_suggest_*.py が書く）。決めた結果は data/ai-suggest-review.json に書き、正解として data/fix-history.json にも足す
const AI_SUGGEST_PATH = path.join(__dirname, 'data', 'ai-suggest.json');
const AI_REVIEW_PATH = path.join(__dirname, 'data', 'ai-suggest-review.json');
app.get('/api/ai-suggest', (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'このPCから開いたときだけ使えます' });
  loadSongs();
  const byId = new Map(ALL_SONGS.map(s => [s.id, s]));
  const reviews = readJson(AI_REVIEW_PATH, {}), list = readJson(AI_SUGGEST_PATH, { items: [] });
  const items = (list.items || []).map(it => {
    const s = byId.get(it.id); if (!s || s.retired) return null;
    return { ...it, title: s.title, work: s.work, artist: s.artist, year: s.year, intro: s.intro || 0, chorus: s.chorus || 0, chorusSource: s.chorusSource || null, review: reviews[it.id] || null };
  }).filter(Boolean);
  res.json({ items, methods: list.methods || {}, made: list.made || null });
});
app.post('/api/ai-suggest', (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'このPCから開いたときだけ使えます' });
  const id = String(req.body?.id || ''), value = Number(req.body?.value), pick = String(req.body?.pick || 'manual').slice(0, 30);
  if (!(value >= 0 && value <= 1200)) return res.status(400).json({ error: '秒数が正しくありません' });
  const songs = readJson(SONGS_PATH, []), s = songs.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: '曲が見つかりません' });
  const before = s.chorus || 0;
  s.chorus = Math.round(value * 10) / 10; s.chorusSource = 'manual'; delete s.chorusBefore;
  fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH);
  loadSongs();
  const reviews = readJson(AI_REVIEW_PATH, {});
  reviews[id] = { pick, value: s.chorus, before, at: new Date().toISOString() };
  writeJson(AI_REVIEW_PATH, reviews);
  const hist = readJson(path.join(__dirname, 'data', 'fix-history.json'), []); // 正解として学ぶ（どの案が当たったかも pick に残る）
  hist.push({ id, title: s.title, work: s.work, channel: s.channel || '', at: new Date().toISOString(), by: 'ai-suggest',
              before: { intro: s.intro || 0, chorus: before }, after: { intro: s.intro || 0, chorus: s.chorus } });
  writeJson(path.join(__dirname, 'data', 'fix-history.json'), hist);
  res.json({ ok: true, chorus: s.chorus, was: before });
});

// ── カップリング曲の管理（coupling.html。このPCから開いたときだけ）：印がある曲を見る・ふつうの曲に戻す・印を付ける ──
// 戻した曲には couplingNo を付ける（tools/merge-coupling.js・itunes-couplings.js で、あとからまた印を付けないように）
// 公開サイトでも、一覧は見られて、「カップリング曲です／ふつうの曲に戻して」の提案を送れる（書き換えは手元だけ。提案は反映の前に tools/pull-fixes.js で手元に取り込み、coupling.html の「届いた提案」で承認する）
const CW_REPORTS_PATH = path.join(__dirname, 'data', 'coupling-reports.json');
let CW_REPORTS = {}; // 公開側で受け付けた提案：id → { on, title, artist, at, n, notes[] }
try { CW_REPORTS = JSON.parse(fs.readFileSync(CW_REPORTS_PATH, 'utf8')).pending || {}; } catch (e) { CW_REPORTS = {}; }
const cwLast = new Map();
app.get('/api/coupling-reports', (req, res) => {
  // 手元：取り込み済みの提案（ファイル）を毎回読む／公開側：メモリ
  const local = canEdit(req) ? (readJson(CW_REPORTS_PATH, {}).pending || {}) : null;
  res.json({ 'coupling-reports': local || CW_REPORTS });
});
app.post('/api/coupling-reports', (req, res) => {
  if (canEdit(req) && req.body?.resolve) { // 手元：承認（apply）・却下
    const id = String(req.body.id || ''), file = readJson(CW_REPORTS_PATH, { pending: {}, resolved: {} }), rp = file.pending?.[id];
    if (!rp) return res.status(404).json({ error: '提案がありません' });
    if (req.body.apply) {
      const songs = readJson(SONGS_PATH, []), s = songs.find(x => x.id === id);
      if (s) { if (rp.on) { s.coupling = true; delete s.couplingNo; } else { delete s.coupling; s.couplingNo = true; } fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH); loadSongs(); }
    }
    delete file.pending[id]; (file.resolved = file.resolved || {})[id] = rp.at;
    writeJson(CW_REPORTS_PATH, file);
    return res.json({ ok: true });
  }
  const id = String(req.body?.id || ''), on = !!req.body?.on;
  const note = String(req.body?.note || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 100);
  const song = ALL_SONGS.find(s => s.id === id);
  if (!song) return res.status(400).json({ error: '曲が見つかりません' });
  const ip = String(req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();
  const recent = (cwLast.get(ip) || []).filter(x => Date.now() - x < 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: '少し時間をおいてから送ってください（1分に10件まで）' });
  cwLast.set(ip, [...recent, Date.now()]);
  if (!!song.coupling === on) return res.json({ ok: true, message: `「${song.title}」は、すでにそうなっています` });
  const r = CW_REPORTS[id] && CW_REPORTS[id].on === on ? CW_REPORTS[id] : { on, title: song.title, artist: song.artist, n: 0, notes: [] };
  r.n++; r.at = new Date().toISOString(); r.notes = [...(r.notes || []), ...(note ? [{ note, at: r.at }] : [])].slice(-10);
  CW_REPORTS[id] = r;
  datalog.touch();
  try { writeJson(CW_REPORTS_PATH, { pending: CW_REPORTS, resolved: readJson(CW_REPORTS_PATH, {}).resolved || {} }); } catch (e) { /* 保存できなくても受付は続ける */ }
  res.json({ ok: true, message: on ? `「${song.title}」を「カップリング曲」として受け付けました（確認して、次の更新で反映します）` : `「${song.title}」を「ふつうの曲に戻す」として受け付けました（確認して、次の更新で反映します）` });
});
app.get('/api/coupling', (req, res) => {
  loadSongs();
  res.json({ canEdit: canEdit(req), songs: ALL_SONGS.filter(s => !s.retired).map(s => ({ id: s.id, title: s.title, artist: s.artist, work: s.work, year: s.year, coupling: !!s.coupling, couplingOf: s.couplingOf || '' })) });
});
app.post('/api/coupling', (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'このPCから開いたときだけ使えます' });
  const id = String(req.body?.id || ''), on = !!req.body?.on;
  const songs = readJson(SONGS_PATH, []), s = songs.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: '曲が見つかりません' });
  if (on) { s.coupling = true; delete s.couplingNo; } else { delete s.coupling; s.couplingNo = true; }
  fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH);
  loadSongs();
  res.json({ ok: true, coupling: on });
});

// ── 曲リクエスト（トップ画面の「出してほしい曲」）──
// 公開サーバーは再起動（反映）すると書き込んだファイルが消えるので、反映の前に tools/pull-requests.js で手元に取り込んでから曲を追加する。
// status: open（受付中）／added（追加済み）／notfound（見つからず）
const REQUESTS_PATH = path.join(__dirname, 'data', 'requests.json');
let REQUESTS = [];
try { REQUESTS = JSON.parse(fs.readFileSync(REQUESTS_PATH, 'utf8')); } catch (e) { REQUESTS = []; }
const REQ_MAX = 300, REQ_INTERVAL = 5 * 1000; // 受付中は最大300件、同じ人（IP）からは5秒に1件
const reqLast = new Map();
const reqNorm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s!！?？・〜~～()（）\-♪.。,、'"「」『』]/g, '');
const reqText = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
function saveRequests() {
  datalog.touch();
  try { fs.writeFileSync(REQUESTS_PATH + '.tmp', JSON.stringify(REQUESTS, null, 1) + '\n'); fs.renameSync(REQUESTS_PATH + '.tmp', REQUESTS_PATH); } catch (e) { /* 保存できなくても受付は続ける */ }
}
app.get('/api/requests', (req, res) => res.json({
  // 追加済みのリクエストには、曲のID（songId）を付ける。トップ画面の「イントロ・サビを直す」から、その曲の編集を開くため
  requests: REQUESTS.slice(-500).reverse().map(r => {
    if (r.status !== 'added') return r;
    const id = r.songId && ALL_SONGS.some(s => s.id === r.songId && !s.retired) ? r.songId
      : ALL_SONGS.find(s => !s.retired && reqNorm(s.title) === reqNorm(r.title) && (!r.work || reqNorm(s.work).includes(reqNorm(r.work)) || reqNorm(r.work).includes(reqNorm(s.work))))?.id;
    return id ? { ...r, songId: id } : r;
  }),
  genres: GENRE_KEYS.map(k => ({ key: k, label: GENRES[k].label })),
}));
app.post('/api/requests', (req, res) => {
  const title = reqText(req.body?.title, 60), work = reqText(req.body?.work, 60), artist = reqText(req.body?.artist, 40), note = reqText(req.body?.note, 80);
  const genre = GENRE_KEYS.includes(req.body?.genre) ? req.body.genre : ''; // 今あるジャンルから選ぶ（任意）
  if (!title) return res.status(400).json({ error: '曲名を入れてください' });
  const ip = String(req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();
  // すでにある曲は知らせるだけ。同じリクエストはまとめる
  const key = reqNorm(title), wkey = reqNorm(work);
  const have = ALL_SONGS.find(s => reqNorm(s.title) === key && (!wkey || reqNorm(s.work).includes(wkey) || wkey.includes(reqNorm(s.work))));
  if (have) return res.json({ ok: true, exists: true, message: `「${have.title}」（${have.work}）はもう入っています` });
  if (Date.now() - (reqLast.get(ip) || 0) < REQ_INTERVAL) return res.status(429).json({ error: '少し時間をおいてから送ってください（5秒に1件まで）' });
  const same = REQUESTS.find(r => reqNorm(r.title) === key && (!wkey || !r.work || reqNorm(r.work) === wkey));
  reqLast.set(ip, Date.now());
  if (same) { same.votes = (same.votes || 1) + 1; saveRequests(); return res.json({ ok: true, message: `同じリクエストに1票足しました（${same.votes}票）` }); }
  if (REQUESTS.filter(r => r.status === 'open').length >= REQ_MAX) return res.status(429).json({ error: 'リクエストがいっぱいです。追加されるまでお待ちください' });
  REQUESTS.push({ id: crypto.randomBytes(4).toString('hex'), title, work, artist, genre, note, at: new Date().toISOString(), status: 'open', votes: 1 });
  saveRequests();
  res.json({ ok: true, message: 'リクエストを受け付けました' });
});

// ── 追加を検討中の曲（リクエストのまわりで見つけたが、有名曲の基準に届かなかった曲）──
// トップ画面のリクエストの横に出し、だれでも「入れてほしい」を押せる。票が入った曲は、反映の前に tools/pull-requests.js で取り込んで追加する。
const CANDIDATES_PATH = path.join(__dirname, 'data', 'candidates.json');
let CANDIDATES = [];
try { CANDIDATES = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8')); } catch (e) { CANDIDATES = []; }
const voted = new Set(); // IP:曲 → 同じ人が同じ曲に何度も押せないように（再起動で消える）
function saveCandidates() {
  datalog.touch();
  try { fs.writeFileSync(CANDIDATES_PATH + '.tmp', JSON.stringify(CANDIDATES, null, 1) + '\n'); fs.renameSync(CANDIDATES_PATH + '.tmp', CANDIDATES_PATH); } catch (e) { /* 保存できなくても受付は続ける */ }
}
app.get('/api/candidates', (req, res) => res.json({
  candidates: CANDIDATES.filter(c => c.status === 'pending')
    .sort((a, b) => (b.votes || 0) - (a.votes || 0) || (b.views || 0) - (a.views || 0))
    .map(({ id, title, work, artist, year, type, views, votes, reason, videoId, requestId }) => ({ id, title, work, artist, year, type, views, votes, reason, videoId, requestId })),
}));
app.post('/api/candidates/vote', (req, res) => {
  const c = CANDIDATES.find(x => x.id === String(req.body?.id || '') && x.status === 'pending');
  if (!c) return res.status(400).json({ error: '曲が見つかりません' });
  const ip = String(req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();
  if (voted.has(`${ip}:${c.id}`)) return res.json({ ok: true, message: 'この曲にはもう票を入れています' });
  voted.add(`${ip}:${c.id}`);
  c.votes = (c.votes || 0) + 1;
  saveCandidates();
  res.json({ ok: true, votes: c.votes, message: `「${c.title}」に1票入れました（次の更新で追加します）` });
});

// ── お試しの曲を「ゲームデータに入れる」が押された記録（公開サーバーは再起動で消えるので、反映の前に pull-promotes.js で取り込む）──
const PROMOTES_PATH = path.join(__dirname, 'data', 'promotes.json');
let PROMOTES = {};
try { PROMOTES = JSON.parse(fs.readFileSync(PROMOTES_PATH, 'utf8')); } catch (e) { PROMOTES = {}; }
function savePromotes() { datalog.touch(); try { fs.writeFileSync(PROMOTES_PATH + '.tmp', JSON.stringify(PROMOTES, null, 1) + '\n'); fs.renameSync(PROMOTES_PATH + '.tmp', PROMOTES_PATH); } catch (e) { /* 保存できなくても続ける */ } }
app.get('/api/promotes', (req, res) => res.json({ promotes: Object.fromEntries(Object.entries(PROMOTES).map(([id, e]) => [id, { title: e.title, votes: e.votes.length, at: e.at }])) }));

// ── 追加プレビュー画面（preview.html。このPCから開いたときだけ）──
require('./lib/preview')(app, { canEdit, root: __dirname, loadSongs, candidates: () => CANDIDATES, saveCandidates });

// ── 収録曲一覧（トップ画面の「収録曲一覧」）と、イントロ・サビ位置の修正の受け付け ──
// 修正は誰でも送れる。曲データにはすぐ入れず「修正待ち」として溜め、反映の前に tools/pull-fixes.js で取り込む（公開サーバーは再起動でファイルが消えるため）。
const FIXES_PATH = path.join(__dirname, 'data', 'fixes.json');
let FIXES = {};
try { FIXES = JSON.parse(fs.readFileSync(FIXES_PATH, 'utf8')); } catch (e) { FIXES = {}; }
const fixLast = new Map(); // IP → 直近の送信時刻（連投を防ぐ）
// 送られた修正は、受け付けたらすぐ曲データ（メモリ上）に入れて、次の出題から使う。ファイルへの取り込みは反映の前に tools/pull-fixes.js で
function applyFixes() {
  const byId = new Map(ALL_SONGS.map(s => [s.id, s]));
  for (const [id, f] of Object.entries(FIXES)) { const s = byId.get(id); if (s) { s.intro = f.intro; s.chorus = f.chorus; } }
}
applyFixes();
function saveFixes() {
  datalog.touch();
  try { fs.writeFileSync(FIXES_PATH + '.tmp', JSON.stringify(FIXES, null, 1) + '\n'); fs.renameSync(FIXES_PATH + '.tmp', FIXES_PATH); } catch (e) { /* 保存できなくても受付は続ける */ }
}
// ── 曲の情報（アニメ名・歌っている人・作者）の直し：すでにある名前（カテゴリ）から選んだものだけ受け付けて、すぐ使う。
//    反映の前に tools/pull-fixes.js で曲データに取り込む（data/info-fixes.json は空に戻す）──
const INFO_PATH = path.join(__dirname, 'data', 'info-fixes.json');
let INFO_FIXES = {};
try { INFO_FIXES = JSON.parse(fs.readFileSync(INFO_PATH, 'utf8')); } catch (e) { INFO_FIXES = {}; }
const infoLast = new Map();
function applyInfoFixes() {
  const byId = new Map(ALL_SONGS.map(s => [s.id, s]));
  for (const [id, f] of Object.entries(INFO_FIXES)) { const s = byId.get(id); if (!s) continue; if (f.work) s.work = f.work; if (f.artist) s.artist = f.artist; }
}
applyInfoFixes();
const authorOfWork = w => String(w || '').normalize('NFKC').match(/^ボカロ\((.+)\)$/)?.[1] || null;
let CATS = null; // 名前の一覧（曲が変わったら作り直す）
function categories() {
  if (CATS) return CATS;
  const works = new Set(), artists = new Set(), authors = new Map(); // authors：作者名 → 作品欄の書き方（ボカロ（○○））
  // 直す前の名前も一覧に残す（その曲しかない名前を直しても、元に戻せるように）
  const rows = [...ALL_SONGS, ...Object.values(INFO_FIXES).map(f => f.before || {})];
  for (const s of rows) {
    const a = authorOfWork(s.work);
    if (a) { if (!authors.has(a)) authors.set(a, s.work); } else if (s.work) works.add(s.work);
    if (s.artist) artists.add(s.artist);
  }
  const sort = arr => [...arr].sort((x, y) => x.localeCompare(y, 'ja'));
  CATS = { works: sort(works), artists: sort(artists), authors: sort(authors.keys()), authorWork: authors };
  return CATS;
}
app.get('/api/categories', (req, res) => { const c = categories(); res.json({ works: c.works, artists: c.artists, authors: c.authors }); });
app.get('/api/song-info', (req, res) => res.json({ 'song-info': INFO_FIXES }));
app.post('/api/song-info', (req, res) => {
  const id = String(req.body?.id || ''), song = ALL_SONGS.find(s => s.id === id);
  if (!song) return res.status(400).json({ error: '曲が見つかりません' });
  const ip = String(req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();
  const recent = (infoLast.get(ip) || []).filter(t => Date.now() - t < 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: '少し時間をおいてから送ってください（1分に10曲まで）' });
  const c = categories(), b = req.body || {}, after = {};
  if (b.work != null && b.work !== song.work) { if (!c.works.includes(b.work)) return res.status(400).json({ error: 'アニメ名は一覧から選んでください' }); after.work = b.work; }
  if (b.author != null && b.author !== authorOfWork(song.work)) { if (!c.authorWork.has(b.author)) return res.status(400).json({ error: '作者は一覧から選んでください' }); after.work = c.authorWork.get(b.author); }
  if (b.artist != null && b.artist !== song.artist) { if (!c.artists.includes(b.artist)) return res.status(400).json({ error: '歌っている人は一覧から選んでください' }); after.artist = b.artist; }
  if (!Object.keys(after).length) return res.status(400).json({ error: '変わったところがありません' });
  infoLast.set(ip, [...recent, Date.now()]);
  const prev = INFO_FIXES[id];
  INFO_FIXES[id] = { title: song.title, before: prev?.before || { work: song.work, artist: song.artist }, work: after.work || prev?.work || null, artist: after.artist || prev?.artist || null, at: new Date().toISOString() };
  if (after.work) song.work = after.work;
  if (after.artist) song.artist = after.artist;
  CATS = null; buildSeries();
  datalog.touch();
  try { fs.writeFileSync(INFO_PATH + '.tmp', JSON.stringify(INFO_FIXES, null, 1) + '\n'); fs.renameSync(INFO_PATH + '.tmp', INFO_PATH); } catch (e) { /* 保存できなくても受付は続ける */ }
  res.json({ ok: true, song: { work: song.work, artist: song.artist }, message: `「${song.title}」を直しました（${after.work ? '作品：' + song.work : ''}${after.work && after.artist ? '／' : ''}${after.artist ? '歌：' + song.artist : ''}）` });
});

app.post('/api/live/lyrics', (req, res) => {
  if (!liveOk(req)) return res.status(403).json({ error: '鍵が正しくありません' });
  const b = req.body || {};
  if (b.reset) LYRICS_MEM.clear();
  let n = 0;
  for (const [id, v] of Object.entries(b.songs || {})) {
    if (typeof id !== 'string' || !Array.isArray(v?.lines)) continue;
    LYRICS_MEM.set(id, { lines: v.lines.filter(x => x && typeof x.text === 'string').map(x => ({ t: typeof x.t === 'number' ? x.t : null, text: x.text.slice(0, 200) })), sync: !!v.sync }); n++;
  }
  res.json({ ok: true, added: n, total: LYRICS_MEM.size });
});
app.post('/api/live/push', (req, res) => {
  if (!liveOk(req)) return res.status(403).json({ error: '鍵が正しくありません' });
  const b = req.body || {}, out = { songs: 0, requests: 0, candidates: 0 };
  const fileIds = new Set(JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8')).map(s => s.id));
  for (const s of Array.isArray(b.songs) ? b.songs : []) {
    if (!s || typeof s.id !== 'string' || !s.title) continue;
    LIVE_SONGS[s.id] = { ...s, liveBase: LIVE_BASE }; out.songs++; if (!fileIds.has(s.id)) out.added = (out.added || 0) + 1;
  }
  for (const m of Array.isArray(b.requests) ? b.requests : []) {
    const r = REQUESTS.find(x => x.id === m.id); if (!r || !['open', 'added', 'notfound'].includes(m.status)) continue;
    r.status = m.status; if (m.songId) r.songId = m.songId; r.doneAt = m.doneAt || new Date().toISOString(); out.requests++;
    // near：このリクエストのまわりとして追加した曲（リクエスト一覧に出す）
    if (Array.isArray(m.near)) r.near = m.near.slice(0, 20).map(x => ({ title: String(x.title || '').slice(0, 80), work: String(x.work || '').slice(0, 80), artist: String(x.artist || '').slice(0, 80), songId: String(x.songId || '').slice(0, 20) }));
  }
  if (Array.isArray(b.candidates)) {
    const votes = new Map(CANDIDATES.map(c => [c.id, c.votes || 0]));
    CANDIDATES = b.candidates.map(c => ({ ...c, votes: Math.max(c.votes || 0, votes.get(c.id) || 0) })); out.candidates = CANDIDATES.length; saveCandidates();
  }
  if (out.requests) saveRequests();
  loadSongs(); if (typeof CATS !== 'undefined') CATS = null; GZ_CATALOG = null;
  datalog.touch();
  res.json({ ok: true, ...out, total: SONGS.length });
});
app.get('/api/catalog', (req, res) => {
  loadSongs();
  // 自動チェック（tools/scan_videos.py）で「原曲でない・サビの位置がずれているかも」とされた曲
  let flags = {};
  try { flags = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'scan-flags.json'), 'utf8')); } catch (e) { flags = {}; }
  res.json({
    genres: GENRE_KEYS.map(k => ({ key: k, label: GENRES[k].label })),
    fame: FAME.map(([k, label]) => ({ key: k, label })),
    songs: SONGS.map(s => ({ id: s.id, title: s.title, work: s.work, artist: s.artist, year: s.year, type: s.type || '',
      genres: genresOf(s), genreOwn: !!SONG_GENRES[s.id]?.genres, fame: fameOf(s), fameOwn: !!SONG_FAME[s.id], intro: s.intro || 0, chorus: chorusOf(s), chorusKnown: s.chorus > 0, fix: FIXES[s.id] || null, warn: flags[s.id] || null,
      report: REPORTS[s.id] ? { wrong: REPORTS[s.id].wrong || 0, delete: REPORTS[s.id].delete || 0 } : null,
      // 自動の解析で直した（tools/auto_fix.py）。直す前の値も出して、収録曲一覧で確かめ・戻せるように
      auto: ['auto', 'songle'].includes(s.introSource) || ['audio2', 'songle'].includes(s.chorusSource)
        ? { intro: ['auto', 'songle'].includes(s.introSource) ? s.introBefore ?? 0 : null, chorus: ['audio2', 'songle'].includes(s.chorusSource) ? s.chorusBefore ?? null : null } : null })),
  });
});
app.get('/api/fixes', (req, res) => res.json({ fixes: FIXES }));
app.post('/api/fixes', (req, res) => {
  const id = String(req.body?.id || ''), intro = Number(req.body?.intro), chorus = Number(req.body?.chorus);
  const song = ALL_SONGS.find(s => s.id === id);
  if (!song) return res.status(400).json({ error: '曲が見つかりません' });
  if (!(intro >= 0 && intro <= 1200 && chorus >= 0 && chorus <= 1200)) return res.status(400).json({ error: '秒数が正しくありません' });
  const ip = String(req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();
  const recent = (fixLast.get(ip) || []).filter(t => Date.now() - t < 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: '少し時間をおいてから送ってください（1分に10曲まで）' });
  fixLast.set(ip, [...recent, Date.now()]);
  const r = x => Math.round(x * 10) / 10;
  FIXES[id] = { intro: r(intro), chorus: r(chorus), at: new Date().toISOString(), count: (FIXES[id]?.count || 0) + 1, title: song.title };
  saveFixes();
  song.intro = FIXES[id].intro; song.chorus = FIXES[id].chorus; // すぐ使う（次にこの曲が出たときから）
  res.json({ ok: true, message: `「${song.title}」の位置を直しました（次にこの曲が出たときから使われます）` });
});

// 収録曲一覧の「ジャンルを直す」：だれでも送れて、すぐ使う。反映の前に tools/pull-fixes.js でファイルに取り込む（reset：自動の判定に戻す）
const genreFixLast = new Map();
// 収録曲一覧の「知名度を直す」：だれでも送れて、すぐ使う。反映の前に tools/pull-fixes.js で曲データに取り込む（reset：自動の判定に戻す）
const fameFixLast = new Map();
app.get('/api/song-fame', (req, res) => res.json({ 'song-fame': SONG_FAME, resets: SONG_FAME_RESETS }));
const SONG_FAME_RESETS = {}; // 自動に戻した曲（取り込みのとき、曲データの手で決めた印を外す）
app.post('/api/song-fame', (req, res) => {
  const id = String(req.body?.id || ''), song = ALL_SONGS.find(s => s.id === id);
  if (!song) return res.status(400).json({ error: '曲が見つかりません' });
  const ip = String(req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();
  const recent = (fameFixLast.get(ip) || []).filter(t => Date.now() - t < 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: '少し時間をおいてから送ってください（1分に10曲まで）' });
  fameFixLast.set(ip, [...recent, Date.now()]);
  const at = new Date().toISOString();
  if (req.body?.reset) { delete SONG_FAME[id]; SONG_FAME_RESETS[id] = { at, title: song.title }; }
  else {
    if (!FAME_KEYS.includes(req.body?.fame)) return res.status(400).json({ error: '知名度が正しくありません' });
    SONG_FAME[id] = { fame: req.body.fame, at, title: song.title }; delete SONG_FAME_RESETS[id];
  }
  datalog.touch();
  try { fs.writeFileSync(SONG_FAME_PATH + '.tmp', JSON.stringify(SONG_FAME, null, 1) + '\n'); fs.renameSync(SONG_FAME_PATH + '.tmp', SONG_FAME_PATH); } catch (e) { /* 保存できなくても受付は続ける */ }
  applyFame();
  res.json({ ok: true, fame: fameOf(song), message: `「${song.title}」の知名度を${req.body?.reset ? '自動の判定に戻しました' : `「${FAME.find(([k]) => k === req.body.fame)?.[1]}」にしました`}（すぐ使われます）` });
});
app.get('/api/song-genres', (req, res) => res.json({ 'song-genres': SONG_GENRES }));
app.post('/api/song-genres', (req, res) => {
  const id = String(req.body?.id || ''), song = ALL_SONGS.find(s => s.id === id);
  if (!song) return res.status(400).json({ error: '曲が見つかりません' });
  const ip = String(req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();
  const recent = (genreFixLast.get(ip) || []).filter(t => Date.now() - t < 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: '少し時間をおいてから送ってください（1分に10曲まで）' });
  genreFixLast.set(ip, [...recent, Date.now()]);
  if (req.body?.reset) SONG_GENRES[id] = { genres: null, reset: true, at: new Date().toISOString(), title: song.title };
  else {
    const list = Array.isArray(req.body?.genres) ? [...new Set(req.body.genres.filter(k => GENRES[k]))] : null;
    if (!list) return res.status(400).json({ error: 'ジャンルが正しくありません' });
    SONG_GENRES[id] = { genres: list, at: new Date().toISOString(), title: song.title };
  }
  datalog.touch();
  try { fs.writeFileSync(SONG_GENRES_PATH + '.tmp', JSON.stringify(SONG_GENRES, null, 1) + '\n'); fs.renameSync(SONG_GENRES_PATH + '.tmp', SONG_GENRES_PATH); } catch (e) { /* 保存できなくても受付は続ける */ }
  buildSeries();
  res.json({ ok: true, genres: genresOf(song), message: `「${song.title}」のジャンルを${req.body?.reset ? '自動の判定に戻しました' : '直しました'}（すぐ使われます）` });
});

// ── マイページ（名前だけで登録。合言葉なし）：お気に入り・もう聞きたくない・苦手な曲・もう一度出してほしい曲・成績・称号 ──
// key：名前を NFKC・前後の空白なし・小文字にしたもの（同じ名前は1人だけ）。名前を知っていればだれでも開ける
const USERS_PATH = path.join(__dirname, 'data', 'users.json');
let USERS = {};
try { USERS = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); } catch (e) { USERS = {}; }
let usersTimer = null;
function saveUsers() {
  datalog.touch();
  clearTimeout(usersTimer);
  usersTimer = setTimeout(() => { try { fs.writeFileSync(USERS_PATH + '.tmp', JSON.stringify(USERS) + '\n'); fs.renameSync(USERS_PATH + '.tmp', USERS_PATH); } catch (e) { /* 保存できなくても続ける */ } }, 2000);
}
const userKey = n => String(n || '').normalize('NFKC').replace(/[\u0000-\u001f]/g, '').trim().toLowerCase();
const freshUser = name => ({ name, created: new Date().toISOString(), fav: [], block: [], weak: {}, again: [], prefs: null,
                             stats: { games: 0, correct: 0, answered: 0, wins: 0, byPlay: {} }, titles: {} });
const userPublic = u => u && { name: u.name, created: u.created, fav: u.fav, block: u.block, weak: u.weak, again: u.again, stats: u.stats, titles: u.titles, prefs: u.prefs || null };
// マイページに保存する設定（曲の範囲・出題のしかた・答え方・得点・部屋の設定）。ゲームごとの「前に出た曲を除外しない／記録しない」は保存しない
const prefKeys = () => [...new Set([...Object.keys(OPTIONS), 'questions', 'choices', 'maxPlayers', 'yearFrom', 'yearTo', 'typingExtra', 'coopGoal', 'fame', 'series', 'multiGenres', 'multiSeries', 'gzPicks', 'introLen', 'hintAt', 'chorusLen'])].filter(k => !['noExclude', 'noRecord'].includes(k));
const prefsOf = (settings, excludeGenres) => {
  const PREF_KEYS = prefKeys(); const picked = {}; for (const k of PREF_KEYS) if (settings && settings[k] !== undefined) picked[k] = settings[k];
  const s = sanitizeSettings(picked, { ...DEFAULTS }); // 正しい値だけにする
  const out = {}; for (const k of PREF_KEYS) if (picked[k] !== undefined && s[k] !== undefined) out[k] = s[k];
  return { settings: out, excludeGenres: [...new Set((Array.isArray(excludeGenres) ? excludeGenres : []).filter(k => GENRES[k]))], at: new Date().toISOString() };
};
// 部屋にいる人（つながっている人）のマイページをまとめる：出題の候補に使う
function userCtx(room) {
  const fav = new Set(), block = new Set(), weak = new Set();
  for (const p of room.players.values()) {
    const u = p.connected && p.user && USERS[p.user];
    if (!u) continue;
    u.fav.forEach(id => fav.add(id)); u.block.forEach(id => block.add(id));
    Object.keys(u.weak).forEach(id => weak.add(id)); u.again.forEach(id => weak.add(id));
  }
  return { fav, block, weak };
}
const userHits = new Map(); // IP → 直近の操作の時刻（連打を防ぐ）
const userLimit = (req, n, ms) => {
  const ip = String(req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = ip + ':' + n, recent = (userHits.get(k) || []).filter(x => Date.now() - x < ms);
  if (recent.length >= n) return true;
  userHits.set(k, [...recent, Date.now()]); return false;
};
app.post('/api/user/login', (req, res) => {
  const name = String(req.body?.name || '').normalize('NFKC').replace(/[\u0000-\u001f]/g, '').trim();
  const key = userKey(name);
  if ([...name].length < 2 || [...name].length > 12 || key === 'ゲスト') return res.status(400).json({ error: '名前は2〜12文字で入れてください' });
  if (USERS[key]) return res.json({ ok: true, user: userPublic(USERS[key]) });
  if (userLimit(req, 5, 60 * 60 * 1000)) return res.status(429).json({ error: '新しい登録は少し時間をおいてからにしてください' });
  USERS[key] = freshUser(name); saveUsers();
  res.json({ ok: true, created: true, user: userPublic(USERS[key]) });
});
// 設定の保存・削除（部屋を作るとき自動で使われる）
app.post('/api/user/prefs', (req, res) => {
  const u = USERS[userKey(req.body?.name)];
  if (!u) return res.status(404).json({ error: 'その名前は登録されていません' });
  if (userLimit(req, 30, 60 * 1000)) return res.status(429).json({ error: '少し時間をおいてからにしてください' });
  if (req.body?.clear) u.prefs = null;
  else if (req.body?.settings && typeof req.body.settings === 'object') u.prefs = prefsOf(req.body.settings, req.body.excludeGenres);
  else return res.status(400).json({ error: '設定がありません' });
  saveUsers();
  res.json({ ok: true, user: userPublic(u) });
});
app.get('/api/user', (req, res) => {
  const u = USERS[userKey(req.query.name)];
  if (!u) return res.status(404).json({ error: 'その名前は登録されていません' });
  res.json({ user: userPublic(u) });
});
// リストの出し入れ：fav（お気に入り）／block（もう聞きたくない）／again（もう一度出してほしい）／weak（苦手：外すだけ）
// お気に入りともう聞きたくないは逆なので、片方に入れたらもう片方からは外す
app.post('/api/user/list', (req, res) => {
  const u = USERS[userKey(req.body?.name)], list = String(req.body?.list || ''), id = String(req.body?.id || ''), on = !!req.body?.on;
  if (!u) return res.status(404).json({ error: 'その名前は登録されていません' });
  if (!['fav', 'block', 'again', 'weak'].includes(list) || !ALL_SONGS.some(s => s.id === id)) return res.status(400).json({ error: '曲が見つかりません' });
  if (userLimit(req, 120, 60 * 1000)) return res.status(429).json({ error: '少し時間をおいてからにしてください' });
  if (list === 'weak') { if (!on) delete u.weak[id]; }
  else {
    u[list] = u[list].filter(x => x !== id);
    if (on) u[list].push(id);
    if (on && list === 'fav') u.block = u.block.filter(x => x !== id);
    if (on && list === 'block') { u.fav = u.fav.filter(x => x !== id); u.again = u.again.filter(x => x !== id); }
  }
  saveUsers();
  for (const r of rooms.values()) if ([...r.players.values()].some(p => p.user === userKey(u.name))) broadcastRoom(r); // 部屋の出題できる曲数を更新
  res.json({ ok: true, user: userPublic(u) });
});
// 答え合わせ：間違えた・パスした曲は苦手に（回数）。正解したら苦手・もう一度出してほしいから外す
const WEAK_MAX = 400;
function userReveal(room, q, results) {
  const byId = new Map([...room.players.values()].map(p => [p.id, p])), id = q.song.id;
  let changed = false;
  for (const r of results) {
    const p = byId.get(r.id), u = p?.user && USERS[p.user];
    if (!u) continue;
    changed = true;
    if (r.answered && !r.pass) u.stats.answered++;
    if (r.correct) { u.stats.correct++; delete u.weak[id]; u.again = u.again.filter(x => x !== id); continue; }
    if (room.settings.play === 'karuta' && !r.answered) continue; // かるたは札に触らなかった曲を苦手にしない（取られただけ）
    u.weak[id] = (u.weak[id] || 0) + 1;
    const keys = Object.keys(u.weak);
    if (keys.length > WEAK_MAX) delete u.weak[keys.sort((a, b) => u.weak[a] - u.weak[b])[0]]; // 多すぎたら回数の少ないものから
  }
  if (changed) saveUsers();
}
// ゲームの終わり：遊んだ回数・1位（2人以上のとき）・遊び方ごと・もらった称号
function userEndGame(room, ranking, titles) {
  let changed = false;
  const multi = ranking.length >= 2, play = room.settings.play;
  for (const p of room.players.values()) {
    const u = p.user && USERS[p.user];
    if (!u || !ranking.some(r => r.id === p.id)) continue;
    changed = true;
    const win = multi && ranking[0]?.id === p.id;
    u.stats.games++; if (win) u.stats.wins++;
    const b = u.stats.byPlay[play] || (u.stats.byPlay[play] = { games: 0, wins: 0 });
    b.games++; if (win) b.wins++;
    for (const x of titles) if (x.id === p.id) u.titles[x.title] = (u.titles[x.title] || 0) + 1;
  }
  if (changed) saveUsers();
}

// 収録曲一覧の「曲が違う（探し直す）」「削除を依頼」。誰でも送れる。反映の前に tools/pull-fixes.js で修正と一緒に取り込む
// 曲が違う → 反映のときに正しい動画を探して差し替える／削除 → 消さずに出題から外す（retired）
const REPORTS_PATH = path.join(__dirname, 'data', 'reports.json');
let REPORTS = {};
try { REPORTS = JSON.parse(fs.readFileSync(REPORTS_PATH, 'utf8')); } catch (e) { REPORTS = {}; }
const reportLast = new Map();
app.get('/api/reports', (req, res) => res.json({ reports: REPORTS }));
app.post('/api/reports', (req, res) => {
  const id = String(req.body?.id || ''), kind = String(req.body?.kind || '');
  const note = String(req.body?.note || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  const song = ALL_SONGS.find(s => s.id === id);
  if (!song) return res.status(400).json({ error: '曲が見つかりません' });
  if (!['wrong', 'delete', 'info'].includes(kind)) return res.status(400).json({ error: '種類が正しくありません' });
  // info：曲名・作品名（アニメ名）・歌っている人・作者（ボカロ）の直し。変えた欄だけ受け取る
  const clean = v => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  const fix = {};
  if (kind === 'info') {
    for (const k of ['title', 'work', 'artist', 'author']) { const v = clean(req.body?.fix?.[k]); if (v) fix[k] = v; }
    if (!Object.keys(fix).length) return res.status(400).json({ error: '直すところを入れてください' });
  }
  const ip = String(req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();
  const recent = (reportLast.get(ip) || []).filter(t => Date.now() - t < 60 * 1000);
  if (recent.length >= 5) return res.status(429).json({ error: '少し時間をおいてから送ってください（1分に5件まで）' });
  reportLast.set(ip, [...recent, Date.now()]);
  const r = REPORTS[id] || { title: song.title, work: song.work, wrong: 0, delete: 0, notes: [] };
  r[kind] = (r[kind] || 0) + 1;
  r.notes = [...(r.notes || []), { kind, note, ...(kind === 'info' ? { fix } : {}), at: new Date().toISOString() }].slice(-20);
  REPORTS[id] = r;
  datalog.touch();
  try { fs.writeFileSync(REPORTS_PATH + '.tmp', JSON.stringify(REPORTS, null, 1) + '\n'); fs.renameSync(REPORTS_PATH + '.tmp', REPORTS_PATH); } catch (e) { /* 保存できなくても受付は続ける */ }
  res.json({ ok: true, message: kind === 'info' ? `「${song.title}」の修正の依頼を受け付けました（確認して、次の更新で直します）`
    : kind === 'wrong' ? `「${song.title}」を「曲が違う」として受け付けました（次の更新で探し直します）`
    : `「${song.title}」の削除の依頼を受け付けました（次の更新で出題から外します）` });
});

const server = http.createServer(app);
const io = new Server(server);

// ── 設定 ──
const OPTIONS = {
  introLen: [3, 5, 10, 15],
  hintAt: [5, 10, 15, 20],
  chorusLen: [10, 15, 20],
  typingExtra: [5, 10, 15, 20, 30],
  questions: [1, 3, 5, 10, 20, 30], // 1・3：ババ抜き・大富豪など、1回が長い遊び方用
  mode: ['score', 'buzz'],
  answerMode: ['choice', 'input'],
  clues: [true, false],
  lifelines: [true, false],
  quizType: ['intro', 'sabimae', 'mix', 'random', 'outro', 'utaidashi', 'notchorus', 'oneline'], // utaidashi：歌い出しから／notchorus：サビ以外の歌詞の行から／oneline：歌詞の一行だけ（data/lyric-times.json の曲） // イントロ／サビ前／1問ごとにランダム／どこから（曲の途中）／アウトロ（曲の終わり）
  // 遊び方：ふつう／早押し（押した人だけ答える）／サバイバル（ライフがなくなったら脱落）／出題者（順番に1人が曲を選ぶ）／協力（全員の正解数で目標）／ビンゴ
  play: ['normal', 'buzzer', 'survival', 'picker', 'coop', 'bingo', 'fill', 'rush', 'poker', 'panel', 'karuta', 'nenpyo', 'wolf', 'dixit', 'baba', 'codenames', 'daifugo', 'wits', 'sugoroku', 'genre', 'deck', 'kaerema', 'azul', 'genreex', 'dentatsu', 'lyrics'], // lyrics：歌詞クイズ（歌詞の合言葉で作った非公開の部屋だけ） // dentatsu：アニソン伝達クイズ（伝える人だけが曲を聴いて、文字のヒントで伝える。ほかの人は選択肢から当てる） // genreex：アニソン・ジャンル制覇EX（集める種類を6つ以上・年代や曲の種類・知名度も選べる） // azul：アニソン・アズール（曲カードを取り合い、年代別の棚に並べる） // kaerema：アニソン帰れま10（お題の曲の再生回数トップ10を全部当てる） // deck：アニソン・デッキ構築（正解でコイン、3問ごとのショップでカードを買う） // genre：アニソン・ジャンル制覇（6ジャンルのピースを集める。正解した人が次のジャンルを選ぶ） // sugoroku：アニソンすごろく（正解の速さでコマを進める） // wits：アニソン年当てベット（発売年を予想して、いちばん近い予想に賭ける） // daifugo：アニソン大富豪（発売年が新しい曲ほど強い。年は見えない） // codenames：アニソン・コードネーム（2チームで作品名の盤面から味方の作品を当てる） // baba：アニソン・ババ抜き（同じ作品の曲2枚がペア） // dixit：アニソン・ディクシット（語り手のヒントから、手札の曲を出して語り手の曲を当てる） // wolf：アニソン人狼（1人だけ別の曲。ヒントと話し合いで当てる） nenpyo：アニソン年表（曲を年表の正しい位置に置く） karuta：アニソンかるた（並んだ札から早取り） panel：アニソン陣取り（正解したらパネルを取る） // poker：アニソン・ポーカー（正解した曲のカードで役を作る） // fill：3つ埋めバトル（曲名・アニメ名・アーティストを早押しで埋める）
  target: ['song', 'work', 'year', 'artist'], // 答えるもの：曲名／作品／年／歌手
  speed: ['1', '1.5', '2', '0.75', '0.5', 'random'], // 再生速度（問題の間ずっと。答え合わせでふつうに戻す）
  coopGoal: [50, 70, 90],                 // 協力：問題数×人数の何%正解で達成
  lockSec: [15, 3, 5, 10, 20, 30],        // 3つ埋めバトル：間違えた人が押せない秒数
  noRepeat: [false, true],                // 3つ埋めバトル：間違えた人は、ほかの人が押すまで押せない（連続解答なし）
  buzzStop: [true, false],
  wolfWork: ['hide', 'show'],   // アニソン人狼：候補に作品名（タイトル）を出す（既定は出さない）
  lessPlayed: [false, true],            // 統計（流れた回数）が少ない曲を優先して出す
  noCoupling: [false, true],            // カップリング曲（シングルのB面）を出さない（曲データの coupling が true の曲）
  dtChoices: [4, 8, 12], // 伝達クイズ：選択肢の数
  lyKind: ['mix', 'which', 'blank', 'next'], // 歌詞クイズ：出題の種類
  kmTop: [10, 15, 20], // 帰れま10：当てる順位の数（トップ10／15／20）
  gzSet: ['fixed', 'random', 'choose'], // ジャンル制覇：集めるジャンルの決め方（fixed：今の6つ／random：ゲームごとにランダム／choose：選ぶ）
  gzCount: [6, 7, 8, 10, 12, 15, 20, 25], // ジャンル制覇EX：ランダムで決める種類の数
  gzPick: ['choose', 'random'], // ジャンル制覇：次のジャンル（choose：最速の正解者が選ぶ／random：毎問ランダム）
  wolfTitle: ['show', 'hide'],  // アニソン人狼：候補に曲名を出す（既定は出す。曲名も作品名も出さないときは、候補の一覧を出さない）
  karutaFace: ['title', 'work', 'artist'], // アニソンかるた：札に書くもの（曲名・作品名・歌手名）                // 早押し・3つ埋めバトル：押した人が答えている間、曲と残り時間を止める
  rushRate: ['normal', 'high', 'low'],     // アニソン激アツRUSH：当たりやすさ（ふつう／出やすい×1.5／出にくい×0.6）
  bingoEnd: ['p1', 'p2', 'p3', 'l2', 'l3', 'all'], // ビンゴの終わり：p〇＝〇人がBINGO／l〇＝だれかが〇ビンゴ／all＝問題数まで
  lives: [1, 2, 3],                       // サバイバルのライフ
  teams: [false, true],                   // チーム戦（赤・青の2チーム。合計点で競う）
  leadSec: [3, 5, 10],                   // サビ前：サビの何秒前から流すか
  autoNext: [8, 12, 0],                  // 答え合わせから自動で次へ進むまでの秒数（0 は自動で進まない）
  bonus: [true, false],                  // 連続正解ボーナス・最終問題2倍
  topic: ['all', 'series', 'multi', 'playlist', 'favorites', 'weak', ...GENRE_KEYS], // favorites・weak：部屋にいる人（マイページ）のお気に入り・苦手な曲 // お題：全部／作品を選ぶ／ジャンル（data/genres.json）
  introPlays: [1, 2, 3],                 // イントロを流す回数（わからなかったときのため、頭から流し直す）
  noExclude: [false, true],              // 前に出た曲・ログを貼った曲も出す（除外しない。同じゲームの中で重なることはない）
  noRecord: [false, true],               // これから遊ぶ曲を除外に追加しない（ロビーの一番上のボタン）
};

const AVATARS = 12; // 席ごとに割り当てるアバター画像の数（public/assets/glass/avatar-1〜12）
const DEFAULTS = { introLen: 5, hintAt: 10, chorusLen: 15, choices: 8, mode: 'score', questions: 10, maxPlayers: 12,
                   yearFrom: 1980, yearTo: 2029, answerMode: 'choice', clues: true, lifelines: false, typingExtra: 10,
                   quizType: 'intro', leadSec: 5, autoNext: 8, bonus: true, topic: 'all', introPlays: 1, noExclude: false, noRecord: false,
                   lessPlayed: false, play: 'normal', target: 'song', lives: 1, teams: false, speed: '1', coopGoal: 70, lockSec: 15, noRepeat: false, bingoEnd: 'p1', rushRate: 'normal', buzzStop: true, karutaFace: 'title', wolfWork: 'hide', wolfTitle: 'show', gzPick: 'choose', gzSet: 'fixed', gzCount: 10, gzPicks: [], kmTop: 10, dtChoices: 8, lyKind: 'mix', noCoupling: false };
const SURVIVAL_MAX = 50; // サバイバルは問題数の代わりに、終わるまで出す（最大この問題数）
const BUZZ_SEC = 10;     // 早押し：押した人が答えられる秒数
const BUZZ_MISS = 200;   // 早押し：お手つき（間違い・時間切れ）の減点
const YEAR_POINTS = [1000, 800, 600, 400, 200, 200]; // 年代当て：ずれ 0〜5 年の得点（それ以上は 0）
// 新しい部屋で最初から除外しておくジャンル（アニソン以外）
const DEFAULT_EXCLUDE = ['vocaloid', 'jpop', 'slot']; // ライフラインは使わない（画面からも外した）
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
  // ジャンル制覇：選んだ種類（カタログにあるものだけ）
  if (Array.isArray(input.gzPicks)) { const ok = new Set(gzCatalog().map(c => c.key)); s.gzPicks = [...new Set(input.gzPicks.filter(k => ok.has(k)))].slice(0, 30); }
  // 自由に選ぶお題（ジャンル・作品を何個でも）
  if (Array.isArray(input.multiGenres)) s.multiGenres = [...new Set(input.multiGenres.filter(k => GENRES[k]))];
  if (Array.isArray(input.multiSeries)) { const names = new Set(SERIES_LIST.map(x => x.name)); s.multiSeries = [...new Set(input.multiSeries.filter(n => names.has(n)))].slice(0, 500); }
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
  // できない組み合わせ：年代当て＋早押し、サバイバル＋チーム戦
  if (s.target === 'year' && s.play === 'buzzer') s.play = 'normal';
  if (['survival', 'coop', 'bingo', 'rush', 'poker', 'nenpyo', 'wolf', 'dixit', 'baba', 'codenames', 'daifugo', 'wits', 'sugoroku', 'genre', 'genreex', 'deck', 'kaerema', 'azul', 'dentatsu'].includes(s.play) && s.teams) s.teams = false; // サバイバル・協力・ビンゴはチーム戦にしない（3つ埋めバトルはできる。お手つきはチームで共有）
  return s;
}

// 部屋の年代設定に合う曲
// ctx：部屋にいる人のマイページ（userCtx）。「もう聞きたくない」曲はいつも外す。お気に入り・苦手のお題は、年代・知名度の設定に関係なく全部
function poolFor(settings, ctx = {}) {
  // 知名度はお題に関係なく、チェックした段階の曲だけにする（難しさの調整）
  const fame = Array.isArray(settings.fame) && settings.fame.length ? settings.fame : FAME_KEYS;
  const mine = ['favorites', 'weak'].includes(settings.topic);
  const out = (settings.topic === 'playlist' ? STAGED : SONGS).filter(s => (mine || (s.year >= settings.yearFrom && s.year <= settings.yearTo && fame.includes(fameOf(s)))) && inTopic(s, settings, ctx) && !(settings.noCoupling && s.coupling)
    && !ctx.block?.has(s.id)
    && !(settings.play === 'fill' && genresOf(s).includes('lol'))); // 3つ埋めバトルに LoL の曲は出さない
  out.noCoupling = !!settings.noCoupling;
  out.ex = ['all', 'multi'].includes(settings.topic || 'all') ? settings.excludeGenres || [] : []; // 選択肢を足りない分だけ外から足すときも、除外したジャンルは使わない
  return out;
}

const cleanName = n => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12) || 'ゲスト';
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// 除外中（前に出た・ログを貼った）の曲でも、超有名・有名の曲はときどき出す（除外していない曲の 1/10 の出やすさ）
const POPULAR_REPEAT = 0.1;
const isPopular = s => fameOf(s) === 'top' || fameOf(s) === 'famous';
// [曲, 重み] から重みつきで n 曲を選ぶ（同じ曲は選ばない。並びもランダム）。u^(1/重み) が大きい順に取る方法
function weightedPick(items, n) {
  return items.map(([song, w]) => [song, Math.random() ** (1 / w)]).sort((a, b) => b[1] - a[1]).slice(0, n).map(([song]) => song);
}

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

function createRoom({ roomName, password, lyrics = false } = {}) {
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
    createdAt: Date.now(), // 部屋を作った時刻（部屋一覧・部屋の中で表示）
    lyricsOk: !!lyrics, // 歌詞の合言葉で作った非公開の部屋（歌詞クイズが遊べる。部屋の一覧に出さない）
  };
  rooms.set(room.code, room);
  return room;
}

// ── 部屋一覧（ホーム画面用）。誰もいない部屋は出さない ──
function roomList() {
  return [...rooms.values()]
    .filter(r => connectedPlayers(r).length > 0 && !r.lyricsOk) // 歌詞クイズの部屋（非公開）は一覧に出さない
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
        createdAt: r.createdAt,
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
    createdAt: room.createdAt,
    locked: !!room.passwordHash,
    lyricsOk: !!room.lyricsOk, lyricsSongs: room.lyricsOk ? LYRICS_MEM.size : 0,
    hostId: room.hostId,
    settings: room.settings,
    poolSize: poolFor(room.settings, userCtx(room)).length,
    excluded: room.played?.size || 0,
    excludedHere: room.playedHere?.size || 0, // そのうち、この部屋で流したから除外になった曲
    paused: !!room.game?.paused,
    state: room.state,
    phase: q?.phase || null,
    qNo: room.game ? room.game.qi + 1 : 0,
    qTotal: room.game ? room.game.order.length : 0,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, score: p.score, streak: p.streak || 0, connected: p.connected,
      answered: !!q?.answers.has(p.token), inGame: !!q?.participants.has(p.token),
      lifelines: p.lifelines || null,
      deck: room.settings.play === 'deck' && p.dk ? { ...p.dk, vpPrice: DK_VP + p.dk.vp } : null,
      team: room.settings.teams ? p.team || null : null, lives: p.lives ?? null, out: !!p.out,
      buzzing: q?.buzz?.token === p.token, // 早押しでいま答えている人
      card: room.settings.play === 'bingo' && p.card ? p.card.map(c => ({ w: c.w, open: c.open })) : null, bingo: !!p.bingoAt,
      picker: q?.picker === p.token,
      pokerCount: room.settings.play === 'poker' ? (p.hand || []).length : null,
      pokerKept: room.settings.play === 'poker' ? (p.kept || []).length : null,
      timeline: room.settings.play === 'nenpyo' && p.timeline ? p.timeline.map(c => ({ year: c.year, title: c.title })) : null,
      karutaCount: room.settings.play === 'karuta' ? p.karutaCards || 0 : null, karutaRest: room.settings.play === 'karuta' && room.game ? p.karutaRest === room.game.qi : false,
      panelCount: room.settings.play === 'panel' && room.game?.panel ? room.game.panel.filter(x => x === panelOwner(room, p)).length : null,
      rush: room.settings.play === 'rush' && p.rush?.left > 0 ? { chara: p.rush.chara || 0, mode: p.rush.mode, chain: p.rush.chain, left: p.rush.left, mult: p.rush.mode === 'rush' ? RUSH_MULT[Math.min(p.rush.chain + 1, RUSH_MULT.length) - 1] : p.rush.mode === 'super' ? SUPER_MULT[Math.min(p.rush.chain + 1, SUPER_MULT.length) - 1] : MODE_MULT[p.rush.mode] || 1 } : null,
      passed: !!q?.fillPass?.has(p.token), // 3つ埋めバトルでパスした人
    })),
    fill: fillPublic(room, q),
    teams: teamScores(room),
    coop: room.game?.coop || null,
    genreZone: isGz(room.settings.play) && room.game?.gz && room.state === 'playing'
      ? { cats: room.game.gz.cats.map(c => ({ key: c.key, label: c.label, icon: c.icon })), ex: room.settings.play === 'genreex', cur: room.game.gz.cur, gain: room.game.gz.gain || null, at: room.game.gz.at ?? -1, pick: room.game.gz.pick ? { id: room.game.gz.pick.id, name: room.game.gz.pick.name, until: room.game.gz.pick.until } : null,
          players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, pieces: [...(room.game.gz.pieces.get(p.id) || [])] })) } : null,
    deckGame: room.settings.play === 'deck' && room.game && room.state === 'playing' ? { qNo: Math.max(0, room.game.qi + 1), qTotal: room.game.order.length, shopsDone: room.game.dkShopN || 0, shopsTotal: dkShopTotal(room.game), nextShopIn: Math.min(DK_EVERY - ((room.game.qi + 1) % DK_EVERY || DK_EVERY) + 0, room.game.order.length - (room.game.qi + 1)) } : null,
    sugoroku: room.settings.play === 'sugoroku' && room.game?.sg && room.state === 'playing'
      ? { board: room.game.sg.board, goal: SG_GOAL, last: room.game.sg.last, moves: room.game.sg.moves || [], at: room.game.sg.at ?? -1, pos: [...room.players.values()].map(p => ({ id: p.id, name: p.name, pos: room.game.sg.pos.get(p.id) || 0, rest: room.game.sg.rest.has(p.id), dbl: room.game.sg.dbl.has(p.id) })) } : null,
    panel: room.settings.play === 'panel' && room.game?.panel && room.state === 'playing'
      ? { board: room.game.panel, attackCell: room.game.attackCell ?? null, pick: room.game.panelPick ? { id: room.game.panelPick.id, name: room.game.panelPick.name, allowed: room.game.panelPick.allowed, until: room.game.panelPick.until, stage: room.game.panelPick.stage, attack: !!room.game.panelPick.attack } : null } : null,
    // 激アツRUSH：保留ランプ（いまの問題の色と、先の4問の色）。当たりかどうかは入れない
    rush: room.settings.play === 'rush' && room.game?.rushPlan && room.state === 'playing'
      ? { color: room.game.rushPlan[room.game.qi]?.color || null, state: room.game.rushPlan[room.game.qi]?.state || 0, next: room.game.rushPlan.slice(room.game.qi + 1, room.game.qi + 5).map(x => x.color) } : null,
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
// 動画の長さ（秒）。自動チェック（tools/scan_videos.py）の結果から。「どこから」問題で曲の終わりを越えないように使う
// 歌詞の行の時刻（tools/lyric-times.js が作る。歌詞の文字は入っていない）：歌い出し・サビ以外・一行だけの問題で使う
let LYRIC_TIMES = {};
try { LYRIC_TIMES = require('./data/lyric-times.json'); } catch (e) { /* なくても動く（その問題はイントロで出す） */ }
const LYRIC_KINDS = ['utaidashi', 'notchorus', 'oneline'];
// 歌詞の問題の流し始め（秒）と流す長さ。歌詞の時刻がない曲は null（イントロで出す）
function lyricStart(song, kind, S) {
  const L = LYRIC_TIMES[song.id]; if (!L || !L.t.length) return null;
  const pick = arr => arr[crypto.randomInt(arr.length)];
  if (kind === 'utaidashi') return { start: Math.max(0, L.t[0] - 0.3), len: S.introLen };
  const ch = chorusOf(song), idx = L.t.map((x, i) => i);
  if (kind === 'notchorus') { // くり返す行（サビらしい行）・サビの前後・最初の2行は使わない
    const ok = idx.filter(i => i >= 2 && !L.r[i] && Math.abs(L.t[i] - ch) > 12);
    const i = ok.length ? pick(ok) : null; if (i == null) return null;
    return { start: Math.max(0, L.t[i] - 0.3), len: S.introLen };
  }
  if (kind === 'oneline') { // 一行だけ：その行の長さ（2〜7秒）だけ流して止める
    const ok = idx.filter(i => i + 1 < L.t.length && L.t[i + 1] - L.t[i] >= 1.5);
    const i = ok.length ? pick(ok) : null; if (i == null) return null;
    return { start: Math.max(0, L.t[i] - 0.2), len: Math.min(7, Math.max(2, L.t[i + 1] - L.t[i] - 0.1)) };
  }
  return null;
}
// ── 歌詞クイズ（非公開の部屋だけ）──
// 歌詞の文字は、このPCから tools/push-lyrics-live.js で送ったものを、サーバーのメモリにだけ置く（ファイル・git・data-log には書かない。再起動で消える）。
// 遊べるのは、部屋を作るときに「歌詞の合言葉」（data/lyrics-pass.sha256 と同じもの）を入れ、パスワードを付けた部屋だけ（部屋の一覧に出さない・10人まで）
const LYRICS_MEM = new Map(); // 曲ID → { lines: [{ t, text }], sync }
let LY_PASS_HASH = '';
try { LY_PASS_HASH = fs.readFileSync(path.join(__dirname, 'data', 'lyrics-pass.sha256'), 'utf8').trim(); } catch (e) { /* なければ歌詞クイズは使えない */ }
const lyricsPassOk = p => !!LY_PASS_HASH && typeof p === 'string' && p.length > 0 && crypto.createHash('sha256').update(p.trim()).digest('hex') === LY_PASS_HASH;
const LY_MAX = 10;
const LY_ASK = { which: 'この歌詞の曲は？', blank: '曲を聴いて、？に入る言葉は？', next: '続きの歌詞はどれ？' };
// 歌詞の問題：kind = which（この歌詞の曲は？）／blank（穴あき）／next（続きはどれ？）。曲を流す問題は、動画と時刻が合う曲だけ
function lyricQuestion(kind, song, n, pool) {
  const L = LYRICS_MEM.get(song.id)?.lines; if (!L || L.length < 6) return null;
  const pickR = a => a[crypto.randomInt(a.length)];
  if (kind === 'which') {
    const i = 1 + crypto.randomInt(Math.max(1, L.length - 3));
    const ch = buildChoices(song, n, pool.length >= n * 2 ? Object.assign(pool.slice(), { strict: true, ex: [] }) : pool);
    return { lyric: { ask: LY_ASK.which, show: L.slice(i, i + 2).map(x => x.text) }, choices: ch.choices, correctIndex: ch.correctIndex, play: null };
  }
  if (!LYRICS_MEM.get(song.id).sync || L.some(x => x.t == null)) return null;
  if (kind === 'blank') {
    const cand = [];
    L.forEach((x, i) => { for (const m of x.text.matchAll(/[\u4E00-\u9FFF々]{2,}|[\u30A0-\u30FF]{3,}|[A-Za-z]{4,}/g)) cand.push({ i, w: m[0], at: m.index }); });
    if (!cand.length) return null;
    const c = pickR(cand), line = L[c.i], latin = /[A-Za-z]/.test(c.w), words = new Set();
    for (const s of shuffle(pool.filter(x => LYRICS_MEM.has(x.id))).slice(0, 60)) for (const l of LYRICS_MEM.get(s.id).lines)
      for (const m of l.text.matchAll(latin ? /[A-Za-z]{4,}/g : /[\u4E00-\u9FFF々]{2,}|[\u30A0-\u30FF]{3,}/g)) if (m[0] !== c.w && Math.abs(m[0].length - c.w.length) <= 1) words.add(m[0]);
    const choices = shuffle([c.w, ...shuffle([...words]).slice(0, n - 1)]).map(w => ({ title: w, work: '' }));
    return { lyric: { ask: LY_ASK.blank, before: line.text.slice(0, c.at), after: line.text.slice(c.at + c.w.length) }, choices, correctIndex: choices.findIndex(x => x.title === c.w),
             play: { from: Math.max(0, (L[c.i - 1]?.t ?? line.t) - 0.3), until: L[c.i + 1]?.t ?? line.t + 6 } };
  }
  if (kind === 'next') {
    const ok = L.map((x, i) => i).filter(i => i >= 1 && i + 1 < L.length && L[i + 1].text !== L[i].text);
    if (!ok.length) return null;
    const i = pickR(ok), right = L[i + 1].text;
    const others = new Set(L.filter(x => x.text !== right && x.text !== L[i].text).map(x => x.text));
    for (const s of shuffle(pool.filter(x => x !== song && LYRICS_MEM.has(x.id))).slice(0, 6)) others.add(pickR(LYRICS_MEM.get(s.id).lines).text);
    const choices = shuffle([right, ...shuffle([...others]).slice(0, n - 1)]).map(x => ({ title: x, work: '' }));
    return { lyric: { ask: LY_ASK.next, show: [L[i - 1].text, L[i].text], tail: true }, choices, correctIndex: choices.findIndex(x => x.title === right),
             play: { from: Math.max(0, L[i - 1].t - 0.3), until: L[i + 1].t - 0.2 } };
  }
  return null;
}
let DURATIONS = new Map();
try { DURATIONS = new Map(Object.entries(require('./data/scan-videos.json')).filter(([, v]) => v?.dur > 0).map(([id, v]) => [id, v.dur])); } catch (e) { /* なくても動く */ }
// 「どこから」問題の流し始め：イントロでもサビでもない、曲の途中のどこか（サビのあたりは避ける）
function randomStart(song) {
  const intro = song.intro || 0, chorus = chorusOf(song), dur = DURATIONS.get(song.id);
  const lo = intro + 15, hi = dur ? dur - 25 : (hasChorus(song) ? chorus + 20 : intro + 40);
  const avoid = [chorus - 6, chorus + 22]; // サビの少し前〜サビの間
  const spots = [];
  for (let t = lo; t <= hi; t += 1) if (t < avoid[0] || t > avoid[1]) spots.push(t);
  if (!spots.length) return Math.max(intro, Math.min(lo, chorus - 10)); // 短い曲：イントロの後あたり
  return spots[crypto.randomInt(spots.length)];
}

// 除外の記録。room.played：出題しない曲（前から除外していた曲＋この部屋で流した曲）。
// room.playedHere：そのうち「この部屋で流したから」除外になった曲だけ（ロビーの「このルームで流した曲の除外を解除」で外す）
// ── 再生の統計（曲ごとの「流れた回数」「答えた人数・正解した人数」と、日ごと・遊び方ごとのゲーム数・出題数）──
// 数えるのは公開サーバー（Render）だけ（手元の試しのゲームは数えない。環境変数 COUNT_STATS=1 なら手元でも数える）。
// 公開側の数は、反映の前の tools/pull-fixes.js で手元の data/play-stats.json に取り込む（再起動で戻らないように）
const STATS_PATH = path.join(__dirname, 'data', 'play-stats.json');
const todayStr = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // 日本時間の日付
let PSTATS = readJson(STATS_PATH, null) || { since: todayStr(), songs: {}, days: {}, byPlay: {} };
const statsOn = !!process.env.RENDER || process.env.COUNT_STATS === '1';
let statsTimer = null;
function statsTouch() {
  datalog.touch(); clearTimeout(statsTimer);
  statsTimer = setTimeout(() => { try { writeJson(STATS_PATH, PSTATS); } catch (e) { /* 保存できなくても数え続ける */ } }, 5000);
}
const statsDay = () => (PSTATS.days[todayStr()] = PSTATS.days[todayStr()] || { games: 0, plays: 0 });
function statsGame(room) { // ゲームが始まった
  if (!statsOn) return;
  statsDay().games++;
  const b = (PSTATS.byPlay[room.settings.play] = PSTATS.byPlay[room.settings.play] || { games: 0, plays: 0 }); b.games++;
  statsTouch();
}
function statsPlay(room, song) { // 曲が流れた（出題された）
  if (!statsOn || !song?.id) return;
  const r = (PSTATS.songs[song.id] = PSTATS.songs[song.id] || [0, 0, 0]); r[0]++;
  statsDay().plays++;
  const b = (PSTATS.byPlay[room.settings.play] = PSTATS.byPlay[room.settings.play] || { games: 0, plays: 0 }); b.plays++;
  statsTouch();
}
function statsReveal(room, q, results) { // 答え合わせ：答えた人数・正解した人数
  if (!statsOn || !q?.song?.id) return;
  const r = (PSTATS.songs[q.song.id] = PSTATS.songs[q.song.id] || [0, 0, 0]);
  for (const x of results) { if (x.pass || !x.answered) continue; r[1]++; if (x.correct) r[2]++; }
  statsTouch();
}
app.get('/api/play-stats', (req, res) => {
  const days = Object.fromEntries(Object.entries(PSTATS.days).sort().slice(-90));
  res.json({ 'play-stats': PSTATS, since: PSTATS.since, days, counting: statsOn });
});
function recordPlayed(room, s) {
  // どの遊び方でも、出た曲を画面の「🛠 修正」の候補に送る
  if (s?.id) {
    const fs_ = { id: s.id, title: s.title, work: s.work, artist: s.artist, type: s.type, year: s.year, intro: s.intro || 0, chorus: s.chorus || 0 };
    room.fixRecent = [fs_, ...(room.fixRecent || []).filter(x => x.id !== s.id)].slice(0, 30); // 入り直した人にも送る
    io.to(room.code).emit('fixSong', fs_);
  }
  if (!room.playedHere) room.playedHere = new Set();
  const before = room.played.has(s.id) && !room.playedHere.has(s.id); // 前から除外していた曲（貼り付けたログ・端末の記録）
  room.played.delete(s.id); // 新しく出た曲ほど後ろ（戻すのは古い順）
  if (room.kept?.has(s.id)) return; // 「除外しない」にした曲は記録しない
  room.played.add(s.id);
  if (!before) room.playedHere.add(s.id);
}
function unrecordPlayed(room, s) { room.played.delete(s.id); room.playedHere?.delete(s.id); }

function startGame(room) {
  const S = room.settings;
  const ctx = userCtx(room);
  const pool = poolFor(S, ctx);
  if (pool.length === 0) return false;
  if (S.play === 'picker' && connectedPlayers(room).length < 2) return 'picker'; // 出題者モードは2人以上
  if (S.play === 'wolf' && connectedPlayers(room).length < 3) return 'wolf'; // 人狼は3人以上
  if (S.play === 'dixit' && connectedPlayers(room).length < 3) return 'dixit'; // ディクシットは3人以上
  if (S.play === 'dentatsu' && connectedPlayers(room).length < 2) return 'dentatsu'; // 伝達クイズは2人以上
  if (S.play === 'baba' && connectedPlayers(room).length < 3) return 'baba'; // ババ抜きは3人以上
  if (S.play === 'codenames' && connectedPlayers(room).length < 4) return 'codenames'; // コードネームは4人以上
  if (S.play === 'daifugo' && connectedPlayers(room).length < 3) return 'daifugo'; // 大富豪は3人以上
  // サビ前だけの部屋は、サビの位置が確かな曲から出す（足りなければ全部から）
  let candidates = pool;
  if (S.quizType === 'sabimae') {
    const sure = pool.filter(hasChorus);
    if (sure.length >= S.questions) candidates = sure;
  }
  if (S.play === 'lyrics') {
    if (!room.lyricsOk) return 'lyricsLocked';
    const ly = pool.filter(s => LYRICS_MEM.has(s.id));
    if (!ly.length) return 'lyricsEmpty';
    // 曲を流す問題（穴あき・続き・ミックス）は、動画と歌詞の時刻が合う曲を優先（足りなければ全部から）
    const synced = ly.filter(s => LYRICS_MEM.get(s.id).sync);
    candidates = S.lyKind !== 'which' && synced.length >= Math.min(S.questions, 10) ? synced : ly;
  }
  if (LYRIC_KINDS.includes(S.quizType) && S.play !== 'lyrics') { // 歌詞の問題は、歌詞の時刻がある曲から（足りなければ、ない曲はイントロで出す）
    const ly = pool.filter(s => LYRIC_TIMES[s.id]);
    if (ly.length >= Math.min(S.questions, 5)) candidates = ly;
  }
  // この部屋で前のゲームに出た曲・貼り付けたログの曲は避ける。足りなければ古く除外した曲から戻して使う
  if (!room.played) room.played = new Set();
  const want = S.play === 'survival' ? SURVIVAL_MAX : S.play === 'panel' ? PANEL_MAX : S.play === 'sugoroku' ? SG_MAX : isGz(S.play) ? GZ_MAX : S.play === 'nenpyo' ? NENPYO_MAX : S.questions; // サバイバルは終わるまで（最大 SURVIVAL_MAX 問）
  const need = Math.min(want, candidates.length);
  let fresh = S.noExclude ? [...candidates] : candidates.filter(s => !room.played.has(s.id) || ctx.fav.has(s.id)); // お気に入りは前に出ていても外さない
  if (fresh.length < need) {
    const byId = new Map(candidates.map(s => [s.id, s]));
    for (const id of room.played) {
      if (fresh.length >= need) break;
      if (byId.has(id)) { fresh.push(byId.get(id)); room.played.delete(id); }
    }
  }
  const n = Math.min(want, fresh.length);
  const freshSet = new Set(fresh);
  const popular = S.noExclude ? [] : candidates.filter(s => !freshSet.has(s) && room.played.has(s.id) && isPopular(s));
  room.state = 'playing';
  for (const p of room.players.values()) {
    p.score = 0; p.streak = 0; p.lifelines = freshLifelines(S);
    p.dk = S.play === 'deck' ? { coins: +process.env.DK_TEST_COINS || 0, invest: 0, boost: 0, vp: 0 } : null; // デッキ構築：コイン・投資・ブースト・勝利点を買った数
    p.lives = S.play === 'survival' ? S.lives : null; p.out = false; p.outAt = 0; // サバイバル：ライフ・脱落・何問目で脱落したか
  }
  if (S.teams) assignTeams(room);
  // 曲オブジェクトそのものを持つ（ゲーム中に曲データが保存し直されても影響しないように）
  // 流れた回数が少ない曲を優先：みんなの遊びの統計で、流れた回数が多い曲ほど選ばれにくくする（0回の曲がいちばん出やすい）
  const playW = s => (S.lessPlayed ? 1 / (1 + (PSTATS.songs[s.id]?.[0] || 0)) ** 2 : 1);
  const order = spreadLowFame(capLowFame(weightedPick([...fresh.map(s => [s, playW(s)]), ...popular.map(s => [s, POPULAR_REPEAT * playW(s)])], n), [fresh, candidates]));
  if (S.play === 'poker') { biasPokerOrder(order, [fresh.length ? fresh : candidates, candidates]); spreadLowFame(order); }
  // 人狼・かるた：同じ曲名の曲（曲名のそろえた形が同じ）は、同じゲームに2問入れない。かぶったら別の曲に入れ替える
  if (S.play === 'wolf' || S.play === 'karuta') {
    const used = new Set(), spare = shuffle([...(fresh.length ? fresh : candidates), ...candidates].filter((s, i, arr) => arr.indexOf(s) === i));
    for (let i = 0; i < order.length; i++) {
      const k = normText(order[i].title);
      if (!used.has(k)) { used.add(k); continue; }
      const r = spare.find(s => !order.includes(s) && !used.has(normText(s.title)));
      if (r) { order[i] = r; used.add(normText(r.title)); }
    }
  }
  const pokerPool = shuffle(Array.from({ length: 13 }, (_, i) => i + 1));
  const pokerDeck = S.play === 'poker' ? shuffle(candidates.filter(s => !order.includes(s))) : null; // ボーナスカード用の山（出題に使わない曲）
  // アニソン激アツRUSH：全問の色と当たりをここで決める（当たりの問題には、パチスロで有名な曲を入れる）
  const rushPlan = S.play === 'rush' ? buildRushPlan(order, fresh.length ? fresh : candidates, S) : null;
  if (!S.noRecord) order.forEach(s => recordPlayed(room, s));
  room.gameNo = (room.gameNo || 0) + 1; // この部屋で何ゲーム目か（曲ログ用）
  statsGame(room);
  room.game = { order, pool, qi: -1, q: null, timers: [], stats: new Map(), // stats: token -> 称号用の成績
                rushPlan, // 激アツRUSH：問題ごとの { color, hit }
                pokerDeck, // アニソン・ポーカー：ボーナスカードの山
                sg: S.play === 'sugoroku' ? { board: sgBoard(), pos: new Map(), rest: new Set(), dbl: new Set(), last: [] } : null, sgDone: false, gz: isGz(S.play) ? { pieces: new Map(), cur: null, pick: null, cats: gzBuildCats(S) } : null, gzDone: false, // ジャンル制覇：id → 持っているジャンル。// アニソンすごろく：盤・コマの位置（id → マス）
                panel: S.play === 'panel' ? Array(25).fill(null) : null, panelPick: null, panelDone: false, // アニソン陣取り：盤（持ち主の id）・いま選んでいる人
                pokerPool, pokerNums: new Map(), // 数字の残り・作品ごとの数字
                bingoTarget: S.target, // ビンゴのマスの種類（ゲームの途中で答えるものを変えても、配ったカードのまま）
                solo: connectedPlayers(room).length <= 1 }; // サバイバル：1人で遊ぶときはライフがなくなるまで、2人以上なら残り1人まで
  // 協力：目標は「問題数 × 人数 × 目標%」をゲーム開始時に決める（途中で人数が変わっても変えない）
  if (S.play === 'coop') room.game.coop = { goal: Math.max(1, Math.ceil(order.length * connectedPlayers(room).length * S.coopGoal / 100)), count: 0 };
  // ビンゴ：一人ひとりにカードを配る（途中から入った人には入ったときに配る）
  for (const p of room.players.values()) { p.rush = freshRush(); p.hand = []; p.kept = []; p.karutaCards = 0; p.karutaRest = -1;
    p.timeline = S.play === 'nenpyo' ? [nenpyoStartCard(room, order, ctx)] : null; p.card = S.play === 'bingo' ? bingoCard(order, pool, S.target) : null; p.bingoAt = 0; p.reachN = 0; p.bingoLinesN = 0; }
  // 動作確認用（本番では使わない）：環境変数 PANEL_TEST_FILL=マス数 で、陣取りの盤を先に埋める（アタックチャンスの確認用）
  if (S.play === 'panel' && +process.env.PANEL_TEST_FILL > 0) { const ids = [...room.players.values()].map(p => panelOwner(room, p)); for (let i = 0; i < +process.env.PANEL_TEST_FILL && i < 25; i++) room.game.panel[i] = ids[i % ids.length]; }
  // 動作確認用（本番では使わない）：環境変数 POKER_DEAL=枚数 で、はじめから手札を配る
  if (S.play === 'poker' && +process.env.POKER_DEAL > 0) for (const p of room.players.values()) for (let i = 0; i < +process.env.POKER_DEAL && room.game.pokerDeck.length; i++) p.hand.push(cardOf(room.game.pokerDeck.pop(), room));
  if (S.play === 'poker' && +process.env.POKER_DEAL > 0) for (const p of room.players.values()) sendPokerHand(room, p);
  nextQuestion(room);
  return true;
}

// ── アニソン激アツRUSH：保留の色 → 当たり → 大当たり → RUSH（確変）。仕様は docs/rush-spec.md ──
const RUSH_COLORS = ['blue', 'green', 'red', 'gold', 'rainbow']; // 青・緑・赤・金・虹
const RUSH_WEIGHT = [66, 20, 9, 4, 1];                             // 色が出る重み（%）
const RUSH_HIT = [0.05, 0.15, 0.40, 0.75, 1];                      // 色ごとの当たりやすさ
const RUSH_RATE = { normal: 1, high: 1.5, low: 0.6 };              // 設定「当たりやすさ」
const RUSH_BONUS = 2000;                                           // 大当たりのボーナス点
const RUSH_MULT = [2, 2.5, 3, 3.5, 4];                             // 連チャンごとの倍率（上限 ×4）
const RUSH_MAX = 10;                                               // RUSH は最大この問題数（当たりでまた10に戻る）
const freshRush = () => ({ left: 0, chain: 0, earned: 0, jackpots: 0, maxChain: 0, rainbow: 0, mode: 'normal', streak: 0, forgive: 0, chara: 0 });
// 通常中の確率変動（状態 0〜3）：ルナ（低確）→ミコト→ヒナタ→ミヤビ（高確）。問題ごとに状態が動き、状態が高いほど当たりやすい（キャラで気づける）
const STATE_HIT = [0.5, 0.9, 1.4, 2.0];
const nextState = s => { const r = Math.random(); return r < 0.58 ? s : r < 0.8 ? Math.min(3, s + 1) : Math.max(0, s - 1); };
// モード：通常 → チャンス（3連続正解）→ RUSH（大当たり）→ 超RUSH（RUSH中に5連チャン、または天国で大当たり）→ 天国（RUSH／超RUSHを走りきったあと）
// left > 0 のあいだは、通常以外のモード中。len＝そのモードの問題数、mult＝点数の倍率、bonus＝大当たりのボーナス点
const RUSH_MODE = {
  chance: { len: 5, bonus: 3000, label: 'CHANCE', sub: '連続正解のチャンス！ 当たれば大きい' },
  rush:   { len: RUSH_MAX, bonus: 2000, label: 'RUSH', sub: '大当たり継続中！ 当てるほど加速' },
  super:  { len: 5, bonus: 5000, label: 'SUPER RUSH', sub: '超RUSH！ 倍率MAX級' },
  heaven: { len: 5, bonus: 2000, label: 'HEAVEN', sub: '天国モード：1回だけミスOK' },
};
const MODE_MULT = { chance: 1.2, heaven: 1.5 }; // 固定倍率（RUSH・超RUSH は連チャンで上がる）
const SUPER_MULT = [4, 4.5, 5, 5, 5];
const SUPER_AT = 5;        // RUSH中にこの連チャンで超RUSHへ
const HEAVEN_RATE = 0.6;   // RUSHを走りきったあと天国へ行く確率
const CHANCE_AT = 3;       // 通常でこの連続正解でチャンスへ
// 予兆：色が良いほど、当たりの問題ほど、多くて強い（ガセもある）。f は「イントロの中のどのへんで」（0〜1）、lv は強さ 1〜3
const OMEN_BASE = [0, 1, 2, 3, 4];
const OMEN_KIND = { 1: ['flash', 'voice', 'ripple'], 2: ['shake', 'redout', 'voice'], 3: ['lightning', 'group', 'rainbow'] };
function makeOmens(ci, hit) {
  let n = OMEN_BASE[ci] + (Math.random() < 0.4 ? 1 : 0) - (ci < 2 && Math.random() < 0.4 ? 1 : 0);
  if (hit) n += Math.random() < 0.5 ? 1 : 0; else if (ci >= 2 && Math.random() < 0.3) n += 1; // ガセ予告
  n = Math.max(0, Math.min(5, n));
  const out = [];
  const fs_ = Array.from({ length: n }, () => 0.12 + Math.random() * 0.76).sort((a, b) => a - b);
  if (n >= 3 && Math.random() < 0.4) { // ステップアップ予告（1→2→3）
    for (let k = 0; k < 3; k++) out.push({ f: fs_[k], kind: 'step', lv: k + 1, step: k + 1 });
    for (let k = 3; k < n; k++) out.push({ f: fs_[k], kind: OMEN_KIND[3][Math.floor(Math.random() * 3)], lv: 3 });
    return out;
  }
  for (let k = 0; k < n; k++) {
    let lv = 1 + Math.floor(Math.random() * (1 + ci / 2)) + (k === n - 1 && hit ? 1 : 0);
    lv = Math.max(1, Math.min(3, lv));
    out.push({ f: fs_[k], kind: OMEN_KIND[lv][Math.floor(Math.random() * 3)], lv });
  }
  return out;
}
function buildRushPlan(order, source, S) {
  const rate = RUSH_RATE[S.rushRate] || 1, force = process.env.RUSH_FORCE === 'hit'; // RUSH_FORCE=hit：テスト用（全問を当たりにする。本番では使わない）
  const used = new Set(order.map(s => s.id));
  const spare = shuffle(source.filter(s => genresOf(s).includes('pachislot') && !used.has(s.id)));
  const plan = [];
  let state = crypto.randomInt(2);
  for (let i = 0; i < order.length; i++) {
    state = i === 0 ? state : nextState(state);
    let r = crypto.randomInt(100), ci = 0;
    for (; ci < RUSH_WEIGHT.length - 1; ci++) { if (r < RUSH_WEIGHT[ci]) break; r -= RUSH_WEIGHT[ci]; }
    let hit = force || Math.random() < Math.min(1, RUSH_HIT[ci] * rate * STATE_HIT[state]) || ci === RUSH_COLORS.length - 1;
    if (hit) {
      // もともとパチスロの曲ならそのまま。そうでなければ、パチスロの曲に入れ替える（足りなければ当たりにしない）
      if (!genresOf(order[i]).includes('pachislot')) {
        const next = spare.pop();
        if (next) { used.add(next.id); order[i] = next; } else hit = false;
      }
    }
    plan.push({ color: RUSH_COLORS[ci], hit, omens: makeOmens(ci, hit), state });
  }
  return plan;
}
// 答えたとき：モード中なら倍率、当たりの問題に正解なら大当たり（ボーナス＋RUSH開始・延長）。間違い・パスならモード終了（天国は1回だけ許す）
// 戻りの info：mode＝この問題の前のモード、next＝答えたあとのモード、entered＝新しく入ったモード
function rushApply(room, q, player, correct, points) {
  const r = player.rush || (player.rush = freshRush()), st = statsOf(room, player);
  const was = r.mode || 'normal';
  const info = { mult: 1, bonus: 0, jackpot: false, ended: false, done: false, chain: r.chain, earned: r.earned, mode: was, next: was, entered: null };
  const enter = (m, left) => { if (was === 'normal') r.chara = q.rush?.state || 0; r.mode = m; r.left = left; r.forgive = m === 'heaven' ? 1 : 0; info.entered = m; };
  const toNormal = () => { r.mode = 'normal'; r.left = 0; r.chain = 0; r.streak = 0; r.forgive = 0; };
  if (!correct) {
    if (was === 'heaven' && r.forgive > 0) { r.forgive--; r.left = Math.max(0, r.left - 1); info.forgiven = true; if (r.left === 0) { info.done = true; toNormal(); } }
    else if (was !== 'normal') { info.ended = true; info.chain = r.chain; info.earned = r.earned; toNormal(); r.earned = 0; }
    r.streak = 0; info.next = r.mode;
    return { points, info };
  }
  if (was !== 'normal') { // モード中の正解：倍率がかかる
    if (was === 'rush' || was === 'super') { r.chain++; st.maxChain = Math.max(st.maxChain || 0, r.chain); }
    info.mult = was === 'rush' ? RUSH_MULT[Math.min(r.chain, RUSH_MULT.length) - 1] : was === 'super' ? SUPER_MULT[Math.min(r.chain, SUPER_MULT.length) - 1] : MODE_MULT[was];
    points = Math.round(points * info.mult);
    r.left--; r.earned += points;
  } else r.streak++;
  const hit = !!q.rush?.hit;
  if (hit) { // 大当たり
    info.jackpot = true; info.bonus = RUSH_MODE[was === 'normal' ? 'rush' : was === 'heaven' ? 'super' : was].bonus; points += info.bonus;
    r.jackpots++; st.jackpots = (st.jackpots || 0) + 1;
    if (q.rush.color === 'rainbow') { r.rainbow++; st.rainbow = (st.rainbow || 0) + 1; }
    if (was === 'normal' || was === 'chance') { r.chain = 0; r.earned = 0; enter('rush', RUSH_MODE.rush.len); }
    else if (was === 'heaven') { r.chain = 0; enter('super', RUSH_MODE.super.len); }
    else r.left = RUSH_MODE[was].len; // RUSH・超RUSH中の大当たり＝延長
  } else if (was === 'normal' && r.streak >= CHANCE_AT) { r.streak = 0; enter('chance', RUSH_MODE.chance.len); }
  else if (was === 'rush' && r.chain >= SUPER_AT) enter('super', RUSH_MODE.super.len);
  else if (r.left === 0 && was !== 'normal') { // 走りきった
    info.done = true;
    if ((was === 'rush' && Math.random() < HEAVEN_RATE) || was === 'super') enter('heaven', RUSH_MODE.heaven.len); else toNormal();
  }
  info.next = r.mode; info.chain = r.chain; info.earned = r.earned; info.left = r.left;
  return { points, info };
}

// ── アニソン・ポーカー：正解した曲のカードを引いて、最後に役を比べる ──
const POKER_HAND = 5;
const FAME_IDX = { top: 0, famous: 1, normal: 2, minor: 3, otaku: 4 };
// マーク（0=♠ 1=♥ 2=♦ 3=♣）：ジャンル系統（♠バトル・ロボット・SF ♥恋愛・日常 ♦異世界・ゲーム・劇場 ♣その他）
const SUIT_GENRES = [['robot', 'sf', 'jump', 'sports'], ['romcom', 'nichijou', 'idol', 'galge'], ['isekai', 'game', 'ghibli', 'theater', 'kids']];
function suitOf(s) {
  const gs = genresOf(s), i = SUIT_GENRES.findIndex(l => l.some(k => gs.includes(k)));
  return i >= 0 ? i : 3;
}
// 本物のトランプと同じく、同じ数字・同じマークのカードは場に1枚だけ（全員の手札＋この答え合わせで作ったカードを見る）
function suitFor(room, num, pref) {
  const g = room.game;
  const used = new Set([...room.players.values()].flatMap(p => p.hand || []).concat(g.pokerFresh || []).filter(c => c.num === num).map(c => c.suit));
  if (!used.has(pref)) return pref;
  const free = [0, 1, 2, 3].filter(x => !used.has(x));
  return free.length ? free[crypto.randomInt(free.length)] : pref; // 同じ作品が場に4枚あるときだけ重なる
}
// 数字（1=A〜13=K）：作品ごと。同じゲームの中で「同じ数字＝同じ作品」になるよう、13種類を順に割り当てる
function cardOf(s, room) {
  const g = room.game;
  const gs = genresOf(s).filter(k => !['pachislot', 'slot', 'vocaloid', 'jpop', 'lol'].includes(k));
  const series = workKey(s.work);
  let num = g.pokerNums.get(series);
  if (!num) { num = g.pokerPool.length ? g.pokerPool.pop() : 1 + crypto.randomInt(13); g.pokerNums.set(series, num); }
  const card = { id: `${s.id}#${g.pokerSerial = (g.pokerSerial || 0) + 1}`, song: s.id, title: s.title, work: s.work, seriesLabel: bingoLabel(s.work), series, num, suit: suitFor(room, num, suitOf(s)), artistLabel: s.artist,
           genreLabels: gs.map(k => GENRES[k]?.label || k), year: s.year, type: s.type || '', fame: FAME_IDX[fameOf(s)] ?? 2 };
  (g.pokerFresh = g.pokerFresh || []).push(card);
  return card;
}
// 役がそろいやすいよう、出題の中に「同じシリーズの曲」を3曲ずつ、2組入れる（入れる場所はばらばら）
function biasPokerOrder(order, pools) {
  const all = [...new Set(pools.flat())];
  const bySeries = new Map();
  for (const s of all) { const k = workKey(s.work); if (!bySeries.has(k)) bySeries.set(k, []); bySeries.get(k).push(s); }
  const used = new Set(order.map(s => s.id));
  const big = shuffle([...bySeries.values()].filter(v => v.filter(s => !used.has(s.id)).length >= 3));
  const slots = shuffle([...order.keys()]);
  let si = 0;
  for (const group of big.slice(0, order.length >= 8 ? 2 : 1)) {
    for (const s of shuffle(group.filter(x => !used.has(x.id))).slice(0, 3)) { if (si >= slots.length) break; used.add(s.id); order[slots[si++]] = s; }
  }
  return order;
}
const sendPokerHand = (room, p) => {
  if (!p?.socketId) return;
  const b = poker.bestFive(p.hand || []);
  io.to(p.socketId).emit('pokerHand', { hand: p.hand || [], over: (p.hand || []).length > POKER_HAND, best: b.eval.name, bestIds: b.cards.map(c => c.id), usedIds: b.eval.used.map(c => c.id), kept: p.kept || [] });
};
// 答え合わせ：正解した人は曲のカードを1枚、いちばん早く正解した人はプラス1枚（ランダム・山から）
function pokerReveal(room, q, results, song) {
  const g = room.game;
  g.pokerFresh = [];
  let card = null;
  const winners = results.filter(r => r.correct);
  const fastest = [...winners].sort((a, b) => (a.elapsed ?? 99) - (b.elapsed ?? 99))[0];
  const gains = [];
  for (const r of winners) {
    const p = [...room.players.values()].find(x => x.id === r.id); if (!p) continue;
    p.hand = p.hand || [];
    const c = cardOf(song, room); card = card || c; // 正解した人ごとに、別のマークのカード（同じカードは2枚ない）
    p.hand.push(c);
    let bonus = null;
    if (fastest && r.id === fastest.id && g.pokerDeck?.length) {
      let i = g.pokerDeck.length - 1;
      if (!g.pokerPool.length) { const j = g.pokerDeck.findLastIndex(x => g.pokerNums.has(workKey(x.work))); if (j >= 0) i = j; } // 数字が足りないときは、数字を割り当て済みの作品から引く
      bonus = cardOf(g.pokerDeck.splice(i, 1)[0], room); p.hand.push(bonus);
    }
    gains.push({ id: r.id, name: r.name, bonus: !!bonus });
    sendPokerHand(room, p);
  }
  g.pokerFresh = [];
  return { card: card || cardPreview(song), gains, fastest: fastest?.name || null };
}
// 手札が5枚を超えたまま次の問題へ進む人は、いちばん強い5枚が残るように自動で捨てる
const cardPreview = s => ({ seriesLabel: bingoLabel(s.work) }); // だれも正解しなかったとき（表示用）
function pokerAutoDiscard(room) {
  for (const p of room.players.values()) if ((p.hand || []).length > POKER_HAND) { p.hand = poker.bestFive(p.hand).cards; sendPokerHand(room, p); }
}
function pokerShowdown(room) {
  return [...room.players.values()].map(p => {
    const b = poker.bestFive(p.hand || []);
    return { id: p.id, name: p.name, avatar: p.avatar, hand: b.cards, handName: b.eval.name, rank: b.eval.rank, score: b.eval.score, used: b.eval.used.map(c => c.id) };
  }).sort((a, b) => poker.compare(b, a) || 0);
}

// 保管したカード1枚につき最後に入る点／役ごとのボーナス（役のランク×この点）
const POKER_KEEP_PTS = 50, POKER_RANK_PTS = 100;
const POKER_BET_EVERY = +process.env.POKER_BET_EVERY || 10, POKER_BET_SEC = 25, POKER_BET_SHOW_SEC = 13;
const pokerPlayers = room => connectedPlayers(room).filter(p => room.players.get(p.token));
const roundTo = (n, u) => Math.floor(n / u) * u;
const pokerBetOptions = p => (p.hand || []).length ? [...new Set([0, 0.25, 0.5, 1].map(f => roundTo(Math.max(0, p.score || 0) * f, 10)))].sort((a, b) => a - b) : [0];
// 10問ごと：手札に点を賭けて、全員でオープン。勝った人が賭けた点を総取り
function startPokerBet(room) {
  const g = room.game;
  g.pokerBet = { bets: new Map(), open: true };
  const ps = pokerPlayers(room);
  const seats = ps.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, count: (p.hand || []).length, score: p.score || 0 })); // 卓に座る全員（手札は枚数だけ）
  const round = Math.floor((g.qi + 1) / POKER_BET_EVERY);
  for (const p of ps) io.to(p.socketId).emit('pokerBet', { sec: POKER_BET_SEC, score: p.score || 0, options: pokerBetOptions(p), total: ps.length, seats, round });
  later(room, () => finishPokerBet(room), POKER_BET_SEC * 1000);
  broadcastRoom(room);
}
function finishPokerBet(room) {
  const g = room.game; if (!g?.pokerBet?.open) return;
  clearTimers(room);
  g.pokerBet.open = false;
  const rows = [];
  for (const p of pokerPlayers(room)) {
    const bet = Math.min(g.pokerBet.bets.get(p.token) || 0, roundTo(Math.max(0, p.score || 0), 10));
    rows.push({ p, bet, b: poker.bestFive(p.hand || []) });
  }
  const bettors = rows.filter(r => r.bet > 0 && (r.p.hand || []).length);
  let pot = 0, winners = [];
  const duel = bettors.length >= 2;
  if (duel) {
    pot = bettors.reduce((s, r) => s + r.bet, 0);
    const top = bettors.reduce((m, r) => poker.compare(r.b.eval, m.b.eval) > 0 ? r : m, bettors[0]);
    winners = bettors.filter(r => poker.compare(r.b.eval, top.b.eval) === 0);
    const share = Math.floor(pot / winners.length / 10) * 10;
    for (const r of bettors) r.p.score -= r.bet;
    for (const w of winners) w.p.score += share;
    for (const r of bettors) r.delta = (winners.includes(r) ? share : 0) - r.bet;
    for (const r of bettors) { const st = statsOf(room, r.p); if (r.bet >= roundTo(Math.max(0, r.p.score - r.delta), 10)) st.allin++; if (r.delta > 0) st.betWon += r.delta; }
  }
  io.to(room.code).emit('pokerBetResult', { duel, pot, sec: POKER_BET_SHOW_SEC,
    rows: rows.map(r => ({ id: r.p.id, name: r.p.name, avatar: r.p.avatar, bet: r.bet, hand: duel && r.bet > 0 ? r.b.cards : [], handName: duel && r.bet > 0 ? r.b.eval.name : '見送り',
                           used: r.b.eval.used.map(c => c.id), win: winners.includes(r), delta: r.delta || 0, score: r.p.score })) });
  if (duel) for (const r of bettors) { r.p.kept = (r.p.kept || []).concat(r.p.hand); r.p.hand = []; } // 使った手札は保管へ（最後にボーナス）
  for (const r of rows) sendPokerHand(room, r.p);
  broadcastRoom(room);
  later(room, () => { g.pokerBet = null; g.pokerBetAt = g.qi; nextQuestion(room); }, POKER_BET_SHOW_SEC * 1000);
}

// ── アニソン年表（ヒットスター風）：流れた曲を自分の年表の正しい位置に置く。合っていれば年表に入り、先に NENPYO_GOAL 枚になった人の勝ち ──
const NENPYO_GOAL = 10, NENPYO_MAX = 60;
const nenpyoCard = s => ({ id: s.id, title: s.title, work: s.work, year: s.year });
function nenpyoStartCard(room, order, ctx) {
  const used = new Set(order.map(s => s.id));
  const pool = SONGS.filter(s => !used.has(s.id) && !ctx.block.has(s.id));
  return nenpyoCard(pool[crypto.randomInt(pool.length)]);
}
function nenpyoReveal(room, q) {
  const g = room.game;
  for (const [token, a] of q.answers) {
    const p = room.players.get(token);
    if (p?.timeline && a.correct) nenpyo.insert(p.timeline, nenpyoCard(q.song));
  }
  if ([...room.players.values()].some(p => (p.timeline || []).length >= NENPYO_GOAL)) g.nenpyoDone = true;
}

// ── アニソンかるた：16枚の札を場に並べたまま、読まれた（流れた）曲の札を早取り。取った札は場から消え、空いたところに次の札を置く ──
const KARUTA_N = 16;
const karutaFaceOf = (s, face) => face === 'work' ? bingoLabel(s.work) : face === 'artist' ? s.artist : s.title;
const SONG_BY_ID = id => ALL_SONGS.find(s => s.id === id);
function karutaChoices(room, song) {
  const g = room.game, face = room.settings.karutaFace || 'title';
  if (!g.karuta) g.karuta = Array(KARUTA_N).fill(null); // { id, face }
  const faceOf = s => karutaFaceOf(s, face);
  // 読まれる札がまだ場になければ置く（同じ文字の札があればその札と入れ替える。空きがなければ、先の問題で読まれない札と入れ替える）
  if (!g.karuta.some(c => c?.id === song.id)) {
    let slot = g.karuta.findIndex(c => c && normText(c.face) === normText(faceOf(song)));
    if (slot < 0) slot = g.karuta.findIndex(c => !c);
    if (slot < 0) {
      const later_ = new Set(g.order.slice(g.qi + 1).map(s => s.id));
      const free = g.karuta.map((c, i) => [c, i]).filter(([c]) => !later_.has(c.id)).map(([, i]) => i);
      slot = free.length ? free[crypto.randomInt(free.length)] : crypto.randomInt(KARUTA_N);
    }
    g.karuta[slot] = { id: song.id, face: faceOf(song) };
  }
  // 空いたところに札を足す：これから読まれる曲 → 足りなければ候補の曲（読まれない札。同じ文字は置かない）
  const faces = new Set(g.karuta.filter(Boolean).map(c => normText(c.face))), ids = new Set(g.karuta.filter(Boolean).map(c => c.id));
  // 札はいつも16枚：空いたところには、これから読まれる曲の札を足し、足りなければ（読まれない）ランダムな曲の札を足す
  const fill = [...g.order.slice(g.qi + 1), ...shuffle(g.pool.filter(s => !g.order.includes(s))), ...shuffle(SONGS.filter(s => !g.order.includes(s) && !g.pool.includes(s)))];
  for (const s of fill) {
    const slot = g.karuta.findIndex(c => !c);
    if (slot < 0) break;
    const f = faceOf(s);
    if (!f || faces.has(normText(f)) || ids.has(s.id)) continue;
    g.karuta[slot] = { id: s.id, face: f }; faces.add(normText(f)); ids.add(s.id);
  }
  const choices = g.karuta.map(c => c ? { title: c.face, work: '' } : { title: '', work: '', gone: true });
  return { choices, correctIndex: g.karuta.findIndex(c => c?.id === song.id) };
}
// 答え合わせ：最初に正解した人がその札を取る
function karutaTake(room, q) {
  const g = room.game, p = q.winner && room.players.get(q.winner);
  // 流れた曲の札は、取られても取られなくても場から消す（その曲はもう流れないので、残しても使わない札になる）
  const i = g.karuta.findIndex(c => c?.id === q.song.id);
  if (i >= 0) g.karuta[i] = null;
  if (p && q.answers.get(q.winner)?.correct) p.karutaCards = (p.karutaCards || 0) + 1;
}

// ── アニソン陣取り（アタック25風）：いちばん早く正解した人がパネルを1枚選び、挟んだ相手のパネルを裏返す ──
const PANEL_MAX = 60, PANEL_PICK_SEC = 15, PANEL_SHOW_MS = 2500;
// ── アニソン・デッキ構築：正解でコイン。3問ごとのショップでカードを買う（docs/deck-spec.md）──
const DK_EVERY = 3, DK_SHOP_SEC = 20, DK_VP = 5, DK_VP_PTS = 1000, DK_COIN = [3, 2];
const DK_CARDS = [
  { key: 'fifty', label: '50:50', icon: '✂', price: 2, text: '問題中に使う：不正解の選択肢を半分消す' },
  { key: 'audience', label: 'オーディエンス', icon: '👥', price: 2, text: '問題中に使う：ほかの人の答えが見える' },
  { key: 'phone', label: 'テレフォン', icon: '📞', price: 2, text: '問題中に使う：歌手か年のヒントがもらえる' },
  { key: 'replay', label: 'もう一度聴く', icon: '🔁', price: 1, text: '問題中に使う：イントロをもう一度' },
  { key: 'gift', label: 'ランダムカード', icon: '🎁', price: 2, text: '使い切りカード（50:50・オーディエンス・テレフォン・もう一度聴く）のどれかが1枚もらえる' },
  { key: 'boost', label: 'ブースト', icon: '✖2', price: 3, text: '次に正解した問題の点数が2倍' },
  { key: 'boost3', label: '大ブースト', icon: '✖3', price: 6, text: '次に正解した問題の点数が3倍' },
  { key: 'steal', label: 'コイン強奪', icon: '🧲', price: 4, text: 'いちばんコインを持っている他の人から、2コイン奪う' },
  { key: 'invest', label: '投資', icon: '💰', price: 4, text: 'ずっと：正解のたびにコイン +1' },
  { key: 'invest2', label: '大投資', icon: '🏦', price: 7, text: 'ずっと：正解のたびにコイン +2' },
  { key: 'vp', label: '勝利点', icon: '👑', price: DK_VP, text: `すぐに +${DK_VP_PTS}点（買うたびに値段 +1）` },
  { key: 'vp2', label: '大勝利点', icon: '💎', price: 10, text: 'すぐに +2500点' },
];
const DK_LIFE = ['fifty', 'audience', 'phone', 'replay'];
const dkShopTotal = g => Math.ceil(g.order.length / DK_EVERY); // 3問ごと＋最後の問題のあと
function dkReveal(room, q, results) {
  const out = [], order = results.filter(r => r.correct).sort((a, b) => (a.elapsed ?? 99) - (b.elapsed ?? 99));
  order.forEach((r, i) => {
    const p = [...room.players.values()].find(x => x.id === r.id); if (!p?.dk) return;
    const c = (DK_COIN[i] ?? DK_COIN[DK_COIN.length - 1]) + p.dk.invest + (p.dk.invest2 || 0) * 2;
    p.dk.coins += c;
    let msg = `🪙 ${r.name} +${c}コイン`;
    const mult = p.dk.boost3 > 0 ? 3 : p.dk.boost > 0 ? 2 : 1;
    if (mult > 1 && r.points > 0) { if (mult === 3) p.dk.boost3--; else p.dk.boost--; p.score += r.points * (mult - 1); msg += ` ✖${mult} ブーストで +${r.points * (mult - 1)}点`; }
    out.push(msg);
  });
  return out;
}
function startDkShop(room) {
  const g = room.game;
  clearTimers(room);
  g.dkShopN = (g.dkShopN || 0) + 1;
  g.dkShop = { done: new Set(), until: Date.now() + DK_SHOP_SEC * 1000 };
  io.to(room.code).emit('dkShop', { cards: DK_CARDS, until: g.dkShop.until, round: g.dkShopN, rounds: dkShopTotal(g), qNo: g.qi + 1, qTotal: g.order.length, last: g.qi + 1 >= g.order.length });
  later(room, () => finishDkShop(room), DK_SHOP_SEC * 1000);
  broadcastRoom(room);
}
function finishDkShop(room) {
  const g = room.game; if (!g?.dkShop) return;
  clearTimers(room);
  g.dkShop = null; g.dkShopAt = g.qi;
  io.to(room.code).emit('dkShopEnd');
  nextQuestion(room);
}

// ── アニソン・ジャンル制覇：6ジャンルのピースを集める。最速の正解者がピースをもらい、次のジャンルを選ぶ（docs/genre-zone-spec.md）──
const GZ_HARD_MAX = 400; // ジャンル制覇は、全部そろえるまで続ける（これだけ出しても決まらなければ終わる）
const GZ_MAX = 60, GZ_PICK_SEC = 10, GZ_DUP = 300, GZ_WIN = 3000, GZ_NEXT_MS = 3000;
const GZ_CATS = [
  { key: 'jump', label: 'ジャンプ', icon: '🔥', g: ['jump'] },
  { key: 'robot', label: 'ロボット・SF', icon: '🤖', g: ['robot', 'sf'] },
  { key: 'love', label: 'ラブコメ・日常', icon: '💕', g: ['romcom', 'nichijou'] },
  { key: 'idol', label: 'アイドル・バンド', icon: '🎤', g: ['idol'] },
  { key: 'fantasy', label: '異世界・ファンタジー', icon: '🗡️', g: ['isekai'] },
  { key: 'game', label: 'ゲーム・スポーツ', icon: '🎮', g: ['game', 'galge', 'sports'] },
];
const isGz = p => p === 'genre' || p === 'genreex';
// ジャンル制覇EXで選べる「集める種類」のカタログ：ジャンル（約20）・年代・曲の種類・知名度。test(曲) で、その種類の曲かどうか
const GZ_ICONS = { jump: '🔥', game: '🎮', galge: '💘', ghibli: '🌳', theater: '🎬', movie: '🎞️', sports: '⚽', isekai: '🗡️', romcom: '💕', nichijou: '☕', idol: '🎤', robot: '🤖', sf: '🚀', kids: '🧸', action: '💥', horror: '👻', mahou: '🪄', drama: '🎭', vocaloid: '🎹', jpop: '🎵', pachislot: '🎰' };
let GZ_CATALOG = null, GZ_CATALOG_N = -1;
function gzCatalog() {
  if (GZ_CATALOG && GZ_CATALOG_N === SONGS.length) return GZ_CATALOG;
  const out = [];
  for (const k of GENRE_KEYS) if (GZ_ICONS[k]) out.push({ key: 'g:' + k, group: 'genre', icon: GZ_ICONS[k], label: GENRES[k].label.replace(/（.*$/, ''), test: s => genresOf(s).includes(k) });
  [['e:80', '〜1989年', '📻', y => y < 1990], ['e:90', '1990年代', '💿', y => y >= 1990 && y < 2000], ['e:00', '2000年代', '📀', y => y >= 2000 && y < 2010], ['e:10', '2010年代', '📱', y => y >= 2010 && y < 2020], ['e:20', '2020年代', '🆕', y => y >= 2020]]
    .forEach(([key, label, icon, f]) => out.push({ key, group: 'era', icon, label, test: s => f(s.year || 0) }));
  [['t:op', 'OP（オープニング）', '▶️', s => s.type === 'OP'], ['t:ed', 'ED（エンディング）', '⏹️', s => s.type === 'ED'], ['t:ins', '挿入歌・劇中歌', '🎶', s => ['挿入歌', '劇中歌'].includes(s.type)], ['t:movie', '映画主題歌', '🎥', s => s.type === '映画主題歌'], ['t:vocal', 'ボカロ曲', '🤖', s => s.type === 'ボカロ'], ['t:char', 'キャラソン・イメージソング', '🎙️', s => ['キャラソン', 'イメージソング'].includes(s.type)]]
    .forEach(([key, label, icon, f]) => out.push({ key, group: 'type', icon, label, test: f }));
  [['f:top', '超有名の曲', '⭐', 'top'], ['f:famous', '有名な曲', '🌟', 'famous'], ['f:normal', '普通の知名度の曲', '🙂', 'normal'], ['f:minor', 'マイナーな曲', '🔍', 'minor'], ['f:otaku', 'オタク向けの曲', '🎩', 'otaku']]
    .forEach(([key, label, icon, k]) => out.push({ key, group: 'fame', icon, label, test: s => fameOf(s) === k }));
  for (const c of out) c.count = SONGS.filter(c.test).length;
  GZ_CATALOG = out.filter(c => c.count >= 8); GZ_CATALOG_N = SONGS.length; // 曲が少なすぎる種類は出さない
  return GZ_CATALOG;
}
// そのゲームで集める種類：ジャンル制覇（6つ）は 今の6つ／ジャンルからランダムに6つ／選んだジャンル（最大6）。EX は、ランダムに N 個／選んだ種類（何個でも）
function gzBuildCats(S) {
  const cat = gzCatalog(), pickN = (list, n) => shuffle(list.slice()).slice(0, n);
  const own = key => cat.find(c => c.key === key);
  if (S.play === 'genreex') {
    const chosen = (S.gzPicks || []).map(own).filter(Boolean);
    if (S.gzSet === 'choose' && chosen.length >= 2) return chosen;
    return pickN(cat, Math.max(2, Math.min(S.gzCount || 10, cat.length)));
  }
  const genres = cat.filter(c => c.group === 'genre');
  if (S.gzSet === 'random') return pickN(genres, 6);
  if (S.gzSet === 'choose') { const chosen = (S.gzPicks || []).map(own).filter(c => c && c.group === 'genre').slice(0, 6); if (chosen.length >= 2) return chosen; }
  return GZ_CATS.map(c => ({ key: c.key, label: c.label, icon: c.icon, test: s => genresOf(s).some(k => c.g.includes(k)) })); // 今の6つ
}
const gzCatOf = (gz, key) => gz.cats.find(c => c.key === key);
function gzPrepare(room) { // 次の問題の曲を、選ばれたジャンルから選ぶ（この試合でまだ出していない曲）
  const g = room.game, gz = g.gz;
  if (!gz.cur) gz.cur = gz.cats[crypto.randomInt(gz.cats.length)].key;
  const cat = gzCatOf(gz, gz.cur), used = new Set(g.order.slice(0, g.qi).map(s => s.id)), ctx = userCtx(room);
  const ok = s => !used.has(s.id) && !ctx.block.has(s.id) && cat.test(s);
  const list = g.pool.filter(ok), alt = list.length ? list : SONGS.filter(ok);
  if (alt.length) g.order[g.qi] = alt[crypto.randomInt(alt.length)];
}
// ランダムに次のジャンルを決めるとき：参加者の全員がもう持っているジャンルは出さない（持っていない人がいるジャンルから選ぶ）
function gzAnnounceRandom(room) { const gz = room.game.gz, c = gzCatOf(gz, gz.cur); if (c) io.to(room.code).emit('gzChosen', { name: '', random: true, key: c.key, label: c.label, icon: c.icon }); }
function gzRandomNext(room) {
  const gz = room.game.gz, ids = [...room.players.values()].filter(p => p.connected !== false).map(p => p.id);
  const lack = gz.cats.filter(c => ids.some(id => !(gz.pieces.get(id) || new Set()).has(c.key)));
  const list = lack.length ? lack : gz.cats;
  return list[crypto.randomInt(list.length)];
}
function gzReveal(room, q, results) {
  const g = room.game, gz = g.gz, out = [], cat = gzCatOf(gz, gz.cur);
  const win = results.filter(r => r.correct).sort((a, b) => (a.elapsed ?? 99) - (b.elapsed ?? 99))[0];
  gz.gain = null; gz.at = g.qi;
  if (!win) { gz.cur = gzRandomNext(room).key; gzAnnounceRandom(room); out.push(`だれも正解しなかったので、次のジャンルはランダム：${gzCatOf(gz, gz.cur).icon}${gzCatOf(gz, gz.cur).label}`); return out; }
  const p = [...room.players.values()].find(x => x.id === win.id);
  if (!gz.pieces.has(win.id)) gz.pieces.set(win.id, new Set());
  const mine = gz.pieces.get(win.id);
  gz.gain = { id: win.id, key: cat.key, dup: mine.has(cat.key), n: mine.has(cat.key) ? mine.size : mine.size + 1 }; gz.at = g.qi; // 画面のハイライト用
  if (mine.has(cat.key)) { if (p) p.score += GZ_DUP; out.push(`${cat.icon} ${win.name} もう持っているジャンル → +${GZ_DUP}点`); }
  else { mine.add(cat.key); out.push(`${cat.icon} ${win.name} が「${cat.label}」のピースを手に入れた！（${mine.size}/${gz.cats.length}）`); }
  if (mine.size >= gz.cats.length) { g.gzDone = true; if (p) p.score += GZ_WIN; out.push(`👑 ${win.name} ${gz.cats.length}種類 制覇！ +${GZ_WIN}点`); return out; }
  // 全種類をそろえる人が出るまで終わらない（問題数の上限はない。ただし、止まらなくならないよう GZ_HARD_MAX 問まで）
  if (g.qi + 1 >= GZ_HARD_MAX) return out;
  if (room.settings.gzPick === 'random') { gz.cur = gzRandomNext(room).key; gzAnnounceRandom(room); const c2 = gzCatOf(gz, gz.cur); out.push(`次のジャンルはランダム：${c2.icon}${c2.label}`); return out; } // ランダム制
  gz.pick = { id: win.id, token: p?.token, name: win.name, until: Date.now() + GZ_PICK_SEC * 1000, q };
  later(room, () => gzChoose(room, null), GZ_PICK_SEC * 1000);
  return out;
}
function gzChoose(room, key) {
  const g = room.game, gz = g?.gz, pk = gz?.pick; if (!pk) return;
  let cat = gzCatOf(gz, key);
  if (!cat) { const mine = gz.pieces.get(pk.id) || new Set(), lack = gz.cats.filter(c => !mine.has(c.key)); cat = (lack.length ? lack : gz.cats)[crypto.randomInt((lack.length ? lack : gz.cats).length)]; }
  gz.cur = cat.key; gz.pick = null;
  io.to(room.code).emit('gzChosen', { name: pk.name, key: cat.key, label: cat.label, icon: cat.icon });
  broadcastRoom(room);
  const q = pk.q, S = room.settings;
  // ジャンルが決まったら、3秒後に次の問題へ（画面には小さく「選択されました」と出す）
  if (S.autoNext > 0 && room.game?.q === q) { q.revealAt = Date.now(); scheduleNext(room, q, Date.now() + GZ_NEXT_MS); io.to(room.code).emit('nextAt', { seconds: GZ_NEXT_MS / 1000, by: '' }); }
}

// ── アニソンすごろく：正解の速い順に 3・2・1 マス進む。止まったマスのイベント。先にゴールした人の勝ち（docs/sugoroku-spec.md）──
const SG_GOAL = 30, SG_MAX = 60, SG_STEPS = [3, 2, 1], SG_BONUS = 300, SG_GOAL_PTS = 2000;
const SG_EVENTS = ['fwd', 'back', 'bonus', 'rest', 'dbl', 'swap', 'hit'];
const SG_LABEL = { fwd: '+2マス進む', back: '2マス戻る', bonus: `ボーナス +${SG_BONUS}点`, rest: '1回休み', dbl: '次は2倍進む', swap: '先頭と入れ替え', hit: 'すぐ前の人を2マス戻す' };
function sgBoard() { // 0 がスタート、SG_GOAL がゴール。3〜27 マス目の半分くらいにイベント
  const b = Array(SG_GOAL + 1).fill('');
  for (let i = 3; i <= SG_GOAL - 3; i++) if (crypto.randomInt(100) < 50) b[i] = SG_EVENTS[crypto.randomInt(SG_EVENTS.length)];
  return b;
}
function sgReveal(room, q, results) {
  const g = room.game, sg = g.sg, out = [];
  const name = id => results.find(r => r.id === id)?.name || [...room.players.values()].find(p => p.id === id)?.name || '';
  const ids = [...room.players.values()].filter(p => q.participants.has(p.token)).map(p => p.id);
  for (const id of ids) if (!sg.pos.has(id)) sg.pos.set(id, 0);
  const order = results.filter(r => r.correct).sort((a, b) => (a.elapsed ?? 99) - (b.elapsed ?? 99));
  sg.last = []; sg.moves = []; const before = new Map(sg.pos);
  order.forEach((r, i) => {
    if (g.sgDone) return;
    if (sg.rest.has(r.id)) { sg.rest.delete(r.id); out.push(`🎲 ${r.name} 1回休み（進めない）`); return; }
    let n = SG_STEPS[i] ?? 1;
    if (sg.dbl.has(r.id)) { sg.dbl.delete(r.id); n *= 2; }
    const from = sg.pos.get(r.id) || 0, to = Math.min(SG_GOAL, from + n);
    sg.pos.set(r.id, to); sg.last.push(r.id);
    let msg = `🎲 ${r.name} ${n}マス進む（${to}マス目）`;
    const p = [...room.players.values()].find(x => x.id === r.id);
    if (to >= SG_GOAL) { g.sgDone = true; if (p) p.score += SG_GOAL_PTS; out.push(`${msg} 🏁 ゴール！ +${SG_GOAL_PTS}点`); return; }
    const ev = sg.board[to];
    if (ev === 'fwd') { const t2 = Math.min(SG_GOAL, to + 2); sg.pos.set(r.id, t2); msg += ` ⏩ さらに2マス（${t2}マス目）`; if (t2 >= SG_GOAL) { g.sgDone = true; if (p) p.score += SG_GOAL_PTS; msg += ` 🏁 ゴール！ +${SG_GOAL_PTS}点`; } }
    else if (ev === 'back') { const t2 = Math.max(0, to - 2); sg.pos.set(r.id, t2); msg += ` ⏪ 2マス戻る（${t2}マス目）`; }
    else if (ev === 'bonus') { if (p) p.score += SG_BONUS; msg += ` 💰 +${SG_BONUS}点`; }
    else if (ev === 'rest') { sg.rest.add(r.id); msg += ' 💤 次は1回休み'; }
    else if (ev === 'dbl') { sg.dbl.add(r.id); msg += ' ✖2 次は2倍進む'; }
    else if (ev === 'swap') {
      const lead = [...sg.pos].filter(([k]) => k !== r.id).sort((a, b) => b[1] - a[1])[0];
      if (lead && lead[1] > to) { sg.pos.set(lead[0], to); sg.pos.set(r.id, lead[1]); msg += ` 🔀 先頭の${name(lead[0])}と入れ替え（${lead[1]}マス目）`; } else msg += ' 🔀（先頭なので何もなし）';
    } else if (ev === 'hit') {
      const ahead = [...sg.pos].filter(([k, v]) => k !== r.id && v > to).sort((a, b) => a[1] - b[1])[0];
      if (ahead) { sg.pos.set(ahead[0], Math.max(0, ahead[1] - 2)); msg += ` 💥 ${name(ahead[0])}を2マス戻す`; } else msg += ' 💥（前にだれもいない）';
    }
    out.push(msg);
  });
  for (const id of sg.last) sg.moves.push({ id, from: before.get(id) || 0, to: sg.pos.get(id) || 0, ev: sg.board[sg.pos.get(id)] || '' }); // 画面の「進んだ分」のハイライト用
  sg.at = g.qi;
  return out;
}
// アタックチャンス：PANEL_ATTACK_Q 問目のあと、1マスが白くなる（取られているマスなら色が消えて空きに戻る）。次の問題で、正解の最速の人がそのマスをどこからでも取れる
const PANEL_ATTACK_Q = +process.env.PANEL_ATTACK_Q || 20;
function panelAttackSetup(room) {
  const g = room.game;
  if (room.settings.play !== 'panel' || g.attackDone || g.qi + 1 !== PANEL_ATTACK_Q || g.panel.every(x => !!x)) return;
  g.attackDone = true;
  const filled = g.panel.map((x, i) => (x ? i : -1)).filter(i => i >= 0), empty = g.panel.map((x, i) => (x ? -1 : i)).filter(i => i >= 0);
  const list = filled.length ? filled : empty, idx = list[crypto.randomInt(list.length)];
  const was = g.panel[idx];
  g.panel[idx] = null;
  g.attackCell = idx; g.attackQi = g.qi + 1;
  io.to(room.code).emit('panelAttack', { board: g.panel, idx, was: !!was });
}
const panelOwner = (room, p) => (room.settings.teams && p.team ? p.team : p.id); // 盤の持ち主：チーム戦ならチーム
function startPanelPick(room, q, results) {
  const g = room.game, win = results.find(r => r.correct);
  if (!win || g.panel.every(x => x)) return;
  const p = [...room.players.values()].find(x => x.id === win.id);
  if (!p) return;
  const own = panelOwner(room, p);
  const allowed = panelLib.allowedCells(g.panel, own);
  if (q.attack && g.attackCell != null && !g.panel[g.attackCell] && !allowed.includes(g.attackCell)) allowed.push(g.attackCell); // 白いマスは、どこからでも取れる
  g.panelPick = { atkCell: q.attack ? g.attackCell : null, token: p.token, id: p.id, own, name: p.name, allowed, until: Date.now() + PANEL_PICK_SEC * 1000, q, stage: 'place', attack: !!q.attack };
  later(room, () => panelChoose(room, null), PANEL_PICK_SEC * 1000);
}
function panelChoose(room, idx) {
  const g = room.game, pk = g?.panelPick;
  if (!pk) return;
  if (idx == null || !pk.allowed.includes(idx)) { if (idx != null) return; idx = panelLib.autoPick(g.panel, pk.own); } // 時間切れはいちばん多く裏返せるマス
  clearTimers(room);
  const flipped = panelLib.place(g.panel, idx, pk.own);
  g.panelPick = null;
  if (g.panel.every(x => x)) g.panelDone = true;
  io.to(room.code).emit('panelUpdate', { board: g.panel, idx, flipped, id: pk.id, name: pk.name, attack: pk.atkCell != null && idx === pk.atkCell, done: g.panelDone });
  if (pk.atkCell != null) g.attackCell = null; // アタックチャンスの問題が終わったので、白いマスは普通の空きマスに戻る
  if (!g.panelDone) panelAttackSetup(room);
  broadcastRoom(room);
  // 次へ：盤が埋まったら少し見せて終わり。そうでなければ、ふだんの自動で次へ（答え合わせのときに止めていた分）
  const q = pk.q, S = room.settings;
  if (g.panelDone) return later(room, () => nextQuestion(room), PANEL_SHOW_MS + 1500);
  if (S.autoNext > 0 && room.game?.q === q) { q.revealAt = Date.now(); scheduleNext(room, q, Date.now() + Math.max(PANEL_SHOW_MS, S.autoNext * 1000 / 2)); }
}

// ── アニソン人狼（ワードウルフ風）：1人だけ「同じ作品の別の曲」が流れる。本人も知らない。ヒント → 話し合い → 投票。
// 当てられた人狼は、みんなの曲名を当てれば逆転。勝った側に点数 ──
const WOLF_SEC = { listen: 25, hint: 40, talk: 90, vote: 30, tally: 6, guess: 25 };
const WOLF_CHOICES = 10; // 聴いているときから見える曲の候補。全員同じ一覧（みんなの曲と人狼の曲の両方が入っている）
const WOLF_PTS = { village: 1000, wolf: 2000 };
// 版ちがい（TV Size・Remix・カッコつき・「 - From ...」・feat.）の同名も、同じ曲として扱う（区切りより前だけで比べる）
const wolfKey = title => normText(shortForm(String(title).split(/\s*[-–—~〜(（\[【]\s*|\s+feat\.?\s|\s+ft\.\s/i)[0]) || title);
const wolfArtist = s => artistKey(s.artist); // 同じ歌手・作者かどうか（「A feat. B」は A）
// 人狼の曲：みんなの曲とは、別の作品（シリーズも別）の曲。同じ作品の曲だと、作品のヒントで見分けがつかなくなるため。
// 似た曲（同じジャンルで近い年代・別の歌手）を優先する
const wolfFam = s => bingoLabel(s.work); // 作品（シリーズ）の名前
function wolfSongFor(room, song) {
  const pool = room.game.pool.length > 10 ? room.game.pool : SONGS, ctx = userCtx(room);
  const ok = s => s.id !== song.id && wolfKey(s.title) !== wolfKey(song.title) && !ctx.block.has(s.id) && workKey(s.work) !== workKey(song.work) && wolfFam(s) !== wolfFam(song);
  const gs = genresOf(song), diffArtist = s => wolfArtist(s) !== wolfArtist(song), sameKind = s => kindOf(s) === kindOf(song);
  const tiers0 = [
    pool.filter(s => ok(s) && diffArtist(s) && Math.abs(s.year - song.year) <= 5 && genresOf(s).some(k => gs.includes(k))),
    pool.filter(s => ok(s) && diffArtist(s) && Math.abs(s.year - song.year) <= 10),
    pool.filter(s => ok(s) && diffArtist(s)),
    SONGS.filter(ok),
  ];
  const tiers = [...tiers0.map(l => l.filter(sameKind)), ...tiers0]; // 同じ種類（アニメ・ボカロ・J-POP・パチスロ）の曲を先に
  const list = tiers.find(l => l.length) || [];
  return list[crypto.randomInt(list.length)];
}
const wolfStartOf = s => hasChorus(s) ? Math.max(s.intro || 0, chorusOf(s) - 3) : (s.intro || 0);
function startWolfRound(room, song) {
  statsPlay(room, song);
  const g = room.game, ps = connectedPlayers(room);
  const wolfP = ps[crypto.randomInt(ps.length)], other = wolfSongFor(room, song);
  // 候補は全員同じ一覧：みんなの曲と人狼の曲を両方入れる（一覧から、どちらが人狼の曲かは分からない）
  // 残りの8曲も、みんなの曲・人狼の曲とは別の作品（全部ちがう作品）で、似た曲（同じジャンルで近い年代）を優先する
  const ctx = userCtx(room), taken = new Set([wolfKey(song.title), wolfKey(other.title)]);
  const works = new Set([workKey(song.work), workKey(other.work), wolfFam(song), wolfFam(other)]);
  const gs = new Set([...genresOf(song), ...genresOf(other)]);
  const artists = new Set([wolfArtist(song), wolfArtist(other)]); // 歌手もできるだけ重ならないように（1歌手1曲）
  const ok = s => !ctx.block.has(s.id) && !taken.has(wolfKey(s.title)), sameKind = s => kindOf(s) === kindOf(song);
  const tiers0 = [
    room.game.pool.filter(s => ok(s) && Math.abs(s.year - song.year) <= 6 && genresOf(s).some(k => gs.has(k))),
    room.game.pool.filter(ok),
    SONGS.filter(ok),
  ];
  const tiers = [...tiers0.map(l => l.filter(sameKind)), ...tiers0]; // 候補も同じ種類の曲を先に（ちがう種類が混ざって浮かないように）
  const base = [];
  // 1周目：作品も歌手も重ならない曲だけ／足りなければ2周目：歌手は重なってもよい（作品は必ず別）
  for (const strict of [true, false]) {
    for (const tier of tiers) {
      for (const s of shuffle(tier.slice())) {
        if (base.length >= WOLF_CHOICES - 2) break;
        if (taken.has(wolfKey(s.title)) || works.has(workKey(s.work)) || works.has(wolfFam(s)) || (strict && artists.has(wolfArtist(s)))) continue;
        taken.add(wolfKey(s.title)); works.add(workKey(s.work)); works.add(wolfFam(s)); artists.add(wolfArtist(s)); base.push({ title: s.title, work: s.work });
      }
      if (base.length >= WOLF_CHOICES - 2) break;
    }
    if (base.length >= WOLF_CHOICES - 2) break;
  }
  const choices = shuffle([{ title: song.title, work: song.work }, { title: other.title, work: other.work }, ...base]);
  const correctIndex = choices.findIndex(c => c.title === song.title);
  g.q = { phase: 'wolf', song, participants: new Set(ps.map(p => p.token)), answers: new Map(), ready: new Set(), clues: [], lifelineResults: new Map(),
          wolf: { step: null, until: 0, wolfToken: wolfP.token, wolfSong: other, hints: new Map(), chat: [], votes: new Map(), talkDone: new Set(), guess: null, choices, correctIndex } };
  for (const p of ps) io.to(p.socketId).emit('wolfSong', wolfSongPayload(room, p));
  wolfStep(room, 'listen');
}
function wolfSongPayload(room, p) {
  const q = room.game.q, s = p.token === q.wolf.wolfToken ? q.wolf.wolfSong : q.song;
  return { videoId: s.id, start: wolfStartOf(s), sec: WOLF_SEC.listen, round: room.game.qi + 1, total: room.game.order.length };
}
function wolfPublic(room) {
  const q = room.game?.q, w = q?.wolf;
  if (!w) return null;
  const ps = [...q.participants].map(t => room.players.get(t)).filter(Boolean);
  const base = { step: w.step, until: w.until, round: room.game.qi + 1, total: room.game.order.length,
                 done: w.step === 'hint' ? [...w.hints.keys()].map(t => room.players.get(t)?.id) : w.step === 'vote' ? [...w.votes.keys()].map(t => room.players.get(t)?.id) : w.step === 'talk' ? [...w.talkDone].map(t => room.players.get(t)?.id) : [],
                 players: ps.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })) };
  // 聴いているときから、話し合い・投票まで見える（部屋の設定で、作品名・曲名を隠せる。人狼が曲名を当てる段階では曲名は必ず出す）
  const S = room.settings, showT = S.wolfTitle !== 'hide' || w.step === 'guess', showW = S.wolfWork === 'show';
  base.choices = showT || showW ? w.choices.map(c => ({ title: showT ? c.title : '', work: showW ? c.work : '' })) : null;
  if (['talk', 'vote', 'tally', 'guess', 'result'].includes(w.step)) base.hints = ps.map(p => ({ id: p.id, text: w.hints.get(p.token) || '（なし）' }));
  if (['talk', 'vote', 'tally', 'guess', 'result'].includes(w.step)) base.chat = w.chat;
  if (['tally', 'guess', 'result'].includes(w.step)) base.votes = w.votesOut || {}; // 結果の前に、投票数が見える
  if (w.step === 'guess') base.guess = { id: room.players.get(w.wolfToken)?.id };
  if (w.step === 'result') base.result = w.result;
  return base;
}
const wolfEmit = room => io.to(room.code).emit('wolfPhase', wolfPublic(room));
function wolfStep(room, step) {
  const q = room.game.q, w = q.wolf;
  clearTimers(room);
  w.step = step;
  w.until = Date.now() + (WOLF_SEC[step] || 0) * 1000;
  if (step === 'listen') later(room, () => wolfStep(room, 'hint'), WOLF_SEC.listen * 1000);
  if (step === 'hint') later(room, () => wolfStep(room, 'talk'), WOLF_SEC.hint * 1000);
  if (step === 'talk') later(room, () => wolfStep(room, 'vote'), WOLF_SEC.talk * 1000);
  if (step === 'vote') later(room, () => wolfTally(room), WOLF_SEC.vote * 1000);
  if (step === 'tally') later(room, () => (w.caught ? wolfStep(room, 'guess') : wolfFinish(room, null)), WOLF_SEC.tally * 1000);
  if (step === 'guess') later(room, () => wolfFinish(room, false), WOLF_SEC.guess * 1000);
  wolfEmit(room); broadcastRoom(room);
}
// 投票を数える：いちばん票の多い人が1人だけで、それが人狼なら「当てた」。同票・人狼以外なら人狼の勝ち
function wolfTally(room) {
  const q = room.game.q, w = q.wolf;
  if (w.step !== 'vote') return;
  const count = new Map();
  for (const [token, target] of w.votes) if (token !== w.wolfToken) count.set(target, (count.get(target) || 0) + 1); // 人狼の票は無効（人狼は自分が人狼だと知らないので、投票はできるが数えない）
  const max = Math.max(0, ...count.values()), top = [...count].filter(([, n]) => n === max).map(([id]) => id);
  const wolfId = room.players.get(w.wolfToken)?.id;
  w.votesOut = Object.fromEntries(count);
  w.caught = top.length === 1 && top[0] === wolfId;
  // 投票数を見せてから（tally）、当てられた人狼なら曲名を当てる（guess）／そうでなければ結果へ
  wolfStep(room, 'tally');
}
function wolfFinish(room, guessIndex) {
  const g = room.game, q = g.q, w = q.wolf;
  if (w.step === 'result') return;
  clearTimers(room);
  const guessed = w.caught && Number.isInteger(guessIndex) && guessIndex === w.correctIndex;
  const winner = w.caught && !guessed ? 'village' : 'wolf';
  for (const t of q.participants) {
    const p = room.players.get(t); if (!p) continue;
    const isWolf = t === w.wolfToken, pts = winner === 'wolf' ? (isWolf ? WOLF_PTS.wolf : 0) : (isWolf ? 0 : WOLF_PTS.village);
    p.score += pts;
    q.answers.set(t, { correct: pts > 0, points: pts, elapsed: null, pass: false });
  }
  const wp = room.players.get(w.wolfToken);
  w.result = { winner, caught: !!w.caught, guessed, wolfId: wp?.id, wolfName: wp?.name, votes: w.votesOut || {},
               song: { title: q.song.title, work: q.song.work, artist: q.song.artist, year: q.song.year, id: q.song.id },
               wolfSong: { title: w.wolfSong.title, work: w.wolfSong.work, artist: w.wolfSong.artist, year: w.wolfSong.year, id: w.wolfSong.id },
               guessTitle: Number.isInteger(guessIndex) ? w.choices?.[guessIndex]?.title : null, points: { ...WOLF_PTS } };
  w.step = 'result'; w.until = 0;
  q.phase = 'reveal'; // ホストの「次へ」・自動で次へを使えるように
  recordPlayed(room, q.song);
  wolfEmit(room); broadcastRoom(room);
  const sec = Math.max(12, room.settings.autoNext || 0);
  if (room.settings.autoNext > 0) { q.revealAt = Date.now(); scheduleNext(room, q, Date.now() + sec * 1000); }
}

// ── アニソン・アズール：工房の曲カードを色（ジャンル）ごとに取り合い、年代別の棚に並べる（docs/azul-spec.md）──
const AZ = { turn: 40, rounds: 3, per: 4, caps: [3, 3, 4, 5, 4], floor: [1, 1, 2, 2, 2, 3, 3], unit: 200, pause: 900, allBonus: 10 };
const AZ_ROWS = ['〜1989', '1990年代', '2000年代', '2010年代', '2020年代'];
const AZ_COLORS = [
  { key: 'jump', icon: '🔥', label: 'ジャンプ', g: ['jump'] },
  { key: 'robot', icon: '🤖', label: 'ロボット・SF', g: ['robot', 'sf'] },
  { key: 'love', icon: '💕', label: 'ラブコメ・日常', g: ['romcom', 'nichijou'] },
  { key: 'idol', icon: '🎤', label: 'アイドル・バンド', g: ['idol'] },
  { key: 'other', icon: '🗡️', label: '異世界・ゲーム・スポーツ', g: ['isekai', 'game', 'galge', 'sports'] },
];
const azRowOf = y => (y < 1990 ? 0 : y < 2000 ? 1 : y < 2010 ? 2 : y < 2020 ? 3 : 4);
const azColorOf = s => { const gs = genresOf(s); return AZ_COLORS.find(c => c.g.some(k => gs.includes(k)))?.key || null; };
function azDeal(room) { // 工房に4枚ずつ（同じ曲名は1ゲームで1回だけ）
  const g = room.game, a = g.q.az, ctx = userCtx(room), pool = g.pool.length > 100 ? g.pool : SONGS;
  const n = a.seats.length * 2 + 1;
  a.factories = Array.from({ length: n }, () => []);
  let f = 0;
  for (const s of shuffle(pool.slice())) {
    if (f >= n) break;
    if (!s.year || ctx.block.has(s.id) || a.usedTitles.has(wolfKey(s.title))) continue;
    const color = azColorOf(s); if (!color) continue;
    a.usedTitles.add(wolfKey(s.title));
    a.factories[f].push({ id: s.id, title: s.title, work: s.work, artist: s.artist, year: s.year, color, row: azRowOf(s.year) });
    if (a.factories[f].length >= AZ.per) f++;
  }
  a.center = []; a.marker = true; // 先手マーカーは中央に
}
function startAzulRound(room, placeholder) {
  const g = room.game, ps = shuffle(connectedPlayers(room).slice());
  const boards = new Map(ps.map(p => [p.token, { rows: AZ.caps.map(() => []), floor: [], marker: false, filled: new Set(), pts: 0 }]));
  g.q = { phase: 'azul', song: placeholder, participants: new Set(ps.map(p => p.token)), answers: new Map(), ready: new Set(), clues: [], lifelineResults: new Map(),
          az: { step: 'take', until: 0, seats: ps.map(p => p.token), boards, factories: [], center: [], marker: true, turn: ps[0].token, first: ps[0].token, hand: [], round: 1, usedTitles: new Set(), log: [], result: null } };
  azDeal(room);
  azTurn(room, ps[0].token);
}
const azTile = (x, open) => ({ id: x.id, title: x.title, work: x.work, color: x.color, ...(open ? { year: x.year, row: x.row } : {}) });
function azPublic(room) {
  const q = room.game?.q, a = q?.az; if (!a) return null;
  const idOf = t => room.players.get(t)?.id;
  return { step: a.step, until: a.until, round: a.round, rounds: AZ.rounds, game: room.game.qi + 1, games: room.game.order.length, turn: idOf(a.turn),
           colors: AZ_COLORS.map(c => ({ key: c.key, icon: c.icon, label: c.label })), rows: AZ_ROWS, caps: AZ.caps,
           factories: a.factories.map(f => f.map(x => azTile(x))), center: a.center.map(x => azTile(x)), marker: a.marker, hand: a.hand.map(x => azTile(x)),
           boards: a.seats.map(t => { const b = a.boards.get(t), p = room.players.get(t); return { id: p?.id, name: p?.name, rows: b.rows.map(r => r.map(x => azTile(x, true))), floor: b.floor.length + (b.marker ? 1 : 0), marker: b.marker, filled: [...b.filled], pts: b.pts }; }),
           log: a.log.slice(-2), result: a.result };
}
const azEmit = room => io.to(room.code).emit('azPhase', azPublic(room));
function azTurn(room, token) {
  const a = room.game.q.az;
  clearTimers(room);
  a.turn = token; a.step = 'take'; a.hand = [];
  const on = room.players.get(token)?.connected;
  a.until = Date.now() + (on ? AZ.turn : 2) * 1000;
  later(room, () => azAuto(room), (on ? AZ.turn : 2) * 1000);
  azEmit(room); broadcastRoom(room);
}
function azAuto(room) { // 時間切れ：取っていなければ、いちばん枚数の多い色を取る。手元のカードは置ける段へ（なければ床）
  const a = room.game.q.az;
  if (a.step === 'take') {
    let best = null;
    [...a.factories.map((f, i) => [f, i]), [a.center, -1]].forEach(([f, i]) => { const cnt = {}; for (const x of f) cnt[x.color] = (cnt[x.color] || 0) + 1; for (const [c, n] of Object.entries(cnt)) if (!best || n > best.n) best = { i, c, n }; });
    if (!best) return azNext(room);
    azTake(room, a.turn, best.i, best.c);
  }
  if (a.step === 'place') { const b = a.boards.get(a.turn); for (const x of [...a.hand]) { const r = b.rows.findIndex((row, k) => row.length < AZ.caps[k] && (!row.length || row[0].row === k)); azPlace(room, a.turn, x.id, r); } }
}
function azTake(room, token, fi, color) {
  const a = room.game.q.az;
  if (a.step !== 'take' || token !== a.turn) return;
  const src = fi === -1 ? a.center : a.factories[fi]; if (!src) return;
  const take = src.filter(x => x.color === color); if (!take.length) return;
  const rest = src.filter(x => x.color !== color);
  if (fi === -1) { a.center = rest; if (a.marker) { a.marker = false; a.boards.get(token).marker = true; a.first = token; } }
  else { a.factories[fi] = []; a.center.push(...rest); }
  a.hand = take; a.step = 'place';
  const c = AZ_COLORS.find(x => x.key === color);
  a.log.push(`${room.players.get(token)?.name} さんが ${c.icon}${c.label} を ${take.length}枚 取りました`);
  clearTimers(room);
  const on = room.players.get(token)?.connected;
  a.until = Date.now() + (on ? AZ.turn : 2) * 1000;
  later(room, () => azAuto(room), (on ? AZ.turn : 2) * 1000);
  azEmit(room);
}
function azPlace(room, token, id, rowIdx) {
  const a = room.game.q.az;
  if (a.step !== 'place' || token !== a.turn) return;
  const i = a.hand.findIndex(x => x.id === id); if (i < 0) return;
  const [x] = a.hand.splice(i, 1), b = a.boards.get(token), name = room.players.get(token)?.name;
  const r = Number.isInteger(rowIdx) && rowIdx >= 0 && rowIdx < AZ.caps.length ? rowIdx : -1;
  if (r === -1) { b.floor.push(x); a.log.push(`${name}：「${x.title}」（${x.year}年）を床へ`); }
  else if (x.row !== r) { b.floor.push(x); a.log.push(`${name}：「${x.title}」は ${x.year}年 … ${AZ_ROWS[r]}ではないので床へ`); }
  else if (b.rows[r].length >= AZ.caps[r]) { b.floor.push(x); a.log.push(`${name}：${AZ_ROWS[r]}の段がいっぱいなので「${x.title}」は床へ`); }
  else { b.rows[r].push(x); a.log.push(`${name}：「${x.title}」（${x.year}年）を${AZ_ROWS[r]}に置きました`); }
  io.to(room.code).emit('wolfSong', { videoId: x.id, start: wolfStartOf(x), sec: 6 });
  if (!a.hand.length) { clearTimers(room); a.step = 'between'; a.until = 0; azEmit(room); return later(room, () => azNext(room), AZ.pause); }
  azEmit(room);
}
function azNext(room) {
  const a = room.game.q.az;
  if (a.factories.every(f => !f.length) && !a.center.length) return azRoundEnd(room);
  const i = a.seats.indexOf(a.turn);
  azTurn(room, a.seats[(i + 1) % a.seats.length]);
}
function azRoundEnd(room) {
  const a = room.game.q.az;
  const lines = [];
  for (const t of a.seats) {
    const b = a.boards.get(t); let pts = 0;
    b.rows.forEach((row, k) => { if (row.length >= AZ.caps[k]) { pts += row.length * 2 + (row.every(x => x.color === row[0].color) ? 3 : 0); b.filled.add(k); b.rows[k] = []; } });
    const fl = b.floor.length + (b.marker ? 1 : 0); let pen = 0; for (let k = 0; k < Math.min(fl, AZ.floor.length); k++) pen += AZ.floor[k]; // 床は7枚目までで数える（本家と同じ）
    pts -= pen; b.pts += pts; b.floor = []; b.marker = false;
    lines.push(`${room.players.get(t)?.name} ${pts >= 0 ? '+' : ''}${pts}`);
  }
  a.log.push(`ラウンド${a.round} の得点：${lines.join('／')}`);
  if (a.round >= AZ.rounds) return azFinish(room);
  a.round++;
  azDeal(room);
  a.step = 'between'; a.until = 0; azEmit(room);
  later(room, () => azTurn(room, a.first), 2500);
}
function azFinish(room) {
  const g = room.game, q = g.q, a = q.az;
  if (a.step === 'result') return;
  clearTimers(room);
  const rows = a.seats.map(t => {
    const b = a.boards.get(t), bonus = b.filled.size >= AZ.caps.length ? AZ.allBonus : 0, total = (b.pts + bonus) * AZ.unit, p = room.players.get(t);
    if (p) { p.score = Math.max(0, (p.score || 0) + total); q.answers.set(t, { correct: total > 0, points: total, elapsed: null, pass: false }); }
    return { id: p?.id, name: p?.name, pts: b.pts, bonus, total, filled: b.filled.size };
  }).sort((x, y) => y.total - x.total);
  a.result = { rows };
  a.step = 'result'; a.until = 0; a.turn = null;
  q.phase = 'reveal';
  recordPlayed(room, q.song);
  azEmit(room); broadcastRoom(room);
  const sec = Math.max(14, room.settings.autoNext || 0);
  if (room.settings.autoNext > 0) { q.revealAt = Date.now(); scheduleNext(room, q, Date.now() + sec * 1000); }
}

// ── アニソン帰れま10：お題の曲の中から、再生回数トップ10を全部当てたら帰れる（docs/kaerema-spec.md）──
const KM = { turn: 30, cands: 20, top: 10, misses: 6, min: 14, play: 8, hit: 500, first: 1000, last: 2000, home: 1000, pause: 3500 };
// トップ N に応じて、候補の曲数・外れの上限を決める（トップ10：候補20・外れ6／15：28・8／20：36・10）
const kmSetup = room => { const top = [10, 15, 20].includes(room.settings.kmTop) ? room.settings.kmTop : KM.top; return { top, cands: Math.round(top * 1.8), misses: top === 10 ? 6 : top === 15 ? 8 : 10 }; };
function kmTopics(room) { // 曲が KM.min 曲以上ある歌手・シリーズ・年
  const pool = room.game.pool.length > 200 ? room.game.pool : SONGS, ctx = userCtx(room), groups = new Map();
  const add = (key, label, s) => { if (!groups.has(key)) groups.set(key, { label, songs: [] }); groups.get(key).songs.push(s); };
  // J-POP は、お題で J-POP を指定したとき（お題「J-POP」か、自由選択に J-POP を入れたとき）だけ出す。ふつうは、部屋の除外の設定に関係なく出さない
  const S = room.settings, jpopOk = S.topic === 'jpop' || (S.topic === 'multi' && (S.multiGenres || []).includes('jpop'));
  // お題の種類：歌手／作品・シリーズ／年／ジャンル／年代／曲の種類（OP・ED…）／組み合わせ（年代×曲の種類・年代×ジャンル・年×OP/ED）
  const cat = gzCatalog(), byKey = Object.fromEntries(cat.map(c => [c.key, c]));
  const SPECIAL = ['jpop', 'vocaloid', 'slot', 'lol', 'pachislot']; // J-POP・ボカロ・パチスロ・LoL は、お題で指定したときだけ（ふつうは出さない）
  const said = k => S.topic === k || (S.topic === 'multi' && (S.multiGenres || []).includes(k));
  const eraOf = s => (s.year < 1990 ? 'e:80' : s.year < 2000 ? 'e:90' : s.year < 2010 ? 'e:00' : s.year < 2020 ? 'e:10' : 'e:20');
  const typeKeys = ['t:op', 't:ed', 't:ins', 't:movie'], typeShort = { 't:op': 'OP', 't:ed': 'ED', 't:ins': '挿入歌・劇中歌', 't:movie': '映画主題歌' };
  const eraShort = { 'e:80': '〜1989年', 'e:90': '1990年代', 'e:00': '2000年代', 'e:10': '2010年代', 'e:20': '2020年代' };
  for (const s of pool) {
    if (ctx.block.has(s.id) || !(s.views > 0) || (S.noCoupling && s.coupling)) continue;
    if (!jpopOk && genresOf(s).includes('jpop')) continue;
    add('a:' + wolfArtist(s), `「${String(s.artist).split(/\s+(?:feat\.?|ft\.)\s/i)[0]}」の曲`, s);
    add('w:' + wolfFam(s), `「${wolfFam(s)}」の曲`, s);
    if (s.year) add('y:' + s.year, `${s.year}年のアニソン`, s);
    const gs = genresOf(s), era = s.year ? eraOf(s) : null, types = typeKeys.filter(k => byKey[k]?.test(s));
    for (const k of gs) {
      if (!byKey['g:' + k] || (SPECIAL.includes(k) && !said(k))) continue;
      add('g:' + k, `${byKey['g:' + k].icon}${byKey['g:' + k].label}の曲`, s);
      if (era && !SPECIAL.includes(k)) add('x:g:' + k + ':' + era, `${eraShort[era]}の${byKey['g:' + k].label}の曲`, s);
    }
    if (era) add('e:' + era, `${eraShort[era]}のアニソン`, s);
    for (const tk of types) {
      add('t:' + tk, `${typeShort[tk]}の曲`, s);
      if (era) add('x:' + tk + ':' + era, `${eraShort[era]}の${typeShort[tk]}`, s);
      if ((tk === 't:op' || tk === 't:ed') && s.year) add('x:' + tk + ':y:' + s.year, `${s.year}年の${typeShort[tk]}`, s);
    }
  }
  const out = [];
  for (const [key, g] of groups) {
    const best = new Map(); // 同じ曲名（版ちがい）は再生回数の多いほうだけ
    for (const s of g.songs) { const k = wolfKey(s.title); if (!best.has(k) || best.get(k).views < s.views) best.set(k, s); }
    const songs = [...best.values()].sort((a, b) => b.views - a.views);
    if (songs.length >= Math.max(KM.min, kmSetup(room).cands)) out.push({ key, label: g.label, songs, kind: key.startsWith('x:') ? 'x' : key.startsWith('g:') ? 'g' : key.startsWith('e:') ? 'e' : key.startsWith('t:') ? 't' : key[0] });
  }
  return out;
}
function startKaeremaRound(room, placeholder) {
  const g = room.game, ps = shuffle(connectedPlayers(room).slice()); // 答える順番はお題ごとにランダム
  if (!g.kmUsed) g.kmUsed = new Set();
  const all = kmTopics(room), topics = all.filter(x => !g.kmUsed.has(x.key));
  // お題の種類（歌手・作品・年・ジャンル・年代・曲の種類・組み合わせ）を先にランダムに選んでから、その中から選ぶ（種類がかたよらない）
  const kinds = [...new Set(topics.map(x => x.kind))], kind = kinds.length ? kinds[crypto.randomInt(kinds.length)] : null, inKind = topics.filter(x => x.kind === kind);
  const tp = inKind.length ? inKind[crypto.randomInt(inKind.length)] : all[0];
  g.kmUsed.add(tp.key);
  const ranked = tp.songs.map((s, i) => ({ s, rank: i + 1 }));
  const U = kmSetup(room);
  const others = shuffle(ranked.slice(U.top)).slice(0, U.cands - U.top);
  const cands = shuffle([...ranked.slice(0, U.top), ...others]);
  g.q = { phase: 'kaerema', song: placeholder, participants: new Set(ps.map(p => p.token)), answers: new Map(), ready: new Set(), clues: [], lifelineResults: new Map(),
          km: { top: U.top, maxMiss: U.misses, step: 'turn', until: 0, topic: tp.label, total: tp.songs.length, cands, picked: new Map(), seats: ps.map(p => p.token), turnIdx: -1, turn: null, misses: 0, found: 0, gain: new Map(), log: [], result: null } };
  kmTurn(room);
}
function kmPublic(room) {
  const q = room.game?.q, k = q?.km; if (!k) return null;
  const over = k.step === 'result', nameOf = t => room.players.get(t)?.name || '';
  return { step: k.step, until: k.until, round: room.game.qi + 1, total: room.game.order.length, topic: k.topic, count: k.total, turn: room.players.get(k.turn)?.id || null, turnName: nameOf(k.turn),
           misses: k.misses, maxMiss: k.maxMiss, found: k.found, top: k.top,
           cands: k.cands.map((c, i) => { const pk = k.picked.get(i); return { title: c.s.title, artist: c.s.artist, work: pk || over ? c.s.work : '', picked: !!pk, rank: pk || over ? c.rank : null, hit: pk ? c.rank <= KM.top : null, by: pk ? nameOf(pk.by) : '' }; }).map((c, i) => ({ ...c, by: k.picked.get(i)?.byName || '' })),
           players: k.seats.map(t => ({ id: room.players.get(t)?.id, name: nameOf(t), gain: k.gain.get(t) || 0 })), log: k.log.slice(-2), result: k.result };
}
const kmEmit = room => io.to(room.code).emit('kmPhase', kmPublic(room));
function kmTurn(room) {
  const k = room.game.q.km;
  clearTimers(room);
  const alive = k.seats.filter(t => room.players.get(t)?.connected);
  if (!alive.length) return kmFinish(room, false);
  for (let n = 0; n < k.seats.length; n++) { k.turnIdx = (k.turnIdx + 1) % k.seats.length; if (alive.includes(k.seats[k.turnIdx])) break; }
  k.turn = k.seats[k.turnIdx]; k.step = 'turn'; k.until = Date.now() + KM.turn * 1000;
  later(room, () => { k.log.push(`${room.players.get(k.turn)?.name} さんは時間切れ（とばし）`); kmTurn(room); }, KM.turn * 1000);
  kmEmit(room); broadcastRoom(room);
}
function kmPick(room, token, i) {
  const k = room.game.q.km;
  if (k.step !== 'turn' || token !== k.turn || !Number.isInteger(i) || !k.cands[i] || k.picked.has(i)) return;
  clearTimers(room);
  const c = k.cands[i], p = room.players.get(token), hit = c.rank <= k.top;
  k.picked.set(i, { by: token, byName: p?.name || '' });
  io.to(room.code).emit('wolfSong', { videoId: c.s.id, start: wolfStartOf(c.s), sec: KM.play });
  if (hit) {
    k.found++;
    let pts = c.rank === 1 ? KM.first : KM.hit; if (k.found >= k.top) pts += KM.last;
    k.gain.set(token, (k.gain.get(token) || 0) + pts); if (p) p.score += pts;
    k.log.push(`⭕ ${p?.name}「${c.s.title}」（${c.s.work}）→ ${c.rank}位！ +${pts}点`);
  } else { k.misses++; k.log.push(`❌ ${p?.name}「${c.s.title}」（${c.s.work}）→ ${c.rank}位（トップ${k.top}の外）`); }
  k.step = 'show'; k.until = 0; kmEmit(room);
  if (k.found >= k.top) return later(room, () => kmFinish(room, true), KM.pause);
  if (k.misses >= k.maxMiss) return later(room, () => kmFinish(room, false), KM.pause);
  later(room, () => kmTurn(room), KM.pause);
}
function kmFinish(room, home) {
  const g = room.game, q = g.q, k = q.km;
  if (k.step === 'result') return;
  clearTimers(room);
  if (home) for (const t of k.seats) { const p = room.players.get(t); if (p) { p.score += KM.home; k.gain.set(t, (k.gain.get(t) || 0) + KM.home); } }
  for (const t of q.participants) q.answers.set(t, { correct: (k.gain.get(t) || 0) > 0, points: k.gain.get(t) || 0, elapsed: null, pass: false });
  k.result = { home, found: k.found, misses: k.misses };
  k.step = 'result'; k.until = 0; k.turn = null;
  q.phase = 'reveal';
  recordPlayed(room, q.song);
  kmEmit(room); broadcastRoom(room);
  const sec = Math.max(14, room.settings.autoNext || 0);
  if (room.settings.autoNext > 0) { q.revealAt = Date.now(); scheduleNext(room, q, Date.now() + sec * 1000); }
}

// ── アニソン年当てベット（ウィッツ＆ウェイジャーズ風）：発売年を予想 → 並んだ予想のどれがいちばん近いかに賭ける（docs/wits-spec.md）──
const WW = { guess: 35, bet: 30, listen: 25, base: 100, extras: [0, 200, 500], own: 300, exact: 600, minYear: 1960 };
function startWitsRound(room, song) {
  const g = room.game, ps = connectedPlayers(room);
  g.q = { phase: 'wits', song, participants: new Set(ps.map(p => p.token)), answers: new Map(), ready: new Set(), clues: [], lifelineResults: new Map(),
          ww: { step: null, until: 0, guesses: new Map(), bets: new Map(), slots: null, result: null } };
  io.to(room.code).emit('wolfSong', { videoId: song.id, start: song.intro || 0, sec: WW.listen });
  wwStep(room, 'guess');
}
function wwSlots(room) { // 予想を年の順に並べ、左端に「全員より古い」。倍率は真ん中 2倍から外へ 3・4・5倍、「全員より古い」6倍
  const w = room.game.q.ww, years = [...new Set(w.guesses.values())].sort((a, b) => a - b);
  const n = years.length, mid = (n - 1) / 2;
  const slots = [{ year: null, odds: 6, owners: [] }, ...years.map((y, i) => ({ year: y, odds: Math.min(5, 2 + Math.floor(Math.abs(i - mid))), owners: [] }))];
  for (const [t, y] of w.guesses) slots.find(s => s.year === y).owners.push(t);
  return slots;
}
function wwPublic(room) {
  const q = room.game?.q, w = q?.ww; if (!w) return null;
  const idOf = t => room.players.get(t)?.id, nameOf = t => room.players.get(t)?.name || '';
  const done = w.step === 'guess' ? [...w.guesses.keys()].map(idOf) : w.step === 'bet' ? [...w.bets.keys()].map(idOf) : [];
  const out = { step: w.step, until: w.until, round: room.game.qi + 1, total: room.game.order.length, done, extras: WW.extras, minYear: WW.minYear, maxYear: new Date().getFullYear(),
                players: [...q.participants].map(t => { const p = room.players.get(t); return { id: p?.id, name: p?.name, score: p?.score || 0 }; }) };
  if (w.slots) out.slots = w.slots.map(s => ({ year: s.year, odds: s.odds, owners: s.owners.map(nameOf) }));
  if (w.step === 'result') out.result = w.result;
  return out;
}
const wwEmit = room => io.to(room.code).emit('wwPhase', wwPublic(room));
function wwStep(room, step) {
  const w = room.game.q.ww;
  clearTimers(room);
  w.step = step; w.until = Date.now() + (WW[step] || 0) * 1000;
  if (step === 'guess') later(room, () => wwToBet(room), WW.guess * 1000);
  if (step === 'bet') later(room, () => wwFinish(room), WW.bet * 1000);
  wwEmit(room); broadcastRoom(room);
}
function wwToBet(room) {
  const w = room.game.q.ww;
  if (w.step !== 'guess') return;
  w.slots = wwSlots(room);
  wwStep(room, 'bet');
}
function wwFinish(room) {
  const g = room.game, q = g.q, w = q.ww, s = q.song;
  if (w.step !== 'bet') return;
  clearTimers(room);
  // 当たり：正解の年を超えない中でいちばん近い予想。どれも新しすぎたら「全員より古い」
  let win = 0;
  w.slots.forEach((sl, i) => { if (sl.year != null && sl.year <= s.year) win = i; });
  const gain = new Map([...q.participants].map(t => [t, 0])), lines = new Map();
  for (const [t, ms] of w.bets) for (const m of ms) {
    if (m.slot === win) { const v = (WW.base + m.extra) * w.slots[win].odds; gain.set(t, gain.get(t) + v); (lines.get(t) || lines.set(t, []).get(t)).push(`当たり +${v}`); }
    else if (m.extra) { gain.set(t, gain.get(t) - m.extra); (lines.get(t) || lines.set(t, []).get(t)).push(`外れ −${m.extra}`); }
  }
  for (const t of w.slots[win].owners) { const v = w.slots[win].year === s.year ? WW.exact : WW.own; gain.set(t, gain.get(t) + v); (lines.get(t) || lines.set(t, []).get(t)).push(`予想が当たり +${v}`); }
  for (const t of q.participants) {
    const p = room.players.get(t); if (!p) continue;
    const before = p.score || 0, pts = gain.get(t) || 0; p.score = Math.max(0, before + pts);
    q.answers.set(t, { correct: pts > 0, points: p.score - before, elapsed: null, pass: false });
  }
  const idOf = t => room.players.get(t)?.id;
  w.result = { year: s.year, win, song: { title: s.title, work: s.work, artist: s.artist, year: s.year, id: s.id },
               rows: [...q.participants].map(t => ({ id: idOf(t), name: room.players.get(t)?.name || '', guess: w.guesses.get(t) ?? null, bets: (w.bets.get(t) || []).map(m => ({ slot: m.slot, extra: m.extra })), points: q.answers.get(t)?.points || 0, lines: lines.get(t) || [] })) };
  w.step = 'result'; w.until = 0;
  q.phase = 'reveal';
  recordPlayed(room, s);
  wwEmit(room); broadcastRoom(room);
  const sec = Math.max(12, room.settings.autoNext || 0);
  if (room.settings.autoNext > 0) { q.revealAt = Date.now(); scheduleNext(room, q, Date.now() + sec * 1000); }
}

// ── アニソン大富豪：発売年が新しい曲ほど強い。手札の年は見えない。場より新しい曲を出す（docs/daifugo-spec.md）──
const DF = { hand: 7, turn: 25, up: [3000, 2000, 1000], miss: 200, pause: 1200 };
const dfCard = s => ({ id: s.id, title: s.title, work: s.work, artist: s.artist });
function startDaifugoRound(room, placeholder) {
  const g = room.game, ps = shuffle(connectedPlayers(room).slice()), ctx = userCtx(room), pool = g.pool.length > 60 ? g.pool : SONGS;
  const years = new Set(), titles = new Set(), deck = [];
  for (const s of shuffle(pool.filter(x => x.year && !ctx.block.has(x.id)))) { // 全部ちがう年（同じ年だと強さが同じになるため）
    if (deck.length >= ps.length * DF.hand) break;
    if (years.has(s.year) || titles.has(wolfKey(s.title))) continue;
    years.add(s.year); titles.add(wolfKey(s.title)); deck.push(s);
  }
  const hands = new Map(ps.map(p => [p.token, []]));
  deck.forEach((s, i) => hands.get(ps[i % ps.length].token).push(s));
  g.q = { phase: 'daifugo', song: placeholder, participants: new Set(ps.map(p => p.token)), answers: new Map(), ready: new Set(), clues: [], lifelineResults: new Map(),
          df: { step: 'turn', until: 0, seats: ps.map(p => p.token), hands, field: [], lastBy: null, passes: new Set(), turn: ps[0].token, finished: [], miss: new Map(), log: [], result: null } };
  for (const p of ps) io.to(p.socketId).emit('dfHand', dfHandOf(room, p.token));
  dfTurn(room, ps[0].token);
}
const dfHandOf = (room, token) => ({ hand: (room.game.q.df.hands.get(token) || []).map(dfCard) });
function dfPublic(room) {
  const q = room.game?.q, f = q?.df; if (!f) return null;
  const idOf = t => room.players.get(t)?.id;
  return { step: f.step, until: f.until, round: room.game.qi + 1, total: room.game.order.length, turn: idOf(f.turn), lead: !f.field.length,
           field: f.field.slice(-3).map(x => ({ ...dfCard(x.s), year: x.s.year, by: room.players.get(x.by)?.name || '' })),
           players: f.seats.map(t => { const p = room.players.get(t); return { id: p?.id, name: p?.name, count: f.hands.get(t)?.length || 0, rank: f.finished.includes(t) ? f.finished.indexOf(t) + 1 : null, passed: f.passes.has(t) }; }),
           log: f.log.slice(-3), result: f.result };
}
const dfEmit = room => io.to(room.code).emit('dfPhase', dfPublic(room));
const dfAlive = f => f.seats.filter(t => (f.hands.get(t) || []).length > 0);
function dfTurn(room, token) {
  const f = room.game.q.df;
  clearTimers(room);
  if (dfAlive(f).length <= 1) return dfFinish(room);
  f.turn = token; f.step = 'turn';
  const on = room.players.get(token)?.connected;
  f.until = Date.now() + (on ? DF.turn : 2) * 1000;
  later(room, () => { if (!f.field.length) { const h = f.hands.get(token) || []; dfPlay(room, token, h[crypto.randomInt(h.length)]?.id); } else dfPass(room, token); }, (on ? DF.turn : 2) * 1000);
  dfEmit(room); broadcastRoom(room);
}
function dfNextOf(f, token) { // 次の人（上がった人はとばす）
  const alive = dfAlive(f), i = f.seats.indexOf(token);
  for (let k = 1; k <= f.seats.length; k++) { const t = f.seats[(i + k) % f.seats.length]; if (alive.includes(t)) return t; }
  return null;
}
function dfAdvance(room, from) {
  const f = room.game.q.df;
  const alive = dfAlive(f);
  if (alive.length <= 1) return later(room, () => dfFinish(room), DF.pause);
  // 出した人以外が全員パス（出した人が上がっていれば、残り全員パス）→ 場が流れて、最後に出した人（上がっていればその次の人）が親
  const others = alive.filter(t => t !== f.lastBy);
  if (f.field.length && others.every(t => f.passes.has(t))) {
    const lead = alive.includes(f.lastBy) ? f.lastBy : dfNextOf(f, f.lastBy);
    f.log.push('場が流れました'); f.field = []; f.passes.clear();
    f.step = 'between'; f.until = 0; dfEmit(room);
    return later(room, () => dfTurn(room, lead), DF.pause);
  }
  f.step = 'between'; f.until = 0; dfEmit(room);
  later(room, () => dfTurn(room, dfNextOf(f, from)), DF.pause);
}
function dfPlay(room, token, id) {
  const f = room.game.q.df;
  if (f.step !== 'turn' || token !== f.turn) return;
  clearTimers(room);
  const h = f.hands.get(token) || [], s = h.find(x => x.id === id), p = room.players.get(token);
  if (!s) return dfTurn(room, token);
  const top = f.field[f.field.length - 1]?.s;
  if (top && !(s.year > top.year)) { // 失敗：場より新しくない
    f.miss.set(token, (f.miss.get(token) || 0) + 1); f.passes.add(token);
    f.log.push(`${p?.name} さんの「${s.title}」は ${s.year}年 … 場（${top.year}年）より新しくないので失敗（−${DF.miss}点）`);
    if (p) io.to(p.socketId).emit('bbMsg', { ok: false, text: `「${s.title}」は ${s.year}年でした（場は ${top.year}年）。失敗 −${DF.miss}点` });
    return dfAdvance(room, token);
  }
  f.hands.set(token, h.filter(x => x !== s));
  f.field.push({ s, by: token }); f.lastBy = token; f.passes.clear();
  f.log.push(`${p?.name} さんが「${s.title}」（${s.year}年）を出しました`);
  io.to(room.code).emit('wolfSong', { videoId: s.id, start: wolfStartOf(s), sec: 6 });
  if (p) io.to(p.socketId).emit('dfHand', dfHandOf(room, token));
  if (!f.hands.get(token).length) { f.finished.push(token); f.log.push(`${p?.name} さんが ${f.finished.length} 番に上がり！`); }
  dfAdvance(room, token);
}
function dfPass(room, token) {
  const f = room.game.q.df;
  if (f.step !== 'turn' || token !== f.turn || !f.field.length) return;
  clearTimers(room);
  f.passes.add(token);
  f.log.push(`${room.players.get(token)?.name} さんはパス`);
  dfAdvance(room, token);
}
function dfFinish(room) {
  const g = room.game, q = g.q, f = q.df;
  if (f.step === 'result') return;
  clearTimers(room);
  const order = [...f.finished, ...dfAlive(f), ...f.seats.filter(t => !f.finished.includes(t) && !dfAlive(f).includes(t))];
  const TITLE = ['大富豪', '富豪', '平民', '平民', '平民', '平民', '平民', '平民'];
  const rows = order.map((t, i) => {
    const p = room.players.get(t), last = i === order.length - 1, place = last ? 0 : (DF.up[i] || 0), miss = -(f.miss.get(t) || 0) * DF.miss, total = place + miss;
    if (p) { p.score = Math.max(0, (p.score || 0) + total); q.answers.set(t, { correct: total > 0, points: total, elapsed: null, pass: false }); }
    return { id: p?.id, name: p?.name, rank: i + 1, title: last ? '大貧民' : TITLE[i], place, miss, total, left: (f.hands.get(t) || []).map(s => ({ title: s.title, year: s.year })) };
  });
  f.result = { rows };
  f.step = 'result'; f.until = 0; f.turn = null;
  q.phase = 'reveal';
  recordPlayed(room, q.song);
  dfEmit(room); broadcastRoom(room);
  const sec = Math.max(14, room.settings.autoNext || 0);
  if (room.settings.autoNext > 0) { q.revealAt = Date.now(); scheduleNext(room, q, Date.now() + sec * 1000); }
}

// ── アニソン・コードネーム：赤・青の2チーム。5×5の作品名の盤面から、スパイマスターのヒントで味方の作品を当てる（docs/codenames-spec.md）──
const CN = { clue: 90, guess: 90, win: 3000, winSpy: 4000, play: 8 };
const cnOther = c => (c === 'red' ? 'blue' : 'red');
function startCodenamesRound(room, placeholder) {
  const g = room.game, ps = shuffle(connectedPlayers(room).slice()), ctx = userCtx(room), pool = g.pool.length > 60 ? g.pool : SONGS;
  const teams = new Map(), members = { red: [], blue: [] };
  ps.forEach((p, i) => { const c = i % 2 === 0 ? 'red' : 'blue'; teams.set(p.token, c); members[c].push(p.token); });
  const spy = { red: members.red[g.qi % members.red.length], blue: members.blue[g.qi % members.blue.length] };
  const first = Math.random() < 0.5 ? 'red' : 'blue';
  const fams = new Set(), cards = [];
  for (const s of shuffle(pool.filter(x => !ctx.block.has(x.id)))) {
    if (cards.length >= 25) break;
    const fam = wolfFam(s); if (fams.has(fam)) continue;
    fams.add(fam); cards.push({ work: fam, song: s, revealed: false });
  }
  while (cards.length < 25) { const s = SONGS[crypto.randomInt(SONGS.length)], fam = wolfFam(s); if (!fams.has(fam)) { fams.add(fam); cards.push({ work: fam, song: s, revealed: false }); } }
  const key = shuffle([...Array(first === 'red' ? 9 : 8).fill('red'), ...Array(first === 'blue' ? 9 : 8).fill('blue'), ...Array(7).fill('neutral'), 'assassin']);
  g.q = { phase: 'codenames', song: placeholder, participants: new Set(ps.map(p => p.token)), answers: new Map(), ready: new Set(), clues: [], lifelineResults: new Map(),
          cn: { step: null, until: 0, teams, members, spy, key, cards, turn: first, first, clue: null, guesses: 0, max: 0, winner: null, reason: '', log: [], result: null } };
  cnStep(room, 'clue');
  // 色の答えは、盤面（cnPhase）を送ったあとに送る（先に送ると、画面が新しい回の盤面を受け取ったときに消してしまう）
  for (const c of ['red', 'blue']) { const sp = room.players.get(spy[c]); if (sp) io.to(sp.socketId).emit('cnKey', { key, round: room.game.qi + 1 }); }
}
function cnPublic(room) {
  const q = room.game?.q, c = q?.cn; if (!c) return null;
  const idOf = t => room.players.get(t)?.id, over = c.step === 'result';
  const left = col => c.key.filter((k, i) => k === col && !c.cards[i].revealed).length;
  return { step: c.step, until: c.until, round: room.game.qi + 1, total: room.game.order.length, turn: c.turn, clue: c.clue, guesses: c.guesses, max: c.max,
           spy: { red: idOf(c.spy.red), blue: idOf(c.spy.blue) },
           players: [...q.participants].map(t => { const p = room.players.get(t); return { id: p?.id, name: p?.name, team: c.teams.get(t) }; }),
           cards: c.cards.map((x, i) => ({ work: x.work, color: x.revealed || over ? c.key[i] : null, revealed: x.revealed, title: x.revealed ? x.song.title : null })),
           left: { red: left('red'), blue: left('blue') }, log: c.log.slice(-3), winner: c.winner, reason: c.reason, result: c.result };
}
const cnEmit = room => io.to(room.code).emit('cnPhase', cnPublic(room));
function cnStep(room, step) {
  const c = room.game.q.cn;
  clearTimers(room);
  c.step = step; c.until = Date.now() + (CN[step] || 0) * 1000;
  if (step === 'clue') {
    c.clue = null; c.guesses = 0; c.max = 0;
    const sp = c.spy[c.turn];
    later(room, () => cnClue(room, sp, '（なし）', 1), (room.players.get(sp)?.connected ? CN.clue : 2) * 1000);
  }
  if (step === 'guess') later(room, () => cnTurnEnd(room, '時間切れ'), CN.guess * 1000);
  cnEmit(room); broadcastRoom(room);
}
function cnClue(room, token, word, num) {
  const c = room.game.q.cn;
  if (c.step !== 'clue' || token !== c.spy[c.turn]) return;
  const w = String(word || '（なし）').trim().slice(0, 12) || '（なし）', n = Math.max(0, Math.min(9, Math.floor(+num || 0)));
  c.clue = { word: w, num: n }; c.max = n === 0 ? 99 : n + 1; c.guesses = 0;
  c.log.push(`${c.turn === 'red' ? '赤' : '青'}のヒント：${w} ${n || '∞'}`);
  cnStep(room, 'guess');
}
function cnTurnEnd(room, why) {
  const c = room.game.q.cn;
  if (c.step !== 'guess') return;
  if (why) c.log.push(`${c.turn === 'red' ? '赤' : '青'}の手番が終わりました（${why}）`);
  c.turn = cnOther(c.turn);
  cnStep(room, 'clue');
}
function cnGuess(room, token, i) {
  const c = room.game.q.cn;
  if (c.step !== 'guess' || c.teams.get(token) !== c.turn || token === c.spy[c.turn] || !Number.isInteger(i) || i < 0 || i > 24 || c.cards[i].revealed) return;
  c.cards[i].revealed = true;
  const col = c.key[i], mine = c.turn;
  const song = c.cards[i].song, sp = wolfStartOf(song);
  io.to(room.code).emit('wolfSong', { videoId: song.id, start: sp, sec: CN.play });
  c.log.push(`${room.players.get(token)?.name} さんが「${c.cards[i].work}」を選びました → ${col === 'assassin' ? '暗殺！' : col === 'neutral' ? '中立' : col === 'red' ? '赤' : '青'}`);
  if (col === 'assassin') return cnFinish(room, cnOther(mine), '暗殺カードを引いた');
  for (const side of ['red', 'blue']) if (c.key.every((k, j) => k !== side || c.cards[j].revealed)) return cnFinish(room, side, '全部当てた');
  c.guesses++;
  if (col !== mine || c.guesses >= c.max) return cnTurnEnd(room, col === mine ? '' : '外れ');
  cnEmit(room);
}
function cnFinish(room, winner, reason) {
  const g = room.game, q = g.q, c = q.cn;
  if (c.step === 'result') return;
  clearTimers(room);
  c.winner = winner; c.reason = reason;
  const rows = [];
  for (const t of q.participants) {
    const p = room.players.get(t); if (!p) continue;
    const won = c.teams.get(t) === winner, pts = won ? (t === c.spy[winner] ? CN.winSpy : CN.win) : 0;
    p.score += pts; q.answers.set(t, { correct: won, points: pts, elapsed: null, pass: false });
    rows.push({ id: p.id, name: p.name, team: c.teams.get(t), spy: t === c.spy.red || t === c.spy.blue, points: pts });
  }
  c.result = { winner, reason, rows };
  c.step = 'result'; c.until = 0;
  q.phase = 'reveal';
  recordPlayed(room, q.song);
  cnEmit(room); broadcastRoom(room);
  const sec = Math.max(14, room.settings.autoNext || 0);
  if (room.settings.autoNext > 0) { q.revealAt = Date.now(); scheduleNext(room, q, Date.now() + sec * 1000); }
}

// ── アニソン・ババ抜き：同じ作品の曲2枚がペア。右隣から1枚ずつ引き、最後までババを持っていた人が負け（docs/baba-spec.md）──
const BB = { pair: 40, turn: 25, up: [3000, 2000, 1000], pairPts: 300, wrongPts: 300, jokerPts: -1000, perHand: 5, pause: 1500 };
const BB_JOKER = { id: 'JOKER', title: 'ババ（ジョーカー）', artist: '', work: '', year: 0, wk: '', joker: true };
const bbCardOf = s => ({ id: s.id, title: s.title, artist: s.artist, work: s.work, year: s.year, wk: workKey(s.work) });
function bbMakeDeck(room, nPairs) { // 同じ作品の曲2枚を1組にして、nPairs 組。どの組も別のシリーズ。最後にババを足す
  const ctx = userCtx(room), pool = room.game.pool.length > 30 ? room.game.pool : SONGS, byWork = new Map();
  for (const s of SONGS) { if (ctx.block.has(s.id)) continue; const k = workKey(s.work); if (!byWork.has(k)) byWork.set(k, []); byWork.get(k).push(s); }
  const cards = [], fams = new Set(), titles = new Set();
  for (const s of shuffle(pool.slice())) {
    if (cards.length >= nPairs * 2) break;
    const fam = wolfFam(s);
    if (ctx.block.has(s.id) || fams.has(fam) || titles.has(wolfKey(s.title))) continue;
    const mates = shuffle((byWork.get(workKey(s.work)) || []).filter(x => x.id !== s.id && wolfKey(x.title) !== wolfKey(s.title)));
    const mate = mates.find(x => wolfArtist(x) !== wolfArtist(s)) || mates[0];
    if (!mate) continue;
    fams.add(fam); titles.add(wolfKey(s.title)); titles.add(wolfKey(mate.title));
    cards.push(bbCardOf(s), bbCardOf(mate));
  }
  return shuffle([...cards, { ...BB_JOKER }]);
}
function startBabaRound(room, placeholder) {
  const g = room.game, ps = connectedPlayers(room), n = ps.length;
  const cards = bbMakeDeck(room, Math.ceil(n * BB.perHand / 2));
  const hands = new Map(ps.map(p => [p.token, []]));
  cards.forEach((c, i) => hands.get(ps[i % n].token).push(c));
  for (const h of hands.values()) shuffle(h);
  g.q = { phase: 'baba', song: placeholder, participants: new Set(ps.map(p => p.token)), answers: new Map(), ready: new Set(), clues: [], lifelineResults: new Map(),
          bb: { step: null, until: 0, seats: ps.map(p => p.token), hands, finished: [], turn: null, target: null, gain: new Map(ps.map(p => [p.token, 0])), pairs: new Map(ps.map(p => [p.token, 0])), wrong: new Map(ps.map(p => [p.token, 0])),
                log: [], ready: new Set(), turns: 0, result: null } };
  for (const p of ps) { io.to(p.socketId).emit('bbHand', bbHandOf(room, p.token)); bbCheckDone(room, p.token); }
  bbStep(room, 'pair');
}
const bbHandOf = (room, token) => ({ hand: room.game.q.bb.hands.get(token) || [] });
function bbPublic(room) {
  const q = room.game?.q, b = q?.bb; if (!b) return null;
  const idOf = t => room.players.get(t)?.id;
  const players = b.seats.map(t => { const p = room.players.get(t); return { id: p?.id, name: p?.name, avatar: p?.avatar, count: b.hands.get(t)?.length || 0, rank: b.finished.includes(t) ? b.finished.indexOf(t) + 1 : null, ready: b.ready.has(t) }; });
  return { step: b.step, until: b.until, round: room.game.qi + 1, total: room.game.order.length, turn: idOf(b.turn), target: idOf(b.target), players, log: b.log.slice(-6), result: b.result };
}
const bbEmit = room => io.to(room.code).emit('bbPhase', bbPublic(room));
const bbSendHand = (room, token) => { const p = room.players.get(token); if (p) io.to(p.socketId).emit('bbHand', bbHandOf(room, token)); };
function bbStep(room, step) {
  const b = room.game.q.bb;
  clearTimers(room);
  b.step = step; b.until = Date.now() + (step === 'pair' ? BB.pair : step === 'turn' ? BB.turn : 0) * 1000;
  if (step === 'pair') later(room, () => bbNextTurn(room), BB.pair * 1000);
  bbEmit(room); broadcastRoom(room);
}
function bbCheckDone(room, token) { // 手札がなくなったら上がり
  const b = room.game.q.bb;
  if (!b.finished.includes(token) && !(b.hands.get(token) || []).length) { b.finished.push(token); b.log.push(`${room.players.get(token)?.name} さんが ${b.finished.length} 番に上がり！`); }
}
const bbAlive = b => b.seats.filter(t => (b.hands.get(t) || []).length > 0);
function bbAutoPair(room, token) { // つながっていない人の分：同じ作品の2枚を自動で出す
  const b = room.game.q.bb, h = b.hands.get(token) || [];
  for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) {
    if (h[i].wk && h[i].wk === h[j].wk) { h.splice(j, 1); h.splice(i, 1); b.pairs.set(token, (b.pairs.get(token) || 0) + 1); i = -1; break; }
  }
  bbCheckDone(room, token);
}
function bbNextTurn(room) {
  const b = room.game.q.bb;
  clearTimers(room);
  for (const t of b.seats) if (!room.players.get(t)?.connected) bbAutoPair(room, t);
  const alive = bbAlive(b);
  if (alive.length <= 1 || b.turns > 300) return bbFinish(room);
  const from = b.turn ? b.seats.indexOf(b.turn) : -1;
  const nextAlive = i => { for (let k = 1; k <= b.seats.length; k++) { const t = b.seats[(i + k) % b.seats.length]; if (alive.includes(t)) return t; } return null; };
  b.turn = nextAlive(from);
  b.target = nextAlive(b.seats.indexOf(b.turn));
  b.turns++;
  b.step = 'turn'; b.until = Date.now() + BB.turn * 1000;
  const connected = room.players.get(b.turn)?.connected;
  later(room, () => bbDraw(room, b.turn, -1), (connected ? BB.turn : 2) * 1000);
  if (!connected) b.until = Date.now() + 2000;
  bbEmit(room); broadcastRoom(room);
}
function bbDraw(room, token, idx) {
  const b = room.game.q.bb;
  if (b.step !== 'turn' || token !== b.turn) return;
  clearTimers(room);
  const th = b.hands.get(b.target) || [], dh = b.hands.get(token) || [];
  if (!th.length) return bbNextTurn(room);
  const i = Number.isInteger(idx) && idx >= 0 && idx < th.length ? idx : crypto.randomInt(th.length);
  const [card] = th.splice(i, 1);
  dh.splice(crypto.randomInt(dh.length + 1), 0, card); // ババの場所が分からないよう、ランダムな場所に入れる
  b.log.push(`${room.players.get(token)?.name} さんが ${room.players.get(b.target)?.name} さんから1枚引きました`);
  const dp = room.players.get(token); if (dp) io.to(dp.socketId).emit('bbDrew', { id: card.id });
  bbSendHand(room, token); bbSendHand(room, b.target);
  bbCheckDone(room, b.target);
  b.step = 'between'; b.until = 0;
  bbEmit(room);
  later(room, () => bbNextTurn(room), BB.pause);
}
function bbPair(room, token, a, c) {
  const b = room.game.q.bb;
  if (!['pair', 'turn', 'between'].includes(b.step) || b.finished.includes(token)) return;
  const h = b.hands.get(token) || [], x = h.find(k => k.id === a), y = h.find(k => k.id === c), p = room.players.get(token);
  if (!x || !y || x === y || x.joker || y.joker) return;
  if (!x.wk || x.wk !== y.wk) { b.wrong.set(token, (b.wrong.get(token) || 0) + 1); if (p) io.to(p.socketId).emit('bbMsg', { ok: false, text: `ちがいます（${BB.wrongPts}点ひかれます）` }); return; }
  b.hands.set(token, h.filter(k => k !== x && k !== y));
  b.pairs.set(token, (b.pairs.get(token) || 0) + 1);
  if (p) io.to(p.socketId).emit('bbMsg', { ok: true, text: `ペア成立！ 「${x.work}」 +${BB.pairPts}点` });
  bbSendHand(room, token);
  bbCheckDone(room, token);
  bbEmit(room);
  if (bbAlive(b).length <= 1) { clearTimers(room); later(room, () => bbFinish(room), 800); }
}
function bbFinish(room) {
  const g = room.game, q = g.q, b = q.bb;
  if (b.step === 'result') return;
  clearTimers(room);
  const loser = bbAlive(b)[0] || null;
  const order = [...b.finished, ...(loser ? [loser] : []), ...b.seats.filter(t => !b.finished.includes(t) && t !== loser)];
  const rows = order.map((t, i) => {
    const p = room.players.get(t), place = b.finished.includes(t) ? (BB.up[b.finished.indexOf(t)] || 0) : 0, joker = t === loser ? BB.jokerPts : 0;
    const pairs = (b.pairs.get(t) || 0) * BB.pairPts, wrong = -(b.wrong.get(t) || 0) * BB.wrongPts, total = place + joker + pairs + wrong;
    if (p) { p.score = Math.max(0, (p.score || 0) + total); q.answers.set(t, { correct: total > 0, points: total, elapsed: null, pass: false }); }
    return { id: p?.id, name: p?.name, rank: i + 1, loser: t === loser, place, joker, pairs, wrong, total };
  });
  b.result = { rows, loser: rows.find(r => r.loser)?.name || null };
  b.step = 'result'; b.until = 0; b.turn = null; b.target = null;
  q.phase = 'reveal';
  recordPlayed(room, q.song);
  bbEmit(room); broadcastRoom(room);
  const sec = Math.max(14, room.settings.autoNext || 0);
  if (room.settings.autoNext > 0) { q.revealAt = Date.now(); scheduleNext(room, q, Date.now() + sec * 1000); }
}

// ── アニソン伝達クイズ：伝える人（順番に全員）だけがイントロ・サビを聴いて、文字のヒントで伝える。
//    ほかの人は選択肢から当てる（選択肢は伝える人には見えない）。正解した人が多いほど伝える人の点が増える（docs/dentatsu-spec.md）──
const DT_SEC = 100, DT_UNIT = 100, DT_BONUS = 50, DT_HINT_MAX = 10, DT_HINT_LEN = 30, DT_PLAY = 20;
function dtNextTeller(room) { // 順番に全員：一巡ごとに順番をまぜる（抜けた人は飛ばす）
  const g = room.game, on = new Set(connectedPlayers(room).map(p => p.token));
  for (let i = 0; i < 2; i++) {
    while (g.dtQueue?.length) { const t = g.dtQueue.shift(); if (on.has(t)) return t; }
    g.dtQueue = shuffle([...on]);
  }
  return [...on][0];
}
function startDentatsuRound(room, song) {
  const g = room.game, ps = connectedPlayers(room);
  const teller = dtNextTeller(room);
  const n = [4, 8, 12].includes(room.settings.dtChoices) ? room.settings.dtChoices : 8;
  const ch = buildChoices(song, n, g.pool);
  // 選択肢の曲（答える人の試聴用）。正解は出題の曲、ほかは曲名・作品名から探す
  const songOf = (c, i) => i === ch.correctIndex ? song : SONGS.find(s => s.title === c.title && s.work === c.work) || null;
  g.q = { phase: 'dentatsu', song, participants: new Set(ps.map(p => p.token)), answers: new Map(), ready: new Set(), clues: [], lifelineResults: new Map(),
          dt: { step: 'tell', until: Date.now() + DT_SEC * 1000, teller, hints: [], choices: ch.choices, correctIndex: ch.correctIndex, choiceSongs: ch.choices.map(songOf), picks: new Map(), firstHintAt: 0, result: null } };
  statsPlay(room, song);
  clearTimers(room);
  later(room, () => dtFinish(room), DT_SEC * 1000);
  const tp = room.players.get(teller);
  if (tp?.connected) io.to(tp.socketId).emit('wolfSong', { videoId: song.id, start: song.intro || 0, sec: DT_PLAY });
  dtEmit(room); broadcastRoom(room);
}
function dtPublic(room, token) { // 見る人ごと（伝える人には選択肢を見せない。答える人には曲名を見せない）
  const q = room.game?.q, d = q?.dt;
  if (!d) return null;
  const idOf = t => room.players.get(t)?.id;
  const isTeller = token === d.teller;
  const out = { step: d.step, until: d.until, round: room.game.qi + 1, total: room.game.order.length, teller: idOf(d.teller), me: isTeller ? 'teller' : 'answer',
                hints: d.hints, answered: [...d.picks].filter(([, p]) => p.locked).map(([t]) => idOf(t)), /* 「決定」した人 */ answerers: [...q.participants].filter(t => t !== d.teller && room.players.get(t)?.connected).length,
                players: [...q.participants].map(t => room.players.get(t)).filter(Boolean).map(p => ({ id: p.id, name: p.name })) };
  if (isTeller && d.step === 'tell') out.song = { title: q.song.title, work: q.song.work, artist: q.song.artist, year: q.song.year, chorus: hasChorus(q.song) };
  if (!isTeller || d.step === 'result') out.choices = d.choices.map(c => ({ title: c.title, work: c.work }));
  if (!isTeller) { out.myPick = d.picks.get(token)?.i ?? null; out.myLocked = !!d.picks.get(token)?.locked; }
  if (!isTeller && d.step === 'tell') out.canPreview = d.choiceSongs.map(s => !!s);
  if (d.step === 'result') out.result = d.result;
  return out;
}
function dtEmit(room) {
  for (const p of room.players.values()) if (p.connected) io.to(p.socketId).emit('dtPhase', dtPublic(room, p.token));
}
// ヒントに曲名・作品名・歌手名（の一部でも2文字以上の名前）が入っていないか
function dtBanned(song, text) {
  const n = normText(text);
  const names = [song.title, shortForm(song.title), song.work, shortForm(song.work), song.artist, shortForm(song.artist), ...(song.aliases || []), ...(song.workAliases || [])]
    .map(normText).filter(s => [...s].length >= 2 && !/^ボカロ/.test(s));
  return names.some(s => n.includes(s));
}
function dtHint(room, player, text) {
  const q = room.game?.q, d = q?.dt;
  if (!d || d.step !== 'tell' || player.token !== d.teller || typeof text !== 'string') return;
  const s = text.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DT_HINT_LEN);
  if (!s || d.hints.length >= DT_HINT_MAX) return;
  if (dtBanned(q.song, s)) return io.to(player.socketId).emit('notice', '曲名・作品名・歌手名はヒントに使えません');
  d.hints.push(s);
  if (!d.firstHintAt) d.firstHintAt = Date.now();
  dtEmit(room);
}
// 選ぶ：「決定」を押すまでは何度でも選び直せる（早さボーナスは最後に選んだ時間で数える）
function dtPick(room, player, i) {
  const q = room.game?.q, d = q?.dt;
  if (!d || d.step !== 'tell' || player.token === d.teller || !q.participants.has(player.token) || !Number.isInteger(i) || !d.choices[i] || d.picks.get(player.token)?.locked) return;
  if (!d.hints.length) return io.to(player.socketId).emit('notice', 'ヒントが出てから選んでください');
  if (d.picks.get(player.token)?.i === i) return;
  d.picks.set(player.token, { i, at: Date.now(), locked: false });
  dtEmit(room);
}
// 決定：全員（つながっている答える人）が決定したら答え合わせ
function dtLock(room, player) {
  const q = room.game?.q, d = q?.dt, p = d?.picks.get(player.token);
  if (!d || d.step !== 'tell' || !p || p.locked) return;
  p.locked = true;
  const left = [...q.participants].filter(t => t !== d.teller && room.players.get(t)?.connected && !d.picks.get(t)?.locked);
  if (!left.length) return dtFinish(room);
  dtEmit(room);
}
function dtFinish(room) {
  const g = room.game, q = g.q, d = q?.dt;
  if (!d || d.step !== 'tell') return;
  clearTimers(room);
  const span = Math.max(1, d.until - (d.firstHintAt || d.until));
  const rows = [];
  let nCorrect = 0;
  for (const t of q.participants) {
    if (t === d.teller) continue;
    const p = room.players.get(t); if (!p) continue;
    const pk = d.picks.get(t), correct = !!pk && pk.i === d.correctIndex;
    // 答える人：正解で100点＋早いほど最大50点
    let pts = correct ? DT_UNIT + Math.round(DT_BONUS * Math.max(0, Math.min(1, (d.until - pk.at) / span))) : 0;
    if (correct && room.settings.bonus && isFinalQuestion(room)) pts *= 2;
    if (correct) nCorrect++;
    p.score += pts;
    q.answers.set(t, { correct, points: pts, elapsed: null, pass: !pk });
    rows.push({ name: p.name, pick: pk ? d.choices[pk.i]?.title || '' : null, correct, pts });
  }
  // 伝える人：正解した人1人につき100点
  const tp = room.players.get(d.teller);
  let tpts = nCorrect * DT_UNIT;
  if (room.settings.bonus && isFinalQuestion(room)) tpts *= 2;
  if (tp) { tp.score += tpts; q.answers.set(d.teller, { correct: tpts > 0, points: tpts, elapsed: null, pass: false }); }
  rows.sort((a, b) => b.pts - a.pts);
  d.result = { song: { title: q.song.title, work: q.song.work, artist: q.song.artist, year: q.song.year }, correctIndex: d.correctIndex,
               teller: tp?.name || '', tellerPts: tpts, nCorrect, nAnswer: rows.length, rows };
  d.step = 'result'; d.until = 0;
  q.phase = 'reveal';
  recordPlayed(room, q.song);
  io.to(room.code).emit('wolfSong', { videoId: q.song.id, start: wolfStartOf(q.song), sec: 15 }); // 答え合わせ：みんなでサビを聴く
  dtEmit(room); broadcastRoom(room);
  const sec = Math.max(12, room.settings.autoNext || 0);
  if (room.settings.autoNext > 0) { q.revealAt = Date.now(); scheduleNext(room, q, Date.now() + sec * 1000); }
}

// ── アニソン・ディクシット：語り手が曲にヒントを付け、ほかの人は手札から合う曲を出す。出た曲から語り手の曲を当てる（docs/dixit-spec.md）──
const DX_SEC = { tell: 60, pick: 45, vote: 60 };
const DX_HAND = 5, DX_UNIT = 500, DX_PREVIEW = 20;
function dixitDeal(room) { // 手札を5曲にそろえる（同じ曲名・同じ作品は同じ手札に入れない。みんなの手札でも重ならないようにする）
  const g = room.game, dx = g.dx, ctx = userCtx(room);
  const pool = g.pool.length > 30 ? g.pool : SONGS;
  const held = new Set(), works = new Set();
  for (const h of dx.hands.values()) for (const s of h) held.add(wolfKey(s.title));
  for (const [token, h] of dx.hands) {
    const mine = new Set(h.map(s => workKey(s.work)));
    for (let tries = 0; h.length < DX_HAND && tries < 400; tries++) {
      const s = pool[crypto.randomInt(pool.length)];
      if (ctx.block.has(s.id) || held.has(wolfKey(s.title)) || mine.has(workKey(s.work)) || dx.seen.has(s.id)) continue;
      held.add(wolfKey(s.title)); mine.add(workKey(s.work)); h.push(s);
    }
    while (h.length < DX_HAND) { const s = SONGS[crypto.randomInt(SONGS.length)]; if (!h.includes(s)) h.push(s); }
  }
}
const dixitCard = s => ({ id: s.id, title: s.title, work: s.work, artist: s.artist, year: s.year });
const dixitHandOf = (room, token) => { const d = room.game.q?.dx; return { hand: (room.game.dx.hands.get(token) || []).map(dixitCard), pick: (d && (token === d.teller ? d.tellerSong : d.picks.get(token)))?.id || null }; };
function startDixitRound(room, placeholder) {
  const g = room.game, ps = connectedPlayers(room);
  if (!g.dx) g.dx = { hands: new Map(), seen: new Set() };
  const dx = g.dx;
  for (const p of ps) if (!dx.hands.has(p.token)) dx.hands.set(p.token, []);
  dixitDeal(room);
  const tokens = ps.map(p => p.token), teller = tokens[g.qi % tokens.length];
  g.q = { phase: 'dixit', song: placeholder, participants: new Set(tokens), answers: new Map(), ready: new Set(), clues: [], lifelineResults: new Map(),
          dx: { step: null, until: 0, teller, hint: '', tellerSong: null, picks: new Map(), cands: null, votes: new Map(), result: null } };
  for (const p of ps) io.to(p.socketId).emit('dixitHand', dixitHandOf(room, p.token));
  dixitStep(room, 'tell');
}
function dixitPublic(room) {
  const q = room.game?.q, d = q?.dx;
  if (!d) return null;
  const ps = [...q.participants].map(t => room.players.get(t)).filter(Boolean);
  const idOf = t => room.players.get(t)?.id;
  const done = d.step === 'tell' ? (d.tellerSong ? [idOf(d.teller)] : []) : d.step === 'pick' ? [...d.picks.keys()].map(idOf) : d.step === 'vote' ? [...d.votes.keys()].map(idOf) : [];
  const out = { step: d.step, until: d.until, round: room.game.qi + 1, total: room.game.order.length, teller: idOf(d.teller), hint: d.step === 'tell' ? '' : d.hint, done,
                players: ps.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score || 0 })) }; // score：いまの点数（窓の上に出す）
  if (d.cands && ['vote', 'result'].includes(d.step)) out.cands = d.cands.map(c => ({ id: c.song.id, title: c.song.title, work: c.song.work, artist: d.step === 'result' ? c.song.artist : '' }));
  if (d.step === 'result') out.result = d.result;
  return out;
}
const dixitEmit = room => io.to(room.code).emit('dixitPhase', dixitPublic(room));
function dixitStep(room, step) {
  const q = room.game.q, d = q.dx;
  clearTimers(room);
  d.step = step;
  d.until = Date.now() + (DX_SEC[step] || 0) * 1000;
  if (step === 'tell') later(room, () => { const h = room.game.dx.hands.get(d.teller) || []; dixitTell(room, h[crypto.randomInt(Math.max(1, h.length))]?.id, '（なし）'); }, DX_SEC.tell * 1000);
  if (step === 'pick') later(room, () => dixitToVote(room), DX_SEC.pick * 1000);
  if (step === 'vote') later(room, () => dixitFinish(room), DX_SEC.vote * 1000);
  dixitEmit(room); broadcastRoom(room);
}
function dixitTell(room, songId, hint) {
  const q = room.game.q, d = q.dx;
  if (d.step !== 'tell') return;
  const hand = room.game.dx.hands.get(d.teller) || [], song = hand.find(s => s.id === songId);
  if (!song) return;
  d.tellerSong = song; d.hint = String(hint || '（なし）').slice(0, 20);
  q.song = song;
  dixitStep(room, 'pick');
}
function dixitToVote(room) { // 出さなかった人（時間切れ）は、手札からランダムに出す。出た曲をまぜて並べる
  const q = room.game.q, d = q.dx, dx = room.game.dx;
  if (d.step !== 'pick') return;
  for (const t of q.participants) {
    if (t === d.teller || d.picks.has(t)) continue;
    const h = (dx.hands.get(t) || []).filter(s => s !== d.tellerSong);
    if (h.length) d.picks.set(t, h[crypto.randomInt(h.length)]);
  }
  d.cands = shuffle([{ owner: d.teller, song: d.tellerSong }, ...[...d.picks].map(([owner, song]) => ({ owner, song }))]);
  dixitStep(room, 'vote');
}
function dixitFinish(room) {
  const g = room.game, q = g.q, d = q.dx;
  if (d.step !== 'vote') return;
  clearTimers(room);
  const idOf = t => room.players.get(t)?.id;
  const voters = [...d.votes].filter(([t]) => q.participants.has(t));
  const correct = voters.filter(([, i]) => d.cands[i]?.owner === d.teller);
  const gain = new Map([...q.participants].map(t => [t, 0]));
  const allOrNone = voters.length > 0 && (correct.length === 0 || correct.length === voters.length);
  if (voters.length) {
    if (allOrNone) { for (const t of q.participants) if (t !== d.teller) gain.set(t, 2); }
    else { gain.set(d.teller, 3); for (const [t] of correct) gain.set(t, 3); }
  }
  const got = d.cands.map(() => 0);
  for (const [, i] of voters) if (d.cands[i] && d.cands[i].owner !== d.teller) { got[i]++; }
  d.cands.forEach((c, i) => { if (c.owner !== d.teller) gain.set(c.owner, (gain.get(c.owner) || 0) + Math.min(3, got[i])); });
  const tally = d.cands.map(() => 0); for (const [, i] of voters) if (d.cands[i]) tally[i]++;
  for (const t of q.participants) {
    const p = room.players.get(t); if (!p) continue;
    const pts = (gain.get(t) || 0) * DX_UNIT; p.score += pts;
    q.answers.set(t, { correct: pts > 0, points: pts, elapsed: null, pass: false });
  }
  d.result = { teller: idOf(d.teller), hint: d.hint, unit: DX_UNIT, allOrNone, tellerIndex: d.cands.findIndex(c => c.owner === d.teller),
               cards: d.cands.map((c, i) => ({ id: c.song.id, title: c.song.title, work: c.song.work, artist: c.song.artist, year: c.song.year, owner: idOf(c.owner), ownerName: room.players.get(c.owner)?.name || '', votes: tally[i],
                                              voters: voters.filter(([, k]) => k === i).map(([t]) => room.players.get(t)?.name || '') })),
               gains: Object.fromEntries([...gain].map(([t, n]) => [idOf(t), n * DX_UNIT])) };
  // 使った曲は手札から外す（次の回で5曲にそろえる）。ここまでに出た曲は、このゲームでは配らない
  for (const [t, h] of g.dx.hands) { const used = t === d.teller ? d.tellerSong : d.picks.get(t); if (used) { g.dx.hands.set(t, h.filter(s => s !== used)); g.dx.seen.add(used.id); } }
  d.step = 'result'; d.until = 0;
  q.phase = 'reveal';
  recordPlayed(room, q.song);
  dixitEmit(room); broadcastRoom(room);
  const sec = Math.max(14, room.settings.autoNext || 0);
  if (room.settings.autoNext > 0) { q.revealAt = Date.now(); scheduleNext(room, q, Date.now() + sec * 1000); }
}

// ライフラインは1ゲームにつき各1回（部屋設定で無しにもできる）
function freshLifelines(settings) {
  return Object.fromEntries(LIFELINES.map(k => [k, settings.lifelines && settings.play !== 'fill' ? 1 : 0])); // 3つ埋めバトルは答えが出てしまうので使わない
}

// ── チーム戦（赤・青）。入った順に人数の少ないほうへ。待機中は自分で切り替えられる ──
const TEAMS = ['red', 'blue'];
function assignTeams(room) {
  for (const p of room.players.values()) {
    if (TEAMS.includes(p.team)) continue;
    const count = t => [...room.players.values()].filter(x => x.team === t).length;
    p.team = count('red') <= count('blue') ? 'red' : 'blue';
  }
}
function teamScores(room) {
  if (!room.settings.teams) return null;
  return TEAMS.map(t => {
    const ms = [...room.players.values()].filter(p => p.team === t);
    return { team: t, score: ms.reduce((a, p) => a + (p.score || 0), 0), members: ms.length };
  });
}

// 作品当ての選択肢：同じシリーズ（「ラブライブ!」と「ラブライブ! 2期」など）が並ばないように、シリーズ名で重ならないものを選ぶ
function buildWorkChoices(song, count, pool) {
  const near = s => Math.abs(s.year - song.year) <= NEAR_YEARS;
  const key = w => seriesKey(seriesName(w));
  const seen = new Set([key(song.work)]);
  const picks = [];
  const candidates = [
    ...similarFirst(song, [...shuffle(pool.filter(s => s !== song)), ...(pool.strict ? [] : shuffle(SONGS.filter(s => !pool.includes(s) && !choiceBlocked(s, pool))))], near).map(s => s.work), // ジャンル・作品のお題では、そのお題の曲だけ
    ...(pool.strict ? [] : shuffle(DECOYS.map(([, work]) => work))),
  ];
  for (const w of candidates) {
    if (picks.length >= count - 1) break;
    if (!w || seen.has(key(w))) continue;
    seen.add(key(w)); picks.push(w);
  }
  const choices = shuffle([song.work, ...picks]).map(w => ({ title: w, work: '' }));
  return { choices, correctIndex: choices.findIndex(c => c.title === song.work) };
}
// 歌手当ての選択肢：「LiSA」と「LiSA × Uru」のように最初の名前が同じ歌手は並べない
const artistKey = a => String(a || '').normalize('NFKC').split(/\s*(?:×|&|＆|feat\.?|ft\.|、|,|\/)\s*/i)[0].toLowerCase().replace(/\s+/g, '');
// 歌手の声（data/artist-gender.json：f 女性・m 男性・mix 男女）。選択肢は正解と同じ声の歌手から選ぶ（声で消去法ができないように）。
// 分からない歌手・足りないときは、ほかの歌手でうめる
let GENDER = new Map();
try { GENDER = new Map(Object.entries(require('./data/artist-gender.json')).map(([a, v]) => [a, Array.isArray(v) ? v[0] : v])); } catch (e) { /* なくても動く */ }
const sameVoiceFirst = (artist, list) => {
  const g = GENDER.get(artist);
  if (!g) return list;
  return [...list.filter(a => GENDER.get(a) === g), ...list.filter(a => GENDER.get(a) !== g)];
};
function buildArtistChoices(song, count, pool) {
  const near = s => Math.abs(s.year - song.year) <= NEAR_YEARS;
  const seen = new Set([artistKey(song.artist)]);
  const picks = [];
  // 曲の種類（アニメ・ボカロ・J-POP・パチスロ）がそろうのを先に（ちがう種類が1つだけ混ざって浮かないように）、その中で同じ声の歌手を先に
  const k = kindOf(song), voice = GENDER.get(song.artist);
  const candidates = ([
    ...similarFirst(song, [...shuffle(pool.filter(s => s !== song)), ...(pool.strict ? [] : shuffle(SONGS.filter(s => !pool.includes(s) && !choiceBlocked(s, pool))))], near)
      .map((s, i) => [s, (kindOf(s) === k ? 0 : 2) + (voice && GENDER.get(s.artist) !== voice ? 1 : 0), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([s]) => s.artist), // ジャンル・作品のお題では、そのお題の曲だけ
  ]);
  for (const a of candidates) {
    if (picks.length >= count - 1) break;
    if (!a || seen.has(artistKey(a))) continue;
    seen.add(artistKey(a)); picks.push(a);
  }
  const choices = shuffle([song.artist, ...picks]).map(a => ({ title: a, work: '' }));
  return { choices, correctIndex: choices.findIndex(c => c.title === song.artist) };
}
// アウトロ問題の流し始め：曲の終わりの少し前（サビへ移るまで流れきらないように）。長さが分からない曲は「どこから？」と同じ
function outroStart(song, hintAt) {
  const dur = DURATIONS.get(song.id);
  if (!dur) return randomStart(song);
  return Math.max(song.intro || 0, Math.round(dur - Math.max(15, hintAt + 3)));
}
// 再生速度：ランダムは1問ごとに選ぶ
const SPEEDS = [0.5, 0.75, 1.5, 2];
const speedOf = S => (S.speed === 'random' ? SPEEDS[crypto.randomInt(SPEEDS.length)] : Number(S.speed) || 1);

// ── ビンゴ：4×4 の作品名カード。このゲームで出る作品を中心に入れる（足りないぶんは FREE を最大4つ、残りはほかの作品） ──
const BINGO_N = 4;
const BINGO_BONUS = 3000;      // 最初にそろったときのボーナス
const BINGO_LINE_BONUS = 1000; // そのあと、そろった列が増えるたびのボーナス
// シリーズ（data/franchises.json）があれば、ビンゴのマスはシリーズ名でまとめる（「機動武闘伝Gガンダム」も「∀ガンダム」も「ガンダム」のマス）
let FRANCHISE_OF = new Map();
try { for (const [name, f] of Object.entries(require('./data/franchises.json'))) for (const w of f.works || []) if (!FRANCHISE_OF.has(w)) FRANCHISE_OF.set(w, name); } catch (e) { /* なくても動く */ }
const workKey = w => (FRANCHISE_OF.has(w) ? 'fr:' + FRANCHISE_OF.get(w) : seriesKey(seriesName(w)));
const bingoLabel = w => FRANCHISE_OF.get(w) || seriesName(w);
// ビンゴの終わり（設定 bingoEnd）：p〇＝〇人がBINGOした／l〇＝だれかが〇ビンゴ（そろった列の数）／all＝問題数まで
function bingoOver(room) {
  const e = room.settings.bingoEnd || 'p1', n = Number(e.slice(1));
  const ps = [...room.players.values()];
  if (e[0] === 'p') return ps.filter(p => p.bingoAt).length >= n;
  if (e[0] === 'l') return ps.some(p => (p.bingoLinesN || 0) >= n);
  return false;
}
// リーチ：あと1マスでそろう列の数
function bingoReach(card) {
  const N = BINGO_N, o = i => card[i].open, lines = [];
  for (let r = 0; r < N; r++) lines.push([...Array(N).keys()].map(c => r * N + c));
  for (let c = 0; c < N; c++) lines.push([...Array(N).keys()].map(r => r * N + c));
  lines.push([...Array(N).keys()].map(i => i * N + i), [...Array(N).keys()].map(i => i * N + N - 1 - i));
  return lines.filter(l => l.filter(o).length === N - 1).length;
}
// ビンゴのマス：答えるものに合わせる（曲名 → 曲名のマス、作品 → シリーズ名のマス、歌手 → 歌手名のマス、年 → 年のマス）
function bingoCell(song, target) {
  if (target === 'song') return { w: song.title, k: 's:' + seriesKey(song.title) };
  if (target === 'artist') return { w: song.artist, k: 'a:' + artistKey(song.artist) };
  if (target === 'year') return { w: `${song.year}年`, k: 'y:' + song.year };
  return { w: bingoLabel(song.work), k: workKey(song.work) };
}
function bingoCard(order, pool, target = 'work') {
  const uniq = (list, seen) => list.map(s => bingoCell(s, target)).filter(c => { if (!c.w || seen.has(c.k)) return false; seen.add(c.k); return true; });
  const seen = new Set();
  const real = uniq(shuffle([...order]), seen).slice(0, BINGO_N * BINGO_N - 2);
  const free = Math.min(4, BINGO_N * BINGO_N - real.length);
  const others = uniq(shuffle([...pool]), seen).slice(0, BINGO_N * BINGO_N - real.length - free);
  const cells = [...real, ...others].map(c => ({ ...c, open: false }))
    .concat(Array.from({ length: free }, () => ({ w: 'FREE', k: '', open: true })));
  while (cells.length < BINGO_N * BINGO_N) cells.push({ w: 'FREE', k: '', open: true });
  // 配った時点でそろっている列がないように並べ直す
  for (let i = 0; i < 50; i++) { shuffle(cells); if (bingoLines(cells) === 0) break; }
  return cells;
}
function bingoLines(card) {
  const N = BINGO_N, o = i => card[i].open;
  let n = 0;
  for (let r = 0; r < N; r++) if ([...Array(N).keys()].every(c => o(r * N + c))) n++;
  for (let c = 0; c < N; c++) if ([...Array(N).keys()].every(r => o(r * N + c))) n++;
  if ([...Array(N).keys()].every(i => o(i * N + i))) n++;
  if ([...Array(N).keys()].every(i => o(i * N + N - 1 - i))) n++;
  return n;
}

// 年代当ての選べる年：部屋の年代設定の範囲（今年より先は出さない）
function yearRange(S, song) {
  const lo = Math.min(S.yearFrom, song.year), hi = Math.max(Math.min(S.yearTo, new Date().getFullYear()), song.year);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

// 選択肢は「出題曲に年が近い曲」→「同じ年代設定の曲」→「それ以外の曲」→「ダミー」の順に選ぶ。
// 年代がばらばらだと、知らなくても消去法で当たってしまうため。
// 選択肢は、正解と「同じ種類」のものを先に選ぶ（J-POP の問題に J-POP が1つだけ、アニメの問題にボカロが1つだけ…で、種類で消去法ができないように）。
// 優先：①同じ種類（アニメ／ボカロ／J-POP／パチスロ曲）→ ②同じジャンルがある → ③近い年代。足りないときだけ、ほかのものでうめる
const KIND_KEYS = ['vocaloid', 'jpop', 'slot'];
const kindOf = s => { const g = genresOf(s); return g.includes('vocaloid') ? 'v' : g.includes('jpop') ? 'j' : g.includes('slot') ? 's' : 'a'; };
function similarFirst(song, list, near) {
  const k = kindOf(song), gs = genresOf(song).filter(x => !KIND_KEYS.includes(x) && !['pachislot', 'lol'].includes(x));
  const score = s => (kindOf(s) === k ? 0 : 8) + (!gs.length || genresOf(s).some(x => gs.includes(x)) ? 0 : 2) + (near(s) ? 0 : 1);
  return list.map(s => [s, score(s)]).sort((a, b) => a[1] - b[1]).map(x => x[0]); // 同じ点どうしは、並べ替え前（ランダム）の順のまま
}
function buildChoices(song, count, pool) {
  const near = s => Math.abs(s.year - song.year) <= NEAR_YEARS;
  const toChoice = s => ({ title: s.title, work: s.work });
  const others = SONGS.filter(s => s !== song && !choiceBlocked(s, pool)); // 除外したジャンルの曲は、選択肢にも出さない
  const candidates = [
    ...similarFirst(song, [...shuffle(pool.filter(s => s !== song)), ...(pool.strict ? [] : shuffle(others.filter(s => !pool.includes(s))))], near).map(toChoice), // ジャンル・作品のお題では、そのお題の曲だけ
    ...(pool.strict ? [] : shuffle(DECOYS.map(([title, work]) => ({ title, work })))),
  ];
  const seen = new Set([normText(song.title)]);
  const picks = [];
  for (const c of candidates) {
    if (picks.length >= count - 1) break;
    if (seen.has(normText(c.title))) continue;
    seen.add(normText(c.title)); picks.push(c);
  }
  const choices = shuffle([{ title: song.title, work: song.work }, ...picks]);
  return { choices, correctIndex: choices.findIndex(c => c.title === song.title) };
}

// ── 3つ埋めバトル：1曲ごとに「曲名・アニメ名・アーティスト」（ボカロは「曲名・作者・VOCALOID」）の枠を、早押しで埋める ──
const FILL_CHOICES = 10;   // 10択で答えるときの選択肢の数（10択は点数が半分）
const FILL_BUZZ_SEC = 20;  // 押した人が枠を選んで答えられる秒数
const FILL_LOCK_SEC = 5;   // 間違えた人が押せない秒数
const AUTO_FILL = '__auto__'; // 最初から埋まっている枠（ボーカルなし）の埋めた人
const VOCAL_COMBOS = ['ミク×リン', 'ミク×ルカ', 'リン×レン', 'ミク×GUMI', 'ミク×KAITO', 'GUMI×IA', 'ルカ×MEIKO'];
const VOCALS = ['初音ミク', '鏡音リン', '鏡音レン', '巡音ルカ', 'GUMI', 'IA', 'v flower', 'KAITO', 'MEIKO', '歌愛ユキ', '重音テト', '可不'];
// ボカロの作者：作品欄「ボカロ（ryo）」のカッコの中。プロセカの書き下ろし（ボカロ（プロセカ））は、作曲者（歌手の欄に入れてある）
const authorOf = s => { const a = String(s.work || '').normalize('NFKC').match(/^ボカロ\((.+)\)$/)?.[1]; return a && a !== 'プロセカ' ? a : s.artist; };
// 選択肢を作る：正解 + ほかの候補から重ならないものを count-1 個
function fillChoices(correct, candidates, count, key = x => String(x).normalize('NFKC').toLowerCase()) {
  const seen = new Set([key(correct)]), picks = [];
  for (const c of candidates) {
    if (picks.length >= count - 1) break;
    if (!c || seen.has(key(c))) continue;
    seen.add(key(c)); picks.push(c);
  }
  const choices = shuffle([correct, ...picks]).map(t => ({ title: t, work: '' }));
  return { choices, correctIndex: choices.findIndex(c => c.title === correct) };
}
function buildFill(song, pool) {
  const title = buildChoices(song, FILL_CHOICES, pool);
  title.choices = title.choices.map(c => ({ title: c.title, work: '' })); // 作品名を出すとアニメ名の枠の答えになるので、曲名だけ
  const slot = (key, label, target, ch) => ({ key, label, target, choices: ch.choices, correctIndex: ch.correctIndex, by: null, given: null });
  if (song.type === 'ボカロ') {
    const vocaloids = (pool.strict ? pool : SONGS).filter(s => s.type === 'ボカロ' && s !== song);
    const slots = [slot('title', '曲名', 'title', title),
      slot('author', '作者', 'author', fillChoices(authorOf(song), shuffle(vocaloids.map(authorOf)), FILL_CHOICES))];
    if (song.vocal?.length) {
      // 2人以上（ミクとリンなど）で歌っている曲は「ミク×リン」のような組み合わせを正解の選択肢にする（歌っている1人ずつの選択肢も正解）。紛らわしい候補には、よくある組み合わせも混ぜる
      const combo = song.vocal.length >= 2 ? vocalCombo(song.vocal) : null;
      const decoys = [...VOCALS, ...VOCAL_COMBOS].filter(v => !song.vocal.includes(v) && v !== combo && !(combo && v.split('×').some(x => song.vocal.map(vocalShort).includes(x))));
      const ch = fillChoices(combo || song.vocal[0], shuffle(decoys), FILL_CHOICES);
      slots.push(slot('vocal', 'VOCALOID', 'vocal', ch));
    } else if (song.singer?.length) {
      // 本人が歌っている動画（米津玄師・Eve など）は、3つ目の枠を「歌手」にする
      const src = (pool.strict ? pool : SONGS).filter(s => s !== song), same = shuffle(src.filter(s => kindOf(s) === kindOf(song))), rest = shuffle(src.filter(s => kindOf(s) !== kindOf(song)));
      const names = [...new Set([...same.flatMap(s => s.singer?.length ? s.singer : [s.artist]), ...rest.map(s => s.artist)])]; // 同じ種類（ボカロ）の歌手を先に
      const ch = fillChoices(song.singer[0], [...sameVoiceFirst(song.singer[0], names.slice(0, Math.max(30, same.length)))], FILL_CHOICES);
      slots.push(slot('singer', '歌手', 'singer', ch));
    } else {
      // ボーカルも歌手も分からない曲：3つ目の枠は最初から「ボーカルなし」で埋まっている（押せない・点数なし）
      const s3 = slot('vocal', 'VOCALOID', 'vocal', { choices: [{ title: 'ボーカルなし', work: '' }], correctIndex: 0 });
      s3.by = AUTO_FILL; s3.given = 'ボーカルなし'; s3.auto = true;
      slots.push(s3);
    }
    return slots;
  }
  return [slot('title', '曲名', 'title', title),
    slot('work', 'アニメ名', 'work', buildWorkChoices(song, FILL_CHOICES, pool)),
    slot('artist', 'アーティスト', 'artist', buildArtistChoices(song, FILL_CHOICES, pool))];
}
// 画面に出す枠（正解の番号は出さない）
function fillPublic(room, q) {
  if (!q?.fill) return null;
  return q.fill.map(f => ({ key: f.key, label: f.label, choices: f.choices.map(c => c.title), peeked: !!f.peeked, removed: [...(f.removed || [])],
                            by: f.by ? room.players.get(f.by)?.name || '' : null, given: f.given,
                            team: f.by && room.settings.teams ? room.players.get(f.by)?.team || null : null })); // チーム戦：埋めたチームの色
}
// 曲が終わるまでの秒数（サビへ移動してから最後まで）。長さが分からない曲は 3 分
function fillTotal(q, hintAt) {
  const dur = DURATIONS.get(q.song.id);
  const sec = !dur ? 180 : q.kind === 'sabimae' ? dur - q.start : hintAt + (dur - chorusOf(q.song));
  return Math.max(hintAt + 20, sec / (q.speed || 1));
}

function nextQuestion(room) {
  clearTimers(room);
  const g = room.game;
  if (g.pokerBet) return; // 賭けのオープン中は進めない
  if (g.panelPick) return; // 陣取りでパネルを選んでいる間は進めない
  if (g.gz?.pick) return; // ジャンル制覇で次のジャンルを選んでいる間は進めない
  if (g.dkShop) return; // デッキ構築のショップ中は進めない
  if (room.settings.play === 'deck' && g.qi >= 0 && ((g.qi + 1) % DK_EVERY === 0 || g.qi + 1 >= g.order.length) && g.dkShopAt !== g.qi) return startDkShop(room); // 3問ごと＋最後の問題のあと（必ず）
  if (room.settings.play === 'poker') {
    pokerAutoDiscard(room);
    if (g.qi >= 0 && (g.qi + 1) % POKER_BET_EVERY === 0 && g.qi + 1 < g.order.length && g.pokerBetAt !== g.qi && !survivalOver(room)) return startPokerBet(room);
  }
  // 終わり：全部出した、またはサバイバルで残りがいなくなった（qi は最後に出した問題のまま）
  if (isGz(room.settings.play) && !g.gzDone && g.qi + 1 >= g.order.length && g.order.length < GZ_HARD_MAX) { // 続ける：曲を足す（実際の曲は gzPrepare が、そのときの種類から選び直す）
    const more = shuffle((g.pool.length ? g.pool : SONGS).slice()).slice(0, 20); g.order.push(...(more.length ? more : shuffle(SONGS.slice()).slice(0, 20)));
  }
  if (g.qi + 1 >= g.order.length || survivalOver(room) || g.bingoDone || g.panelDone || g.nenpyoDone || g.sgDone || g.gzDone) return endGame(room); // ビンゴは設定した人数・ビンゴ数で終わり（問題数までも選べる）
  g.qi++;
  if (room.settings.play === 'picker') return startPicking(room);
  if (room.settings.play === 'wolf') return startWolfRound(room, g.order[g.qi]);
  if (room.settings.play === 'dixit') return startDixitRound(room, g.order[g.qi]);
  if (room.settings.play === 'dentatsu') return startDentatsuRound(room, g.order[g.qi]);
  if (room.settings.play === 'baba') return startBabaRound(room, g.order[g.qi]);
  if (room.settings.play === 'codenames') return startCodenamesRound(room, g.order[g.qi]);
  if (isGz(room.settings.play)) gzPrepare(room);
  if (room.settings.play === 'daifugo') return startDaifugoRound(room, g.order[g.qi]);
  if (room.settings.play === 'wits') return startWitsRound(room, g.order[g.qi]);
  if (room.settings.play === 'kaerema') return startKaeremaRound(room, g.order[g.qi]);
  if (room.settings.play === 'azul') return startAzulRound(room, g.order[g.qi]);
  startQuestion(room, g.order[g.qi]);
}

// ── 出題者モード：順番に1人が収録曲から1曲選ぶ（30秒。時間切れ・抜けたら最初に引いておいた曲）。出題者は答えない ──
const PICK_SEC = 30;
function startPicking(room) {
  const g = room.game, ps = connectedPlayers(room);
  const p = ps[g.qi % ps.length];
  g.q = { phase: 'picking', picker: p.token, pickUntil: Date.now() + PICK_SEC * 1000, song: null,
          participants: new Set(), answers: new Map(), ready: new Set(), clues: [], lifelineResults: new Map() };
  io.to(room.code).emit('picking', pickingPayload(room));
  later(room, () => finishPick(room, null), PICK_SEC * 1000);
  broadcastRoom(room);
}
function pickingPayload(room) {
  const g = room.game, q = g.q, p = room.players.get(q.picker);
  return { id: p?.id, name: p?.name, sec: Math.max(0, (q.pickUntil - Date.now()) / 1000), qNo: g.qi + 1, qTotal: g.order.length };
}
function finishPick(room, id) {
  const g = room.game, q = g?.q;
  if (!q || q.phase !== 'picking') return;
  clearTimers(room);
  const done = new Set(g.order.slice(0, g.qi).map(s => s.id));
  const chosen = typeof id === 'string' ? [...SONGS, ...STAGED].find(s => s.id === id && !done.has(s.id)) : null;
  const drawn = g.order[g.qi];
  if (chosen && chosen !== drawn) {
    const later_ = g.order.indexOf(chosen); // 後で出す予定だった曲を選んだら、その枠と入れ替える
    if (later_ > g.qi) g.order[later_] = drawn;
    g.order[g.qi] = chosen;
    if (!room.settings.noRecord && later_ < 0) { unrecordPlayed(room, drawn); recordPlayed(room, chosen); }
  }
  if (!chosen) io.to(room.code).emit('notice', '出題者が選ばなかったので、ランダムに選んだ曲を出します');
  startQuestion(room, g.order[g.qi], q.picker);
}

function startQuestion(room, song, picker = null) {
  statsPlay(room, song);
  const g = room.game;
  const S = room.settings;
  // ミックスでも、サビの位置が仮の曲はイントロで出す
  let kind = S.quizType === 'mix' ? (hasChorus(song) && crypto.randomInt(2) ? 'sabimae' : 'intro') : S.quizType;
  // 歌詞クイズ：その曲で作れる種類から（流す問題は時刻が合う曲だけ。作れなければ「この歌詞の曲は？」）
  let lyq = null;
  if (S.play === 'lyrics' && room.lyricsOk) {
    const want = S.lyKind === 'mix' ? shuffle(['which', 'blank', 'next']) : [S.lyKind, 'which'];
    for (const k of want) { lyq = lyricQuestion(k, song, Math.min(S.choices || 4, 8), g.pool); if (lyq) { kind = 'ly-' + k; break; } }
  }
  const ly = LYRIC_KINDS.includes(kind) ? lyricStart(song, kind, S) : null;
  if (LYRIC_KINDS.includes(kind) && !ly) kind = 'intro'; // 歌詞の時刻がない曲はイントロで
  // サビ前問題は「サビ − leadSec 秒」から流す（イントロより前にはしない）。「どこから」は曲の途中のどこか
  const start = lyq ? (lyq.play ? lyq.play.from : song.intro || 0) : ly ? ly.start : kind === 'sabimae' ? Math.max(song.intro || 0, chorusOf(song) - S.leadSec)
              : kind === 'random' ? randomStart(song) : kind === 'outro' ? outroStart(song, S.hintAt) : (song.intro || 0);
  // 答えるもの：年 → 年を選ぶ／作品 → 作品名の選択肢（入力なら作品名だけ正解）／曲名 → いつもの選択肢
  const years = S.target === 'year' ? yearRange(S, song) : null;
  g.pool.strict = !['all', 'multi'].includes(S.topic || 'all'); // ジャンル・作品のお題では、選択肢もそのお題の曲だけから作る
  if (isGz(S.play)) g.pool.ex = []; // ジャンル制覇は、出題しないジャンルに入っている種類（ボカロ・J-POP など）が選ばれることがある。選択肢はその種類の曲から作るので、除外はかけない
  // ジャンル制覇：いまのジャンル（種類）はみんなに見えているので、選択肢もそのジャンルの曲から作る（そのジャンルの曲が正解だけで浮かないように）
  let cpool = g.pool;
  if (isGz(S.play) && g.gz?.cur) {
    const cat = gzCatOf(g.gz, g.gz.cur), ctxC = userCtx(room);
    const need = Math.max(S.choices || 8, 8) * 2, inPool = cat ? g.pool.filter(s => cat.test(s) && !ctxC.block.has(s.id)) : [];
    const cp = inPool.length >= need ? inPool : cat ? SONGS.filter(s => cat.test(s) && !ctxC.block.has(s.id)) : []; // 部屋の曲の範囲から。足りなければ全曲から
    if (cp.length >= need) { cp.strict = true; cp.ex = []; cpool = cp; }
  }
  const input = S.answerMode === 'input' && !years;
  const { choices, correctIndex } = lyq ? { choices: lyq.choices, correctIndex: lyq.correctIndex } // 歌詞クイズ
    : S.play === 'nenpyo' ? { choices: null, correctIndex: null } // 年表は置く場所を選ぶ
    : S.play === 'karuta' ? karutaChoices(room, song) // かるたは場に並べた16枚の札
    : S.play === 'fill' ? { choices: null, correctIndex: null } // 3つ埋めバトルは枠ごとの選択肢（buildFill）
    : years ? { choices: null, correctIndex: years.indexOf(song.year) }
    : input ? { choices: null, correctIndex: null }
    : S.target === 'work' ? buildWorkChoices(song, S.choices, cpool)
    : S.target === 'artist' ? buildArtistChoices(song, S.choices, cpool)
    : buildChoices(song, S.choices, cpool);
  g.q = {
    attack: S.play === 'panel' && !!g.panel && g.attackCell != null && g.qi === g.attackQi, // アニソン陣取り：20問目のあと白いマスができた、次の問題が「アタックチャンス」
    song, choices, correctIndex, kind, start, years, introLen: lyq ? (lyq.play ? Math.max(2, lyq.play.until - lyq.play.from) : 0.1) : ly?.len || null, lyric: lyq?.lyric || null, // introLen：歌詞の一行だけの問題は、その行の長さ
    phase: 'loading', t0: 0,
    rush: g.rushPlan?.[g.qi] || null, // 激アツRUSH：この問題の保留の色と当たり
    ready: new Set(),
    answers: new Map(), // token -> { index, given, pass, elapsed, correct, points, hint }
    participants: new Set(connectedPlayers(room).filter(p => !p.out && p.token !== picker && !(S.play === 'karuta' && p.karutaRest === g.qi)).map(p => p.token)), // 脱落した人・出題者・かるたのお手つきで1回休みの人は見ているだけ
    picker, speed: speedOf(S),
    locked: new Set(),  // 早押し：この問題ではもう押せない人（お手つき・パス）
    buzz: null,         // 早押し：いま答えている人 { token, elapsed, until }
    winner: null,
    clues: [],          // 出したヒント（再接続した人に送り直す）
    lifelineResults: new Map(), // token -> [{ type, ... }]（再接続した人に送り直す）
    // 3つ埋めバトル：枠・答えた記録・間違えて押せない人（token → いつまで）・パスした人
    fill: S.play === 'fill' ? buildFill(song, g.pool) : null, fillLog: [], fillLock: new Map(), fillPass: new Set(),
    fillWait: new Set(), // 連続解答なし：間違えて、ほかの人が押すのを待っている人
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
    qNo: g.qi + 1, qTotal: g.order.length, endless: isGz(room.settings.play), // endless：全部そろうまで続く（問題数なし）
    videoId: q.song.id, intro: LYRIC_KINDS.includes(q.kind) || q.kind?.startsWith('ly-') ? q.start : q.song.intro || 0, start: q.start, kind: q.kind,
    lyric: q.lyric || null, // 歌詞クイズの歌詞（非公開の部屋の人にだけ）
    final: room.settings.bonus && isFinalQuestion(room),
    attack: !!q.attack,
    answerMode: room.settings.play === 'lyrics' ? 'choice' : room.settings.play === 'nenpyo' ? 'nenpyo' : q.years ? 'year' : room.settings.answerMode === 'input' && room.settings.play !== 'karuta' ? 'input' : 'choice',
    rest: room.settings.play === 'karuta' ? [...room.players.values()].filter(p => p.karutaRest === g.qi).map(p => p.id) : null, // かるた：お手つきで1回休みの人
    choices: q.choices, years: q.years, settings: room.settings,
    play: room.settings.play, target: room.settings.target, speed: q.speed || 1,
    pickerId: q.picker ? room.players.get(q.picker)?.id : null, pickerName: q.picker ? room.players.get(q.picker)?.name : null,
    fill: fillPublic(room, q),
    rush: q.rush ? { color: q.rush.color } : null, // 当たりかどうかは、リーチ（サビ）まで伏せる
  };
}

// 時間で増えるヒント：サビに入ってから 年 → 歌手 → 作品名の頭文字
// 答えるものが年・作品のときは、答えそのものになるヒント（年・作品の頭文字）は出さない
function clueList(song, target = 'song') {
  const work = shortForm(String(song.work).replace(/^(劇場版|映画)\s*/, '')).replace(/^[【「『\[（(<〈]+/, '');
  return [
    { level: 1, label: '年', text: `${song.year}年の曲` },
    { level: 2, label: '歌手', text: song.artist },
    { level: 3, label: '作品', text: `「${[...work][0]}」から始まる作品` },
  ].filter(c => !(target === 'year' && c.label === '年') && !(target === 'work' && c.label === '作品') && !(target === 'artist' && c.label === '歌手'));
}

// 出題中に再接続した人へ、いまの問題と進み具合を送り直す
function resendQuestion(room, socket, token) {
  const q = room.game?.q;
  if (q?.km) return socket.emit('kmPhase', kmPublic(room));
  if (q?.az) return socket.emit('azPhase', azPublic(room));
  if (q?.ww) { if (q.ww.step === 'guess') socket.emit('wolfSong', { videoId: q.song.id, start: q.song.intro || 0, sec: Math.max(3, Math.ceil((q.ww.until - Date.now()) / 1000) - 8) }); return socket.emit('wwPhase', wwPublic(room)); }
  if (q?.df) { const p = room.players.get(token); if (p && q.participants.has(token)) socket.emit('dfHand', dfHandOf(room, token)); return socket.emit('dfPhase', dfPublic(room)); }
  if (q?.cn) { const p = room.players.get(token); if (p && q.participants.has(token)) { socket.emit('cnPhase', cnPublic(room)); if (q.cn.spy.red === token || q.cn.spy.blue === token) socket.emit('cnKey', { key: q.cn.key }); } return; }
  if (q?.bb) { const p = room.players.get(token); if (p && q.participants.has(token)) socket.emit('bbHand', bbHandOf(room, token)); return socket.emit('bbPhase', bbPublic(room)); }
  if (q?.dt) { const p = room.players.get(token); if (p) { socket.emit('dtPhase', dtPublic(room, token)); if (token === q.dt.teller && q.dt.step === 'tell') socket.emit('wolfSong', { videoId: q.song.id, start: q.song.intro || 0, sec: DT_PLAY }); } return; }
  if (q?.dx) { const p = room.players.get(token); if (p && q.participants.has(token)) socket.emit('dixitHand', dixitHandOf(room, token)); return socket.emit('dixitPhase', dixitPublic(room)); }
  if (q?.wolf) { const p = room.players.get(token); if (p && q.participants.has(token) && q.wolf.step === 'listen') socket.emit('wolfSong', wolfSongPayload(room, p)); return socket.emit('wolfPhase', wolfPublic(room)); }
  if (q?.phase === 'picking') return socket.emit('picking', pickingPayload(room));
  if (!q || (!q.participants.has(token) && q.picker !== token) || q.phase === 'reveal') return; // 出題者は答えないが、問題は見られるように送り直す
  const S = room.settings;
  if (S.play === 'poker') sendPokerHand(room, room.players.get(token));
  socket.emit('question', questionPayload(room));
  if (q.phase === 'intro' || q.phase === 'chorus') {
    const offset = ((q.frozen || Date.now()) - q.t0) / 1000; // 答えている間で止めているときは、止めた時点まで
    socket.emit('go', { intro: LYRIC_KINDS.includes(q.kind) || q.kind?.startsWith('ly-') ? q.start : q.song.intro || 0, start: q.start, kind: q.kind, hintAt: q.hintAt || S.hintAt,
                        total: q.total || questionTotal(S), offset, introLen: S.introLen, plays: q.plays || 1, gap: INTRO_GAP, speed: q.speed || 1, t0: q.frozen ? null : q.t0 });
    if (q.phase === 'chorus' && !q.flowOn) socket.emit('hint', { chorus: chorusOf(q.song), known: q.song.chorus > 0, intro: q.song.intro || 0, seek: q.kind !== 'sabimae' });
    if (q.phase === 'chorus' && q.rush?.hit) socket.emit('rushReach', { color: q.rush.color, again: true });
    if (q.flowOn) socket.emit('flowOn', { total: q.total }); // イントロ中に押されて流し続けになっている
  }
  q.clues.forEach(c => socket.emit('clue', c));
  // パスの下の記録（全員に見せたもの＋自分の答え。ふつうは正解かどうかを伏せたまま）
  (q.qlog || []).filter(e => !e.token || e.token === token)
    .forEach(({ token: t, ...e }) => socket.emit('qlog', t && e.result !== 'almost' ? { ...e, result: null } : e));
  (q.lifelineResults.get(token) || []).forEach(r => socket.emit('lifelineResult', r));
  const a = q.answers.get(token);
  if (a) socket.emit('answered', { index: a.index, given: a.given, pass: a.pass });
  if (q.buzz) { const b = room.players.get(q.buzz.token); socket.emit('buzz', { id: b?.id, name: b?.name, sec: Math.max(0, (q.buzz.until - Date.now()) / 1000) }); }
  if (q.buzzQueue?.length) socket.emit('buzzQueue', { ids: q.buzzQueue.map(e => room.players.get(e.token)?.id), names: queueNames(room, q) });
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
const flowing = kind => kind === 'sabimae' || kind === 'random' || kind === 'outro'; // 止めずに流し続ける問題（サビ前・どこから・アウトロ）
const introPlaysOf = (S, kind) => (flowing(kind) ? 1 : (S.introPlays || 1));
function hintAtOf(S, kind) {
  const n = introPlaysOf(S, kind);
  // 最後のイントロのあとは 1.5 秒あけてからサビへ
  return n <= 1 ? S.hintAt : Math.max(S.hintAt, n * S.introLen + (n - 1) * INTRO_GAP + 1.5);
}

function chorusOf(song) { return song.chorus > 0 ? song.chorus : (song.intro || 0) + 50; }

const COUNTDOWN = 3; // ゲームの最初の問題だけ「3・2・1・START!」を入れる（秒）
function go(room) {
  const q = room.game.q;
  if (q.phase !== 'loading') return;
  clearTimers(room);
  if (room.game.qi === 0 && !q.countdownDone) {
    q.countdownDone = true;
    q.phase = 'countdown'; // カウントダウン中は「準備できた」の合図などで先に進まないように
    io.to(room.code).emit('countdown', { sec: COUNTDOWN });
    // ここで later を使うと、この関数の下で宣言している別の later（LEAD_MS 足し）より前なのでエラーになり、サーバーが落ちる。外側の laterAt を使う
    laterAt(room, () => { if (q.phase === 'countdown') { q.phase = 'loading'; go(room); } }, COUNTDOWN * 1000);
    return;
  }
  const S = room.settings;
  q.phase = 'intro';
  // 選択肢を見てから1秒後に曲が流れ始める。時間・得点の計算もそこから
  q.t0 = Date.now() + LEAD_MS;
  // 途中で設定が変わっても、この問題は始めた時の設定で進める
  const plays = introPlaysOf(S, q.kind), hintAt = hintAtOf(S, q.kind);
  q.hintAt = hintAt; q.plays = plays; q.total = q.fill ? fillTotal(q, hintAt) : questionTotal(S, hintAt); // 3つ埋めバトルは曲が終わるまで
  const sabimae = flowing(q.kind);
  const iLen = q.introLen || S.introLen; // 歌詞の一行だけの問題は、その行の長さ
  io.to(room.code).emit('go', { intro: LYRIC_KINDS.includes(q.kind) || q.kind?.startsWith('ly-') ? q.start : q.song.intro || 0, start: q.start, kind: q.kind, hintAt, total: q.total, offset: -LEAD_MS / 1000,
                                introLen: iLen, plays, gap: INTRO_GAP, speed: q.speed || 1, t0: q.t0 }); // t0：時計合わせ済みの端末は、この時刻ちょうどに流し始める
  const later = (r, fn, ms) => laterAt(r, fn, ms + LEAD_MS);
  // サビ前問題は止めずに流し続ける。イントロは introLen 秒で止め、回数の設定があれば少し空けて頭から流し直す
  if (!sabimae) {
    for (let i = 0; i < plays; i++) {
      const at = i * (iLen + INTRO_GAP);
      if (i > 0) later(room, () => { if (q.phase === 'intro' && !q.flowOn) io.to(room.code).emit('restartIntro', { n: i + 1, plays }); }, at * 1000);
      if (at + iLen < hintAt) later(room, () => { if (q.phase === 'intro' && !q.flowOn) io.to(room.code).emit('stopIntro'); }, (at + iLen) * 1000);
    }
  }
  if (q.rush?.omens?.length) { // 激アツRUSH：予兆（全員に同じ時刻で出す。当たりかどうかは伏せたまま）
    for (const o of q.rush.omens) later(room, () => { if (q.phase === 'intro') io.to(room.code).emit('rushOmen', { kind: o.kind, lv: o.lv, step: o.step }); }, o.f * hintAt * 1000);
  }
  later(room, () => {
    if (q.phase !== 'intro') return;
    q.phase = 'chorus';
    if (q.kind?.startsWith('ly-')) return broadcastRoom(room); // 歌詞クイズはサビへ移らない
    // 3つ埋めバトル：イントロ中に押されて流し続けている曲は、まだサビまで来ていなければサビへ移る（もう過ぎていればそのまま）
    if (q.flowOn) { io.to(room.code).emit('hint', { chorus: chorusOf(q.song), known: q.song.chorus > 0, intro: q.song.intro || 0, seek: q.kind !== 'sabimae', flow: true }); return broadcastRoom(room); }
    io.to(room.code).emit('hint', { chorus: chorusOf(q.song), known: q.song.chorus > 0, intro: q.song.intro || 0, seek: q.kind !== 'sabimae' }); // どこから問題はサビへ移動する
    if (q.rush?.hit) io.to(room.code).emit('rushReach', { color: q.rush.color }); // 激アツRUSH：当たりの問題は「リーチ！」
    broadcastRoom(room);
  }, hintAt * 1000);
  if (S.clues && !q.fill) { // 3つ埋めバトルは、ヒント（年・歌手・作品の頭文字）が枠の答えになるので出さない
    // ビンゴは頭文字のヒント（「〇」から始まる作品）を出さない（カードのマスがすぐ分かってしまうので）
    clueList(q.song, S.target).filter(c => !(S.play === 'bingo' && c.label === '作品') && !(S.play === 'nenpyo' && c.label === '年') && !(S.play === 'karuta' && ((S.karutaFace === 'work' && c.label === '作品') || (S.karutaFace === 'artist' && c.label === '歌手')))).forEach((c, i) => later(room, () => {
      if (q.phase !== 'intro' && q.phase !== 'chorus') return;
      q.clues.push(c);
      io.to(room.code).emit('clue', c);
    }, (hintAt + S.chorusLen * i / 3) * 1000));
  }
  later(room, () => revealAtEnd(room, q), q.total * 1000); // 押して答えている最中なら、答え終わるまで待つ
  broadcastRoom(room);
}

// payload は { index }（選択肢）/ { text }（入力）/ { year }（年代当て）/ { pass: true }（わからない）
// 早押しでは、押して答える権利を取った人だけが答えられる。{ timeout }・{ drop } はサーバーの中から（時間切れ・答える人が抜けた）
function onAnswer(room, player, payload) {
  const q = room.game?.q;
  if (!q || (q.phase !== 'intro' && q.phase !== 'chorus') || room.game.paused) return;
  if (q.fill) return onFillAnswer(room, player, payload);
  if (!q.participants.has(player.token) || q.answers.has(player.token)) return;

  const S = room.settings;
  const buzzer = S.play === 'buzzer', holder = q.buzz?.token === player.token;
  if (buzzer && !holder && payload?.pass !== true) return; // 押していない人は答えられない（パスで「この問題は押さない」はできる）
  let index = null, given = null, pass = false, correct = false, diff = null, miss = false;
  if (payload?.timeout === true && holder) {
    given = '時間切れ'; miss = true;
  } else if (payload?.drop === true && holder) {
    pass = true;
  } else if (payload?.pass === true) {
    pass = true; miss = buzzer && holder; // 押してから「わからない」はお手つき
  } else if (S.play === 'nenpyo') {
    const slot = payload?.slot, tl = player.timeline || [];
    if (!Number.isInteger(slot) || slot < 0 || slot > tl.length) return;
    correct = nenpyo.fits(tl.map(c => c.year), slot, q.song.year);
    given = `${slot > 0 ? tl[slot - 1].year : '…'}〜${slot < tl.length ? tl[slot].year : '…'}の間`;
    (q.nenpyoSlot = q.nenpyoSlot || new Map()).set(player.token, slot);
  } else if (q.years) {
    const y = payload?.year;
    if (!Number.isInteger(y) || !q.years.includes(y)) return;
    index = q.years.indexOf(y); given = `${y}年`;
    diff = Math.abs(y - q.song.year); correct = diff === 0;
  } else if (S.answerMode === 'input') {
    if (typeof payload?.text !== 'string') return;
    given = payload.text.trim().slice(0, 50);
    if (!given) return;
    correct = isCorrectText(given, q.song, S.target);
    // 惜しい（1文字ちがいなど）ときは回答にせず、本人にだけ知らせて打ち直してもらう（1問2回まで）
    if (!correct && isAlmostText(given, q.song, S.target)) {
      q.almost = q.almost || new Map();
      const n = q.almost.get(player.token) || 0;
      if (n < 2) {
        q.almost.set(player.token, n + 1);
        io.to(player.socketId).emit('almost', { text: given, left: 1 - n });
        qlog(room, player, { type: 'answer', how: 'text', text: given, result: 'almost' });
        return;
      }
    }
  } else {
    index = payload?.index;
    if (!Number.isInteger(index) || index < 0 || index >= q.choices.length) return;
    correct = index === q.correctIndex;
  }
  if (buzzer && holder && !correct && !pass) miss = true;
  if (Date.now() >= q.t0 && !(pass && payload?.drop)) {
    const how = pass ? 'pass' : index !== null ? 'choice' : 'text';
    qlog(room, player, { type: 'answer', how, result: pass ? 'pass' : correct ? 'ok' : 'ng',
                         text: pass ? 'パス' : index !== null ? (q.years ? `${q.years[index]}年` : q.choices[index]?.title) : given });
  }

  if (Date.now() < q.t0) return; // 曲が流れる前の回答は受け付けない
  // 早押しは押した時点の速さで点数を決める
  const elapsed = buzzer && holder ? q.buzz.elapsed : (Date.now() - q.t0) / 1000;
  const hint = q.phase === 'chorus';
  let points = 0;
  player.streak = correct ? (player.streak || 0) + 1 : 0;
  const streakBonus = p => (S.bonus && !(S.play === 'rush' && player.rush?.left > 0) ? Math.round(p * (player.streak >= 3 ? 1.5 : player.streak === 2 ? 1.2 : 1)) : p);
  if (q.years && diff !== null) {
    // 年代当て：近いほど高い（ぴったり1000、1年ずれ800…5年まで）。サビが流れてからは ×0.7
    points = YEAR_POINTS[diff] ?? 0;
    if (hint) points = Math.round(points * 0.7);
    if (correct) points = streakBonus(points);
    if (S.bonus && isFinalQuestion(room)) points *= 2;
  } else if (correct) {
    if (S.mode === 'score' || buzzer) {
      // 早いほど高い（500〜1000点）。サビ（ヒント）が流れてからの正解は ×0.7
      const base = Math.round(500 + 500 * Math.max(0, 1 - elapsed / (q.total || questionTotal(S))));
      points = streakBonus(hint ? Math.round(base * 0.7) : base); // 連続正解ボーナス：2連続 ×1.2、3連続以上 ×1.5
    } else if (!q.winner) {
      points = hint ? 1 : 2;
    }
    if (!q.winner) q.winner = player.token;
    if (S.bonus && isFinalQuestion(room)) points *= 2; // 最終問題は得点2倍
  } else if (miss) {
    points = -BUZZ_MISS; // 早押しのお手つき
  }
  let rushInfo = null;
  if (S.play === 'rush' && q.rush) { const o = rushApply(room, q, player, correct && !pass, points); points = o.points; rushInfo = o.info; (q.rushEvents = q.rushEvents || new Map()).set(player.token, rushInfo); }
  player.score += points;
  q.answers.set(player.token, { index, given, pass, elapsed, correct, points, hint, diff, miss, rush: rushInfo });
  const st = statsOf(room, player);
  if (correct && room.game.coop) room.game.coop.count++;
  if (correct && player.card) {
    const k = bingoCell(q.song, room.game.bingoTarget).k; // 答えるものに合わせたマス
    for (const c of player.card) if (c.k && c.k === k) c.open = true;
    // BINGO：ゲームは問題数まで続けて、そろったらボーナス点（最初のBINGOは BINGO_BONUS、そのあと列が増えるたびに BINGO_LINE_BONUS）
    const lines = bingoLines(player.card);
    if (lines > (player.bingoLinesN || 0)) {
      const more = lines - (player.bingoLinesN || 0);
      const bonus = player.bingoAt ? BINGO_LINE_BONUS * more : BINGO_BONUS + BINGO_LINE_BONUS * (more - 1);
      if (!player.bingoAt) player.bingoAt = room.game.qi + 1;
      player.score += bonus;
      const a = q.answers.get(player.token); if (a) a.points += bonus;
      (q.bingoBonus = q.bingoBonus || []).push({ name: player.name, bonus, first: player.bingoAt === room.game.qi + 1 && more === lines });
    }
    player.bingoLinesN = lines;
    // リーチ：あと1マスの列が増えたら、答え合わせでカットイン
    const reach = bingoReach(player.card);
    if (reach > (player.reachN || 0)) (q.reach = q.reach || []).push(player.name);
    player.reachN = reach;
  }
  if (correct) {
    st.correct++; st.time += elapsed;
    for (const k of genresOf(q.song)) st.genres[k] = (st.genres[k] || 0) + 1;
    if (hint) st.chorus++;
    if (q.song.year < 2000) st.retro++;
    if (q.song.year >= 2019) st.reiwa++;
    if (q.winner === player.token) st.first++; // その問題でいちばん最初に正解
    if (S.answerMode === 'input' && !q.years) st.typed++;
    st.maxStreak = Math.max(st.maxStreak, player.streak);
  }
  if (miss) st.miss++;
  if (pass && !payload?.drop) st.pass++;

  const remaining = [...q.participants].filter(t => room.players.get(t)?.connected && !q.answers.has(t));
  if (buzzer) {
    if (correct || remaining.length === 0) return reveal(room);
    if (holder) endBuzz(room); // 間違えた・時間切れ：曲を再開して、ほかの人が押せる
    return broadcastRoom(room);
  }
  if (S.play === 'karuta' && !correct && !pass) player.karutaRest = room.game.qi + 1; // かるたのお手つき：次の1問はお休み
  if ((S.mode === 'buzz' && q.winner && !q.years) || (S.play === 'karuta' && q.winner) || remaining.length === 0) reveal(room);
  else broadcastRoom(room);
}

// ── 出題中の記録（パスの下）：出た選択肢（左）と、選んだ・入力した答え（右） ──
// 早押し・3つ埋めバトルは順番に答えるので全員に見せる。ふつう（同時に答える）は答え合わせまで本人だけ（ほかの人の答えが見えないように）
function qlog(room, player, entry) {
  const q = room.game?.q;
  if (!q) return;
  const e = { ...entry, id: player.id, name: player.name };
  const open = ['buzzer', 'fill'].includes(room.settings.play) || entry.type === 'choices';
  q.qlog = q.qlog || [];
  q.qlog.push({ ...e, token: open ? null : player.token });
  // ふつうは、正解かどうかも答え合わせまで出さない（答え合わせで全員分をまとめて送る）
  if (open) io.to(room.code).emit('qlog', e); else io.to(player.socketId).emit('qlog', { ...e, result: e.result === 'almost' ? 'almost' : null });
}

// 3つ埋めバトルの回答：押した人が { slot, text } か { slot, index }（10択・点数半分）。{ pass } は押してから「やめる」（お手つき）
function onFillAnswer(room, player, payload) {
  const q = room.game.q, S = room.settings;
  if (q.buzz?.token !== player.token) return; // 押した人だけ
  const song = q.song;
  let slot = null, given = null, correct = false, choice = false;
  if (payload?.timeout === true || payload?.pass === true) {
    given = payload?.timeout ? '時間切れ' : 'わからない';
  } else if (payload?.drop === true) {
    endBuzz(room); return broadcastRoom(room); // 抜けた：減点なし
  } else {
    slot = q.fill.find(f => f.key === payload?.slot && !f.by);
    if (!slot) return;
    if (Number.isInteger(payload?.index)) {
      const c = slot.choices[payload.index];
      if (!c || slot.removed?.has(payload.index)) return; // お手つきで消えた選択肢は選べない
      choice = true; given = c.title;
      correct = payload.index === slot.correctIndex || (slot.key === 'vocal' && ((song.vocal || []).includes(c.title) || (song.vocal || []).map(vocalShort).includes(c.title) || isCorrectText(c.title, song, 'vocal')));
      if (!correct) (slot.removed = slot.removed || new Set()).add(payload.index); // 間違えた選択肢は、その枠の10択から消す（全員）
    } else {
      if (typeof payload?.text !== 'string' || slot.peeked) return; // 10択が出た枠は手で打てない
      given = payload.text.trim().slice(0, 50);
      if (!given) return;
      correct = isCorrectText(given, song, slot.target);
      // 惜しい（1文字ちがいなど）ときは回答にせず、本人にだけ知らせて打ち直してもらう（1つの押しで2回まで）
      if (!correct && isAlmostText(given, song, slot.target) && (q.buzz.almost || 0) < 2) {
        q.buzz.almost = (q.buzz.almost || 0) + 1;
        io.to(player.socketId).emit('almost', { text: given, left: 2 - q.buzz.almost, slot: slot.key });
        qlog(room, player, { type: 'answer', label: slot.label, how: 'text', text: given, result: 'almost' });
        return;
      }
    }
  }
  qlog(room, player, { type: 'answer', label: slot?.label || null, how: choice ? 'choice' : slot ? 'text' : 'pass', text: given, result: correct ? 'ok' : 'ng' });
  const elapsed = q.buzz.elapsed;
  const hint = elapsed >= (q.hintAt || S.hintAt);
  let points;
  if (correct) {
    // 早いほど高い（500〜1000点。サビまでの時間＋サビの長さで下がりきる）。サビに入ってからは ×0.7、10択は半分
    const span = (q.hintAt || S.hintAt) + S.chorusLen;
    points = Math.round(500 + 500 * Math.max(0, 1 - elapsed / span));
    if (hint) points = Math.round(points * 0.7);
    if (choice) points = Math.round(points / 2);
    if (S.bonus && isFinalQuestion(room)) points *= 2;
    const st = statsOf(room, player);
    if (!q.fill.some(f => f.by && !f.auto)) st.first++; // その曲でいちばん最初に枠を埋めた
    slot.by = player.token; slot.given = given;
    st.correct++; st.time += elapsed;
    if (hint) st.chorus++;
    if (song.year < 2000) st.retro++;
    if (song.year >= 2019) st.reiwa++;
    if (choice) st.choice++; else st.typed++;
    for (const k of genresOf(song)) st.genres[k] = (st.genres[k] || 0) + 1;
  } else {
    if (slot || payload?.timeout || payload?.pass) statsOf(room, player).miss++;
    points = -BUZZ_MISS; // お手つき：減点＋しばらく押せない
    // チーム戦はお手つきをチームで共有（同じチームの全員が押せない・待つ）
    const mates = S.teams && player.team ? [...room.players.values()].filter(p => p.team === player.team) : [player];
    for (const m of mates) {
      q.fillLock.set(m.token, Date.now() + (S.lockSec || FILL_LOCK_SEC) * 1000);
      if (S.noRepeat) q.fillWait.add(m.token); // 連続解答なし：ほかの人（チーム戦はほかのチーム）が押すまで待つ
      if (m.connected) io.to(m.socketId).emit('fillLock', { sec: S.lockSec || FILL_LOCK_SEC, wait: !!S.noRepeat, by: m === player ? null : player.name });
    }
  }
  player.score += points;
  q.fillLog.push({ token: player.token, slot: slot?.key || null, label: slot?.label || null, given, correct, choice, points, elapsed, hint });
  io.to(room.code).emit('fillResult', { id: player.id, name: player.name, slot: slot?.key || null, label: slot?.label || null,
                                        given, correct, choice, points });
  if (q.fill.every(f => f.by)) return reveal(room); // 全部埋まった
  endBuzz(room); // 曲を再開して、また誰でも押せる
  broadcastRoom(room);
}
// 3つ埋めバトル：全員（つながっている答える人）がパスしたら答え合わせ
function fillAllPassed(room, q) {
  const ps = [...q.participants].filter(t => room.players.get(t)?.connected);
  return ps.length > 0 && ps.every(t => q.fillPass.has(t));
}
function onFillPass(room, player, on) {
  const q = room.game?.q;
  if (!q?.fill || (q.phase !== 'intro' && q.phase !== 'chorus') || room.game.paused || !q.participants.has(player.token)) return;
  if (q.buzz?.token === player.token) return; // 答えている最中はパスにしない（「わからない」で）
  if (on && !q.fillPass.has(player.token)) statsOf(room, player).pass++;
  if (on && q.buzzQueue?.some(e => e.token === player.token)) { q.buzzQueue = q.buzzQueue.filter(e => e.token !== player.token); emitQueue(room, q); } // パスしたら順番待ちからも外す
  if (on) q.fillPass.add(player.token); else q.fillPass.delete(player.token);
  if (!q.buzz && fillAllPassed(room, q)) return reveal(room);
  broadcastRoom(room);
}

// ── 早押し：押した人がいたら、全員の曲と進行（イントロを止める・サビ・ヒント・時間切れ）を止めて、その人だけ答えられる ──
// 3つ埋めバトル：いま押せるか（間違えたあとの秒数・連続解答なし）
function fillCanBuzz(room, q, player) {
  if ((q.fillLock.get(player.token) || 0) > Date.now()) return false; // 間違えてから少しの間は押せない
  // 連続解答なし：間違えた人は、ほかの人が押すまで押せない（ほかに押せる人がいない＝全員パス・1人だけのときは押せる）
  // （チーム戦は同じチームの全員が待つので、「ほかに押せる人」は待っていない人＝ほかのチーム）
  return !(q.fillWait.has(player.token) &&
    [...q.participants].some(t => !q.fillWait.has(t) && room.players.get(t)?.connected && !q.fillPass.has(t)));
}
const queueNames = (room, q) => (q.buzzQueue || []).map(e => room.players.get(e.token)?.name).filter(Boolean);
// 順番待ちが変わるたびに全員へ送る（画面の「並んでいるので押せない」をサーバーの列と必ずそろえる）
const emitQueue = (room, q) => io.to(room.code).emit('buzzQueue', { ids: (q.buzzQueue || []).map(e => room.players.get(e.token)?.id), names: queueNames(room, q) });
// 早押しの回線補正：押した合図が届くまでの遅れ（往復の半分）を引いて、「押した時刻」を比べる。引きすぎないよう上限あり。
// 最初の合図が届いてから短い時間（BUZZ_WINDOW_MS）だけ待って、補正した時刻がいちばん早い人を先にする
const BUZZ_COMP_MAX = 120, BUZZ_WINDOW_MS = 100, BUZZ_CLAIM_MAX = 250; // 端末が時計合わせをしていれば、押した時刻を端末から受け取る（サーバーの時刻より未来・250ms以上前は信じない）
const buzzComp = p => Math.min(BUZZ_COMP_MAX, Math.max(0, (p.rtt || 0) / 2));
// 押した時刻：端末から受け取った時刻（時計合わせ済み）があればそれを、なければ回線の遅れを引いた時刻を使う
// 曲が聞こえ始めた遅れ（端末が測って送る 'heard'）の分も引く：読み込みが遅くて遅れて聞こえた人が不利にならないように
const HEARD_LAG_MAX = 1500;
function buzzAt(q, player, claimed) {
  const now = Date.now();
  const at = typeof claimed === 'number' && isFinite(claimed) ? Math.min(now, Math.max(now - BUZZ_CLAIM_MAX, claimed)) : now - buzzComp(player);
  return Math.max(q.t0, at - (q.heardLag?.get(player.token) || 0));
}
// 最初の合図のあと待つ時間：いまの部屋でいちばん遅れの大きい人の分まで（短すぎると、遅れて届いた人が間に合わない）
const buzzWindow = room => Math.min(200, Math.max(60, Math.max(0, ...[...room.players.values()].filter(p => p.connected).map(p => (p.rtt || 0) / 2)) + 20));
function settleBuzz(room, q) {
  const list = q.buzzPending || []; q.buzzPending = null;
  if (room.game?.q !== q || q.buzz || q.phase === 'reveal' || room.game.paused) return;
  list.sort((a, b) => a.at - b.at);
  let first = null;
  for (const e of list) {
    const p = room.players.get(e.token);
    if (!p?.connected || q.answers.has(e.token) || (q.fill && !fillCanBuzz(room, q, p))) continue;
    if (!first) { first = { p, at: e.at }; continue; }
    if (q.fill) { (q.buzzQueue = q.buzzQueue || []).push({ token: e.token, at: e.at }); q.fillPass.delete(e.token); } // 早押しクイズは、後の人は間に合わなかった
  }
  // 同時に押した人の順番待ちを先に知らせてから、1人目の番を始める（先に「回答中」が届くと、並んだ人の画面で一瞬「押せる」に戻ってしまう）
  if (q.fill) { q.buzzQueue?.sort((a, b) => a.at - b.at); emitQueue(room, q); }
  if (first) startBuzz(room, first.p, first.at);
  else if (q.fill) broadcastRoom(room);
}
function onBuzz(room, player, claimed = null) {
  const g = room.game, q = g?.q;
  if (!q || !['buzzer', 'fill'].includes(room.settings.play) || g.paused) return;
  if (q.phase !== 'intro' && q.phase !== 'chorus') return;
  if (!q.participants.has(player.token) || q.answers.has(player.token) || Date.now() < q.t0) return;
  if (q.fill && !fillCanBuzz(room, q, player)) return;
  if (q.buzz) {
    // 3つ埋めバトルは早押しの順番待ち：答えている人のあとに、押した順に答える（正解でもお手つきでも次の人へ）
    if (!q.fill || q.buzz.token === player.token) return;
    q.buzzQueue = q.buzzQueue || [];
    if (q.buzzQueue.some(e => e.token === player.token)) return;
    q.buzzQueue.push({ token: player.token, at: buzzAt(q, player, claimed) });
    q.buzzQueue.sort((a, b) => a.at - b.at); // 回線の遅れを引いた時刻の順
    q.fillPass.delete(player.token);
    emitQueue(room, q);
    return broadcastRoom(room);
  }
  // まだだれも押していない：ごく短く待って、補正した時刻がいちばん早い人を先にする
  if (!q.buzzPending) { q.buzzPending = []; addTimer(room, () => settleBuzz(room, q), buzzWindow(room)); }
  if (q.buzzPending.some(e => e.token === player.token)) return;
  q.buzzPending.push({ token: player.token, at: buzzAt(q, player, claimed) });
}
// 時間切れ（3つ埋めバトルは曲の終わり）。流し続けにして終わりが延びたときは、延びた時刻に改めて
function revealAtEnd(room, q) {
  if (room.game?.q !== q || q.phase === 'reveal') return;
  const left = q.t0 + q.total * 1000 - Date.now();
  if (left > 200) return later(room, () => revealAtEnd(room, q), left);
  if (q.buzz) q.revealPending = true; else reveal(room); // 押して答えている最中なら、答え終わるまで待つ
}
// 答えている間は止める（設定 buzzStop）：曲・残り時間・サビへの切り替えなどのタイマーを止めて、答え終わったら続きから
function freezeQuestion(room, q) {
  if (q.frozen) return;
  q.frozen = Date.now();
  for (const t of room.game.timers) if (!t.done) { clearTimeout(t.h); t.left = Math.max(0, t.due - Date.now()); }
}
function unfreezeQuestion(room, q) {
  if (!q.frozen) return;
  const d = Date.now() - q.frozen, g = room.game;
  q.frozen = null;
  if (q.t0) q.t0 += d;
  const old = g.timers; g.timers = [];
  for (const t of old) {
    if (t.done) continue;
    const n = addTimer(room, t.fn, t.left ?? Math.max(0, t.due - Date.now()));
    if (q.nextTimer === t) q.nextTimer = n;
  }
}

// 押した人の番を始める（at：押した時刻。早いほど高い点）
function startBuzz(room, player, at) {
  const q = room.game.q;
  const stop = !!room.settings.buzzStop;
  if (stop) freezeQuestion(room, q);
  // 3つ埋めバトル：イントロ中に押されたら、サビへ飛ばずにそのまま流し続ける（イントロで止めない）。曲の終わりも合わせて延ばす
  if (q.fill && q.phase === 'intro' && !q.flowOn && q.kind !== 'sabimae') {
    q.flowOn = true;
    const dur = DURATIONS.get(q.song.id);
    if (dur) q.total = Math.max(q.total, (dur - q.start) / (q.speed || 1));
    io.to(room.code).emit('flowOn', { total: q.total });
  }
  if (q.fill && !q.fillWait.has(player.token)) { for (const t of q.fillWait) io.to(room.players.get(t)?.socketId).emit('fillWaitEnd'); q.fillWait.clear(); }
  else if (q.fill) q.fillWait.delete(player.token);
  const now = Date.now(), sec = q.fill ? FILL_BUZZ_SEC : BUZZ_SEC;
  if (q.fill) q.fillPass.delete(player.token); // 押したらパスは取り消し
  // 押しても曲と進行（サビへ・時間切れ）は止めない。時間切れが答えている最中に来たら、答え終わってから答え合わせ（endBuzz）
  q.buzz = { token: player.token, elapsed: (at - q.t0) / 1000, at: now, until: now + sec * 1000 };
  q.buzz.timer = setTimeout(() => { if (room.game?.q === q && q.buzz?.token === player.token) onAnswer(room, player, { timeout: true }); }, sec * 1000);
  io.to(room.code).emit('buzz', { id: player.id, name: player.name, sec, queue: queueNames(room, q), stop });
  broadcastRoom(room);
}
// 答える人の番が終わった（間違い・時間切れ・抜けた）：順番待ちがいれば次の人へ、いなければ、また誰でも押せる。曲は流れたまま
function endBuzz(room) {
  const g = room.game, q = g?.q, b = q?.buzz;
  if (!b) return;
  clearTimeout(b.timer); q.buzz = null;
  if (q.revealPending) { io.to(room.code).emit('buzzEnd', { ms: 0 }); return setImmediate(() => { if (room.game?.q === q && q.phase !== 'reveal') reveal(room); }); } // 答えている間に時間切れになっていた
  // 3つ埋めバトル：押した順の次の人（抜けた人・その間にお手つきで押せなくなった人は飛ばす）
  let next = null;
  while (q.fill && q.buzzQueue?.length) {
    const e = q.buzzQueue.shift(), p = room.players.get(e.token);
    if (!p?.connected || !fillCanBuzz(room, q, p)) { if (p?.connected) io.to(p.socketId).emit('notice', 'お手つきの間だったので、順番を飛ばしました'); continue; }
    next = { p, at: e.at }; break;
  }
  // 次の人がいれば、止めたまま次の番へ（曲を一瞬だけ流さない）。いなければ続きから再開
  io.to(room.code).emit('buzzEnd', { ms: 0, hold: !!(next && q.frozen) });
  if (next) { emitQueue(room, q); return startBuzz(room, next.p, next.at); }
  unfreezeQuestion(room, q);
  if (q.fill) emitQueue(room, q); // 飛ばした人も、また押せるように（列が空になったことを知らせる）
}

// ライフラインの効果。使った本人にだけ返す内容を作る
function useLifeline(room, q, player, type) {
  if (q.years) return null; // 年代当てでは使えない
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
  if (q.buzz) { clearTimeout(q.buzz.timer); q.buzz = null; }
  q.phase = 'reveal';
  const s = q.song;
  const S = room.settings;
  // 3つ埋めバトル：一人ひとりの「この曲で答えたもの」をまとめて、ふつうの結果の形にする（点数は答えたときに足し済み）
  if (q.fill) {
    for (const t of q.participants) {
      const mine = q.fillLog.filter(l => l.token === t);
      if (!mine.length) { if (q.fillPass.has(t)) q.answers.set(t, { pass: true, points: 0, elapsed: null }); continue; }
      const ok = mine.filter(l => l.correct);
      q.answers.set(t, { index: null, pass: false, correct: ok.length > 0, miss: mine.some(l => !l.correct), hint: ok.some(l => l.hint),
                         points: mine.reduce((a, l) => a + l.points, 0), elapsed: ok.length ? Math.min(...ok.map(l => l.elapsed)) : null,
                         given: mine.map(l => l.correct ? `${l.label}：${l.given}${l.choice ? '（10択）' : ''}` : `×${l.label ? `${l.label}：` : ''}${l.given}`).join('／') });
    }
  }
  // 答えなかった人は連続正解が途切れる（激アツRUSHでは、RUSH中ならそこで終わり）
  for (const t of q.participants) if (!q.answers.has(t)) {
    const p = room.players.get(t); if (p) p.streak = 0;
    if (p && S.play === 'rush' && q.rush) (q.rushEvents = q.rushEvents || new Map()).set(t, rushApply(room, q, p, false, 0).info);
  }
  // サバイバル：正解しなかった人（年代当ては2年以内なら助かる）はライフが減り、0で脱落
  const eliminated = [];
  if (S.play === 'survival') {
    for (const t of q.participants) {
      const p = room.players.get(t), a = q.answers.get(t);
      if (!p || p.out || a?.correct || (q.years && a?.diff != null && a.diff <= 2)) continue;
      p.lives = Math.max(0, (p.lives ?? 1) - 1);
      if (p.lives === 0) { p.out = true; p.outAt = room.game.qi + 1; eliminated.push(p.name); }
    }
  }
  const results = [...room.players.values()]
    .filter(p => q.participants.has(p.token))
    .map(p => {
      const a = q.answers.get(p.token);
      return { id: p.id, name: p.name, avatar: p.avatar, answered: !!a, index: a ? a.index : null, given: a?.given ?? null,
               pass: !!a?.pass, elapsed: a ? a.elapsed : null,
               correct: !!a?.correct, points: a ? a.points : 0, hint: !!a?.hint, diff: a?.diff ?? null, miss: !!a?.miss,
               lives: p.lives ?? null, out: !!p.out, team: S.teams ? p.team : null, rush: q.rushEvents?.get(p.token) || null };
    })
    // 正解した人が上（同じなら速い順）。年代当ては点数（近さ）の順
    .sort((a, b) => (q.years || q.fill ? (b.points - a.points) : (b.correct - a.correct)) || ((a.elapsed ?? 99) - (b.elapsed ?? 99)));
  statsReveal(room, q, results);
  // 出題者：答える人の半分くらいが正解で最高点（全員正解・全員不正解は0点）
  let picker = null;
  if (q.picker) {
    const n = q.participants.size, c = [...q.answers.values()].filter(a => a.correct).length;
    const pts = n > 0 && c > 0 && c < n ? Math.round(1000 * (1 - Math.abs(2 * c / n - 1))) : 0;
    const pp = room.players.get(q.picker);
    if (pp) { pp.score += pts; picker = { id: pp.id, name: pp.name, points: pts, correct: c, of: n }; }
  }
  // ビンゴ：この問題でそろった人
  const bingoBonus = q.bingoBonus || []; // この問題でそろった人とボーナス
  const bingo = bingoBonus.map(b => b.name);
  if (S.play === 'bingo' && bingoOver(room)) room.game.bingoDone = true; // 設定した人数・ビンゴ数に届いたら、この問題で終わり
  const sgEv = S.play === 'sugoroku' ? sgReveal(room, q, results) : isGz(S.play) ? gzReveal(room, q, results) : S.play === 'deck' ? dkReveal(room, q, results) : [];
  const last = (!isGz(S.play) && room.game.qi + 1 >= room.game.order.length) || (isGz(S.play) && room.game.qi + 1 >= GZ_HARD_MAX) || survivalOver(room) || !!room.game.bingoDone || !!room.game.nenpyoDone || !!room.game.sgDone || !!room.game.gzDone;
  // 激アツRUSH：この問題の結果（色・当たり）と、大当たり・RUSH終了の人
  const rushEv = [...(q.rushEvents || new Map())].map(([t, e]) => ({ ...e, name: room.players.get(t)?.name })).filter(e => e.name);
  const rush = q.rush ? { color: q.rush.color, hit: q.rush.hit, jackpot: rushEv.filter(e => e.jackpot).map(e => e.name), ended: rushEv.filter(e => e.ended || e.done) } : null;
  if (S.play === 'karuta') karutaTake(room, q);
  if (S.play === 'nenpyo') nenpyoReveal(room, q);
  trackReveal(room, q, results, picker);
  userReveal(room, q, results);
  const pokerInfo = S.play === 'poker' ? pokerReveal(room, q, results, s) : null;
  io.to(room.code).emit('reveal', {
    rush, poker: pokerInfo,
    eliminated, picker, bingo, bingoBonus, coop: room.game.coop || null, reach: (q.reach || []).filter(n => !bingo.includes(n)),
    correctIndex: q.correctIndex,
    qlog: (q.qlog || []).map(({ token, ...e }) => e), // 出題中の記録（全員分。パスの下）
    // 3つ埋めバトル：枠ごとの正解・埋めた人・10択の正解の番号
    fill: q.fill ? q.fill.map(f => ({ key: f.key, label: f.label, by: f.by ? room.players.get(f.by)?.name || '' : null, given: f.given,
                                       answer: f.key === 'title' ? s.title : f.key === 'work' ? s.work : f.key === 'artist' ? s.artist
                                         : f.key === 'author' ? authorOf(s) : f.key === 'singer' ? s.singer[0] : f.auto ? 'ボーカルなし' : (s.vocal || []).join('・'),
                                       correctIndex: f.correctIndex })) : null,
    song: { id: s.id, title: s.title, work: s.work, artist: s.artist, year: s.year, type: s.type, staged: !!s.staged },
    log: playedLog(room), // ここまでに出た曲（ページを読み込み直した人も曲ログをコピーできるように）
    intro: s.intro || 0, chorus: chorusOf(s), chorusKnown: s.chorus > 0,
    results,
    highlights: [...highlightsOf(room, results), ...eliminated.map(n => `${n} 脱落…`), ...bingoBonus.map(b => `${b.name} ${b.first ? 'BINGO!' : 'もう1列そろった！'} +${b.bonus}点`),
                 ...rushEv.filter(e => e.jackpot).map(e => `${e.name} 大当たり！ +${e.bonus}点${e.mult > 1 ? `（RUSH中 ×${e.mult}）` : '（RUSH突入）'}`),
                 ...rushEv.filter(e => e.ended || e.done).map(e => `${e.name} RUSH${e.done ? '完走' : '終了'}：${e.chain}連チャン・${e.earned}点`),
                 ...(picker ? [`出題者 ${picker.name} +${picker.points}（${picker.of}人中 ${picker.correct}人正解）`] : []), ...sgEv],
    last,
    autoNext: S.autoNext, // 0 なら自動では進まない
  });
  if (S.play === 'panel') {
    startPanelPick(room, q, results);
    if (q.attack && !room.game.panelPick) room.game.attackCell = null; // アタックチャンスの問題が終わったら、白いマスは普通の空きマスに戻る（選ぶ人がいるときは、選び終わってから）
    if (!room.game.panelPick) panelAttackSetup(room);
  }
  if (S.autoNext > 0 && !room.game.panelPick && !room.game.gz?.pick) {
    q.revealAt = Date.now();
    scheduleNext(room, q, Date.now() + S.autoNext * 1000);
  }
  broadcastRoom(room);
}

// 称号用：答え合わせのたびに、その問題の結果から数える（早さ・前半後半・知名度・年代・種類・モード別など）
function trackReveal(room, q, results, picker) {
  const g = room.game, S = room.settings, s = q.song, n = g.order.length, qi = g.qi;
  const byId = new Map([...room.players.values()].map(p => [p.id, p]));
  const fame = fameOf(s), ok = results.filter(r => r.correct);
  for (const r of results) {
    const p = byId.get(r.id); if (!p) continue;
    const st = statsOf(room, p);
    st.seen++;
    if (r.answered && !r.pass) st.answered++;
    if (fame === 'top') st.topSeen++;
    if (q.almost?.get(p.token)) st.almost += q.almost.get(p.token);
    if (!r.correct) { if (qi < n / 2) st.earlyWrong++; continue; }
    if (r.elapsed != null && r.elapsed < 2) st.fast++;
    if (qi >= n / 2) st.late++;
    if (qi === n - 1) st.final++;
    if (S.target === 'work') st.work++;
    if (S.target === 'artist') st.artist++;
    if (q.years && r.diff === 0) st.yearExact++;
    if (fame === 'minor' || fame === 'otaku') st.otaku++;
    if (fame === 'top') st.topOk++;
    if (s.type === 'OP') st.op++;
    if (s.type === 'ED') st.ed++;
    if (s.year >= 1989 && s.year <= 2018) st.heisei++;
    if (s.year <= 1988) st.showa++;
    if (ok.length === 1 && results.length >= 3) st.sole++;
  }
  if (q.fill?.length && q.fill.filter(f => !f.auto).every(f => f.by && f.by === q.fill.find(x => !x.auto).by)) { const p = room.players.get(q.fill.find(x => !x.auto).by); if (p) statsOf(room, p).hat++; }
  if (picker) { const p = byId.get(picker.id); if (p) statsOf(room, p).pickPts += picker.points; }
}

function statsOf(room, player) {
  const m = room.game.stats;
  if (!m.has(player.token)) m.set(player.token, { correct: 0, time: 0, chorus: 0, retro: 0, maxStreak: 0, genres: {},
                                                   reiwa: 0, first: 0, typed: 0, choice: 0, miss: 0, pass: 0,
                                                   seen: 0, answered: 0, fast: 0, late: 0, earlyWrong: 0, final: 0, work: 0, artist: 0, yearExact: 0, otaku: 0, topSeen: 0, topOk: 0,
                                                   op: 0, ed: 0, heisei: 0, showa: 0, sole: 0, almost: 0, hat: 0, pickPts: 0, allin: 0, betWon: 0, pokerEv: 0 });
  return m.get(player.token);
}

// 最終結果の称号。条件を満たした一番の人に1つずつ
function titlesOf(room, ranking = [], showdown = null) {
  for (const p of room.players.values()) statsOf(room, p); // 記録のない人も候補に入れる（全員に最低1つ）
  const list = [...room.game.stats.entries()].map(([t, s]) => ({ p: room.players.get(t), s })).filter(x => x.p);
  const S = room.settings, g = room.game;
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
  const titles = [
    fastest && pick(fastest, '最速王', `平均 ${avg(fastest.s).toFixed(2)}秒（${fastest.s.correct}問）`),
    top(s => s.maxStreak, 3, '連続正解王', s => `${s.maxStreak}連続正解`),
    top(s => s.chorus, 2, 'サビ頼み', s => `サビで ${s.chorus}問正解`),
    top(s => s.retro, 2, 'レトロマスター', s => `2000年より前の曲を ${s.retro}問正解`),
    top(s => s.correct, 1, '正解数王', s => `${s.correct}問正解`),
    top(s => s.first, 2, '一番乗り', s => `いちばん最初の正解 ${s.first}回`),
    top(s => s.typed, 3, '手書きの達人', s => `書いて ${s.typed}回正解`),
    top(s => s.choice, 2, '10択の申し子', s => `10択で ${s.choice}回正解`),
    top(s => s.reiwa, 2, '令和マスター', s => `2019年以降の曲を ${s.reiwa}問正解`),
    top(s => s.miss, 3, 'お手つき大王', s => `お手つき ${s.miss}回（攻めた証）`),
    top(s => s.pass, 3, '見送りの達人', s => `パス ${s.pass}回`),
    top(s => s.maxChain || 0, 3, 'RUSH王', s => `RUSHで ${s.maxChain}連チャン`),
    top(s => s.jackpots || 0, 2, '引き強', s => `大当たり ${s.jackpots}回`),
    top(s => s.rainbow || 0, 1, '全回転', s => `虹（全回転）で ${s.rainbow}回当てた`),
    ...genreTitles,
    // 早さ・テンポ
    top(s => s.fast, 2, '電光石火', s => `2秒以内の正解 ${s.fast}回`),
    top(s => s.late, 3, '大器晩成', s => `後半で ${s.late}問正解`),
    top(s => s.earlyWrong >= 2 ? s.late : 0, 2, 'スロースターター', s => `前半の不正解 ${s.earlyWrong}回から、後半 ${s.late}問正解`),
    top(s => s.final, 1, 'ラストスパート', () => '最終問題で正解'),
    // 曲・作品の知識
    top(s => s.work, 2, '作品当ての達人', s => `作品名を ${s.work}問正解`),
    top(s => s.artist, 2, '歌手博士', s => `歌手を ${s.artist}問正解`),
    top(s => s.yearExact, 1, '年代の目利き', s => `年をピタリ ${s.yearExact}回`),
    top(s => s.otaku, 2, 'オタク認定', s => `マイナー・オタク曲を ${s.otaku}問正解`),
    top(s => s.topSeen >= 3 && s.topOk === s.topSeen ? s.topOk : 0, 3, '王道を往く', s => `超有名曲を ${s.topOk}問すべて正解`),
    top(s => s.op, 3, 'OPの申し子', s => `OPを ${s.op}問正解`),
    top(s => s.ed, 2, 'ED職人', s => `EDを ${s.ed}問正解`),
    top(s => s.heisei, 3, '平成マスター', s => `平成の曲を ${s.heisei}問正解`),
    top(s => s.showa, 2, '昭和の生き字引', s => `昭和の曲を ${s.showa}問正解`),
    // ネタ・ユーモア
    top(s => s.almost, 2, '惜しい人', s => `「惜しい！」${s.almost}回`),
    top(s => s.sole, 1, 'ムードメーカー', s => `ひとりだけ正解 ${s.sole}回`),
    top(s => s.seen >= 5 && s.answered === s.seen ? s.answered : 0, 5, '皆勤賞', s => `全${s.seen}問で回答`),
    ranking.length >= 4 && (() => { const r = ranking[ranking.length - 2], x = list.find(y => y.p.id === r.id); return x && pick(x, 'ブービー賞', `${ranking.length}人中 ${ranking.length - 1}位`); })(),
    // モード別
    ...modeTitles(room, list, pick, top, ranking, showdown),
  ].filter(Boolean);
  // 部屋の中の連勝（同じ部屋で続けて1位）
  const win = ranking[0];
  if (win) {
    room.winStreak = room.winStreak?.id === win.id ? { id: win.id, n: room.winStreak.n + 1 } : { id: win.id, n: 1 };
    const x = list.find(y => y.p.id === win.id);
    if (x && room.winStreak.n >= 2) titles.unshift(pick(x, `${room.winStreak.n}連勝中`, 'この部屋で続けて1位'));
  }
  // 称号がない人にも1つ（その人のよかったところから）
  for (const x of list) {
    if (titles.some(y => y.id === x.p.id)) continue;
    const s = x.s;
    titles.push(s.maxStreak >= 2 ? pick(x, '連続の兆し', `${s.maxStreak}連続正解`)
      : s.correct >= 1 ? pick(x, 'コツコツ賞', `${s.correct}問正解`)
      : s.miss >= 1 ? pick(x, 'チャレンジャー', `果敢に ${s.miss}回挑戦`)
      : s.answered >= 1 ? pick(x, '最後まで参加賞', `${s.answered}問に回答`)
      : pick(x, '次回に期待', 'つぎはきっと当たる！'));
  }
  return titles;
}
// モード別の称号
function modeTitles(room, list, pick, top, ranking, showdown) {
  const S = room.settings, out = [];
  const P = x => x.p;
  if (S.play === 'bingo') {
    const b = list.filter(x => P(x).bingoAt).sort((a, c) => P(a).bingoAt - P(c).bingoAt)[0];
    if (b) out.push(pick(b, '最速ビンゴ', `${P(b).bingoAt}問目でBINGO`));
    const r = list.filter(x => (P(x).reachN || 0) >= 2).sort((a, c) => P(c).reachN - P(a).reachN)[0];
    if (r) out.push(pick(r, 'リーチ職人', `リーチ ${P(r).reachN}列`));
  }
  if (S.play === 'fill') {
    out.push(top(s => s.correct, 3, '埋め職人', s => `${s.correct}枠を埋めた`));
    out.push(top(s => s.hat, 1, 'ハットトリック', s => `1曲で3つとも埋めた ${s.hat}回`));
  }
  if (S.play === 'survival') {
    for (const x of list) {
      if (P(x).out) continue;
      if ((P(x).lives ?? 0) >= S.lives && S.lives > 1) out.push(pick(x, '不死身', 'ライフを1つも減らさず生存'));
      else if (P(x).lives === 1 && S.lives > 1) out.push(pick(x, '粘り腰', '最後の1ライフで生き残った'));
    }
  }
  if (S.play === 'picker') out.push(top(s => s.pickPts, 500, '名出題者', s => `出題で ${s.pickPts}点`));
  if (S.play === 'poker' && showdown) {
    const best = showdown.filter(x => x.rank >= 3).sort((a, c) => c.rank - a.rank)[0];
    const bx = best && list.find(y => y.p.id === best.id);
    if (bx) out.push(pick(bx, best.rank >= 9 ? `${best.handName}の奇跡` : `${best.handName}の使い手`, `最後の役：${best.handName}`));
    out.push(top(s => s.allin, 1, 'ギャンブラー', s => `ALL IN ${s.allin}回`));
    out.push(top(s => s.betWon, 1, '勝負師', s => `賭けで ${s.betWon}点獲得`));
    const k = list.filter(x => (P(x).kept || []).length >= 3).sort((a, c) => P(c).kept.length - P(a).kept.length)[0];
    if (k) out.push(pick(k, 'カード長者', `保管 ${P(k).kept.length}枚`));
  }
  if (S.teams) {
    const teamSum = new Map();
    for (const x of list) teamSum.set(P(x).team, (teamSum.get(P(x).team) || 0) + Math.max(0, P(x).score || 0));
    const c = list.filter(x => list.filter(y => P(y).team === P(x).team).length >= 2 && teamSum.get(P(x).team) > 0)
      .map(x => ({ x, r: Math.max(0, P(x).score) / teamSum.get(P(x).team) })).sort((a, b) => b.r - a.r)[0];
    if (c) out.push(pick(c.x, 'チームの柱', `チームの得点の ${Math.round(c.r * 100)}%`));
  }
  return out;
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

// サバイバルの終わり：2人以上で始めたら残り1人以下、1人ならライフがなくなったとき
function survivalOver(room) {
  if (room.settings.play !== 'survival' || !room.game) return false;
  const alive = [...room.players.values()].filter(p => p.connected && !p.out).length;
  return room.game.solo ? alive === 0 : alive <= 1;
}
const isFinalQuestion = room => room.settings.play !== 'survival' && !isGz(room.settings.play) && room.game.qi + 1 >= room.game.order.length && room.game.order.length > 1;

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
const poolKey = S => JSON.stringify([S.topic, S.series, S.multiGenres, S.multiSeries, S.yearFrom, S.yearTo, S.excludeGenres, S.quizType, S.fame]);
function pauseGame(room, auto = false) {
  const g = room.game, q = g?.q;
  if (room.state !== 'playing' || !g || g.paused || !q) return false;
  if (q.phase === 'loading' || (q.t0 && Date.now() < q.t0)) return false; // 曲が流れ始める直前は止めない
  if (q.buzz || q.phase === 'picking') return false; // 早押しで答えている最中・出題者が選んでいる間は止めない
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
  if ((poolChanged || S.questions !== g.paused.questions) && !['picker', 'bingo', 'rush'].includes(S.play)) {
    const done = g.order.slice(0, g.qi + 1), rest = g.order.slice(g.qi + 1);
    const pool = poolChanged ? poolFor(S, userCtx(room)) : g.pool;
    if (pool.length) g.pool = pool;
    const need = Math.max(0, S.questions - done.length);
    const keep = poolChanged ? [] : rest.filter(s => g.pool.includes(s));
    const avail = g.pool.filter(s => !done.includes(s) && !keep.includes(s));
    const fresh = S.noExclude ? avail : avail.filter(s => !room.played.has(s.id));
    const popular = S.noExclude ? [] : avail.filter(s => room.played.has(s.id) && isPopular(s));
    const picked = weightedPick([...fresh.map(s => [s, 1]), ...popular.map(s => [s, POPULAR_REPEAT])], Math.max(0, need - keep.length));
    const reuse = shuffle(avail.filter(s => room.played.has(s.id) && !picked.includes(s))); // それでも足りなければ除外中の曲から
    const next = [...keep, ...picked, ...reuse].slice(0, need);
    if (!S.noRecord) rest.forEach(s => { if (!next.includes(s)) unrecordPlayed(room, s); }); // 出さなくなった曲は除外の記録から外す
    if (!S.noRecord) next.forEach(s => recordPlayed(room, s));
    g.order = spreadLowFame(capLowFame([...done, ...next], [avail], done.length), Math.max(1, done.length));
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
  if (!room.settings.noRecord) g.order.slice(g.qi + 1).forEach(s => unrecordPlayed(room, s));
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
  const survival = room.settings.play === 'survival', played = Math.min(room.game.qi + 1, room.game.order.length);
  let showdown = null;
  if (room.settings.play === 'poker') { // 最後の勝負：役のボーナス＋保管したカードのボーナスを点に足す。点の多い順が順位
    showdown = pokerShowdown(room);
    for (const x of showdown) {
      const p = [...room.players.values()].find(q => q.id === x.id); if (!p) continue;
      x.keptCards = p.kept || []; x.handBonus = x.rank * POKER_RANK_PTS; x.keptBonus = x.keptCards.length * POKER_KEEP_PTS;
      x.base = p.score || 0; p.score = x.base + x.handBonus + x.keptBonus; x.total = p.score;
    }
    showdown.sort((a, b) => b.total - a.total || poker.compare(b, a));
  }
  const ranking = [...room.players.values()]
    .map(p => {
      // ふりかえり用：正解数・正解したときの平均タイム・いちばん長い連続正解
      const s = room.game.stats.get(p.token);
      return { id: p.id, name: p.name, avatar: p.avatar, score: p.score,
               correct: s?.correct || 0, avg: s?.correct ? Math.round(s.time / s.correct * 100) / 100 : null, maxStreak: s?.maxStreak || 0,
               team: room.settings.teams ? p.team : null,
               survived: survival ? (p.out ? p.outAt : played) : null, out: survival ? !!p.out : null,
               bingoAt: p.bingoAt || 0, jackpots: s?.jackpots || 0, rushMax: s?.maxChain || 0 };
    })
    // サバイバルは長く残った順（最後まで残った人が上）、ビンゴはそろえた人が上、同じなら得点の順
    .sort((a, b) => (survival ? (b.out === a.out ? b.survived - a.survived : a.out - b.out) : 0)
      || b.score - a.score); // ビンゴも得点で競う（BINGO はボーナス点として入っている）
  if (showdown) for (const r of ranking) r.pokerHand = showdown.find(x => x.id === r.id)?.handName;
  if (room.settings.play === 'nenpyo') { // 年表：枚数の多い順（同じなら得点）
    for (const r of ranking) r.nenpyo = ([...room.players.values()].find(p => p.id === r.id)?.timeline || []).length;
    ranking.sort((a, b) => b.nenpyo - a.nenpyo || b.score - a.score);
  }
  if (room.settings.play === 'karuta') { // かるた：取った札の多い順（同じなら得点）
    for (const r of ranking) r.karuta = room.players.get([...room.players.values()].find(p => p.id === r.id)?.token)?.karutaCards || 0;
    ranking.sort((a, b) => b.karuta - a.karuta || b.score - a.score);
  }
  if (isGz(room.settings.play) && room.game.gz) { // ジャンル制覇：ピースの多い順（同じなら得点）
    for (const r of ranking) r.gzPieces = room.game.gz.pieces.get(r.id)?.size || 0;
    ranking.sort((a, b) => b.gzPieces - a.gzPieces || b.score - a.score);
  }
  if (room.settings.play === 'sugoroku' && room.game.sg) { // すごろく：進んだマスの多い順（同じなら得点）
    for (const r of ranking) r.sgPos = room.game.sg.pos.get(r.id) || 0;
    ranking.sort((a, b) => b.sgPos - a.sgPos || b.score - a.score);
  }
  if (room.settings.play === 'panel' && room.game.panel) { // 陣取り：パネルの多い順（同じなら得点）
    for (const r of ranking) { const p = [...room.players.values()].find(x => x.id === r.id); r.panels = room.game.panel.filter(x => x === (p ? panelOwner(room, p) : r.id)).length; }
    ranking.sort((a, b) => b.panels - a.panels || b.score - a.score);
  }
  let teams = teamScores(room)?.sort((a, b) => b.score - a.score) || null;
  if (teams && room.settings.play === 'panel' && room.game.panel) { // 陣取り：チームのパネルの枚数
    teams = teams.map(x => ({ ...x, score: room.game.panel.filter(c => c === x.team).length, unit: '枚' })).sort((a, b) => b.score - a.score);
  }
  if (teams && room.settings.play === 'karuta') { // かるた：チームの取った札の合計
    teams = teams.map(x => ({ ...x, score: [...room.players.values()].filter(p => p.team === x.team).reduce((s, p) => s + (p.karutaCards || 0), 0), unit: '枚' })).sort((a, b) => b.score - a.score);
  }
  const coop = room.game.coop ? { ...room.game.coop, done: room.game.coop.count >= room.game.coop.goal } : null;
  const titles = titlesOf(room, ranking, showdown);
  userEndGame(room, ranking, titles);
  io.to(room.code).emit('gameover', { total: played, ranking, showdown, teams, survival, coop, bingo: room.settings.play === 'bingo', titles, log: playedLog(room), roomLog: room.history });
  broadcastRoom(room);
}

// ── 接続 ──
// 画面の版。新しい版をデプロイすると変わるので、古いページを開いたままの人に再読み込みしてもらう
const APP_VERSION = process.env.RENDER_GIT_COMMIT || String(Date.now());

io.on('connection', socket => {
  const rtts = [];
  const pinger = setInterval(() => {
    const t0 = Date.now();
    socket.timeout(3000).emit('pingc', err => { if (err) return; rtts.push(Date.now() - t0); if (rtts.length > 8) rtts.shift(); if (player) player.rtt = Math.min(...rtts); });
  }, 4000);
  socket.on('disconnect', () => clearInterval(pinger));
  socket.emit('version', APP_VERSION);
  let room = null, player = null;

  function enter(r, token, name) {
    let p = r.players.get(token);
    if (!p) {
      if (r.players.size >= r.settings.maxPlayers) return { ok: false, error: 'この部屋は満員です' };
      p = { token, id: crypto.randomUUID().slice(0, 8), name, avatar: freeAvatar(r), score: 0, connected: true, socketId: socket.id };
      r.players.set(token, p);
      if (r.settings.teams) assignTeams(r);
      if (r.state === 'playing' && r.settings.play === 'survival') { p.out = true; p.lives = 0; }
      if (r.state === 'playing' && r.settings.play === 'bingo' && r.game) { p.card = bingoCard(r.game.order, r.game.pool, r.game.bingoTarget); p.bingoAt = 0; p.reachN = 0; p.bingoLinesN = 0; }
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

  // マイページの名前（登録済みのときだけ）を席に結びつける
  const linkUser = (r, token, user) => { const p = r?.players.get(token); if (p) p.user = USERS[userKey(user)] ? userKey(user) : null; };
  socket.on('create', ({ token, name, roomName, password, user, lyricsPass } = {}, ack) => {
    if (typeof ack !== 'function' || typeof token !== 'string' || token.length < 8) return;
    // 歌詞の合言葉：合っていて、パスワードを付けた部屋だけ（非公開・10人まで）
    const wantLy = typeof lyricsPass === 'string' && lyricsPass.trim() !== '';
    if (wantLy && !lyricsPassOk(lyricsPass)) return ack({ ok: false, error: '歌詞の合言葉が違います' });
    if (wantLy && !cleanPassword(password)) return ack({ ok: false, error: '歌詞クイズの部屋には、パスワードを付けてください（知っている人だけが入れるように）' });
    socket.leave('home');
    const r = createRoom({ roomName, password, lyrics: wantLy });
    if (wantLy) { r.settings.maxPlayers = LY_MAX; r.settings.play = 'lyrics'; }
    const pf = USERS[userKey(user)]?.prefs; // マイページに保存した設定があれば、部屋を作るときに自動で使う
    if (pf?.settings) { r.settings = sanitizeSettings(pf.settings, r.settings); r.settings.excludeGenres = (pf.excludeGenres || []).filter(k => GENRES[k]); }
    const res = enter(r, token, cleanName(name));
    linkUser(r, token, user); ack(res);
    socket.emit('fixSongs', r.fixRecent || []);
  });
  socket.on('login', user => { if (room && player) { linkUser(room, player.token, user); broadcastRoom(room); } });

  socket.on('join', ({ code, token, name, password, user } = {}, ack) => {
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
    const res = enter(r, token, cleanName(name));
    linkUser(r, token, user); ack(res);
    socket.emit('fixSongs', r.fixRecent || []); // このゲームで出た曲（「🛠 修正」用）
  });

  // 歌詞クイズの部屋（非公開・一覧に出ない）：部屋の番号を知らなくても、その部屋のパスワードだけで入れる
  let pwTries = [];
  socket.on('joinByPassword', ({ token, name, password, user } = {}, ack) => {
    if (typeof ack !== 'function' || typeof token !== 'string' || token.length < 8) return;
    const now = Date.now(); pwTries = pwTries.filter(x => now - x < 60 * 1000);
    if (pwTries.length >= 6) return ack({ ok: false, error: '少し時間をおいてから入れてください（1分に6回まで）' }); // 当てずっぽうを防ぐ
    pwTries.push(now);
    const pw = cleanPassword(password);
    if (!pw) return ack({ ok: false, error: 'パスワードを入力してください' });
    const r = [...rooms.values()].filter(x => x.lyricsOk && x.passwordHash && hashPassword(x.salt, pw) === x.passwordHash)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    if (!r) return ack({ ok: false, error: 'このパスワードの部屋は見つかりません' });
    socket.leave('home');
    const res = enter(r, token, cleanName(name));
    linkUser(r, token, user); ack(res);
    socket.emit('fixSongs', r.fixRecent || []);
  });

  // ホーム画面の部屋一覧
  socket.on('watchRooms', () => { socket.join('home'); socket.emit('rooms', roomList()); });
  socket.on('unwatchRooms', () => socket.leave('home'));

  const isHost = () => room && player && room.hostId === player.id;
  const canConfig = () => !!(room && player); // 設定（曲・お題・年代・除外など）は、部屋のだれでも変えられる。開始・一時停止・中止・次の問題などはホストだけ

  socket.on('settings', input => {
    if (!canConfig() || (room.state === 'playing' && !room.game?.paused)) return;
    const before = room.settings;
    room.settings = sanitizeSettings(input, room.settings);
    if (room.settings.play === 'lyrics' && !room.lyricsOk) room.settings.play = before.play === 'lyrics' ? 'normal' : before.play; // 歌詞クイズは非公開の部屋だけ
    if (room.lyricsOk) room.settings.maxPlayers = Math.min(room.settings.maxPlayers, LY_MAX);
    if (room.settings.teams) assignTeams(room);
    broadcastRoom(room);
  });

  // 前回のログを貼り付け：その曲を出題から外す（参加者だれでも足せる。リセットはホスト）
  socket.on('exclude', ids => {
    if (!room || !player || !Array.isArray(ids)) return;
    const known = new Set(ALL_SONGS.map(s => s.id));
    if (!room.played) room.played = new Set();
    let added = 0;
    for (const id of ids.slice(0, 5000)) {
      if (typeof id === 'string' && known.has(id) && !room.played.has(id) && !room.kept?.has(id)) { room.played.add(id); added++; }
    }
    socket.emit('notice', `${added}曲を出題から外しました（除外中 ${room.played.size}曲）`);
    broadcastRoom(room);
  });
  // 答え合わせの「この曲は除外しない」：その曲を除外の記録から外し、この部屋ではこの先も除外しない（参加者だれでも）
  socket.on('keepSong', id => {
    if (!room || !player || typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) return;
    if (!room.kept) room.kept = new Set();
    room.kept.add(id);
    room.played?.delete(id); room.playedHere?.delete(id);
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
    if (!canConfig() || room.state === 'playing') return;
    room.played = new Set(); room.playedHere = new Set();
    broadcastRoom(room);
  });
  // ロビーの「このルームで流した曲の除外を解除」：この部屋で流した曲だけ除外から外す（前から除外していた曲・貼り付けたログの曲は残す）
  socket.on('clearPlayedHere', () => {
    if (!canConfig() || room.state === 'playing') return;
    for (const id of room.playedHere || []) room.played.delete(id);
    room.playedHere = new Set();
    broadcastRoom(room);
  });

  socket.on('start', () => {
    if (!isHost() || room.state === 'playing') return;
    const r = startGame(room);
    if (r === 'picker') socket.emit('notice', '出題者モードは2人以上で遊べます');
    else if (r === 'wolf') socket.emit('notice', 'アニソン人狼は3人以上で遊べます');
    else if (r === 'dixit') socket.emit('notice', 'アニソン・ディクシットは3人以上で遊べます');
    else if (r === 'dentatsu') socket.emit('notice', 'アニソン伝達クイズは2人以上で遊べます');
    else if (r === 'lyricsLocked') socket.emit('notice', '歌詞クイズは、歌詞の合言葉で作った部屋だけで遊べます');
    else if (r === 'lyricsEmpty') socket.emit('notice', '歌詞がまだサーバーに届いていません（PCから tools/push-lyrics-live.js で送ってください）。または曲の範囲に歌詞のある曲がありません');
    else if (r === 'baba') socket.emit('notice', 'アニソン・ババ抜きは3人以上で遊べます');
    else if (r === 'codenames') socket.emit('notice', 'アニソン・コードネームは4人以上で遊べます');
    else if (r === 'daifugo') socket.emit('notice', 'アニソン大富豪は3人以上で遊べます');
    else if (!r) socket.emit('notice', '選んだ年代に出題できる曲がありません。年代の設定を広げてください');
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
  // 答え合わせで「位置を直す」を開いた：直し終わるまで、自動で次へ進まない（全員の画面のカウントも止める）
  socket.on('fixHold', on => {
    const q = room?.game?.q;
    if (!q || !player || room.state !== 'playing' || q.phase !== 'reveal') return;
    q.fixHolds = q.fixHolds || new Set();
    if (on) {
      q.fixHolds.add(player.token);
      if (q.nextTimer) { clearTimeout(q.nextTimer.h); q.nextTimer.done = true; q.nextTimer = null; }
      io.to(room.code).emit('nextHold', { by: player.name });
    } else if (q.fixHolds.delete(player.token) && !q.fixHolds.size && room.settings.autoNext > 0) {
      const at = Date.now() + Math.max(5, room.settings.autoNext) * 1000;
      scheduleNext(room, q, at);
      io.to(room.code).emit('nextAt', { seconds: (at - Date.now()) / 1000, by: '' });
    }
  });
  socket.on('listen', () => {
    const q = room?.game?.q;
    if (!q || !player || room.state !== 'playing' || room.game.paused || q.phase !== 'reveal' || !q.nextAt) return;
    q.listens = q.listens || new Map();
    const n = q.listens.get(player.token) || 0;
    const free = !!q.song.staged; // お試しの曲（プレイリスト）は、何回でも・いくらでも延ばせる
    if (!free && n >= LISTEN_PER_PLAYER) { socket.emit('listenLeft', 0); return socket.emit('notice', 'サビを聞くのは1問2回までです'); }
    const limit = free ? Infinity : q.revealAt + (room.settings.autoNext + LISTEN_MAX_EXTRA) * 1000;
    const at = Math.min(limit, Math.max(q.nextAt, Date.now()) + LISTEN_SEC * 1000);
    if (at <= q.nextAt) { socket.emit('listenLeft', 0); return socket.emit('notice', 'これ以上は延ばせません'); }
    q.listens.set(player.token, n + 1);
    socket.emit('listenLeft', free ? -1 : LISTEN_PER_PLAYER - n - 1); // -1：回数の上限なし
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

  // 端末の時計合わせ（賭ケ盟約と同じ方式）：端末が送った時刻に、サーバーの「いま」を返す
  socket.on('clock', (c, ack) => { if (typeof ack === 'function') ack(Date.now()); });
  // 曲が実際に聞こえ始めた遅れ（秒）。問題ごとに1回だけ受け付ける
  socket.on('heard', lag => {
    const q = room?.game?.q;
    if (!q || !player || !q.participants?.has(player.token) || (q.phase !== 'intro' && q.phase !== 'chorus') || typeof lag !== 'number' || !isFinite(lag)) return;
    if (!q.heardLag) q.heardLag = new Map();
    if (!q.heardLag.has(player.token)) q.heardLag.set(player.token, Math.min(HEARD_LAG_MAX, Math.max(0, lag * 1000)));
    if (process.env.DEBUG_HEARD) console.log('heard', player.name, lag.toFixed(3));
  });
  socket.on('buzz', t => { if (room && player) onBuzz(room, player, typeof t === 'number' ? t : null); });
  socket.on('pickSong', id => { if (room?.game?.q?.phase === 'picking' && room.game.q.picker === player?.token) finishPick(room, id); });
  // チーム戦：待機中に自分のチームを切り替える／ホストがシャッフル
  socket.on('setTeam', team => {
    if (!room || !player || !room.settings.teams || room.state === 'playing' || !TEAMS.includes(team)) return;
    player.team = team; broadcastRoom(room);
  });
  socket.on('shuffleTeams', () => {
    if (!canConfig() || !room.settings.teams || room.state === 'playing') return;
    const ps = shuffle([...room.players.values()]);
    ps.forEach((p, i) => { p.team = TEAMS[i % 2]; });
    broadcastRoom(room);
  });
  socket.on('answer', (payload = {}) => {
    // timeout・drop はサーバーの中だけで使う（画面から送られても無視）
    if (room && player) onAnswer(room, player, { index: payload?.index, text: payload?.text, year: payload?.year, pass: payload?.pass, slot: payload?.slot });
  });
  // お試しの曲（staged）を「ゲームデータに入れる」：押された曲を記録（反映の前に tools/pull-promotes.js で本採用にする）
  socket.on('promote', id => {
    const s = typeof id === 'string' ? ALL_SONGS.find(x => x.id === id && x.staged) : null;
    if (!s || !room || !player) return;
    const who = player.token || player.id;
    const e = PROMOTES[id] || (PROMOTES[id] = { title: s.title, votes: [], at: new Date().toISOString() });
    if (!e.votes.includes(who)) { e.votes.push(who); savePromotes(); }
    io.to(room.code).emit('promoted', { id, title: s.title, by: player.name, votes: e.votes.length });
  });
  // アニソン・ポーカー：手札が5枚を超えているとき、捨てるカード（曲のID）を選ぶ
  const azQ = () => { const q = room?.game?.q; return q?.az && player && q.participants.has(player.token) ? q : null; };
  socket.on('azTake', d => { if (azQ() && d && Number.isInteger(d.f) && typeof d.color === 'string') azTake(room, player.token, d.f, d.color); });
  socket.on('azPlace', d => { if (azQ() && d && typeof d.id === 'string') azPlace(room, player.token, d.id, Number.isInteger(d.row) ? d.row : -1); });
  socket.on('azPreview', id => {
    const q = azQ(); if (!q) return;
    const now = Date.now(); if (now - (player.dxPrevAt || 0) < 700) return; player.dxPrevAt = now;
    const a = q.az, x = [...a.factories.flat(), ...a.center, ...a.hand].find(y => y.id === String(id));
    if (x) socket.emit('wolfSong', { videoId: x.id, start: wolfStartOf(x), sec: DX_PREVIEW });
  });
  socket.on('kmPreview', i => { // 帰れま10：候補の曲を自分だけ試聴（順位は出ない）
    const q = room?.game?.q; if (!q?.km || !player || !Number.isInteger(i) || !q.km.cands[i]) return;
    const now = Date.now(); if (now - (player.dxPrevAt || 0) < 700) return; player.dxPrevAt = now;
    const s = q.km.cands[i].s; socket.emit('wolfSong', { videoId: s.id, start: wolfStartOf(s), sec: DX_PREVIEW });
  });
  socket.on('kmPick', i => { const q = room?.game?.q; if (q?.km && player && q.participants.has(player.token)) kmPick(room, player.token, i); });
  // ── アニソン年当てベット ──
  const wwQ = () => { const q = room?.game?.q; return q?.ww && player && q.participants.has(player.token) ? q : null; };
  socket.on('wwGuess', y => {
    const q = wwQ(); if (!q || q.ww.step !== 'guess') return;
    const year = Math.floor(+y); if (!(year >= WW.minYear && year <= new Date().getFullYear())) return;
    q.ww.guesses.set(player.token, year);
    if ([...q.participants].every(t => q.ww.guesses.has(t) || !room.players.get(t)?.connected)) wwToBet(room); else wwEmit(room);
  });
  socket.on('wwBet', ms => {
    const q = wwQ(); if (!q || q.ww.step !== 'bet' || !Array.isArray(ms)) return;
    const n = q.ww.slots.length;
    const list = ms.slice(0, 2).filter(m => m && Number.isInteger(m.slot) && m.slot >= 0 && m.slot < n).map(m => ({ slot: m.slot, extra: WW.extras.includes(+m.extra) ? +m.extra : 0 }));
    const extraSum = list.reduce((a, m) => a + m.extra, 0); if (extraSum > (player.score || 0)) list.forEach(m => { m.extra = 0; }); // 持っている点より多くは上乗せできない
    q.ww.bets.set(player.token, list);
    if ([...q.participants].every(t => q.ww.bets.has(t) || !room.players.get(t)?.connected)) wwFinish(room); else wwEmit(room);
  });
  // ── アニソン大富豪 ──
  const dfQ = () => { const q = room?.game?.q; return q?.df && player && q.participants.has(player.token) ? q : null; };
  socket.on('dfPlay', id => { if (dfQ()) dfPlay(room, player.token, String(id)); });
  socket.on('dfPass', () => { if (dfQ()) dfPass(room, player.token); });
  socket.on('dfPreview', id => {
    const q = dfQ(); if (!q) return;
    const now = Date.now(); if (now - (player.dxPrevAt || 0) < 700) return; player.dxPrevAt = now;
    const s = (q.df.hands.get(player.token) || []).find(x => x.id === String(id));
    if (s) socket.emit('wolfSong', { videoId: s.id, start: wolfStartOf(s), sec: DX_PREVIEW });
  });
  // ── アニソン・コードネーム ──
  const cnQ = () => { const q = room?.game?.q; return q?.cn && player && q.participants.has(player.token) ? q : null; };
  socket.on('cnClue', d => { const q = cnQ(); if (q && d && typeof d.word === 'string') cnClue(room, player.token, d.word, d.num); });
  socket.on('cnGuess', i => { const q = cnQ(); if (q) cnGuess(room, player.token, i); });
  socket.on('cnEnd', () => { const q = cnQ(); if (q && q.cn.step === 'guess' && q.cn.teams.get(player.token) === q.cn.turn && player.token !== q.cn.spy[q.cn.turn] && q.cn.guesses > 0) cnTurnEnd(room, 'ここまで'); });
  socket.on('cnChat', text => { // チームの一言チャット（同じチームの人だけに届く）
    const q = cnQ(); if (!q || typeof text !== 'string') return;
    const s = text.trim().slice(0, 40); if (!s) return;
    const now = Date.now(); if (now - (player.wolfChatAt || 0) < 600) return; player.wolfChatAt = now;
    const team = q.cn.teams.get(player.token);
    for (const t of q.participants) if (q.cn.teams.get(t) === team) { const p = room.players.get(t); if (p) io.to(p.socketId).emit('cnChat', { name: player.name, text: s, team }); }
  });
  // ── アニソン・ババ抜き ──
  const bbQ = () => { const q = room?.game?.q; return q?.bb && player && q.participants.has(player.token) ? q : null; };
  socket.on('bbDraw', i => { const q = bbQ(); if (q && q.bb.step === 'turn' && q.bb.turn === player.token) bbDraw(room, player.token, Number.isInteger(i) ? i : -1); });
  socket.on('bbPair', d => { const q = bbQ(); if (q && d && typeof d.a === 'string' && typeof d.b === 'string') bbPair(room, player.token, d.a, d.b); });
  socket.on('bbReady', () => {
    const q = bbQ(); if (!q || q.bb.step !== 'pair') return;
    q.bb.ready.add(player.token);
    if ([...q.participants].every(t => q.bb.ready.has(t) || !room.players.get(t)?.connected)) bbNextTurn(room); else bbEmit(room);
  });
  socket.on('bbPreview', id => {
    const q = bbQ(); if (!q) return;
    const now = Date.now(); if (now - (player.dxPrevAt || 0) < 700) return; player.dxPrevAt = now;
    const s = ALL_SONGS.find(x => x.id === String(id)), mine = (q.bb.hands.get(player.token) || []).some(c => c.id === String(id));
    if (s && mine) socket.emit('wolfSong', { videoId: s.id, start: wolfStartOf(s), sec: DX_PREVIEW });
  });
  // ── アニソン伝達クイズ ──
  socket.on('dtHint', text => { if (room && player) dtHint(room, player, text); });
  socket.on('dtPick', i => { if (room && player) dtPick(room, player, i); });
  socket.on('dtLock', () => { if (room && player) dtLock(room, player); });
  socket.on('dtPreview', i => { // 答える人だけ：選択肢の曲を自分だけ試聴（サビあたり20秒）
    const q = room?.game?.q, d = q?.dt; if (!d || d.step !== 'tell' || !player || player.token === d.teller || !q.participants.has(player.token) || !Number.isInteger(i)) return;
    const now = Date.now(); if (now - (player.dtPrevAt || 0) < 700) return; player.dtPrevAt = now;
    const s = d.choiceSongs[i]; if (s) socket.emit('wolfSong', { videoId: s.id, start: wolfStartOf(s), sec: DT_PLAY });
  });
  socket.on('dtListen', what => { // 伝える人だけ：イントロ／サビをもう一度聴く
    const q = room?.game?.q, d = q?.dt; if (!d || d.step !== 'tell' || !player || player.token !== d.teller) return;
    const now = Date.now(); if (now - (player.dtPrevAt || 0) < 700) return; player.dtPrevAt = now;
    const s = q.song; socket.emit('wolfSong', { videoId: s.id, start: what === 'chorus' && hasChorus(s) ? chorusOf(s) : (s.intro || 0), sec: DT_PLAY });
  });
  // ── アニソン・ディクシット ──
  const dixitQ = () => { const q = room?.game?.q; return q?.dx && player && q.participants.has(player.token) ? q : null; };
  socket.on('dxTell', d => {
    const q = dixitQ(); if (!q || q.dx.step !== 'tell' || q.dx.teller !== player.token || !d || typeof d.hint !== 'string') return;
    dixitTell(room, String(d.id), d.hint.trim().replace(/\s+/g, ' '));
  });
  socket.on('dxPick', id => {
    const q = dixitQ(); if (!q || q.dx.step !== 'pick' || q.dx.teller === player.token) return;
    const song = (room.game.dx.hands.get(player.token) || []).find(s => s.id === String(id)); if (!song) return;
    q.dx.picks.set(player.token, song); socket.emit('dixitHand', dixitHandOf(room, player.token));
    if ([...q.participants].every(t => t === q.dx.teller || q.dx.picks.has(t) || !room.players.get(t)?.connected)) dixitToVote(room); else dixitEmit(room);
  });
  socket.on('dxVote', i => {
    const q = dixitQ(); if (!q || q.dx.step !== 'vote' || q.dx.teller === player.token || !Number.isInteger(i) || !q.dx.cands[i] || q.dx.cands[i].owner === player.token) return;
    q.dx.votes.set(player.token, i);
    if ([...q.participants].every(t => t === q.dx.teller || q.dx.votes.has(t) || !room.players.get(t)?.connected)) dixitFinish(room); else dixitEmit(room);
  });
  socket.on('dxPreview', id => { // 試聴：自分の手札か、投票・結果の場に出ている曲だけ
    const q = dixitQ(); if (!q) return;
    const now = Date.now(); if (now - (player.dxPrevAt || 0) < 700) return; player.dxPrevAt = now;
    const d = q.dx, sid = String(id);
    const s = (room.game.dx.hands.get(player.token) || []).find(x => x.id === sid) || (['vote', 'result'].includes(d.step) ? d.cands?.find(c => c.song.id === sid)?.song : null);
    if (s) socket.emit('wolfSong', { videoId: s.id, start: wolfStartOf(s), sec: DX_PREVIEW });
  });
  // ── アニソン人狼 ──
  const wolfQ = () => { const q = room?.game?.q; return q?.wolf && player && q.participants.has(player.token) ? q : null; };
  socket.on('wolfHint', text => {
    const q = wolfQ(); if (!q || q.wolf.step !== 'hint' || typeof text !== 'string') return;
    const s = text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 20); if (!s) return;
    q.wolf.hints.set(player.token, s);
    if ([...q.participants].every(t => q.wolf.hints.has(t) || !room.players.get(t)?.connected)) wolfStep(room, 'talk'); else wolfEmit(room);
  });
  socket.on('wolfChat', text => {
    const q = wolfQ(); if (!q || !['talk', 'vote'].includes(q.wolf.step) || typeof text !== 'string') return;
    const s = text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60); if (!s) return;
    const now = Date.now(); if (now - (player.wolfChatAt || 0) < 800) return; player.wolfChatAt = now; // 連投を防ぐ
    q.wolf.chat.push({ id: player.id, name: player.name, text: s }); q.wolf.chat = q.wolf.chat.slice(-80);
    io.to(room.code).emit('wolfChat', { id: player.id, name: player.name, text: s });
  });
  socket.on('wolfReady', () => { // 話し合いを終えて投票へ（全員そろったら）
    const q = wolfQ(); if (!q || q.wolf.step !== 'talk') return;
    q.wolf.talkDone.add(player.token);
    if ([...q.participants].every(t => q.wolf.talkDone.has(t) || !room.players.get(t)?.connected)) wolfStep(room, 'vote'); else wolfEmit(room);
  });
  socket.on('wolfVote', id => {
    const q = wolfQ(); if (!q || q.wolf.step !== 'vote' || id === player.id) return;
    if (![...q.participants].some(t => room.players.get(t)?.id === id)) return;
    q.wolf.votes.set(player.token, id);
    if ([...q.participants].every(t => q.wolf.votes.has(t) || !room.players.get(t)?.connected)) wolfTally(room); else wolfEmit(room);
  });
  socket.on('wolfGuess', i => {
    const q = wolfQ(); if (!q || q.wolf.step !== 'guess' || player.token !== q.wolf.wolfToken || !Number.isInteger(i)) return;
    wolfFinish(room, i);
  });
  socket.on('dkBuy', key => {
    const g = room?.game; if (!g?.dkShop || !player?.dk || g.dkShop.done.has(player.token)) return;
    const c = DK_CARDS.find(x => x.key === key); if (!c) return;
    const price = c.key === 'vp' ? DK_VP + player.dk.vp : c.price;
    if (player.dk.coins < price) return socket.emit('notice', 'コインが足りません');
    if (c.key === 'steal' && ![...room.players.values()].some(x => x !== player && x.dk && x.dk.coins > 0)) return socket.emit('notice', '奪えるコインを持っている人がいません');
    player.dk.coins -= price;
    if (c.key === 'vp') { player.dk.vp++; player.score += DK_VP_PTS; }
    else if (c.key === 'vp2') { player.dk.vp2 = (player.dk.vp2 || 0) + 1; player.score += 2500; }
    else if (['boost', 'boost3', 'invest', 'invest2'].includes(c.key)) player.dk[c.key] = (player.dk[c.key] || 0) + 1;
    else if (c.key === 'gift') { const k = DK_LIFE[crypto.randomInt(DK_LIFE.length)]; player.lifelines[k] = (player.lifelines[k] || 0) + 1; socket.emit('notice', `🎁 ${DK_CARDS.find(x => x.key === k).label} が当たりました`); }
    else if (c.key === 'steal') {
      const rich = [...room.players.values()].filter(x => x !== player && x.dk && x.dk.coins > 0).sort((a, b) => b.dk.coins - a.dk.coins)[0];
      const n = Math.min(2, rich.dk.coins); rich.dk.coins -= n; player.dk.coins += n;
      io.to(room.code).emit('notice', `🧲 ${player.name} が ${rich.name} から ${n}コイン奪いました`);
    }
    else player.lifelines[c.key] = (player.lifelines[c.key] || 0) + 1;
    broadcastRoom(room);
  });
  socket.on('dkDone', () => {
    const g = room?.game; if (!g?.dkShop || !player) return;
    g.dkShop.done.add(player.token);
    io.to(room.code).emit('dkShopProgress', { done: [...g.dkShop.done].map(t => room.players.get(t)?.id) });
    if (connectedPlayers(room).every(p => g.dkShop.done.has(p.token))) finishDkShop(room);
  });
  socket.on('gzChoose', key => { const pk = room?.game?.gz?.pick; if (pk && player && pk.token === player.token) gzChoose(room, String(key)); });
  socket.on('panelChoose', idx => {
    const pk = room?.game?.panelPick;
    if (!pk || !player || pk.token !== player.token || !Number.isInteger(idx)) return;
    panelChoose(room, idx);
  });
  socket.on('pokerBet', amount => {
    const g = room?.game;
    if (!room || !player || room.settings.play !== 'poker' || !g?.pokerBet?.open || g.pokerBet.bets.has(player.token)) return;
    const a = +amount; if (!pokerBetOptions(player).includes(a)) return;
    g.pokerBet.bets.set(player.token, a);
    const ps = pokerPlayers(room);
    io.to(room.code).emit('pokerBetProgress', { done: ps.filter(p => g.pokerBet.bets.has(p.token)).length, total: ps.length, decided: ps.filter(p => g.pokerBet.bets.has(p.token)).map(p => p.id) });
    if (ps.every(p => g.pokerBet.bets.has(p.token))) finishPokerBet(room);
  });
  socket.on('pokerDiscard', ids => {
    if (!room || !player || room.settings.play !== 'poker' || !Array.isArray(ids)) return;
    const hand = player.hand || [];
    if (hand.length <= POKER_HAND) return;
    const drop = new Set(ids.filter(x => typeof x === 'string'));
    const next = hand.filter(c => !drop.has(c.id));
    player.hand = next.length >= POKER_HAND ? next.slice(0, Math.max(POKER_HAND, next.length)) : hand;
    if (player.hand.length > POKER_HAND) player.hand = poker.bestFive(player.hand).cards; // 捨て方が足りなければ、いちばん強い5枚を残す
    sendPokerHand(room, player); broadcastRoom(room);
  });
  socket.on('fillPass', on => { if (room && player) onFillPass(room, player, on === true); });
  // 3つ埋めバトル：押した人が「10択で選ぶ」を開いた → 出た選択肢を記録（パスの下の左側）
  socket.on('fillChoices', key => {
    const q = room?.game?.q, f = q?.fill?.find(x => x.key === key && !x.by);
    if (!f || q.buzz?.token !== player?.token || f.peeked) return;
    f.peeked = true; // 10択が出た枠は、もう誰も手で打てない（選択肢は記録で全員に見えるので）。10択（半分の点）でだけ答えられる
    qlog(room, player, { type: 'choices', label: f.label, choices: f.choices.map(c => c.title) });
    broadcastRoom(room);
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

  // 部屋から出る（ロビーで。ゲーム中は出ない）：席ごと消す。ホストだったら、残った人の誰かがホストになる
  socket.on('leaveRoom', (_, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    if (!room || !player) return done({ ok: true });
    if (room.state === 'playing') return done({ ok: false, error: 'ゲーム中は出られません' });
    const r = room;
    r.players.delete(player.token);
    socket.leave(r.code);
    room = null; player = null;
    if (connectedPlayers(r).length === 0) r.emptySince = Date.now();
    else ensureHost(r);
    broadcastRoom(r);
    done({ ok: true });
  });

  socket.on('disconnect', () => {
    if (!room || !player || player.socketId !== socket.id) return;
    player.connected = false;
    if (room.game?.q?.buzz?.token === player.token) onAnswer(room, player, { drop: true });
    if (room.game?.q?.phase === 'picking' && room.game.q.picker === player.token) finishPick(room, null);
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
      else if ((q.phase === 'intro' || q.phase === 'chorus') && (q.fill ? !q.buzz && fillAllPassed(room, q) :
               [...q.participants].every(t => !room.players.get(t)?.connected || q.answers.has(t)))) reveal(room);
    }
    broadcastRoom(room);
  });
});

// 空き部屋の掃除
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (r.emptySince && now - r.emptySince > ROOM_TTL) { rooms.delete(code); pushRoomList(); }
}, 60 * 1000);

const restored = Promise.race([
  datalog.restore(() => ({ requests: REQUESTS, candidates: CANDIDATES, promotes: PROMOTES, fixes: FIXES, reports: REPORTS, songGenres: SONG_GENRES, songFame: SONG_FAME, fameResets: SONG_FAME_RESETS, couplingReports: CW_REPORTS, playStats: PSTATS, infoFixes: INFO_FIXES, liveSongs: LIVE_SONGS }), () => USERS),
  new Promise(res => setTimeout(() => res({}), 8000)), // GitHub が遅いときは待ちすぎない
]).then(({ data: d, users } = {}) => {
  if (users && typeof users === 'object') { USERS = { ...USERS, ...users }; console.log(`マイページを記録から戻しました（${Object.keys(users).length}人）`); }
  if (!d) return;
  if (Array.isArray(d.requests)) REQUESTS = d.requests;
  if (Array.isArray(d.candidates)) CANDIDATES = d.candidates;
  if (d.promotes) PROMOTES = d.promotes;
  if (d.fixes) { FIXES = d.fixes; applyFixes(); }
  if (d.liveSongs) { LIVE_SONGS = d.liveSongs; loadSongs(); }
  if (d.infoFixes) { INFO_FIXES = d.infoFixes; applyInfoFixes(); CATS = null; buildSeries(); }
  if (d.reports) REPORTS = d.reports;
  if (d.songGenres) { SONG_GENRES = d.songGenres; buildSeries(); }
  if (d.couplingReports) CW_REPORTS = d.couplingReports;
  if (d.playStats) PSTATS = d.playStats;
  if (d.songFame) { SONG_FAME = d.songFame; Object.assign(SONG_FAME_RESETS, d.fameResets || {}); applyFame(); }
  console.log('記録から戻しました（リクエスト・投票・修正など）');
});
process.on('SIGTERM', async () => { await datalog.flush(); process.exit(0); });
restored.then(() => server.listen(PORT, () => console.log(`イントロクイズ対戦サーバー起動: http://localhost:${PORT} （曲 ${SONGS.length} 件）`)));
