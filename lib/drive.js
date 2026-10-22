// ドライブの部屋：車のアプリ（アニソンドライブ）が問題を出し、助手席の人がスマホ（/drive.html）で4択に答える。
// 曲は車のスピーカーだけで流れる（スマホは音を出さない）。部屋はメモリだけ（6時間で消える）。
// 車：POST /api/drive/room → { code, key }（key は車だけが持つ合言葉）
//     POST /api/drive/q { code, key, qid, choices:[{t,w}], ms }   問題を出す（ms：答えられる長さ）
//     POST /api/drive/reveal { code, key, qid, correct }          答え合わせ → { ranking, results }
//     GET  /api/drive/host?code&key                               参加者と答えた人数
// スマホ：GET /api/drive/qr?code（QRコードの画像）・POST /api/drive/join・GET /api/drive/state・POST /api/drive/answer
// 選曲・設定（スマホ → 車）：スマホは POST /api/drive/cmd で指示を送り、車は GET /api/drive/pull で受け取る。
//     車は POST /api/drive/status でいまの様子（流れている曲・予約・絞り込み）を送り、スマホは /api/drive/state で受け取る。
//     曲の一覧：GET /api/drive/songs（data/drive-songs.json：車のアプリに入っている曲。tools/build-songs.js が作る）に読みがなを足したもの
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');

const ROOMS = new Map();
const TTL = 6 * 3600 * 1000;
const now = () => Date.now();
const clean = s => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16);

function sweep() { for (const [c, r] of ROOMS) if (now() - r.touched > TTL) ROOMS.delete(c); }
function newCode() { for (let i = 0; i < 50; i++) { const c = String(crypto.randomInt(1000, 10000)); if (!ROOMS.has(c)) return c; } return String(crypto.randomInt(10000, 100000)); }
const roomOf = (req, needKey) => {
  const b = { ...req.query, ...(req.body || {}) };
  const r = ROOMS.get(String(b.code || ''));
  if (!r) return null;
  if (needKey && b.key !== r.key) return null;
  r.touched = now();
  return r;
};
const ranking = r => [...r.players.values()].sort((a, b) => b.score - a.score).map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));

// スマホから送れる指示（それ以外は受け付けない）
const MODES = ['MIX', 'QUIZ', 'BGM', 'LISTEN'];
const GROUPS = ['kind', 'era', 'fame', 'genre'];
const SETTINGS = { quizEvery: [2, 3, 5], introSec: [10, 15, 20, 30], chorusSec: [10, 20, 30], mixListen: [true, false], listenKeep: [true, false], shuffle: [true, false] };
const str = (v, n = 80) => String(v ?? '').slice(0, n);
function cleanCmd(c) {
  if (!c || typeof c !== 'object') return null;
  switch (c.type) {
    case 'reserve': return ['quiz', 'after', 'bgm', 'play'].includes(c.how) && c.id ? { type: 'reserve', id: str(c.id, 40), how: c.how } : null;
    case 'unreserve': return c.rid ? { type: 'unreserve', rid: str(c.rid, 20) } : null;
    case 'mode': return MODES.includes(c.m) ? { type: 'mode', m: c.m } : null;
    case 'toggle': return GROUPS.includes(c.group) && c.key ? { type: 'toggle', group: c.group, key: str(c.key, 40) } : null;
    case 'clear': return GROUPS.includes(c.group) ? { type: 'clear', group: c.group } : null;
    case 'preset': case 'source': return { type: c.type, name: str(c.name) };
    case 'setting': return SETTINGS[c.name]?.includes(c.value) ? { type: 'setting', name: c.name, value: c.value } : null;
    case 'pause': case 'next': case 'chorus': case 'stop': return { type: c.type };
    case 'fav': return c.id ? { type: 'fav', id: str(c.id, 40) } : null;
  }
  return null;
}

