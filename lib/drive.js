// ドライブの部屋：車のアプリ（アニソンドライブ）が問題を出し、助手席の人がスマホ（/drive.html）で4択に答える。
// 曲は車のスピーカーだけで流れる（スマホは音を出さない）。部屋はメモリだけ（6時間で消える）。
// 車：POST /api/drive/room → { code, key }（key は車だけが持つ合言葉）
//     POST /api/drive/q { code, key, qid, choices:[{t,w}], ms }   問題を出す（ms：答えられる長さ）
//     POST /api/drive/reveal { code, key, qid, correct }          答え合わせ → { ranking, results }
//     GET  /api/drive/host?code&key                               参加者と答えた人数
// スマホ：GET /api/drive/qr?code（QRコードの画像）・POST /api/drive/join・GET /api/drive/state・POST /api/drive/answer
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

module.exports = function drive(app, site) {
  app.post('/api/drive/room', (req, res) => {
    sweep();
    const code = newCode();
    ROOMS.set(code, { code, key: crypto.randomBytes(12).toString('hex'), players: new Map(), q: null, touched: now() });
    res.json({ code, key: ROOMS.get(code).key, url: `${site(req)}/drive.html?c=${code}` });
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
    r.players.set(pid, { pid, name, score: 0, joined: now() });
    res.json({ pid, name });
  });
  app.post('/api/drive/q', (req, res) => {
    const r = roomOf(req, true); if (!r) return res.status(403).json({ error: 'no room' });
    const { qid, choices, ms } = req.body || {};
    if (!Array.isArray(choices)) return res.status(400).json({ error: 'bad' });
    r.q = { qid: String(qid), choices: choices.slice(0, 8).map(c => ({ t: String(c.t ?? '').slice(0, 80), w: String(c.w ?? '').slice(0, 80) })),
            start: now(), until: now() + Math.min(120000, Math.max(3000, +ms || 15000)), answers: new Map(), correct: null, results: null };
    res.json({ ok: true });
  });
  app.post('/api/drive/answer', (req, res) => {
    const r = roomOf(req, false); const q = r?.q;
    const { pid, qid, idx } = req.body || {};
    if (!r || !q || !r.players.has(pid) || q.qid !== String(qid) || q.correct != null) return res.status(409).json({ error: '受け付けていません' });
    if (q.answers.has(pid)) return res.json({ ok: true, already: true });
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
    res.json({ players: [...r.players.values()].map(p => ({ name: p.name, score: p.score, answered: !!r.q?.answers.has(p.pid) })), answered: r.q ? r.q.answers.size : 0 });
  });
  app.get('/api/drive/state', (req, res) => {
    const r = roomOf(req, false); if (!r) return res.status(404).json({ error: '部屋が見つかりません' });
    const pid = String(req.query.pid || ''); const q = r.q;
    const me = r.players.get(pid);
    const out = { serverNow: now(), me: me ? { name: me.name, score: me.score } : null, ranking: ranking(r), players: r.players.size };
    if (q) {
      out.q = { qid: q.qid, choices: q.choices, until: q.until, phase: q.correct == null ? 'answer' : 'reveal', answered: q.answers.get(pid)?.idx ?? null, correct: q.correct };
      if (q.correct != null) out.results = q.results;
    }
    res.json(out);
  });
};
