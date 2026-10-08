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
  SONGS = ALL_SONGS.filter(s => s.id && s.embeddable !== false && !s.retired); // retired：収録曲一覧の「削除を依頼」で出題から外した曲（データは残す）
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

// ── 曲リクエスト（トップ画面の「出してほしい曲」）──
// 公開サーバーは再起動（反映）すると書き込んだファイルが消えるので、反映の前に tools/pull-requests.js で手元に取り込んでから曲を追加する。
// status: open（受付中）／added（追加済み）／notfound（見つからず）
const REQUESTS_PATH = path.join(__dirname, 'data', 'requests.json');
let REQUESTS = [];
try { REQUESTS = JSON.parse(fs.readFileSync(REQUESTS_PATH, 'utf8')); } catch (e) { REQUESTS = []; }
const REQ_MAX = 300, REQ_INTERVAL = 60 * 1000; // 受付中は最大300件、同じ人（IP）からは1分に1件
const reqLast = new Map();
const reqNorm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s!！?？・〜~～()（）\-♪.。,、'"「」『』]/g, '');
const reqText = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
function saveRequests() {
  try { fs.writeFileSync(REQUESTS_PATH + '.tmp', JSON.stringify(REQUESTS, null, 1) + '\n'); fs.renameSync(REQUESTS_PATH + '.tmp', REQUESTS_PATH); } catch (e) { /* 保存できなくても受付は続ける */ }
}
app.get('/api/requests', (req, res) => res.json({
  requests: REQUESTS.slice(-500).reverse(),
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
  if (Date.now() - (reqLast.get(ip) || 0) < REQ_INTERVAL) return res.status(429).json({ error: '少し時間をおいてから送ってください（1分に1件まで）' });
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

// ── 収録曲一覧（トップ画面の「収録曲一覧」）と、イントロ・サビ位置の修正の受け付け ──
// 修正は誰でも送れる。曲データにはすぐ入れず「修正待ち」として溜め、反映の前に tools/pull-fixes.js で取り込む（公開サーバーは再起動でファイルが消えるため）。
const FIXES_PATH = path.join(__dirname, 'data', 'fixes.json');
let FIXES = {};
try { FIXES = JSON.parse(fs.readFileSync(FIXES_PATH, 'utf8')); } catch (e) { FIXES = {}; }
const fixLast = new Map(); // IP → 直近の送信時刻（連投を防ぐ）
function saveFixes() {
  try { fs.writeFileSync(FIXES_PATH + '.tmp', JSON.stringify(FIXES, null, 1) + '\n'); fs.renameSync(FIXES_PATH + '.tmp', FIXES_PATH); } catch (e) { /* 保存できなくても受付は続ける */ }
}
app.get('/api/catalog', (req, res) => {
  loadSongs();
  // 自動チェック（tools/scan_videos.py）で「原曲でない・サビの位置がずれているかも」とされた曲
  let flags = {};
  try { flags = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'scan-flags.json'), 'utf8')); } catch (e) { flags = {}; }
  res.json({
    genres: GENRE_KEYS.map(k => ({ key: k, label: GENRES[k].label })),
    fame: FAME.map(([k, label]) => ({ key: k, label })),
    songs: SONGS.map(s => ({ id: s.id, title: s.title, work: s.work, artist: s.artist, year: s.year, type: s.type || '',
      genres: genresOf(s), fame: fameOf(s), intro: s.intro || 0, chorus: chorusOf(s), chorusKnown: s.chorus > 0, fix: FIXES[s.id] || null, warn: flags[s.id] || null,
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
  res.json({ ok: true, message: `「${song.title}」の修正を受け付けました（次の更新で反映されます）` });
});

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
  if (!['wrong', 'delete'].includes(kind)) return res.status(400).json({ error: '種類が正しくありません' });
  const ip = String(req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();
  const recent = (reportLast.get(ip) || []).filter(t => Date.now() - t < 60 * 1000);
  if (recent.length >= 5) return res.status(429).json({ error: '少し時間をおいてから送ってください（1分に5件まで）' });
  reportLast.set(ip, [...recent, Date.now()]);
  const r = REPORTS[id] || { title: song.title, work: song.work, wrong: 0, delete: 0, notes: [] };
  r[kind] = (r[kind] || 0) + 1;
  r.notes = [...(r.notes || []), { kind, note, at: new Date().toISOString() }].slice(-20);
  REPORTS[id] = r;
  try { fs.writeFileSync(REPORTS_PATH + '.tmp', JSON.stringify(REPORTS, null, 1) + '\n'); fs.renameSync(REPORTS_PATH + '.tmp', REPORTS_PATH); } catch (e) { /* 保存できなくても受付は続ける */ }
  res.json({ ok: true, message: kind === 'wrong' ? `「${song.title}」を「曲が違う」として受け付けました（次の更新で探し直します）`
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
  questions: [5, 10, 20, 30],
  mode: ['score', 'buzz'],
  answerMode: ['choice', 'input'],
  clues: [true, false],
  lifelines: [true, false],
  quizType: ['intro', 'sabimae', 'mix', 'random', 'outro'], // イントロ／サビ前／1問ごとにランダム／どこから（曲の途中）／アウトロ（曲の終わり）
  // 遊び方：ふつう／早押し（押した人だけ答える）／サバイバル（ライフがなくなったら脱落）／出題者（順番に1人が曲を選ぶ）／協力（全員の正解数で目標）／ビンゴ
  play: ['normal', 'buzzer', 'survival', 'picker', 'coop', 'bingo', 'fill'], // fill：3つ埋めバトル（曲名・アニメ名・アーティストを早押しで埋める）
  target: ['song', 'work', 'year', 'artist'], // 答えるもの：曲名／作品／年／歌手
  speed: ['1', '1.5', '2', '0.75', '0.5', 'random'], // 再生速度（問題の間ずっと。答え合わせでふつうに戻す）
  coopGoal: [50, 70, 90],                 // 協力：問題数×人数の何%正解で達成
  lockSec: [15, 3, 5, 10, 20, 30],        // 3つ埋めバトル：間違えた人が押せない秒数
  noRepeat: [false, true],                // 3つ埋めバトル：間違えた人は、ほかの人が押すまで押せない（連続解答なし）
  lives: [1, 2, 3],                       // サバイバルのライフ
  teams: [false, true],                   // チーム戦（赤・青の2チーム。合計点で競う）
  leadSec: [3, 5, 10],                   // サビ前：サビの何秒前から流すか
  autoNext: [8, 12, 0],                  // 答え合わせから自動で次へ進むまでの秒数（0 は自動で進まない）
  bonus: [true, false],                  // 連続正解ボーナス・最終問題2倍
  topic: ['all', 'series', ...GENRE_KEYS], // お題：全部／作品を選ぶ／ジャンル（data/genres.json）
  introPlays: [1, 2, 3],                 // イントロを流す回数（わからなかったときのため、頭から流し直す）
  noExclude: [false, true],              // 前に出た曲・ログを貼った曲も出す（除外しない。同じゲームの中で重なることはない）
  noRecord: [false, true],               // これから遊ぶ曲を除外に追加しない（ロビーの一番上のボタン）
};

const AVATARS = 12; // 席ごとに割り当てるアバター画像の数（public/assets/glass/avatar-1〜12）
const DEFAULTS = { introLen: 5, hintAt: 10, chorusLen: 15, choices: 8, mode: 'score', questions: 10, maxPlayers: 12,
                   yearFrom: 1980, yearTo: 2029, answerMode: 'choice', clues: true, lifelines: false, typingExtra: 10,
                   quizType: 'intro', leadSec: 5, autoNext: 8, bonus: true, topic: 'all', introPlays: 1, noExclude: false, noRecord: false,
                   play: 'normal', target: 'song', lives: 1, teams: false, speed: '1', coopGoal: 70, lockSec: 15, noRepeat: false };
const SURVIVAL_MAX = 50; // サバイバルは問題数の代わりに、終わるまで出す（最大この問題数）
const BUZZ_SEC = 10;     // 早押し：押した人が答えられる秒数
const BUZZ_MISS = 200;   // 早押し：お手つき（間違い・時間切れ）の減点
const YEAR_POINTS = [1000, 800, 600, 400, 200, 200]; // 年代当て：ずれ 0〜5 年の得点（それ以上は 0）
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
  // できない組み合わせ：年代当て＋早押し、サバイバル＋チーム戦
  if (s.target === 'year' && s.play === 'buzzer') s.play = 'normal';
  if (['survival', 'coop', 'bingo'].includes(s.play) && s.teams) s.teams = false; // サバイバル・協力・ビンゴはチーム戦にしない（3つ埋めバトルはできる。お手つきはチームで共有）
  return s;
}

// 部屋の年代設定に合う曲
function poolFor(settings) {
  // 知名度はお題に関係なく、チェックした段階の曲だけにする（難しさの調整）
  const fame = Array.isArray(settings.fame) && settings.fame.length ? settings.fame : FAME_KEYS;
  return SONGS.filter(s => s.year >= settings.yearFrom && s.year <= settings.yearTo && inTopic(s, settings) && fame.includes(fameOf(s))
    && !(settings.play === 'fill' && genresOf(s).includes('lol'))); // 3つ埋めバトルに LoL の曲は出さない
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
    createdAt: Date.now(), // 部屋を作った時刻（部屋一覧・部屋の中で表示）
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
    hostId: room.hostId,
    settings: room.settings,
    poolSize: poolFor(room.settings).length,
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
      team: room.settings.teams ? p.team || null : null, lives: p.lives ?? null, out: !!p.out,
      buzzing: q?.buzz?.token === p.token, // 早押しでいま答えている人
      card: room.settings.play === 'bingo' && p.card ? p.card.map(c => ({ w: c.w, open: c.open })) : null, bingo: !!p.bingoAt,
      picker: q?.picker === p.token,
      passed: !!q?.fillPass?.has(p.token), // 3つ埋めバトルでパスした人
    })),
    fill: fillPublic(room, q),
    teams: teamScores(room),
    coop: room.game?.coop || null,
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
function recordPlayed(room, s) {
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
  const pool = poolFor(S);
  if (pool.length === 0) return false;
  if (S.play === 'picker' && connectedPlayers(room).length < 2) return 'picker'; // 出題者モードは2人以上
  // サビ前だけの部屋は、サビの位置が確かな曲から出す（足りなければ全部から）
  let candidates = pool;
  if (S.quizType === 'sabimae') {
    const sure = pool.filter(hasChorus);
    if (sure.length >= S.questions) candidates = sure;
  }
  // この部屋で前のゲームに出た曲・貼り付けたログの曲は避ける。足りなければ古く除外した曲から戻して使う
  if (!room.played) room.played = new Set();
  const want = S.play === 'survival' ? SURVIVAL_MAX : S.questions; // サバイバルは終わるまで（最大 SURVIVAL_MAX 問）
  const need = Math.min(want, candidates.length);
  let fresh = S.noExclude ? [...candidates] : candidates.filter(s => !room.played.has(s.id));
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
    p.lives = S.play === 'survival' ? S.lives : null; p.out = false; p.outAt = 0; // サバイバル：ライフ・脱落・何問目で脱落したか
  }
  if (S.teams) assignTeams(room);
  // 曲オブジェクトそのものを持つ（ゲーム中に曲データが保存し直されても影響しないように）
  const order = weightedPick([...fresh.map(s => [s, 1]), ...popular.map(s => [s, POPULAR_REPEAT])], n);
  if (!S.noRecord) order.forEach(s => recordPlayed(room, s));
  room.gameNo = (room.gameNo || 0) + 1; // この部屋で何ゲーム目か（曲ログ用）
  room.game = { order, pool, qi: -1, q: null, timers: [], stats: new Map(), // stats: token -> 称号用の成績
                bingoTarget: S.target, // ビンゴのマスの種類（ゲームの途中で答えるものを変えても、配ったカードのまま）
                solo: connectedPlayers(room).length <= 1 }; // サバイバル：1人で遊ぶときはライフがなくなるまで、2人以上なら残り1人まで
  // 協力：目標は「問題数 × 人数 × 目標%」をゲーム開始時に決める（途中で人数が変わっても変えない）
  if (S.play === 'coop') room.game.coop = { goal: Math.max(1, Math.ceil(order.length * connectedPlayers(room).length * S.coopGoal / 100)), count: 0 };
  // ビンゴ：一人ひとりにカードを配る（途中から入った人には入ったときに配る）
  for (const p of room.players.values()) { p.card = S.play === 'bingo' ? bingoCard(order, pool, S.target) : null; p.bingoAt = 0; p.reachN = 0; p.bingoLinesN = 0; }
  nextQuestion(room);
  return true;
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
    ...shuffle(pool.filter(s => near(s))).map(s => s.work),
    ...shuffle(pool.filter(s => !near(s))).map(s => s.work),
    ...shuffle(SONGS.filter(s => !pool.includes(s))).map(s => s.work),
    ...shuffle(DECOYS.map(([, work]) => work)),
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
function buildArtistChoices(song, count, pool) {
  const near = s => Math.abs(s.year - song.year) <= NEAR_YEARS;
  const seen = new Set([artistKey(song.artist)]);
  const picks = [];
  const candidates = [
    ...shuffle(pool.filter(s => near(s))).map(s => s.artist),
    ...shuffle(pool.filter(s => !near(s))).map(s => s.artist),
    ...shuffle(SONGS.filter(s => !pool.includes(s))).map(s => s.artist),
  ];
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

// ── 3つ埋めバトル：1曲ごとに「曲名・アニメ名・アーティスト」（ボカロは「曲名・作者・VOCALOID」）の枠を、早押しで埋める ──
const FILL_CHOICES = 10;   // 10択で答えるときの選択肢の数（10択は点数が半分）
const FILL_BUZZ_SEC = 20;  // 押した人が枠を選んで答えられる秒数
const FILL_LOCK_SEC = 5;   // 間違えた人が押せない秒数
const VOCALS = ['初音ミク', '鏡音リン', '鏡音レン', '巡音ルカ', 'GUMI', 'IA', 'v flower', 'KAITO', 'MEIKO', '歌愛ユキ', '重音テト', '可不'];
const authorOf = s => String(s.work || '').normalize('NFKC').match(/^ボカロ\((.+)\)$/)?.[1] || s.artist;
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
    const vocaloids = SONGS.filter(s => s.type === 'ボカロ' && s !== song);
    const slots = [slot('title', '曲名', 'title', title),
      slot('author', '作者', 'author', fillChoices(authorOf(song), shuffle(vocaloids.map(authorOf)), FILL_CHOICES))];
    if (song.vocal?.length) {
      const ch = fillChoices(song.vocal[0], shuffle(VOCALS.filter(v => !song.vocal.includes(v))), FILL_CHOICES);
      slots.push(slot('vocal', 'VOCALOID', 'vocal', ch));
    } else if (song.singer?.length) {
      // 本人が歌っている動画（米津玄師・Eve など）は、3つ目の枠を「歌手」にする
      const ch = fillChoices(song.singer[0], shuffle([...new Set(SONGS.filter(s => s !== song).map(s => s.artist))]), FILL_CHOICES);
      slots.push(slot('singer', '歌手', 'singer', ch));
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
  // 終わり：全部出した、またはサバイバルで残りがいなくなった（qi は最後に出した問題のまま）
  if (g.qi + 1 >= g.order.length || survivalOver(room)) return endGame(room); // ビンゴも問題数まで（そろったらボーナス点）
  g.qi++;
  if (room.settings.play === 'picker') return startPicking(room);
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
  const chosen = typeof id === 'string' ? SONGS.find(s => s.id === id && !done.has(s.id)) : null;
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
  const g = room.game;
  const S = room.settings;
  // ミックスでも、サビの位置が仮の曲はイントロで出す
  const kind = S.quizType === 'mix' ? (hasChorus(song) && crypto.randomInt(2) ? 'sabimae' : 'intro') : S.quizType;
  // サビ前問題は「サビ − leadSec 秒」から流す（イントロより前にはしない）。「どこから」は曲の途中のどこか
  const start = kind === 'sabimae' ? Math.max(song.intro || 0, chorusOf(song) - S.leadSec)
              : kind === 'random' ? randomStart(song) : kind === 'outro' ? outroStart(song, S.hintAt) : (song.intro || 0);
  // 答えるもの：年 → 年を選ぶ／作品 → 作品名の選択肢（入力なら作品名だけ正解）／曲名 → いつもの選択肢
  const years = S.target === 'year' ? yearRange(S, song) : null;
  const input = S.answerMode === 'input' && !years;
  const { choices, correctIndex } = S.play === 'fill' ? { choices: null, correctIndex: null } // 3つ埋めバトルは枠ごとの選択肢（buildFill）
    : years ? { choices: null, correctIndex: years.indexOf(song.year) }
    : input ? { choices: null, correctIndex: null }
    : S.target === 'work' ? buildWorkChoices(song, S.choices, g.pool)
    : S.target === 'artist' ? buildArtistChoices(song, S.choices, g.pool)
    : buildChoices(song, S.choices, g.pool);
  g.q = {
    song, choices, correctIndex, kind, start, years,
    phase: 'loading', t0: 0,
    ready: new Set(),
    answers: new Map(), // token -> { index, given, pass, elapsed, correct, points, hint }
    participants: new Set(connectedPlayers(room).filter(p => !p.out && p.token !== picker).map(p => p.token)), // 脱落した人・出題者は見ているだけ
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
    qNo: g.qi + 1, qTotal: g.order.length,
    videoId: q.song.id, intro: q.song.intro || 0, start: q.start, kind: q.kind,
    final: room.settings.bonus && isFinalQuestion(room),
    answerMode: q.years ? 'year' : room.settings.answerMode === 'input' ? 'input' : 'choice',
    choices: q.choices, years: q.years, settings: room.settings,
    play: room.settings.play, target: room.settings.target, speed: q.speed || 1,
    pickerId: q.picker ? room.players.get(q.picker)?.id : null, pickerName: q.picker ? room.players.get(q.picker)?.name : null,
    fill: fillPublic(room, q),
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
  if (q?.phase === 'picking') return socket.emit('picking', pickingPayload(room));
  if (!q || (!q.participants.has(token) && q.picker !== token) || q.phase === 'reveal') return; // 出題者は答えないが、問題は見られるように送り直す
  const S = room.settings;
  socket.emit('question', questionPayload(room));
  if (q.phase === 'intro' || q.phase === 'chorus') {
    const offset = (Date.now() - q.t0) / 1000;
    socket.emit('go', { intro: q.song.intro || 0, start: q.start, kind: q.kind, hintAt: q.hintAt || S.hintAt,
                        total: q.total || questionTotal(S), offset, introLen: S.introLen, plays: q.plays || 1, gap: INTRO_GAP, speed: q.speed || 1 });
    if (q.phase === 'chorus') socket.emit('hint', { chorus: chorusOf(q.song), known: q.song.chorus > 0, intro: q.song.intro || 0, seek: q.kind !== 'sabimae' });
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
  io.to(room.code).emit('go', { intro: q.song.intro || 0, start: q.start, kind: q.kind, hintAt, total: q.total, offset: -LEAD_MS / 1000,
                                introLen: S.introLen, plays, gap: INTRO_GAP, speed: q.speed || 1 });
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
    io.to(room.code).emit('hint', { chorus: chorusOf(q.song), known: q.song.chorus > 0, intro: q.song.intro || 0, seek: q.kind !== 'sabimae' }); // どこから問題はサビへ移動する
    broadcastRoom(room);
  }, hintAt * 1000);
  if (S.clues && !q.fill) { // 3つ埋めバトルは、ヒント（年・歌手・作品の頭文字）が枠の答えになるので出さない
    // ビンゴは頭文字のヒント（「〇」から始まる作品）を出さない（カードのマスがすぐ分かってしまうので）
    clueList(q.song, S.target).filter(c => !(S.play === 'bingo' && c.label === '作品')).forEach((c, i) => later(room, () => {
      if (q.phase !== 'intro' && q.phase !== 'chorus') return;
      q.clues.push(c);
      io.to(room.code).emit('clue', c);
    }, (hintAt + S.chorusLen * i / 3) * 1000));
  }
  later(room, () => { if (q.buzz) q.revealPending = true; else reveal(room); }, q.total * 1000); // 押して答えている最中なら、答え終わるまで待つ
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
  const streakBonus = p => (S.bonus ? Math.round(p * (player.streak >= 3 ? 1.5 : player.streak === 2 ? 1.2 : 1)) : p);
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
  player.score += points;
  q.answers.set(player.token, { index, given, pass, elapsed, correct, points, hint, diff, miss });
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
  if ((S.mode === 'buzz' && q.winner && !q.years) || remaining.length === 0) reveal(room);
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
      correct = payload.index === slot.correctIndex || (slot.key === 'vocal' && (song.vocal || []).includes(c.title));
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
    if (!q.fill.some(f => f.by)) st.first++; // その曲でいちばん最初に枠を埋めた
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
function onBuzz(room, player) {
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
    q.buzzQueue.push({ token: player.token, at: Date.now() });
    q.fillPass.delete(player.token);
    emitQueue(room, q);
    return broadcastRoom(room);
  }
  startBuzz(room, player, Date.now());
}
// 押した人の番を始める（at：押した時刻。早いほど高い点）
function startBuzz(room, player, at) {
  const q = room.game.q;
  if (q.fill && !q.fillWait.has(player.token)) { for (const t of q.fillWait) io.to(room.players.get(t)?.socketId).emit('fillWaitEnd'); q.fillWait.clear(); }
  else if (q.fill) q.fillWait.delete(player.token);
  const now = Date.now(), sec = q.fill ? FILL_BUZZ_SEC : BUZZ_SEC;
  if (q.fill) q.fillPass.delete(player.token); // 押したらパスは取り消し
  // 押しても曲と進行（サビへ・時間切れ）は止めない。時間切れが答えている最中に来たら、答え終わってから答え合わせ（endBuzz）
  q.buzz = { token: player.token, elapsed: (at - q.t0) / 1000, at: now, until: now + sec * 1000 };
  q.buzz.timer = setTimeout(() => { if (room.game?.q === q && q.buzz?.token === player.token) onAnswer(room, player, { timeout: true }); }, sec * 1000);
  io.to(room.code).emit('buzz', { id: player.id, name: player.name, sec, queue: queueNames(room, q) });
  broadcastRoom(room);
}
// 答える人の番が終わった（間違い・時間切れ・抜けた）：順番待ちがいれば次の人へ、いなければ、また誰でも押せる。曲は流れたまま
function endBuzz(room) {
  const g = room.game, q = g?.q, b = q?.buzz;
  if (!b) return;
  clearTimeout(b.timer); q.buzz = null;
  io.to(room.code).emit('buzzEnd', { ms: 0 });
  if (q.revealPending) return setImmediate(() => { if (room.game?.q === q && q.phase !== 'reveal') reveal(room); }); // 答えている間に時間切れになっていた
  // 3つ埋めバトル：押した順の次の人（抜けた人・その間にお手つきで押せなくなった人は飛ばす）
  while (q.fill && q.buzzQueue?.length) {
    const e = q.buzzQueue.shift(), p = room.players.get(e.token);
    if (!p?.connected || !fillCanBuzz(room, q, p)) { if (p?.connected) io.to(p.socketId).emit('notice', 'お手つきの間だったので、順番を飛ばしました'); continue; }
    emitQueue(room, q);
    return startBuzz(room, p, e.at);
  }
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
  // 答えなかった人は連続正解が途切れる
  for (const t of q.participants) if (!q.answers.has(t)) { const p = room.players.get(t); if (p) p.streak = 0; }
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
               lives: p.lives ?? null, out: !!p.out, team: S.teams ? p.team : null };
    })
    // 正解した人が上（同じなら速い順）。年代当ては点数（近さ）の順
    .sort((a, b) => (q.years || q.fill ? (b.points - a.points) : (b.correct - a.correct)) || ((a.elapsed ?? 99) - (b.elapsed ?? 99)));
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
  const last = room.game.qi + 1 >= room.game.order.length || survivalOver(room);
  io.to(room.code).emit('reveal', {
    eliminated, picker, bingo, bingoBonus, coop: room.game.coop || null, reach: (q.reach || []).filter(n => !bingo.includes(n)),
    correctIndex: q.correctIndex,
    qlog: (q.qlog || []).map(({ token, ...e }) => e), // 出題中の記録（全員分。パスの下）
    // 3つ埋めバトル：枠ごとの正解・埋めた人・10択の正解の番号
    fill: q.fill ? q.fill.map(f => ({ key: f.key, label: f.label, by: f.by ? room.players.get(f.by)?.name || '' : null, given: f.given,
                                       answer: f.key === 'title' ? s.title : f.key === 'work' ? s.work : f.key === 'artist' ? s.artist
                                         : f.key === 'author' ? authorOf(s) : f.key === 'singer' ? s.singer[0] : (s.vocal || []).join('・'),
                                       correctIndex: f.correctIndex })) : null,
    song: { id: s.id, title: s.title, work: s.work, artist: s.artist, year: s.year, type: s.type },
    log: playedLog(room), // ここまでに出た曲（ページを読み込み直した人も曲ログをコピーできるように）
    intro: s.intro || 0, chorus: chorusOf(s), chorusKnown: s.chorus > 0,
    results,
    highlights: [...highlightsOf(room, results), ...eliminated.map(n => `${n} 脱落…`), ...bingoBonus.map(b => `${b.name} ${b.first ? 'BINGO!' : 'もう1列そろった！'} +${b.bonus}点`),
                 ...(picker ? [`出題者 ${picker.name} +${picker.points}（${picker.of}人中 ${picker.correct}人正解）`] : [])],
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
  if (!m.has(player.token)) m.set(player.token, { correct: 0, time: 0, chorus: 0, retro: 0, maxStreak: 0, genres: {},
                                                   reiwa: 0, first: 0, typed: 0, choice: 0, miss: 0, pass: 0 });
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
    top(s => s.first, 2, '一番乗り', s => `いちばん最初の正解 ${s.first}回`),
    top(s => s.typed, 3, '手書きの達人', s => `書いて ${s.typed}回正解`),
    top(s => s.choice, 2, '10択の申し子', s => `10択で ${s.choice}回正解`),
    top(s => s.reiwa, 2, '令和マスター', s => `2019年以降の曲を ${s.reiwa}問正解`),
    top(s => s.miss, 3, 'お手つき大王', s => `お手つき ${s.miss}回（攻めた証）`),
    top(s => s.pass, 3, '見送りの達人', s => `パス ${s.pass}回`),
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

// サバイバルの終わり：2人以上で始めたら残り1人以下、1人ならライフがなくなったとき
function survivalOver(room) {
  if (room.settings.play !== 'survival' || !room.game) return false;
  const alive = [...room.players.values()].filter(p => p.connected && !p.out).length;
  return room.game.solo ? alive === 0 : alive <= 1;
}
const isFinalQuestion = room => room.settings.play !== 'survival' && room.game.qi + 1 >= room.game.order.length && room.game.order.length > 1;

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
  if ((poolChanged || S.questions !== g.paused.questions) && !['picker', 'bingo'].includes(S.play)) {
    const done = g.order.slice(0, g.qi + 1), rest = g.order.slice(g.qi + 1);
    const pool = poolChanged ? poolFor(S) : g.pool;
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
  const ranking = [...room.players.values()]
    .map(p => {
      // ふりかえり用：正解数・正解したときの平均タイム・いちばん長い連続正解
      const s = room.game.stats.get(p.token);
      return { id: p.id, name: p.name, avatar: p.avatar, score: p.score,
               correct: s?.correct || 0, avg: s?.correct ? Math.round(s.time / s.correct * 100) / 100 : null, maxStreak: s?.maxStreak || 0,
               team: room.settings.teams ? p.team : null,
               survived: survival ? (p.out ? p.outAt : played) : null, out: survival ? !!p.out : null,
               bingoAt: p.bingoAt || 0 };
    })
    // サバイバルは長く残った順（最後まで残った人が上）、ビンゴはそろえた人が上、同じなら得点の順
    .sort((a, b) => (survival ? (b.out === a.out ? b.survived - a.survived : a.out - b.out) : 0)
      || b.score - a.score); // ビンゴも得点で競う（BINGO はボーナス点として入っている）
  const teams = teamScores(room)?.sort((a, b) => b.score - a.score) || null;
  const coop = room.game.coop ? { ...room.game.coop, done: room.game.coop.count >= room.game.coop.goal } : null;
  io.to(room.code).emit('gameover', { total: played, ranking, teams, survival, coop, bingo: room.settings.play === 'bingo', titles: titlesOf(room), log: playedLog(room), roomLog: room.history });
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
    if (!isHost() || room.state === 'playing') return;
    room.played = new Set(); room.playedHere = new Set();
    broadcastRoom(room);
  });
  // ロビーの「このルームで流した曲の除外を解除」：この部屋で流した曲だけ除外から外す（前から除外していた曲・貼り付けたログの曲は残す）
  socket.on('clearPlayedHere', () => {
    if (!isHost() || room.state === 'playing') return;
    for (const id of room.playedHere || []) room.played.delete(id);
    room.playedHere = new Set();
    broadcastRoom(room);
  });

  socket.on('start', () => {
    if (!isHost() || room.state === 'playing') return;
    const r = startGame(room);
    if (r === 'picker') socket.emit('notice', '出題者モードは2人以上で遊べます');
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

  socket.on('buzz', () => { if (room && player) onBuzz(room, player); });
  socket.on('pickSong', id => { if (room?.game?.q?.phase === 'picking' && room.game.q.picker === player?.token) finishPick(room, id); });
  // チーム戦：待機中に自分のチームを切り替える／ホストがシャッフル
  socket.on('setTeam', team => {
    if (!room || !player || !room.settings.teams || room.state === 'playing' || !TEAMS.includes(team)) return;
    player.team = team; broadcastRoom(room);
  });
  socket.on('shuffleTeams', () => {
    if (!isHost() || !room.settings.teams || room.state === 'playing') return;
    const ps = shuffle([...room.players.values()]);
    ps.forEach((p, i) => { p.team = TEAMS[i % 2]; });
    broadcastRoom(room);
  });
  socket.on('answer', (payload = {}) => {
    // timeout・drop はサーバーの中だけで使う（画面から送られても無視）
    if (room && player) onAnswer(room, player, { index: payload?.index, text: payload?.text, year: payload?.year, pass: payload?.pass, slot: payload?.slot });
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

server.listen(PORT, () => console.log(`イントロクイズ対戦サーバー起動: http://localhost:${PORT} （曲 ${SONGS.length} 件）`));