module.exports = function drive(app, site, catalog) {
  // 曲の一覧（スマホの選曲用）：はじめて使うときに読んで、読みがな（サイトの曲データの別名）を足しておく
  let SONG_LIST = null;
  const songList = () => {
    if (SONG_LIST) return SONG_LIST;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'drive-songs.json'), 'utf8')); } catch (e) { return null; }
    const byId = new Map((catalog?.() || []).map(s => [s.id, s]));
    for (const s of j.songs) {
      const c = byId.get(s.id); if (!c) continue;
      const r = [...(c.aliases || []), ...(c.workAliases || []), ...(c.artistAliases || [])].filter(Boolean);
      if (r.length) s.r = [...new Set(r)].join(' ');
    }
    SONG_LIST = JSON.stringify(j);
    return SONG_LIST;
  };
  app.get('/api/drive/songs', (req, res) => {
    const body = songList(); if (!body) return res.status(404).json({ error: '曲の一覧がありません' });
    res.type('json').set('Cache-Control', 'public, max-age=3600').send(body);
  });
  // 部屋を作る。車が前の部屋の code と key を送ってきたら、その部屋を使い続ける（エンジンを切って戻ったとき）。
  // サーバーが止まって部屋が消えていたら、同じ番号で作り直す（QRコードが変わらないように）。scores：作り直すときに戻す点数。reset：点数を0に（いまは使っていない）
  app.post('/api/drive/room', (req, res) => {
    sweep();
    const b = req.body || {}, want = String(b.code || ''), wkey = String(b.key || '');
    const old = ROOMS.get(want);
    if (old && wkey && old.key === wkey) {
      old.touched = now();
      if (b.reset) { for (const p of old.players.values()) p.score = 0; old.q = null; }
      return res.json({ code: old.code, key: old.key, url: `${site(req)}/drive.html?c=${old.code}`, created: false });
    }
    const same = !old && /^\d{4,5}$/.test(want) && /^[0-9a-f]{24}$/.test(wkey);
    const code = same ? want : newCode(), key = same ? wkey : crypto.randomBytes(12).toString('hex');
    // 作り直した部屋：車が覚えていた点数（名前 → 点）を、同じ名前で入り直した人に戻す
    const restore = new Map();
    if (same && b.scores && typeof b.scores === 'object') for (const [n, v] of Object.entries(b.scores).slice(0, 30)) { const s = Math.round(Number(v)); if (clean(n) && s > 0 && s < 1e7) restore.set(clean(n), s); }
    ROOMS.set(code, { code, key, players: new Map(), q: null, touched: now(), seq: 0, cmds: [], status: null, restore });
    res.json({ code, key, url: `${site(req)}/drive.html?c=${code}`, created: true });
  });
  app.get('/api/drive/qr', async (req, res) => {
    const r = roomOf(req, false); if (!r) return res.status(404).end();
    const png = await QRCode.toBuffer(`${site(req)}/drive.html?c=${r.code}`, { margin: 1, width: 480 });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  });
  app.post('/api/drive/join', (req, res) => {
    const r = roomOf(req, false); if (!r) return res.status(404).json({ error: '部屋が見つかりません' });
    const name = clean(req.body?.name) || 'ゲスト';
    const pid = crypto.randomBytes(8).toString('hex');
    const score = r.restore?.get(name) || 0; r.restore?.delete(name);
    r.players.set(pid, { pid, name, score, joined: now() });
    res.json({ pid, name });
  });
  app.post('/api/drive/q', (req, res) => {
    const r = roomOf(req, true); if (!r) return res.status(403).json({ error: 'no room' });
    const { qid, choices, ms, setter } = req.body || {};
    if (!Array.isArray(choices)) return res.status(400).json({ error: 'bad' });
    r.q = { qid: String(qid), choices: choices.slice(0, 8).map(c => ({ t: String(c.t ?? '').slice(0, 80), w: String(c.w ?? '').slice(0, 80) })),
            start: now(), until: now() + Math.min(120000, Math.max(3000, +ms || 15000)), answers: new Map(), correct: null, results: null, setter: setter ? str(setter, 16) : '' };
    res.json({ ok: true });
  });
  app.post('/api/drive/answer', (req, res) => {
    const r = roomOf(req, false); const q = r?.q;
    const { pid, qid, idx } = req.body || {};
    if (!r || !q || !r.players.has(pid) || q.qid !== String(qid) || q.correct != null) return res.status(409).json({ error: '受け付けていません' });
    if (q.answers.has(pid)) return res.json({ ok: true, already: true });
    if (q.setter && r.players.get(pid).name === q.setter) return res.status(409).json({ error: '自分で出した問題には答えられません' });
    if (!Number.isInteger(idx) || idx < 0 || idx >= q.choices.length) return res.status(400).json({ error: 'bad' });
    q.answers.set(pid, { idx, at: now() });
    res.json({ ok: true });
  });
  // 答え合わせ：早く正解するほど高得点（500〜1000点。時間いっぱいで500点）
  app.post('/api/drive/reveal', (req, res) => {
    const r = roomOf(req, true); const q = r?.q;
    if (!r || !q || q.qid !== String(req.body?.qid)) return res.status(409).json({ error: 'no question' });
    if (q.correct == null) {
      q.correct = +req.body.correct;
      const span = Math.max(1, q.until - q.start);
      q.results = [];
      for (const [pid, a] of q.answers) {
        const p = r.players.get(pid); if (!p) continue;
        const ok = a.idx === q.correct;
        const pts = ok ? Math.round(500 + 500 * Math.max(0, 1 - (a.at - q.start) / span)) : 0;
        p.score += pts;
        q.results.push({ name: p.name, ok, pts, sec: Math.round((a.at - q.start) / 100) / 10 });
      }
      q.results.sort((a, b) => b.pts - a.pts);
    }
    res.json({ ranking: ranking(r), results: q.results });
  });
  app.get('/api/drive/host', (req, res) => {
    const r = roomOf(req, true); if (!r) return res.status(403).json({ error: 'no room' });
    res.json({ players: [...r.players.values()].map(p => ({ name: p.name, score: p.score, answered: !!r.q?.answers.has(p.pid) || (!!r.q?.setter && p.name === r.q.setter) })), answered: r.q ? r.q.answers.size : 0 });
  });
  app.get('/api/drive/state', (req, res) => {
    const r = roomOf(req, false); if (!r) return res.status(404).json({ error: '部屋が見つかりません' });
    const pid = String(req.query.pid || ''); const q = r.q;
    const me = r.players.get(pid);
    const out = { serverNow: now(), me: me ? { name: me.name, score: me.score } : null, ranking: ranking(r), players: r.players.size, status: r.status };
    if (q) {
      out.q = { qid: q.qid, choices: q.choices, until: q.until, phase: q.correct == null ? 'answer' : 'reveal', answered: q.answers.get(pid)?.idx ?? null, correct: q.correct, setter: q.setter || '' };
      if (q.correct != null) out.results = q.results;
    }
    res.json(out);
  });

  // ── 選曲・設定 ──
  // スマホ → 部屋：指示をためる（予約には取り消し用の番号をつける）
  app.post('/api/drive/cmd', (req, res) => {
    const r = roomOf(req, false); if (!r) return res.status(404).json({ error: '部屋が見つかりません' });
    const p = r.players.get(String(req.body?.pid || ''));
    if (!p) return res.status(403).json({ error: '参加してから操作してください' });
    const c = cleanCmd(req.body?.cmd); if (!c) return res.status(400).json({ error: 'bad' });
    c.seq = ++r.seq; c.by = p.name; c.at = now();
    if (c.type === 'reserve') c.rid = 'r' + c.seq;
    r.cmds.push(c); if (r.cmds.length > 100) r.cmds.splice(0, r.cmds.length - 100);
    res.json({ ok: true, seq: c.seq, rid: c.rid });
  });
  // 車：まだ受け取っていない指示と、参加者（after=-1：番号だけ受け取る。起動したとき、前の指示をやり直さないように）
  app.get('/api/drive/pull', (req, res) => {
    const r = roomOf(req, true); if (!r) return res.status(403).json({ error: 'no room' });
    const after = Number(req.query.after);
    res.json({ seq: r.seq, cmds: after < 0 ? [] : r.cmds.filter(c => c.seq > after),
      players: [...r.players.values()].map(p => ({ name: p.name, score: p.score, answered: !!r.q?.answers.has(p.pid) || (!!r.q?.setter && p.name === r.q.setter) })) });
  });
  // 車 → スマホ：いまの様子
  app.post('/api/drive/status', (req, res) => {
    const r = roomOf(req, true); if (!r) return res.status(403).json({ error: 'no room' });
    const s = req.body?.status;
    if (!s || typeof s !== 'object' || JSON.stringify(s).length > 60000) return res.status(400).json({ error: 'bad' });
    r.status = s;
    res.json({ ok: true });
  });
};
