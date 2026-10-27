// 自分の YouTube アカウントに、アニソンの本物のプレイリストを作る（YouTube Data API。自分専用・非公開）。
// ・ジャンルごと／年代ごと（5年ずつ）は、知名度で絞った曲を「ジャンル → タイトル → 知名度 → 年」の順に入れる
// ・お気に入り・BGMで作ったプレイリストは、本番のマイページの中身をそのまま
// API の1日の枠（10,000）では、1曲足すのに50かかる → 1日190曲ほど。枠が切れたら止まり、次に実行すると続きから。
// どこまで入れたかは data/yt-playlists.json（git に入れない）。鍵は .yt-client.json・.yt-token.json（git に入れない）。
// 使い方:
//   node tools/yt-playlists.js --login                 はじめに1回（ブラウザで Google にログインして許可）
//   node tools/yt-playlists.js --dry                   作るものと曲数だけ見る（API は使わない）
//   node tools/yt-playlists.js                         作る・続きを足す
// オプション: --user 名前（お気に入り・プレイリストを入れる）／--fame top,famous（all で全部）／--only mine,genre,span／--limit 190
// 環境変数 YT_DIR：鍵と進み具合を置くフォルダ（初期値はこのリポジトリ）
const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');

const ROOT = process.env.YT_DIR || path.join(__dirname, '..');  // 鍵と進み具合を置くフォルダ（worktree から動かすときは本体を指す）
const SITE = process.env.LIVE_SITE || 'https://anison-intro-vs.onrender.com';
const CLIENT = path.join(ROOT, '.yt-client.json');
const TOKEN = path.join(ROOT, '.yt-token.json');
const STATE = path.join(ROOT, 'data', 'yt-playlists.json');
const SCOPE = 'https://www.googleapis.com/auth/youtube';
const PREFIX = 'アニソン｜';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const DRY = !!opt('dry'), LIMIT = +opt('limit', 190), USER = opt('user', '');
const FAME = String(opt('fame', 'top,famous')).split(',');
const ONLY = String(opt('only', 'mine,genre,span')).split(',');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1));

