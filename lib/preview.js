// 追加プレビュー画面（public/preview.html）の API。このPCから開いたときだけ使える。
// 元データ data/preview.json は tools/build-preview.js が作る。追加・見送りの状態は data/preview-state.json に残す。
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

module.exports = function mountPreview(app, { canEdit, root, loadSongs, candidates, saveCandidates }) {
  const P = n => path.join(root, 'data', n);
  const SONGS_PATH = P('songs.json');
  const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
  const writeJson = (p, v) => { fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 1) + '\n'); fs.renameSync(p + '.tmp', p); };
  const guard = (req, res, next) => (canEdit(req) ? next() : res.status(403).json({ error: 'このPCから開いたときだけ使えます' }));
  const OFFICIAL = /- Topic$|公式|official|records|music|ミュージック|entertainment|sony|avex|lantis|victor|king|pony|bandai|nbc|kadokawa|toho|aniplex|warner|universal|columbia/i;
  const BAD = /MAD|AMV|歌ってみた|cover|カバー|弾いてみた|piano|ピアノ|カラオケ|karaoke|オルゴール|instrumental|nightcore|リミックス|remix|実機|実戦/i;
  const VID = /^[A-Za-z0-9_-]{11}$/;
  const state = () => readJson(P('preview-state.json'), {});

  // 有名度の目安：いちばん上の動画の再生回数が、いまのカタログの曲の中でどのへんか
  function fameGuess(views, sorted) {
    if (!views || !sorted.length) return null;
    const pct = sorted.filter(v => v <= views).length / sorted.length;
    const [key, label] = pct >= .9 ? ['top', '超有名'] : pct >= .7 ? ['famous', '有名'] : pct >= .4 ? ['normal', '普通'] : pct >= .15 ? ['minor', 'マイナー'] : ['otaku', 'オタク'];
    return { key, label, pct: Math.round(pct * 100) };
  }

  app.get('/api/preview', guard, (req, res) => {
    const songs = readJson(SONGS_PATH, []);
    const ids = new Set(songs.map(s => s.id));
    const sorted = songs.map(s => s.views).filter(v => v > 0).sort((a, b) => a - b);
    const st = state();
    const data = readJson(P('preview.json'), { rows: [] });
    const rows = data.rows.map(r => {
      const yt = (r.yt || []).map(v => ({ ...v, official: OFFICIAL.test(v.ch || ''), bad: BAD.test(v.title || ''), inCatalog: ids.has(v.id) }));
      const top = yt.find(v => !v.bad && !v.inCatalog) || yt[0];
      return { ...r, yt, state: st[r.key] || null, fame: fameGuess(top?.views, sorted), searched: r.yt != null };
    });
    const cands = (candidates() || []).filter(c => c.status === 'pending').map(c => ({
      ...c, state: st['cand:' + c.id] || null, fame: fameGuess(c.views, sorted), inCatalog: ids.has(c.videoId || c.id),
    }));
    // 追加したがまだ測っていない曲
    const unmeasured = songs.filter(s => s.source === '追加プレビュー' && s.embeddable !== false && !(s.introMeasured || s.intro > 0 || s.introMethod)).map(s => s.id);
    res.json({ builtAt: data.builtAt || null, rows, candidates: cands, unmeasured: songs.filter(s => s.source === '追加プレビュー' && !s.viewsAt).map(s => ({ id: s.id, title: s.title })), unmeasuredIds: unmeasured });
  });

  // YouTube を検索（見つからなかった曲用）
  app.post('/api/preview/search', guard, (req, res) => {
    const q = String(req.body?.q || '').trim().slice(0, 120);
    if (!q) return res.status(400).json({ error: '検索の言葉を入れてください' });
    const py = path.join(root, '.venv-embed', 'Scripts', 'python.exe');
    execFile(py, ['-m', 'yt_dlp', '--compat-options', 'no-certifi', '--js-runtimes', 'node', '--flat-playlist', '--no-warnings', '-q',
      '--print', '%(id)s|%(channel)s|%(view_count)s|%(title)s|%(duration)s', `ytsearch8:${q}`], { encoding: 'utf8', timeout: 60000 }, (err, out) => {
      if (err) return res.status(500).json({ error: '検索できませんでした（yt-dlp）' });
      const ids = new Set(readJson(SONGS_PATH, []).map(s => s.id));
      const results = out.trim().split('\n').filter(Boolean).map(l => {
        const [id, ch, v, ...t] = l.split('|'); const dur = Number(t.pop()) || 0; const title = t.join('|');
        return { id, ch, views: Number(v) || 0, title, dur, official: OFFICIAL.test(ch || ''), bad: BAD.test(title), inCatalog: ids.has(id) };
      });
      res.json({ results });
    });
  });

  // 追加：曲データへすぐ入れる。イントロ・サビが入っていればそのまま使い、空なら「あとで測定」にする
  app.post('/api/preview/add', guard, (req, res) => {
    const b = req.body || {};
    const id = String(b.videoId || '').trim();
    if (!VID.test(id)) return res.status(400).json({ error: '動画のIDが正しくありません' });
    const title = String(b.title || '').trim(), artist = String(b.artist || '').trim();
    if (!title || !artist) return res.status(400).json({ error: '曲名と歌手を入れてください' });
    const num = v => (v === '' || v == null ? null : Number(v));
    const intro = num(b.intro), chorus = num(b.chorus);
    for (const v of [intro, chorus]) if (v != null && !(v >= 0 && v <= 1200)) return res.status(400).json({ error: 'イントロ・サビの秒数が正しくありません' });
    const songs = readJson(SONGS_PATH, []);
    if (songs.some(s => s.id === id)) return res.status(400).json({ error: 'この動画はもう曲データに入っています' });
    const song = { id, title, work: String(b.work || '').trim() || 'その他', artist, year: parseInt(b.year, 10) || new Date().getFullYear(),
      type: String(b.type || '').trim() || 'その他', confidence: '中', source: '追加プレビュー', intro: 0, chorus: 0, aliases: [], embeddable: null };
    if (intro != null && intro > 0) song.intro = Math.round(intro * 10) / 10;
    if (chorus != null && chorus > 0) { song.chorus = Math.round(chorus * 10) / 10; song.chorusSource = 'manual'; song.chorusChecked = true; }
    songs.push(song);
    songs.sort((a, c) => (a.year - c.year) || a.title.localeCompare(c.title, 'ja'));
    fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH);
    // 記録（作り直しても消えないよう、いつもの取り込み用の CSV にも足す）
    const csv = P('catalog/additions-preview.csv'), q = v => `"${String(v).replace(/"/g, '""')}"`;
    if (!fs.existsSync(csv)) fs.writeFileSync(csv, 'year,title,work,artist,type,confidence,videoId,source,note\n');
    fs.appendFileSync(csv, [song.year, q(title), q(song.work), q(artist), q(song.type), '中', id, '追加プレビュー', ''].join(',') + '\n');
    const st = state(); const key = String(b.key || '');
    if (key) st[key] = { status: 'added', id, at: new Date().toISOString() };
    writeJson(P('preview-state.json'), st);
    if (key.startsWith('cand:')) { const c = candidates().find(x => 'cand:' + x.id === key); if (c) { c.status = 'added'; saveCandidates(); } }
    loadSongs();
    res.json({ ok: true, id, needsMeasure: !(song.intro > 0) || !(song.chorus > 0) });
  });

  app.post('/api/preview/skip', guard, (req, res) => {
    const key = String(req.body?.key || '');
    if (!key) return res.status(400).json({ error: 'key がありません' });
    const st = state();
    if (req.body?.undo) delete st[key]; else st[key] = { status: 'skipped', at: new Date().toISOString() };
    writeJson(P('preview-state.json'), st);
    res.json({ ok: true });
  });

  // 検討中の曲を足す（曲名・歌手などを入れる。動画は検索して選ぶ）
  app.post('/api/preview/candidate', guard, (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim(), artist = String(b.artist || '').trim();
    if (!title || !artist) return res.status(400).json({ error: '曲名と歌手を入れてください' });
    const id = VID.test(String(b.videoId || '')) ? b.videoId : 'm' + Date.now().toString(36);
    const list = candidates();
    if (list.some(c => c.id === id && c.status === 'pending')) return res.status(400).json({ error: 'もう検討中に入っています' });
    list.push({ id, title, work: String(b.work || '').trim(), artist, year: parseInt(b.year, 10) || 0, type: String(b.type || '').trim(), videoId: VID.test(id) ? id : '',
      views: Number(b.views) || 0, source: '手で追加', reason: String(b.reason || '手で検討中に追加'), votes: 0, status: 'pending', at: new Date().toISOString() });
    saveCandidates();
    res.json({ ok: true });
  });

  // まとめて測定：イントロ・サビ・再生回数・知名度・動画の確認。終わるまで時間がかかるので裏で走らせ、ログを返す
  let job = null;
  app.get('/api/preview/measure', guard, (req, res) => {
    let log = ''; try { log = fs.readFileSync(P('preview-measure.log'), 'utf8').split('\n').slice(-30).join('\n'); } catch (e) { /* まだない */ }
    res.json({ running: !!job, log });
  });
  app.post('/api/preview/measure', guard, (req, res) => {
    if (job) return res.status(400).json({ error: 'いま測定中です' });
    const ids = readJson(SONGS_PATH, []).filter(s => s.source === '追加プレビュー' && !s.viewsAt).map(s => s.id).filter(i => VID.test(i));
    if (!ids.length) return res.json({ ok: true, message: '測定する曲はありません' });
    const out = fs.openSync(P('preview-measure.log'), 'w');
    job = spawn('cmd', ['/c', path.join(root, 'tools', 'measure-new.cmd'), ids.join(',')], { cwd: root, stdio: ['ignore', out, out], windowsHide: true });
    job.on('exit', () => { job = null; try { loadSongs(); } catch (e) { /* 次の読み直しで反映 */ } });
    res.json({ ok: true, message: `${ids.length} 曲の測定を始めました` });
  });
};
