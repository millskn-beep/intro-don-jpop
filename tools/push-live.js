// 再起動なしの反映：手元で足した曲（計測ずみ）と、リクエスト・検討中の状態を、公開サーバーにそのまま送る。
// 遊んでいる部屋は切れない。送った曲は、次の「反映して」（git に入れて push）で songs.json としてそのまま残る。
// 使い方: node tools/push-live.js            （公開サーバーにない曲・リクエストの状態・検討中を送る）
//         node tools/push-live.js --ids a,b  （その曲も送る：位置などを直した既存の曲）
//         node tools/push-live.js --dry-run  （送らずに、送るものだけ出す）
// 鍵：初めて使うとき .live-key（git に入れない）を作り、その SHA-256 を data/live-key.sha256 に書く。
//     公開サーバーが data/live-key.sha256 を持つまで（一度「反映して」で出すまで）は送れない。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SITE = process.env.LIVE_SITE || 'https://anison-intro-vs.onrender.com'; // 試すときは LIVE_SITE=http://localhost:3001
const KEY_PATH = path.join(ROOT, '.live-key'), HASH_PATH = path.join(ROOT, 'data', 'live-key.sha256');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const args = process.argv.slice(2), DRY = args.includes('--dry-run');
const idsArg = args.includes('--ids') ? String(args[args.indexOf('--ids') + 1] || '').split(',').filter(Boolean) : [];

(async () => {
  if (!fs.existsSync(KEY_PATH)) {
    const key = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(KEY_PATH, key + '\n');
    fs.writeFileSync(HASH_PATH, crypto.createHash('sha256').update(key).digest('hex') + '\n');
    console.log('鍵を作りました（.live-key と data/live-key.sha256）。一度「反映して」で出すと、このあと送れるようになります');
  }
  const key = fs.readFileSync(KEY_PATH, 'utf8').trim();
  const songs = readJson(path.join(ROOT, 'data', 'songs.json'), []);
  const scan = readJson(path.join(ROOT, 'data', 'scan-videos.json'), {});
  const remote = await fetch(`${SITE}/api/songs`).then(r => r.json()).then(j => j.songs || []);
  const have = new Set(remote.map(s => s.id));
  const send = songs.filter(s => s.id && (!have.has(s.id) || idsArg.includes(s.id)))
    .map(s => (scan[s.id]?.dur > 0 && !s.dur ? { ...s, dur: scan[s.id].dur } : s)); // 曲の長さ（3つ埋めなどで使う）も付ける
  // リクエスト：手元で状態を変えたもの（追加済み・見つからず）
  const rreq = await fetch(`${SITE}/api/requests`).then(r => r.json()).then(j => j.requests || []).catch(() => []);
  const rst = new Map(rreq.map(r => [r.id, r.status]));
  const marks = readJson(path.join(ROOT, 'data', 'requests.json'), []).filter(r => rst.has(r.id) && rst.get(r.id) !== r.status)
    .map(r => ({ id: r.id, status: r.status, songId: r.songId, doneAt: r.doneAt }));
  const candidates = readJson(path.join(ROOT, 'data', 'candidates.json'), []);
  console.log(`送る曲 ${send.length} 曲${send.length ? '：' + send.slice(0, 30).map(s => s.title).join('、') + (send.length > 30 ? ' …' : '') : ''}`);
  console.log(`リクエストの状態 ${marks.length} 件、検討中 ${candidates.length} 曲`);
  if (DRY || (!send.length && !marks.length)) return;
  const res = await fetch(`${SITE}/api/live/push`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-live-key': key }, body: JSON.stringify({ songs: send, requests: marks, candidates }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { console.log(`送れませんでした：${j.error || res.status}（公開サーバーに鍵がまだないときは、一度「反映して」で出してください）`); process.exit(1); }
  console.log(`送りました：曲 ${j.songs}（新しい曲 ${j.added || 0}）・リクエスト ${j.requests}・検討中 ${j.candidates}。公開サーバーの曲数 ${j.total}`);
})().catch(e => { console.error('送れませんでした:', e.message); process.exit(1); });