// ── Google にログイン（デスクトップアプリの OAuth。127.0.0.1 で受け取る） ──
function client() {
  const c = readJson(CLIENT, null);
  const x = c?.installed || c?.web;
  if (!x) { console.log('.yt-client.json がありません（Google Cloud の「OAuth クライアント ID（デスクトップ アプリ）」の JSON をこの名前で置いてください）'); process.exit(1); }
  return x;
}
async function tokenReq(body) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const j = await r.json();
  if (!r.ok) throw new Error('token: ' + JSON.stringify(j));
  return j;
}
async function login() {
  const c = client();
  const srv = http.createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${srv.address().port}`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: c.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent' });
  console.log('ブラウザで Google にログインして許可してください。開かないときはこのURLを開く:\n' + url);
  exec(`start "" "${url}"`);
  const code = await new Promise(resolve => srv.on('request', (req, res) => {
    const q = new URL(req.url, redirect).searchParams;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(q.get('code') ? '許可しました。この画面は閉じてください。' : 'うまくいきませんでした：' + (q.get('error') || ''));
    if (q.get('code') || q.get('error')) resolve(q.get('code'));
  }));
  srv.close();
  if (!code) { console.log('許可されませんでした'); process.exit(1); }
  const t = await tokenReq({ code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirect, grant_type: 'authorization_code' });
  writeJson(TOKEN, { refresh_token: t.refresh_token });
  console.log('ログインできました（.yt-token.json）');
}
let access = null;
async function accessToken() {
  if (access && access.until > Date.now()) return access.token;
  const c = client(), rt = readJson(TOKEN, {}).refresh_token;
  if (!rt) { console.log('先に node tools/yt-playlists.js --login'); process.exit(1); }
  const t = await tokenReq({ refresh_token: rt, client_id: c.client_id, client_secret: c.client_secret, grant_type: 'refresh_token' });
  access = { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 };
  return access.token;
}
class Quota extends Error {}
// YouTube は続けて足すと 409 SERVICE_UNAVAILABLE（The operation was aborted）や 5xx をよく返す → 少し待ってやり直す
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function yt(method, part, body) {
  for (let i = 0; ; i++) {
    try { return await ytOnce(method, part, body); }
    catch (e) {
      if (i >= 5 || e instanceof Quota || !(e.status >= 500 || e.status === 409 && /SERVICE_UNAVAILABLE|aborted/i.test(e.message))) throw e;
      await sleep(2000 * 2 ** i);
    }
  }
}
async function ytOnce(method, part, body) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${method}?part=${part}`, { method: 'POST', headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return j;
  const reason = j.error?.errors?.[0]?.reason || '';
  if (/quotaExceeded|rateLimitExceeded|dailyLimitExceeded/.test(reason)) throw new Quota(reason);
  const e = new Error(`${r.status} ${reason} ${j.error?.message || ''}`); e.status = r.status; e.reason = reason; throw e;
}

async function videoExists(id) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=id&id=${id}`, { headers: { Authorization: 'Bearer ' + await accessToken() } });
  const j = await r.json().catch(() => ({}));
  return !r.ok || !!j.items?.length;  // 調べられなかったときは「ある」扱い（勝手にとばさない）
}

// ── 作るプレイリスト ──
const spanOf = y => Math.floor(y / 5) * 5;
const spanLabel = x => `${String(Math.floor(x / 10) * 10).slice(2)}年代${x % 10 ? '後半' : '前半'}`;
// 本番が反映中・スリープ明け、PC起動直後でネットがまだのときは JSON が返らない → 30秒おきに10回まで待つ
async function siteJson(p) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(SITE + p); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) {}
    if (i >= 10) throw new Error(`本番（${SITE}${p.split('?')[0]}）から読めませんでした`);
    await sleep(30000);
  }
}
async function plan() {
  const cat = await siteJson('/api/catalog');
  const songs = cat.songs.filter(s => s.year);
  const byId = new Map(songs.map(s => [s.id, s]));
  const gi = new Map(cat.genres.map((g, i) => [g.key, i])), fi = new Map(cat.fame.map((f, i) => [f.key, i]));
  const g0 = s => Math.min(99, ...s.genres.map(k => gi.get(k) ?? 99));
  const byWork = (a, b) => a.work.localeCompare(b.work, 'ja') || (fi.get(a.fame) ?? 9) - (fi.get(b.fame) ?? 9) || a.year - b.year;
  const byGenre = (a, b) => g0(a) - g0(b) || byWork(a, b);
  const fameOk = s => FAME.includes('all') || FAME.includes(s.fame);
  const fameNote = FAME.includes('all') ? '' : `（${FAME.map(k => cat.fame.find(f => f.key === k)?.label || k).join('・')}）`;
  const out = [];
  if (ONLY.includes('mine') && USER) {
    const j = await siteJson('/api/user?name=' + encodeURIComponent(USER));
    if (!j?.user) console.log(`マイページ「${USER}」が見つかりません`);
    else {
      const u = j.user;
      const ids = l => l.map(id => byId.get(id)).filter(Boolean).map(s => s.id);
      out.push({ key: 'fav', title: PREFIX + 'お気に入り', ids: ids(u.fav || []) });
      for (const [n, l] of Object.entries(u.playlists || {})) out.push({ key: 'pl:' + n, title: PREFIX + n, ids: ids(l) });
    }
  }
  if (ONLY.includes('genre')) for (const g of cat.genres) {
    out.push({ key: 'genre:' + g.key, title: PREFIX + g.label + fameNote, ids: songs.filter(s => fameOk(s) && s.genres.includes(g.key)).sort(byWork).map(s => s.id) });
  }
  if (ONLY.includes('span')) for (const x of [...new Set(songs.map(s => spanOf(s.year)))].sort()) {
    out.push({ key: 'span:' + x, title: PREFIX + spanLabel(x) + fameNote, ids: songs.filter(s => fameOk(s) && spanOf(s.year) === x).sort(byGenre).map(s => s.id) });
  }
  return out.filter(p => p.ids.length);
}

async function main() {
  if (opt('login')) return login();
  const P = await plan();
  const st = readJson(STATE, { playlists: {} });
  let left = 0;
  for (const p of P) { const s = st.playlists[p.key]; const done = new Set([...(s?.added || []), ...(s?.skipped || [])]); p.todo = p.ids.filter(id => !done.has(id)); left += p.todo.length + (s?.id ? 0 : 1); }
  console.log(`プレイリスト ${P.length} 本、まだ足していない曲 ${left - P.filter(p => !st.playlists[p.key]?.id).length} 曲（1日 ${LIMIT} 回ほど → あと約 ${Math.ceil(left / LIMIT)} 日）`);
  if (DRY) { for (const p of P) console.log(`  ${p.title}：${p.ids.length}曲（残り ${p.todo.length}）`); return; }
  let n = 0;
  try {
    for (const p of P) {
      if (!p.todo.length && st.playlists[p.key]?.id) continue;
      if (n >= LIMIT) break;
      let s = st.playlists[p.key];
      if (!s?.id) {
        const j = await yt('playlists', 'snippet,status', { snippet: { title: p.title.slice(0, 150), description: 'アニソンイントロ対戦のBGMから作ったプレイリスト' }, status: { privacyStatus: 'private' } });
        s = st.playlists[p.key] = { id: j.id, title: p.title, added: [], skipped: [] }; n++; writeJson(STATE, st);
        console.log(`作りました：${p.title}`);
      }
      for (const id of p.todo) {
        if (n >= LIMIT) break;
        try {
          await yt('playlistItems', 'snippet', { snippet: { playlistId: s.id, resourceId: { kind: 'youtube#video', videoId: id } } });
          s.added.push(id);
          await sleep(500);
        } catch (e) {
          if (e instanceof Quota) throw e;
          if (/playlistNotFound/.test(e.reason)) { delete st.playlists[p.key]; writeJson(STATE, st); throw new Error(`「${p.title}」が YouTube にありません（消した？）。次の実行で作り直します`); }
          // 消えた・非公開の動画は failedPrecondition で返ることもある → 動画が本当に無いときだけとばす
          const gone = e.reason === 'failedPrecondition' && !(await videoExists(id));
          if (gone || e.status === 404 || e.status === 403 && /forbidden|videoNotFound/i.test(e.reason)) { s.skipped.push(id); console.log(`  入れられない動画（消えた・非公開など）：${id}`); }
          else { e.message += `（動画 ${id}）`; throw e; }
        }
        n++; writeJson(STATE, st);
      }
      console.log(`${p.title}：${s.added.length}／${p.ids.length}曲`);
    }
    console.log(n >= LIMIT ? `今日はここまで（${n}回）。明日また実行すると続きから足します` : 'ぜんぶ足し終わりました');
  } catch (e) {
    writeJson(STATE, st);
    if (e instanceof Quota) console.log(`今日の API の枠が切れました（${n}回）。明日（枠は日本時間の夕方16〜17時に戻ります）また実行すると続きから足します`);
    else { console.log('止まりました：' + e.message); process.exitCode = 1; }
  }
}
main().catch(e => { console.log("止まりました：" + e.message); process.exitCode = 1; });
