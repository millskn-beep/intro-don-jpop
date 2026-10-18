import { createPlayer } from './player.js';
import { guessChorus } from './chorus-guess.js';
import { initLayout } from './layout.js';
import { CHARACTERS, FALLBACK, kanjiNum } from './characters.js';
import { initCharFx } from './charfx.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// マイページ：この端末でログインしている名前（me.html で登録。合言葉なし）
const meUser = () => { try { return localStorage.getItem('aq-user') || ''; } catch (e) { return ''; } };
let meData = null; // { fav, block, again, weak, ... }
async function loadMe() {
  const u = meUser();
  if (!u) { meData = null; return; }
  try { const r = await fetch('/api/user?name=' + encodeURIComponent(u)); meData = r.ok ? (await r.json()).user : null; } catch (e) { meData = null; }
}
async function meList(list, id, on) {
  const r = await fetch('/api/user/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: meUser(), list, id, on }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) meData = j.user;
  return r.ok ? null : (j.error || '送れませんでした');
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

// 席の鍵：再読み込みや切断のあとも同じ席に戻るため
let token = store.get('aq-token');
if (!token) { token = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now(); store.set('aq-token', token); }
$('nameInput').value = store.get('aq-name') || '';

const params = new URLSearchParams(location.search);
if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase();

// ── 画像（すりガラスのデザイン用。tools/gen-assets.js で生成）──
const ASSET = 'assets/glass/';
const avatarImg = (n, cls = 'avatar') => `<img class="${cls}" src="${ASSET}avatar-${n || 1}.webp" alt="">`;
const icon = (name, cls = 'icon') => `<img class="${cls}" src="${ASSET}icon-${name}.webp" alt="">`;

const WARMUP_VIDEO = 'o6wtDPVkKqI';
const socket = io();
socket.on('pingc', ack => { if (typeof ack === 'function') ack(); });
// ── 時計合わせ（賭ケ盟約と同じ方式）：端末の時計は performance.now() 基準（端末の時刻修正で飛ばない）。
// 直近の計測のうち往復の短い3回の中央値で、サーバーの時刻とのずれを推定する。早押しは、押した時刻をこのずれで直してサーバーに送る
const clientNow = () => performance.timeOrigin + performance.now();
let clockSamples = [], clockOffset = null, clockBurstTimer = null;
function clockPing() {
  const c = clientNow();
  socket.emit('clock', c, s => {
    const now = clientNow(), rtt = now - c;
    if (!(rtt >= 0 && rtt < 5000) || typeof s !== 'number') return;
    clockSamples.push({ rtt, offset: s - (c + rtt / 2), at: now });
    clockSamples = clockSamples.filter(x => now - x.at < 60000).slice(-16);
    const offs = [...clockSamples].sort((p, q) => p.rtt - q.rtt).slice(0, 3).map(x => x.offset).sort((p, q) => p - q);
    clockOffset = offs[Math.floor(offs.length / 2)];
  });
}
function clockBurst(n = 8) { clearInterval(clockBurstTimer); let i = 0; clockBurstTimer = setInterval(() => { if (socket.connected) clockPing(); if (++i >= n) clearInterval(clockBurstTimer); }, 120); }
socket.on('connect', () => { clockSamples = []; clockOffset = null; clockBurst(); });
setInterval(() => { if (document.visibilityState === 'visible' && socket.connected) clockPing(); }, 4000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && socket.connected) { clockSamples = []; clockBurst(); } });
window.addEventListener('online', () => { clockSamples = []; clockBurst(); }); // サーバーが回線の遅れを測るための合図（早押しの補正に使う）
let me = null, room = null, question = null, myAnswer = null, timerStart = 0, tick = null;
let myLifelines = null, answering = false; // answering: イントロ/サビ中で、まだ答えられる状態

const player = createPlayer('player', {
  onReadyToPlay: () => practice ? layoutApi.onReady() : wolfPending ? wolfStartPlayback() : socket.emit('ready'), // テスト1問のときはサーバーに送らない
  onError: code => { toast(`この動画は再生できません（エラー ${code}）`); socket.emit('playerError', { code }); },
});
$('volume').value = store.get('aq-vol') || 80;
player.setVolume(+$('volume').value);
$('volume').oninput = e => { player.setVolume(+e.target.value); store.set('aq-vol', e.target.value); };

// ── パスワードの保存（このブラウザだけ）──
// 入れたパスワードを部屋の合言葉ごとと部屋名ごとに覚えておき、次からは自動で使う
const passKey = { code: c => 'aq-pass:' + c, name: n => 'aq-pass-name:' + n };
function savedPassword(r) { return store.get(passKey.code(r.code)) || (r.name ? store.get(passKey.name(r.name)) : null) || ''; }
function savePassword(r, pw) {
  if (!pw) return;
  store.set(passKey.code(r.code), pw);
  if (r.name) store.set(passKey.name(r.name), pw);
}
function forgetPassword(r) {
  try { localStorage.removeItem(passKey.code(r.code)); if (r.name) localStorage.removeItem(passKey.name(r.name)); } catch (e) {}
}
$('roomPassInput').value = store.get('aq-host-pass') || '';
$('roomNameInput').value = store.get('aq-room-name') || '';

// ── ホーム ──
function myName(errEl) {
  const name = $('nameInput').value.trim();
  if (!name) { (errEl || $('homeError')).textContent = '名前を入れてください'; $('nameInput').focus(); return null; }
  store.set('aq-name', name);
  return name;
}
function createRoom() {
  const name = myName(); if (!name) return;
  const roomName = $('roomNameInput').value.trim(), password = $('roomPassInput').value;
  store.set('aq-room-name', roomName); store.set('aq-host-pass', password);
  player.prime(WARMUP_VIDEO); // タップの中で一度再生して、スマホの音声制限を解除する
  socket.emit('create', { token, name, roomName, password, user: meUser() }, res => {
    if (!res.ok) { $('homeError').textContent = res.error; return; }
    savePassword({ code: res.code, name: res.room.name }, password);
    joined(res);
    // 自分で作った部屋には、この端末に保存している「出た曲」を自動で除外として入れる
    const ids = deviceIds();
    if (ids.length) socket.emit('exclude', ids);
  });
}
// info: 一覧の部屋情報（code, name, locked）。onNeedPassword: パスワード入力を出す関数
function joinRoom(info, password, errEl, onNeedPassword) {
  const name = myName(errEl); if (!name) return;
  player.prime(WARMUP_VIDEO);
  const pw = password ?? savedPassword(info);
  socket.emit('join', { code: info.code, token, name, password: pw, user: meUser() }, res => {
    if (res.ok) { savePassword({ code: res.code, name: res.room.name }, pw); joined(res); return; }
    if (res.needPassword) {
      if (res.wrongPassword && password == null) forgetPassword(info); // 保存していたものが古かった
      if (onNeedPassword) { onNeedPassword(res.wrongPassword && password != null ? res.error : ''); return; }
    }
    (errEl || $('homeError')).textContent = res.error;
  });
}
$('createBtn').onclick = createRoom;
$('joinBtn').onclick = () => {
  const code = $('codeInput').value.trim().toUpperCase();
  joinRoom({ code }, undefined, null, msg => {
    const pw = window.prompt((msg ? msg + '\n' : '') + 'この部屋のパスワードを入力してください');
    if (pw != null) joinRoom({ code }, pw);
  });
};
$('codeInput').onkeydown = e => { if (e.key === 'Enter') $('joinBtn').click(); };

// ── 部屋一覧 ──
let roomsCache = [], listFilter = 'all';
socket.on('rooms', list => { roomsCache = list; renderRoomList(); });
$('listFilter').querySelectorAll('button').forEach(b => b.onclick = () => {
  listFilter = b.dataset.f;
  $('listFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  renderRoomList();
});
const ANSWER_LABEL = { choice: '選択肢', input: '入力' }, MODE_LABEL = { score: 'スコア制', buzz: '早押し' };
function renderRoomList() {
  const list = roomsCache.filter(r => listFilter === 'all' || r.state === listFilter);
  $('roomCount').textContent = roomsCache.length ? `（${roomsCache.length}）` : '';
  if (!list.length) { $('roomList').innerHTML = `<li class="empty">${roomsCache.length ? '該当する部屋はありません' : 'いま開いている部屋はありません。部屋を立ててみましょう'}</li>`; return; }
  $('roomList').innerHTML = list.map(r => {
    const full = r.players >= r.max;
    const state = full ? ['full', '満員'] : r.state === 'playing' ? ['playing', '対戦中'] : ['lobby', '募集中'];
    const years = r.yearFrom <= 1980 && r.yearTo >= 2029 ? '全年代' : `${r.yearFrom}〜${Math.min(r.yearTo, new Date().getFullYear())}年`;
    return `<li class="room-card" data-code="${esc(r.code)}">
      <div class="rc-top"><span class="rc-state ${state[0]}">${state[1]}</span><span class="rc-name">${r.locked ? '🔒 ' : ''}${esc(r.name)}</span></div>
      <div class="rc-meta"><span title="部屋を作った時刻">🕒 ${madeAt(r.createdAt)}</span><span>👤 ${r.players}/${r.max}</span><span>HOST ${esc(r.host)}</span><span>${r.questions}問</span><span>${ANSWER_LABEL[r.answerMode] || ''}・${MODE_LABEL[r.mode] || ''}</span><span>${years}</span></div>
      <div class="rc-join"><button class="btn-main" ${full ? 'disabled' : ''}>${r.state === 'playing' ? '途中から参加' : '入る'}</button></div>
      <p class="rc-err"></p>
    </li>`;
  }).join('');
  $('roomList').querySelectorAll('.room-card').forEach(card => {
    const info = roomsCache.find(r => r.code === card.dataset.code);
    const err = card.querySelector('.rc-err');
    card.querySelector('.rc-join .btn-main').onclick = () => joinRoom(info, undefined, err, msg => askPassword(card, info, msg));
  });
}
// パスワード付きの部屋：カードの中に入力欄を出す
function askPassword(card, info, msg) {
  const box = card.querySelector('.rc-join'), err = card.querySelector('.rc-err');
  box.innerHTML = `<input type="password" maxlength="32" placeholder="パスワード" autocomplete="off"><button class="btn-main">入る</button>`;
  err.textContent = msg || '';
  const input = box.querySelector('input'); input.focus();
  const go = () => { if (input.value) joinRoom(info, input.value, err, m => { err.textContent = m || 'パスワードが違います'; input.select(); }); };
  box.querySelector('button').onclick = go;
  input.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) go(); };
}

function joined(res) {
  me = res.you;
  store.set('aq-room', res.code);
  history.replaceState(null, '', '?room=' + res.code);
  socket.emit('unwatchRooms');
  $('home').hidden = true; $('roomListPanel').hidden = true; $('requestPanel').hidden = true; $('room').hidden = false;
  $('roomCode').hidden = false; $('roomCode').textContent = res.code;
  $('inviteUrl').value = location.origin + location.pathname + '?room=' + res.code;
  renderRoom(res.room);
}

// 接続したら：部屋にいれば同じ席に戻る。ホームなら部屋一覧を受け取る
// 新しい版がデプロイされたら（再接続時に版が変わったら）、対戦中でなければ自動で読み込み直す
let appVersion = null, reloadPending = false;
socket.on('version', v => {
  if (appVersion === null) { appVersion = v; return; }
  if (v === appVersion) return;
  if (!room || room.state !== 'playing') location.reload();
  else if (!reloadPending) { reloadPending = true; toast('新しい版が公開されました。部屋に戻ったときに自動で読み込み直します'); }
});
function reloadIfPending() { if (reloadPending) location.reload(); }

socket.on('connect', () => {
  // 部屋にいる途中の再接続、またはページを読み込み直した（URL の部屋が前回入っていた部屋と同じ）ときは、自動で同じ席に戻る
  const urlRoom = (params.get('room') || '').toUpperCase();
  const code = me ? store.get('aq-room') : (urlRoom && urlRoom === store.get('aq-room') ? urlRoom : null);
  if (code) socket.emit('join', { code, token, name: store.get('aq-name'), password: store.get(passKey.code(code)) || '', user: meUser() },
    res => res.ok ? joined(res) : leaveToHome(res.error));
  else socket.emit('watchRooms');
});
function leaveToHome(msg) {
  me = null; $('room').hidden = true; $('home').hidden = false; $('roomListPanel').hidden = false; $('requestPanel').hidden = false; loadRequests(); loadCandidates(); $('roomCode').hidden = true;
  $('homeError').textContent = msg || '';
  socket.emit('watchRooms');
}

// 部屋から出る（ロビーで）：席を消して最初の画面へ。前の部屋に自動で戻らないよう、覚えていた部屋も消す
$('leaveBtn').onclick = () => {
  if (!confirm('この部屋から出ますか？')) return;
  socket.emit('leaveRoom', null, res => {
    if (res && res.ok === false) return toast(res.error || '出られませんでした');
    store.set('aq-room', '');
    history.replaceState(null, '', location.pathname);
    room = null;
    leaveToHome('');
  });
};

$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText($('inviteUrl').value); toast('コピーしました'); }
  catch (e) { $('inviteUrl').select(); }
};

// ── 設定 ──
const SETTING_OPTIONS = {
  questions: [1, 3, 5, 10, 20, 30].map(n => [n, n + '問']),
  choices: Array.from({ length: 11 }, (_, i) => [i + 2, (i + 2) + '択']),
  introLen: [3, 5, 10, 15].map(n => [n, n + '秒']),
  hintAt: [5, 10, 15, 20].map(n => [n, n + '秒後']),
  chorusLen: [10, 15, 20].map(n => [n, n + '秒']),
  typingExtra: [5, 10, 15, 20, 30].map(n => [n, '最低 ' + n + '秒']),
  leadSec: [3, 5, 10].map(n => [n, n + '秒前']),
  introPlays: [[1, '1回'], [2, '2回'], [3, '3回']],
  autoNext: [[8, '8秒後'], [12, '12秒後'], [0, '自動で進まない']],
  maxPlayers: Array.from({ length: 11 }, (_, i) => [i + 2, (i + 2) + '人']),
  yearFrom: Array.from({ length: 50 }, (_, i) => [1980 + i, (1980 + i) + '年']),
  yearTo: Array.from({ length: 50 }, (_, i) => [1980 + i, (1980 + i) + '年']),
};
// 年代のかんたん設定
const PRESETS = [
  ['全年代', 1980, 2029], ['80年代', 1980, 1989], ['90年代', 1990, 1999],
  ['2000年代', 2000, 2009], ['2010年代', 2010, 2019], ['2020年代', 2020, 2029],
];
for (const [key, opts] of Object.entries(SETTING_OPTIONS)) {
  const sel = document.querySelector(`[data-key="${key}"]`);
  opts.forEach(([v, label]) => sel.add(new Option(label, v)));
}
const STRING_KEYS = ['mode', 'answerMode', 'quizType', 'topic', 'series', 'play', 'target', 'speed', 'bingoEnd', 'rushRate', 'karutaFace', 'wolfWork', 'wolfTitle', 'gzPick', 'gzSet'], BOOL_KEYS = ['clues', 'lifelines', 'bonus', 'noExclude', 'teams', 'noRepeat', 'buzzStop', 'noCoupling'];
function sendSettings(extra = {}) {
  const s = {};
  document.querySelectorAll('#settings select').forEach(x => {
    const k = x.dataset.key;
    s[k] = STRING_KEYS.includes(k) ? x.value : BOOL_KEYS.includes(k) ? x.value === 'true' : +x.value;
  });
  // 知名度のチェック（複数）
  const fame = [...$('fameList').querySelectorAll('input:checked')].map(x => x.value);
  if ($('fameList').querySelector('input')) s.fame = fame;
  socket.emit('settings', { ...s, ...extra });
}
document.querySelectorAll('#settings select').forEach(sel => sel.onchange = () => sendSettings());
$('presets').innerHTML = PRESETS.map(([label], i) => `<button class="btn-sub" data-p="${i}">${label}</button>`).join('');
$('presets').querySelectorAll('button').forEach(b => b.onclick = () => {
  const [, yearFrom, yearTo] = PRESETS[+b.dataset.p];
  sendSettings({ yearFrom, yearTo });
});
// お題の選択肢（ジャンルと作品）をサーバーから読み込む
let TOPIC_DATA = { genres: [], series: [] };
const topicLabel = S => S.topic === 'multi' ? `自由に選んだお題（ジャンル${(S.multiGenres || []).length}・作品${(S.multiSeries || []).length}）` : S.topic === 'series' ? (S.series || '作品') : S.topic === 'all' ? '全部' : S.topic === 'playlist' ? 'プレイリスト（お試し）' : S.topic === 'favorites' ? 'お気に入り' : S.topic === 'weak' ? '苦手な曲' : (TOPIC_DATA.genres.find(g => g.key === S.topic)?.label || 'お題');
fetch('/api/topics').then(r => r.json()).then(d => {
  TOPIC_DATA = d;
  const tp = document.querySelector('[data-key="topic"]');
  if (d.playlist > 0) tp.add(new Option(`プレイリスト（お試し・${d.playlist}曲）`, 'playlist'));
  tp.add(new Option('♡ お気に入り（部屋にいる人のマイページ）', 'favorites'));
  tp.add(new Option('🎯 苦手な曲（部屋にいる人のマイページ）', 'weak'));
  d.genres.forEach(g => tp.add(new Option(`${g.label}（${g.count}曲）`, g.key)));
  const se = document.querySelector('[data-key="series"]');
  d.series.forEach(s => se.add(new Option(`${s.name}（${s.count}曲）`, s.name)));
  $('cwInfo').textContent = d.coupling ? `（カップリング曲と分かっている ${d.coupling}曲）` : '';
  // 知名度のチェック欄（ホストが変える）
  $('fameList').innerHTML = (d.fame || []).map(f =>
    `<label><input type="checkbox" value="${esc(f.key)}" checked>${esc(f.label)}<small>${f.count}</small></label>`).join('');
  $('fameList').querySelectorAll('input').forEach(cb => cb.onchange = () => sendSettings());
  // 除外するジャンルのチェック欄
  $('genreExList').innerHTML = d.genres.map(g =>
    `<label><input type="checkbox" value="${esc(g.key)}">${esc(g.label)}<small>${g.count}</small></label>`).join('');
  $('genreExList').querySelectorAll('input').forEach(cb => cb.onchange = () =>
    socket.emit('excludeGenres', [...$('genreExList').querySelectorAll('input:checked')].map(x => x.value)));
  // 一括：全部チェック（全部出さない）・チェックを全部外す（全部出す）
  $('genreExAll').onclick = () => socket.emit('excludeGenres', d.genres.map(g => g.key));
  $('genreExNone').onclick = () => socket.emit('excludeGenres', []);
  if (room) renderRoom(room); // 選択肢がそろったので選ばれている値を入れ直す
}).catch(() => {});

// ── ジャンル制覇：集める種類を選ぶ（別の画面。EX は年代・曲の種類・知名度も選べて、何個でも。ふつうは、ジャンルから最大6つ）──
let catSel = new Set();
$('gzPickOpen').onclick = () => {
  const ex = room?.settings?.play === 'genreex';
  catSel = new Set(room?.settings?.gzPicks || []);
  renderCatPicker(ex);
  $('catPop').hidden = false;
};
function renderCatPicker(ex) {
  const cat = (TOPIC_DATA?.gzCatalog || []).filter(c => ex || c.group === 'genre'), max = ex ? 99 : 6;
  const G = { genre: 'ジャンル', era: '年代', type: '曲の種類', fame: '知名度' };
  const pop = $('catPop');
  pop.innerHTML = `<div class="wf-field mt-field cat-field"><div class="wf-head"><b>🏆 集める種類を選ぶ</b><span>${ex ? '何個でも選べます（2個以上）。選んだ種類を全部そろえた人の勝ち' : 'ジャンルを最大6つ選びます（2つ以上）'}</span></div>
    <div class="mt-tabs"><span class="cat-count" id="catCount"></span><button type="button" class="btn-sub" id="catClear">全部外す</button>${ex ? '<button type="button" class="btn-sub" id="catRand">おまかせで10個</button>' : ''}</div>
    <div class="mt-list cat-list">${Object.entries(G).filter(([g]) => cat.some(c => c.group === g)).map(([g, label]) => `<h4 class="cat-h">${label}</h4>${cat.filter(c => c.group === g).map(c => `<label class="${catSel.has(c.key) ? 'on' : ''}"><input type="checkbox" value="${esc(c.key)}"${catSel.has(c.key) ? ' checked' : ''}>${c.icon} ${esc(c.label)}<small>${c.count}</small></label>`).join('')}`).join('')}</div>
    <div class="mt-foot"><span id="catNote"></span><button type="button" class="btn-sub" id="catCancel">やめる</button><button type="button" class="btn-main" id="catOk">この内容で決める</button></div></div>`;
  const upd = () => { $('catCount').textContent = `選んだ種類：${catSel.size}${ex ? '' : ' / 6'}`; $('catOk').disabled = catSel.size < 2; $('catNote').textContent = catSel.size < 2 ? '2つ以上選んでください' : ''; };
  pop.querySelectorAll('.cat-list input').forEach(cb => cb.onchange = () => {
    if (cb.checked && catSel.size >= max) { cb.checked = false; return toast('ふつうのジャンル制覇は、最大6つまでです（EXなら何個でも）'); }
    cb.checked ? catSel.add(cb.value) : catSel.delete(cb.value); cb.parentElement.classList.toggle('on', cb.checked); upd();
  });
  $('catClear').onclick = () => { catSel.clear(); renderCatPicker(ex); };
  const rb = $('catRand'); if (rb) rb.onclick = () => { catSel = new Set([...cat].sort(() => Math.random() - .5).slice(0, 10).map(c => c.key)); renderCatPicker(ex); };
  $('catCancel').onclick = () => { $('catPop').hidden = true; };
  $('catOk').onclick = () => { sendSettings({ gzPicks: [...catSel] }); $('catPop').hidden = true; };
  upd();
}
// ── マイページの設定：保存（曲の範囲・遊び方・答え方・得点・部屋の設定）と、保存した設定を使う ──
$('prefSave').onclick = async () => {
  if (!meUser() || !room) return;
  try {
    const res = await fetch('/api/user/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: meUser(), settings: room.settings, excludeGenres: room.settings.excludeGenres }) });
    const j = await res.json().catch(() => ({}));
    toast(res.ok ? '💾 いまの設定をマイページに保存しました（次から、部屋を作るときに自動で使われます）' : (j.error || '保存できませんでした'));
  } catch (e) { toast('保存できませんでした（通信エラー）'); }
};
$('prefLoad').onclick = async () => {
  if (!meUser()) return;
  try {
    const j = await fetch('/api/user?name=' + encodeURIComponent(meUser())).then(r => r.json());
    const pf = j.user?.prefs;
    if (!pf) return toast('マイページに保存した設定がありません（先に「いまの設定を保存」を押してください）');
    socket.emit('settings', pf.settings);
    socket.emit('excludeGenres', pf.excludeGenres || []);
    toast('📂 保存した設定を使いました');
  } catch (e) { toast('読み込めませんでした'); }
};
// ── お題を自由に選ぶ（別の画面。ジャンル・作品を何個でも。選んだもののどれかに入る曲を出す）──
let multiAsked = false, multiSel = { g: new Set(), s: new Set() }, multiTab = 'g', multiQ = '';
$('multiOpen').onclick = () => openMulti();
function openMulti() {
  const S = room?.settings || {};
  multiSel = { g: new Set(S.multiGenres || []), s: new Set(S.multiSeries || []) }; multiQ = '';
  renderMulti(); $('multiPop').hidden = false;
}
function renderMulti() {
  const d = TOPIC_DATA; if (!d) return;
  const list = multiTab === 'g' ? d.genres.map(g => ({ key: g.key, label: g.label, count: g.count })) : d.series.map(s => ({ key: s.name, label: s.name, count: s.count }));
  const sel = multiTab === 'g' ? multiSel.g : multiSel.s;
  const q = multiQ.trim().toLowerCase(), shown = q ? list.filter(x => x.label.toLowerCase().includes(q)) : list;
  $('multiPop').innerHTML = `<div class="wf-field mt-field"><div class="wf-head"><b>🎯 お題を自由に選ぶ</b><span>選んだジャンル・作品のどれかに入る曲を出します（除外のチェックも効きます）</span></div>
    <div class="mt-tabs"><button type="button" class="btn-sub${multiTab === 'g' ? ' on' : ''}" data-mt="g">ジャンル（${multiSel.g.size}）</button><button type="button" class="btn-sub${multiTab === 's' ? ' on' : ''}" data-mt="s">作品・シリーズ（${multiSel.s.size}）</button>
      <input id="mtSearch" placeholder="${multiTab === 'g' ? 'ジャンルを探す' : '作品を探す（例：ガンダム）'}" value="${esc(multiQ)}" autocomplete="off">
      <button type="button" class="btn-sub" id="mtAll">表示中を全部選ぶ</button><button type="button" class="btn-sub" id="mtNone">表示中を全部外す</button></div>
    <div class="mt-list">${shown.map(x => `<label class="${sel.has(x.key) ? 'on' : ''}"><input type="checkbox" value="${esc(x.key)}"${sel.has(x.key) ? ' checked' : ''}>${esc(x.label)}<small>${x.count}</small></label>`).join('') || '<small>見つかりません</small>'}</div>
    <div class="mt-foot"><span>選んでいるもの：ジャンル ${multiSel.g.size}・作品 ${multiSel.s.size}</span><button type="button" class="btn-sub" id="mtCancel">やめる</button><button type="button" class="btn-main" id="mtOk">この内容で決める</button></div></div>`;
  const pop = $('multiPop');
  pop.querySelectorAll('[data-mt]').forEach(b => b.onclick = () => { multiTab = b.dataset.mt; multiQ = ''; renderMulti(); });
  pop.querySelectorAll('.mt-list input').forEach(cb => cb.onchange = () => { cb.checked ? sel.add(cb.value) : sel.delete(cb.value); cb.parentElement.classList.toggle('on', cb.checked); pop.querySelector('.mt-foot span').textContent = `選んでいるもの：ジャンル ${multiSel.g.size}・作品 ${multiSel.s.size}`; pop.querySelector(`[data-mt="${multiTab}"]`).textContent = `${multiTab === 'g' ? 'ジャンル' : '作品・シリーズ'}（${sel.size}）`; });
  const sr = $('mtSearch'); sr.oninput = () => { multiQ = sr.value; const pos = sr.selectionStart; renderMulti(); const n = $('mtSearch'); n.focus(); n.setSelectionRange(pos, pos); };
  $('mtAll').onclick = () => { shown.forEach(x => sel.add(x.key)); renderMulti(); };
  $('mtNone').onclick = () => { shown.forEach(x => sel.delete(x.key)); renderMulti(); };
  $('mtCancel').onclick = () => { $('multiPop').hidden = true; };
  $('mtOk').onclick = () => { sendSettings({ topic: 'multi', multiGenres: [...multiSel.g], multiSeries: [...multiSel.s] }); $('multiPop').hidden = true; };
}

// おまかせ設定（細かい設定はまとめて変える）
const MODES = {
  easy:   { choices: 4,  introLen: 10, hintAt: 15, chorusLen: 20, clues: true,  answerMode: 'choice', mode: 'score', typingExtra: 20, fame: ['top', 'famous'] },
  normal: { choices: 8,  introLen: 5,  hintAt: 10, chorusLen: 15, clues: true,  answerMode: 'choice', mode: 'score', typingExtra: 10, fame: ['top', 'famous', 'normal'] },
  hard:   { choices: 12, introLen: 3,  hintAt: 5,  chorusLen: 10, clues: false, answerMode: 'input',  mode: 'buzz',  typingExtra: 10, fame: ['top', 'famous', 'normal', 'minor', 'otaku'] },
};
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { sendSettings(MODES[b.dataset.mode]); toast(`「${b.textContent}」の設定にしました`); });
// リアクションスタンプ
document.querySelectorAll('[data-react]').forEach(b => b.onclick = () => socket.emit('react', b.dataset.react));
$('startBtn').onclick = () => socket.emit('start');
$('nextBtn').onclick = () => practice ? layoutApi.end() : socket.emit('next');
$('lobbyBtn').onclick = () => socket.emit('backToLobby');
$('againBtn').onclick = () => socket.emit('start'); // 同じ設定のまま、すぐ次のゲーム
$('quitBtn').onclick = () => socket.emit('abort');   // 一時停止中：結果発表はせずにロビーへ戻る
// 出題した曲のログ：コピーしてどこかに貼り付けて残せるように
let playLog = [];
function playLogText(list = playLog, title = '出題曲') {
  const d = new Date();
  const head = `アニソンイントロ対戦 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${title}`;
  const lines = list.map((s, i) => s && `${i + 1}. ${s.title} ／ ${s.work}${s.type ? `（${s.type}）` : ''} ／ ${s.artist}${s.year ? `（${s.year}）` : ''}`).filter(Boolean);
  const kept = keptIds(); // 「除外しない」にした曲は除外コードに入れない
  const ids = list.filter(s => s?.id && !kept.has(s.id)).map(s => s.id).join('');
  return [head, ...lines, ...(ids ? [`除外コード（新しい部屋に貼ると、この曲を出題しません）：AQX1:${ids}`] : [])].join('\n');
}
// この部屋で遊んだ全ゲームの曲（ゲームごとに区切る）
let roomLog = [];
function roomLogText() {
  const d = new Date();
  const out = [`アニソンイントロ対戦 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} この部屋で出題した曲（全${roomLog.length}曲）`];
  let game = null, i = 0;
  for (const s of roomLog) {
    if (s.game !== game) { game = s.game; i = 0; out.push(`■ ${game}ゲーム目`); }
    out.push(`${++i}. ${s.title} ／ ${s.work}${s.type ? `（${s.type}）` : ''} ／ ${s.artist}${s.year ? `（${s.year}）` : ''}`);
  }
  out.push(`除外コード（新しい部屋に貼ると、この曲を出題しません）：AQX1:${roomLog.map(s => s.id).join('')}`);
  return out.join('\n');
}
$('roomLogBtn').onclick = async () => {
  if (!roomLog.length) return toast('まだ出題した曲がありません');
  toast(await copyText(roomLogText()) ? `この部屋の${roomLog.length}曲をコピーしました` : 'コピーできませんでした');
};
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = Object.assign(document.createElement('textarea'), { value: text }); // 古いブラウザ・http 用
  ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove(); return ok;
}
// 貼り付けたログから除外コードを読み取る（動画IDは11文字ずつ）
$('excludeBtn').onclick = () => {
  const ids = [...$('excludeInput').value.matchAll(/AQX1:([\w-]+)/g)].flatMap(m => m[1].match(/[\w-]{11}/g) || []);
  if (!ids.length) return toast('除外コードが見つかりません（ログを丸ごと貼り付けてください）');
  socket.emit('exclude', ids); rememberIds(ids); $('excludeInput').value = '';
};
$('excludeClear').onclick = () => socket.emit('clearExclude');
// 除外：このルームで流した曲だけを除外から外す（前から除外していた曲は残す）。全部リセットは別のボタン
$('resetPlayed').onclick = () => {
  if (confirm('このルームで流した曲の除外を解除しますか？（前から除外していた曲・貼り付けたログの曲はそのまま残ります）')) socket.emit('clearPlayedHere');
};
// 設定のタブ（曲の範囲・遊び方・出題のしかた・答え方・除外）。選んだタブはこの端末に覚えておく
function setSettingsTab(sec) {
  $('setTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.sec === sec));
  document.querySelectorAll('#settings .set-group').forEach(g => { g.hidden = g.dataset.sec !== sec; });
  store.set('aq-settab', sec);
}
$('setTabs').onclick = e => { const b = e.target.closest('button[data-sec]'); if (b) setSettingsTab(b.dataset.sec); };
setSettingsTab(store.get('aq-settab') || 'range');
$('openExclude').onclick = () => { setLobbyTab('settings'); lobbyTabChosen = true; setSettingsTab('exclude'); $('settings').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
// 遊び方の説明（選んだ遊び方のルールを一言で）
// 遊び方の一覧（アイコン・名前・ひとこと・人数・分類）。「遊び方を選ぶ」の画面で使う
const PLAY_INFO = {
  normal: ['🎵', 'ふつう', '全員で同時に答える。速く正解するほど高得点', '1人〜', 'quiz'],
  buzzer: ['🔔', '早押し', '押した人だけが答えられる。お手つきに注意', '2人〜', 'quiz'],
  survival: ['💀', 'サバイバル', '間違えると脱落。最後まで残った人の勝ち', '1人〜', 'quiz'],
  picker: ['🎤', '出題者', '順番に1人が曲を選んで出題。半分くらいが正解すると出題者も高得点', '2人〜', 'quiz'],
  coop: ['🤝', '協力', '全員の正解数を合わせて目標をめざす', '1人〜', 'quiz'],
  fill: ['🧩', '3つ埋めバトル', '曲名・アニメ・アーティストの枠を早押しで埋める', '1人〜', 'quiz'],
  rush: ['🎰', '激アツRUSH', 'パチンコ風。保留・リーチ・大当たり・確変で点が跳ねる', '1人〜', 'quiz'],
  karuta: ['🎴', 'かるた', '並んだ札から、流れた曲の札を早取り', '1人〜', 'quiz'],
  nenpyo: ['📅', '年表', '流れた曲を、自分の年表の正しい位置に置く', '1人〜', 'quiz'],
  panel: ['🟥', '陣取り', 'アタック25風。正解したらパネルを取って挟んで裏返す', '1人〜', 'quiz'],
  bingo: ['🎯', 'ビンゴ', '正解した作品名のマスを開けて、列をそろえる', '1人〜', 'quiz'],
  poker: ['🃏', 'ポーカー', '正解した曲がトランプになる。10問ごとに役で勝負', '1人〜', 'quiz'],
  sugoroku: ['🎲', 'すごろく', '正解の速さでコマを進める。止まったマスでイベント', '1人〜', 'quiz'],
  genreex: ['👑', 'ジャンル制覇EX', '集める種類を6つ以上に。ジャンル・年代・曲の種類・知名度から選ぶ（ランダムも）', '1人〜', 'quiz'],
  genre: ['🏆', 'ジャンル制覇', '6ジャンルのピースを集める。次のジャンルは選択制かランダム制', '1人〜', 'quiz'],
  deck: ['🛒', 'デッキ構築', '正解でコイン。3問ごとのショップでカードを買って育てる', '1人〜', 'quiz'],
  wits: ['💰', '年当てベット', '発売年を予想して、いちばん近い予想に賭ける', '2人〜', 'quiz'],
  kaerema: ['🍜', '帰れま10', 'お題の曲の再生回数トップ10を、全部当てたら帰れる', '1人〜', 'board'],
  wolf: ['🐺', '人狼', '1人だけ別の曲。ヒントと話し合いで、だれが違うか当てる', '3人〜', 'board'],
  dentatsu: ['📨', '伝達クイズ', '伝える人だけが曲を聴いて、文字のヒントで伝える。ほかの人は選択肢から当てる', '2人〜', 'board'],
  dixit: ['🖼️', 'ディクシット', '語り手のヒントに合う曲を手札から出し、語り手の曲を当てる', '3人〜', 'board'],
  baba: ['😈', 'ババ抜き', '同じ作品の曲2枚がペア。最後までババを持っていたら負け', '3人〜', 'board'],
  daifugo: ['👑', '大富豪', '発売年が新しい曲ほど強い。年は見えない', '3人〜', 'board'],
  codenames: ['🕵️', 'コードネーム', '2チームで、作品名の盤面から味方の作品を当てる', '4人〜', 'board'],
  azul: ['🧱', 'アズール', '曲カードを色ごとに取り合い、年代別の棚に並べる', '2〜4人', 'board'],
};
const PLAY_GROUPS = [['quiz', '🎧 イントロクイズで遊ぶ（毎問、曲を聴いて答える）'], ['board', '🎲 ボードゲーム風（手札・投票・話し合いなど）']];
function renderPlayPick(play) {
  const p = PLAY_INFO[play] || ['🎵', play, '', '', ''];
  $('playPick').innerHTML = `<b>${p[0]}</b>${esc(p[1])}<small>▾ 一覧から選ぶ</small>`;
}
$('playPick').onclick = () => {
  const cur = room?.settings?.play;
  $('playPop').innerHTML = `<div class="wf-field pl-field"><div class="wf-head"><b>🎮 遊び方を選ぶ</b><span>カードを押すと、その遊び方になります</span><button class="btn-sub pl-close" id="plClose" type="button">閉じる</button></div>
    <div class="pl-body">${PLAY_GROUPS.map(([g, label]) => `<h4>${label}</h4><div class="pl-grid">${Object.entries(PLAY_INFO).filter(([, v]) => v[4] === g).map(([k, v]) => `<button type="button" class="pl-card${k === cur ? ' on' : ''}" data-play="${k}" title="${esc(PLAY_DESC[k] || '')}"><span class="pl-icon">${v[0]}</span><b>${esc(v[1])}</b><small>${esc(v[2])}</small><i>${esc(v[3])}</i></button>`).join('')}</div>`).join('')}</div></div>`;
  $('playPop').hidden = false;
  $('plClose').onclick = () => { $('playPop').hidden = true; };
  $('playPop').onclick = e => { if (e.target === $('playPop')) $('playPop').hidden = true; };
  $('playPop').querySelectorAll('[data-play]').forEach(b => b.onclick = () => {
    const sel = document.querySelector('[data-key="play"]'); sel.value = b.dataset.play; sendSettings(); renderPlayPick(b.dataset.play); $('playPop').hidden = true;
  });
};
const PLAY_DESC = {
  dentatsu: '2人以上で遊びます。毎回、順番に1人が「伝える人」になり、その人だけがイントロとサビを聴けます（曲名も見えます）。伝える人は、曲名・作品名・歌手名を使わずに、文字のヒント（1つ30文字まで・10個まで）で曲を伝えます。ほかの人は、ヒントを見ながら選択肢から曲を当てます（選択肢は伝える人には見えません）。正解すると100点（早いほど最大+50点）、伝える人は正解した人1人につき100点です。',
  azul: 'ボードゲーム「アズール」の曲版（2〜4人）。工房に並んだ曲カード（曲名と色＝ジャンルが見える。年代は見えない）から、同じ色を全部取り、自分の棚の年代別の段（〜80年代／90年代／00年代／10年代／20年代）に1枚ずつ置きます。年代ちがい・段があふれたカードは床に落ちて失点。段がいっぱいになると、ラウンドの終わりに 1枚2点（同じ色だけなら+3点）。3ラウンドで終わり。置いた曲はサビが流れます。',
  kaerema: 'テレビの「帰れま10」のアニソン版。お題（歌手・作品・年・ジャンル・年代・曲の種類・それらの組み合わせ）の曲20曲から、再生回数トップ10に入っている曲を順番に1曲ずつ選びます（選ぶとサビが流れて順位が出ます）。トップ10を全部当てたら帰れる！ 外れが6回で帰れません…。当たり +500点（1位は +1000点）、10曲目を当てた人 +2000点、帰れたら全員 +1000点。問題数＝お題の数です。',
  deck: 'いつものイントロクイズで正解するとコインがもらえます（いちばん速い人 +3、ほかの正解 +2）。3問ごと（と、最後の問題のあと必ず）にショップが開き、コインでカードを買えます：50:50・オーディエンス・テレフォン・もう一度聴く（問題中に使う）、ランダムカード、ブースト（次の正解の点数2倍／大ブーストは3倍）、投資（ずっと正解のたびにコイン+1／大投資は+2）、コイン強奪、勝利点（すぐ+1000点・買うたびに値上がり／大勝利点は+2500点）。',
  genreex: 'ジャンル制覇の発展版。集める「種類」を6つより多くできます。ジャンル（約20種類）・年代・曲の種類（OP・ED・挿入歌・ボカロなど）・知名度の中から、ランダムに決める（数も選べる）か、自分たちで好きなだけ選びます。毎問、どれか1つの種類の曲が出て、最速の正解者がその種類のピースをもらい、選んだ種類を先に全部そろえた人の勝ちです（だれかが全部そろえるまで終わりません。次の種類の決め方は「選択制／ランダム制」）。',
  genre: 'いつものイントロクイズで、6つのジャンル（ジャンプ／ロボット・SF／ラブコメ・日常／アイドル・バンド／異世界・ファンタジー／ゲーム・スポーツ）のピースを集めます。毎問どれか1つのジャンルの曲が出て、いちばん速く正解した人がそのジャンルのピースをもらいます。次の問題のジャンルは、設定で「選択制（最速の正解者が選ぶ）」か「ランダム制（毎問ランダム）」にできます。先に6つそろえた人の勝ち（+3000点）。だれかが全部そろえるまで終わりません（問題数の設定はありません）。',
  sugoroku: 'いつものイントロクイズに答えながら、すごろくでゴール（30マス目）を目指します。正解の速い順に 3・2・1 マス進み、止まったマスでイベント（進む・戻る・ボーナス・1回休み・次は2倍・先頭と入れ替え・前の人を戻す）。だれかがゴールしたら終わり（+2000点）。順位は進んだマスの多い順です。',
  wits: '2人以上（3人以上がおすすめ）。イントロを聴いて発売年を予想します。全員の予想が年の順に並んだら、「正解の年を超えない中でいちばん近い予想」がどれかを当てるマーカーを2個置きます（ほかの人の予想にも置けます）。外側の枠ほど倍率が高く、点数を上乗せして勝負もできます。自分の予想が当たり枠なら +300点（ぴったりなら +600点）。',
  daifugo: '3人以上で遊びます。曲のカードが7枚ずつ配られます。カードの強さは発売年で、新しい曲ほど強いのですが、手札の年は見えません。場の曲より新しいと思う曲を出すか、パス。新しくなかったら失敗（−200点・カードは戻る）。全員パスで場が流れます。早く手札をなくした順に 大富豪+3000／富豪+2000／平民+1000点。1回が1ゲームです。',
  codenames: '4人以上で遊びます。赤・青の2チームに分かれ、各チームに1人のスパイマスターがいます。盤面は25枚の作品名で、スパイマスターだけが「どれが赤・青・中立・暗殺か」を知っています。スパイマスターが「ヒントの言葉＋数字」を出し、仲間がそれを手がかりに自分のチームの作品を当てます（めくると曲が流れます）。先に全部当てたチームの勝ち。暗殺カードを引くと負けです。1回が1ゲームです。',
  baba: '3人以上で遊びます。曲のカード（曲名と歌手だけ見えます）が配られます。同じ作品の曲2枚を選んで「ペア」にして出し、手札を早くなくしましょう（合っていれば+300点、ちがうと−300点）。順番に右隣の人から1枚ずつ引き、最後までババ（ジョーカー）を持っていた人が負け。上がった順に 3000／2000／1000点です。1回が1ゲームです（1〜2回がおすすめ）。',
  dixit: '3人以上で遊びます。順番に語り手になり、手札の5曲から1曲を選んで一言ヒントを出します。ほかの人は、ヒントに合うと思う曲を手札から出し、出た曲の中から語り手の曲だと思うものに投票。全員が当てたり、だれも当てなかったりすると語り手は0点、ほどよく当たると語り手も当てた人も高得点です。自分の曲に票が入ってもプラス。問題数＝回数です（人数×1〜2回くらいがおすすめ）。',
  wolf: '3人以上で遊びます。全員に同じ曲が流れますが、1人（人狼）だけ別の作品の曲が流れます（自分が人狼かは分かりません）。曲について一言ヒントを出し合い、チャットで話し合って、人狼だと思う人に投票。人狼を当てたら村人の勝ち（+1000点）、外したら人狼の勝ち（+2000点）。当てられた人狼も、みんなの曲名を当てれば逆転勝ちです。問題数＝回数です（5回くらいがおすすめ）。',
  nenpyo: '一人ひとり、年の見えている曲を1枚持って始めます。曲が流れたら（年は伏せたまま）、自分の年表の「どこに入るか」（この曲とこの曲の間）を選びます。合っていれば、その曲が年表に入ります（同じ年はどちらでも正解）。先に10枚並べた人の勝ち。曲名がわからなくても「この時代っぽい」で戦えます。',
  karuta: '画面に16枚の札（曲名・作品名・歌手名のどれか）を並べたまま、イントロが流れたら正しい札を早取りします。いちばん早く正しい札を取った人がその札をもらい、そこで答え合わせ。違う札を取るとお手つきで、次の1曲はお休みです。取った札は場から消え、空いたところに新しい札が入ります。取った札の多い人が勝ちです。',
  panel: '5×5のパネルを取り合います。20問目のあとにアタックチャンスが起きて、1マスが白くなります（取られているマスは色が消えます）。次の問題の正解者は、その白いマスをどこからでも取れます。いちばん早く正解した人がパネルを1枚選び、自分の色で縦・横に挟んだ相手のパネルを裏返せます（斜めはなし）。選べるのは、最初は真ん中、そのあとは取られているパネルの縦・横の隣（挟めるところがあればそこだけ）。パネルが全部埋まったら終わりで、パネルの多い人が勝ちです。',
  poker: '10問ごとに、手札に点を賭けて中間オープン（勝った人が総取り・使った手札は保管して最後にボーナス）。全員で同じ曲に答えます。正解すると、その曲のトランプが手札に入り、いちばん早く正解した人はランダムのカードがもう1枚もらえます。数字は作品ごと（同じ数字＝同じ作品）、マークはジャンル系統（♠バトル・SF ♥恋愛・日常 ♦異世界・ゲーム ♣その他）。同じ数字・マークのカードは場に1枚だけです。手札は5枚で、増えたら不要なカードを捨てます。最後に全員の手札を開いて、ポーカーの役がいちばん強い人が勝ちです。カードに触れると曲の名前などが見えます。最後は、ポーカー場のテーブルで全員の手札をオープン！',
  normal: '全員が同時に答えます。速く正解するほど高得点。',
  buzzer: '曲が流れている間に「押す！」を押した人だけが答えられます。間違えると −200点で、ほかの人が押せます。',
  survival: '間違える・時間切れ・パスでライフが減り、0で脱落。最後まで残った人の勝ち（問題数は最大50問）。',
  picker: '1問ごとに順番で1人が出題者になり、収録曲から曲を選びます。答える人の半分くらいが正解すると、出題者に最高1000点。2人以上で遊べます。',
  coop: '全員の正解数の合計で、目標（問題数×人数×目標%）をめざします。',
  bingo: '一人ひとりに4×4のカードを配ります（答えるものに合わせて、曲名・作品・歌手・年のマス）。正解するとそのマスが開き、縦・横・斜めのどれかがそろったら BINGO！で +3000点（そのあと列が増えるたびに +1000点）。「ビンゴの終わり」で決めた人数・ビンゴ数に届いたらゲーム終了（問題数までも選べます）。イントロの点数とボーナスの合計で競います（20問以上がおすすめ）',
  rush: '全員が同じ問題に答えます。問題の前に「保留ランプ」の色（青・緑・赤・金・虹）で、その問題の当たりやすさが分かります。当たりの問題はサビで「リーチ！」。パチスロの曲に正解すると「大当たり！」で +2000点、そのあと RUSH（確変）に入り、連続で正解するほど点数が ×2〜×4 に。間違えるか答えないとRUSH終了。得点の合計で競います（20問くらいがおすすめ）',
  fill: '1曲ごとに「曲名・アニメ名・アーティスト」の3つの枠を早押しで埋めます（ボカロは「曲名・作者・VOCALOID」）。押した人が空いている枠を選んで答え、書けば早いほど高得点・10択なら半分。間違えると −200点で、しばらく押せません（秒数は「お手つき後に押せない秒数」で変えられます。初めは15秒）。全部埋まるか、全員がパスしたら次の曲へ。LoL の曲は出ません。',
};
// ロビーの一番上：これから遊ぶ曲を除外に追加しない（ホストが切り替え）
$('noRecordBtn').onclick = () => { if (room) sendSettings({ noRecord: !room.settings.noRecord }); };
// 除外を一時的に解除（除外の一覧は残したまま、オンの間だけ除外している曲も出す。設定の「前に出た曲を：出す」と同じ）
$('noExcludeBtn').onclick = () => { if (room) sendSettings({ noExclude: !room.settings.noExclude }); };
// 除外中の曲（この部屋で出た曲＋貼り付けたログの曲）を全部コピー
// （スマホではタップの処理の中ですぐコピーしないと失敗するので、一覧は先に受け取っておく）
let excludedCache = [], excludedCount = -1;
// ゲーム中の除外には「これから出す予定の曲」も入っているので、端末に記録するのはゲーム中以外だけ
const refreshExcluded = () => socket.emit('excludedList', list => { excludedCache = list || []; if (room?.state !== 'playing') rememberIds(excludedCache.map(s => s.id)); });
// ── この端末に保存する「出た曲」（サーバーの再起動・反映で部屋が消えても、除外し直せるように）──
const DEVICE_KEY = 'aq-device-played', DEVICE_MAX = 5000;
function deviceIds() { try { return JSON.parse(store.get(DEVICE_KEY) || '[]'); } catch (e) { return []; } }
function rememberIds(ids) {
  const set = new Set(deviceIds());
  let added = false;
  const kept = keptIds(); // 「除外しない」にした曲は記録しない
  for (const id of ids) if (/^[\w-]{11}$/.test(id) && !set.has(id) && !kept.has(id)) { set.add(id); added = true; }
  if (!added) return;
  store.set(DEVICE_KEY, JSON.stringify([...set].slice(-DEVICE_MAX)));
  updateDeviceInfo();
}
function updateDeviceInfo() {
  const n = deviceIds().length;
  $('deviceInfo').textContent = `この端末の記録：${n}曲`;
  $('deviceApply').disabled = $('deviceClear').disabled = !n;
}
updateDeviceInfo();
$('deviceApply').onclick = () => { const ids = deviceIds(); if (ids.length) socket.emit('exclude', ids); };
$('deviceClear').onclick = () => {
  if (!confirm('この端末に保存している「出た曲」の記録を消しますか？（部屋の除外はそのまま）')) return;
  store.set(DEVICE_KEY, '[]'); updateDeviceInfo(); toast('端末の記録を消しました');
};
$('excludeCopy').onclick = async () => {
  if (!excludedCache.length) return toast('除外中の曲はありません');
  toast(await copyText(playLogText(excludedCache, '除外中の曲')) ? `除外中の${excludedCache.length}曲をコピーしました` : 'コピーできませんでした');
};
document.querySelectorAll('[data-copylog]').forEach(b => b.onclick = async () => {
  if (!playLog.some(Boolean)) return toast('まだ出題した曲がありません');
  toast(await copyText(playLogText()) ? `${playLog.filter(Boolean).length}曲のログをコピーしました` : 'コピーできませんでした');
});

// ── 背景の映像の濃さ（0〜100%、スライダー）。自分の画面だけに効き、次に開いたときも覚えておく ──
function applyBg(v) {
  v = Math.max(0, Math.min(100, Number(v)));
  if (!Number.isFinite(v)) v = 100;
  document.body.style.setProperty('--bgk', v / 100);
  $('bgRange').value = v;
  $('bgRange').title = `背景の濃さ ${v}%`;
  store.set('aq-bg', String(v));
}
applyBg({ normal: 100, dim: 40, off: 0 }[store.get('aq-bg')] ?? store.get('aq-bg') ?? 100);
$('bgRange').oninput = e => applyBg(e.target.value);
// エフェクトの輝き（0〜100%）。--fxk として掛ける。0 のときはエフェクトを出さず文字だけ
function applyFx(v) {
  v = Math.max(0, Math.min(100, Number(v)));
  if (!Number.isFinite(v)) v = 100;
  document.body.style.setProperty('--fxk', v / 100);
  document.body.classList.toggle('fx-off', v === 0);
  $('fxRange').value = v;
  $('fxRange').title = `エフェクトの輝き ${v}%`;
  store.set('aq-fx', String(v));
}
applyFx(store.get('aq-fx') ?? 100);
$('fxRange').oninput = e => applyFx(e.target.value);
// キャラクター（双子）の表示のオンオフ
function applyMascot(on) {
  document.body.classList.toggle('mascot-off', !on);
  $('mascotChk').checked = on;
  store.set('aq-mascot', on ? '1' : '0');
}
applyMascot(store.get('aq-mascot') !== '0');
$('mascotChk').onchange = e => applyMascot(e.target.checked);
// スマホ版（mobile.css）：音量・表示・一時停止などは ⚙ で下から出るシートにまとめる
const closeSheet = () => document.body.classList.remove('sheet-open');
$('gearBtn').onclick = () => document.body.classList.toggle('sheet-open');
$('sheetClose').onclick = closeSheet;
$('sheetShade').onclick = closeSheet;
$('gameCtrl').addEventListener('click', closeSheet); // 一時停止・ルームに戻るを押したら閉じる
matchMedia('(max-width: 600px)').addEventListener('change', closeSheet);

// ── 一時停止・途中でやめる ──
let shownBeforePause = null, pausedNow = false, pausedAt = 0;
$('menuBtn').onclick = e => {
  e.stopPropagation();
  const r = $('menuBtn').getBoundingClientRect(); // 枠からはみ出して切れないよう、画面に対して位置を決める
  $('menuPop').style.top = r.bottom + 4 + 'px'; $('menuPop').style.right = Math.max(8, innerWidth - r.right) + 'px';
  $('menuPop').hidden = !$('menuPop').hidden;
};
document.addEventListener('click', e => { if (!e.target.closest('#menuPop')) $('menuPop').hidden = true; });
$('menuLayout').onclick = () => { $('menuPop').hidden = true; document.querySelector('.stage-tools .layout-open')?.click(); }; // 既存のレイアウト編集を開く
$('pauseBtn').onclick = () => { $('menuPop').hidden = true; socket.emit('pause'); };
$('resumeBtn').onclick = () => socket.emit('resume');
$('abortBtn').onclick = () => { $('menuPop').hidden = true; if (confirm('ゲームをやめて部屋に戻りますか？（得点は残りません）')) socket.emit('abort'); };
let phaseBefore = null; // 一時停止の前の表示（再開したら戻す）
socket.on('paused', () => { pausedNow = true; pausedAt = performance.now(); player.pause(); phaseBefore = [$('phase').className.replace('phase ', ''), $('phase').textContent]; setPhase('ready', '一時停止中'); });
socket.on('resumed', ({ ms, qTotal }) => {
  pausedNow = false;
  const d = performance.now() - pausedAt; // 止まっていたぶん、残り時間の計算を後ろへずらす
  timerStart += d; nextUntil += d;
  player.resume();
  if (document.body.classList.contains('revealing')) setPhase('reveal', '答え合わせ');
  else if (phaseBefore && phaseBefore[0] !== 'ready') setPhase(...phaseBefore);
  else setPhase('intro', '再開');
  if (question && qTotal) { question.qTotal = qTotal; $('qno').innerHTML = $('qno').innerHTML.replace(/\/ \d+ 問/, `/ ${qTotal} 問`); }
});
socket.on('aborted', () => {
  player.stop(); stopTick(); clearInterval(nextTick); clearTimeout(goTimer);
  $('nextCount').textContent = ''; question = null; pausedNow = false; shownBeforePause = null;
  toast('ゲームを中断して部屋に戻りました');
});

// ── 部屋の状態 ──
socket.on('room', r => { renderRoom(r); refreshScoreStrips(); updateFixFab(); });
// ── ボードゲーム風の窓：後ろの点数表が隠れるので、窓の見出しの下に全員の点数を出す（ディクシットは自分の欄に出している）──
const SCORE_POPS = ['wolfPop', 'dtPop', 'babaPop', 'cnPop', 'dfPop', 'wwPop', 'kmPop', 'azPop', 'dkPop'];
function scoreStripHtml() {
  const ps = (room?.players || []).filter(p => p.connected !== false || p.score);
  if (!ps.length) return '';
  const top = Math.max(0, ...ps.map(p => p.score || 0));
  return [...ps].sort((a, b) => (b.score || 0) - (a.score || 0)).map(p => `<span class="${p.id === me ? 'me' : ''}">${top > 0 && p.score === top ? '👑' : ''}${esc(p.name)}<b>${p.score || 0}点</b></span>`).join('');
}
function putScoreStrip(pop) {
  const f = pop.querySelector('.wf-field'); if (!f || pop.hidden) return;
  let s = f.querySelector(':scope > .sc-strip');
  if (!s) { s = document.createElement('div'); s.className = 'sc-strip'; const h = f.querySelector(':scope > .wf-head, :scope > .cn-head'); h ? h.after(s) : f.prepend(s); }
  const html = scoreStripHtml(); if (s.innerHTML !== html) s.innerHTML = html;
}
function refreshScoreStrips() { for (const id of SCORE_POPS) { const p = $(id); if (p && !p.hidden) putScoreStrip(p); } }
for (const id of SCORE_POPS) { const p = $(id); if (p) new MutationObserver(() => putScoreStrip(p)).observe(p, { childList: true, attributes: true, attributeFilter: ['hidden'] }); } // 窓を描き直したら付け直す
// 部屋を作った時刻（今日なら 時:分:秒、別の日なら 月/日 時:分:秒）
function madeAt(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date(), p = n => String(n).padStart(2, '0');
  const hms = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return d.toDateString() === now.toDateString() ? hms : `${d.getMonth() + 1}/${d.getDate()} ${hms}`;
}
// チーム戦（赤・青）
const TEAM_LABEL = { red: '赤', blue: '青' };
$('teamRow').querySelectorAll('[data-team]').forEach(b => b.onclick = () => socket.emit('setTeam', b.dataset.team));
$('shuffleTeams').onclick = () => socket.emit('shuffleTeams');
$('teamRandomBtn').onclick = () => { socket.emit('shuffleTeams'); toast('チームをランダムに分けました'); }; // 設定のチーム戦の横（ホスト）
const amOut = () => !!room?.players?.find(p => p.id === me)?.out; // サバイバルで脱落して、見ているだけ
// スマホ版のロビーのタブ（参加者・招待／設定）。最初はホストなら「設定」、ほかの人は「参加者・招待」
let lobbyTabChosen = false, prevMyStreak = 0, prevMyRank = 0;
// 答え合わせのあと、順位のことをしゃべる（トップ・接戦・自分の順位が上がった）
function talkRanking() {
  const ps = [...(room?.players || [])].sort((a, b) => b.score - a.score);
  if (!ps.length || !ps[0].score) return;
  const myRank = ps.findIndex(p => p.id === me) + 1;
  const [top, second] = ps;
  if (myRank > 0 && prevMyRank && myRank < prevMyRank && myRank > 1) charFx.say('rankUp', { rank: myRank });
  else if (top.id === me) charFx.say('meTop');
  else if (second && second.score && top.score - second.score <= 150) charFx.say('close', { top: top.name, second: second.name });
  else charFx.say('lead', { top: top.name, score: top.score });
  prevMyRank = myRank;
}
function setLobbyTab(tab) {
  document.body.dataset.ltab = tab;
  $('lobbyTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
}
$('lobbyTabs').onclick = e => { const b = e.target.closest('button[data-tab]'); if (b) { lobbyTabChosen = true; setLobbyTab(b.dataset.tab); } };
function renderRoom(r) {
  const prevState = room?.state;
  const prevScores = new Map((room?.players || []).map(p => [p.id, p.score]));
  room = r;
  if (practice) return; // テスト1問の間は画面を切り替えない（終わったら最新の部屋の状態で描き直す）
  if (prevState === 'playing' && r.state !== 'playing') { hidePokerBet(); hideWolf(); hideDixit(); hideDt(); hideBaba(); hideCn(); hideDf(); hideWw(); hideKm(); hideAz(); } // 中止して部屋に戻ったら、ボードゲーム風の窓を閉じる
  const isHost = r.hostId === me;
  const canSet = !(r.state === 'playing' && !r.paused); // 設定はだれでも変えられる（ゲーム中は一時停止のときだけ）
  if (!lobbyTabChosen) setLobbyTab(isHost ? 'settings' : 'members');
  document.querySelectorAll('#settings select').forEach(sel => {
    sel.value = String(r.settings[sel.dataset.key] ?? '');
    sel.disabled = !canSet;
  });
  $('seriesLabel').hidden = r.settings.topic !== 'series';
  $('multiOpen').hidden = r.settings.topic !== 'multi';
  $('multiOpen').textContent = `お題を選ぶ（ジャンル${(r.settings.multiGenres || []).length}・作品${(r.settings.multiSeries || []).length}）`;
  ['genreExAll', 'genreExNone'].forEach(id => { $(id).disabled = r.state === 'playing' && !r.paused; });
  if (r.settings.topic === 'multi' && !(r.settings.multiGenres || []).length && !(r.settings.multiSeries || []).length && !multiAsked) { multiAsked = true; openMulti(); } // 初めて選んだときは、選ぶ画面を開く
  // 新しいモードの設定：サバイバルはライフ（問題数の代わりに終わるまで）、早押しは採点の欄を使わない。できない組み合わせは選べなくする
  $('livesLabel').hidden = r.settings.play !== 'survival';
  $('coopGoalLabel').hidden = r.settings.play !== 'coop';
  $('rushRateLabel').hidden = r.settings.play !== 'rush'; // アニソン激アツRUSH：当たりやすさ
  $('lockSecLabel').hidden = r.settings.play !== 'fill'; // 3つ埋めバトル：間違えたあと押せない秒数
  $('bingoEndLabel').hidden = r.settings.play !== 'bingo'; // ビンゴ：何人・何ビンゴで終わるか
  $('karutaFaceLabel').hidden = r.settings.play !== 'karuta'; // かるた：札に書くもの
  $('prefRow').hidden = !meUser() || (r.state === 'playing' && !r.paused);
  $('kmTopLabel').hidden = r.settings.play !== 'kaerema';
  $('dtChoicesLabel').hidden = r.settings.play !== 'dentatsu';
  const isGzP = ['genre', 'genreex'].includes(r.settings.play), isEx = r.settings.play === 'genreex';
  $('gzPickLabel').hidden = !isGzP;
  $('gzSetLabel').hidden = !isGzP;
  document.querySelector('[data-key="gzSet"] option[value="fixed"]').disabled = isEx; // EXは「今の6つ」の固定はなし
  if (isEx && r.settings.gzSet === 'fixed') document.querySelector('[data-key="gzSet"]').value = 'random';
  $('gzCountLabel').hidden = !(isEx && r.settings.gzSet !== 'choose');
  $('gzPickOpen').hidden = !(isGzP && r.settings.gzSet === 'choose');
  $('gzPickOpen').textContent = `集める種類を選ぶ（${(r.settings.gzPicks || []).length}）`;
  $('wolfWorkLabel').hidden = $('wolfTitleLabel').hidden = r.settings.play !== 'wolf'; // 人狼：候補に出す作品名・曲名
  $('buzzStopLabel').hidden = !['buzzer', 'fill'].includes(r.settings.play); // 早押し・3つ埋めバトル：答えている間は曲を止める
  $('noRepeatLabel').hidden = r.settings.play !== 'fill'; // 3つ埋めバトル：間違えた人は、ほかの人が押すまで押せない
  $('playDesc').textContent = PLAY_DESC[r.settings.play] || '';
  renderPlayPick(r.settings.play);
  $('playPick').disabled = document.querySelector('[data-key="play"]').disabled;
  $('questionsLabel').hidden = r.settings.play === 'survival';
  const fillMode = r.settings.play === 'fill'; // 3つ埋めバトルは、答えるもの・回答方法・採点・ヒントを使わない（枠ごとに書くか10択）
  $('modeLabel').hidden = r.settings.play === 'buzzer' || r.settings.target === 'year' || fillMode;
  for (const k of ['target', 'answerMode', 'choices', 'clues']) document.querySelector(`#settings [data-key="${k}"]`).closest('label').hidden = fillMode;
  document.querySelector('[data-key="play"] option[value="buzzer"]').disabled = r.settings.target === 'year';
  document.querySelector('[data-key="teams"] option[value="true"]').disabled = ['survival', 'coop', 'bingo', 'rush', 'poker', 'nenpyo', 'wolf', 'dixit', 'baba', 'codenames', 'genreex', 'daifugo', 'wits', 'sugoroku', 'genre', 'deck', 'kaerema', 'azul', 'dentatsu'].includes(r.settings.play);
  // チーム戦：待機中に自分のチームを切り替える（ホストはシャッフルも）。チームの合計点
  const teamsOn = !!r.settings.teams;
  $('teamRow').hidden = !teamsOn || r.state === 'playing';
  $('shuffleTeams').hidden = false;
  $('teamRandomBtn').hidden = !teamsOn || r.state === 'playing';
  const myTeam = r.players.find(p => p.id === me)?.team;
  $('teamRow').querySelectorAll('[data-team]').forEach(b => { b.disabled = b.dataset.team === myTeam; });
  $('teamInfo').textContent = teamsOn && r.teams ? r.teams.map(t => `${TEAM_LABEL[t.team]} ${t.members}人`).join('・') : ''; // 待機中は人数だけ（点数は前のゲームのもの）
  $('presets').hidden = false;
  $('modes').hidden = false;
  const fame = r.settings.fame || [];
  $('fameList').querySelectorAll('input').forEach(cb => { cb.checked = !fame.length || fame.includes(cb.value); cb.disabled = !canSet; });
  const ex = r.settings.excludeGenres || [];
  $('genreExList').querySelectorAll('input').forEach(cb => { cb.checked = ex.includes(cb.value); cb.disabled = r.state === 'playing' && !r.paused; });
  const exLabels = ex.map(k => TOPIC_DATA.genres.find(g => g.key === k)?.label || k);
  $('genreExInfo').textContent = exLabels.length ? `（${exLabels.join('・')}）` : '（なし）';
  $('poolInfo').textContent = `${topicLabel(r.settings)}${r.settings.topic === 'all' && exLabels.length ? `（${exLabels.join('・')}を除く）` : ''}・${r.settings.yearFrom}〜${r.settings.yearTo}年：出題できる曲 ${r.poolSize} 曲` +
    (r.poolSize < r.settings.questions ? `（${r.settings.questions}問に足りないので ${r.poolSize} 問で出題します）` : '');
  $('startBtn').disabled = r.poolSize === 0;
  // 除外：全部の数と、「このルームで流した曲」「前から除外していた曲」の内訳
  const exHere = r.excludedHere || 0, exBefore = Math.max(0, (r.excluded || 0) - exHere);
  $('excludeCount').textContent = `（合計 ${r.excluded || 0}曲）`;
  $('excludeTabCount').textContent = r.excluded ? `(${r.excluded})` : '';
  $('beforeInfo').textContent = `${exBefore}曲`;
  $('exSummary').textContent = r.excluded ? `除外中 ${r.excluded}曲（このルームで流した曲 ${exHere}・前から ${exBefore}）` : '除外中の曲はありません';
  if (r.excluded !== excludedCount) { excludedCount = r.excluded; refreshExcluded(); }
  $('excludeCopy').hidden = !r.excluded;
  $('excludeClear').hidden = !r.excluded;
  // いつも出しておく（除外中が0曲のときはボタンを押せない）。解除できるのはホスト
  $('resetInfo').textContent = `${exHere}曲`;
  $('resetPlayed').disabled = !exHere;
  $('resetPlayed').hidden = false;
  const noRec = !!r.settings.noRecord;
  $('pokerBox').hidden = !(r.settings.play === 'poker' && r.state !== 'lobby');
  renderPanel(r); renderNenpyo(); renderSugoroku(r); renderGenreZone(r); renderDeck(r);
  $('noRecordBtn').textContent = noRec ? '✓ これから遊ぶ曲は除外に追加しない' : '🔁 これから遊ぶ曲は除外に追加しない';
  $('noRecordBtn').classList.toggle('on', noRec);
  $('noRecordBtn').disabled = !canSet;
  $('noRecordBtn').hidden = false;
  const noEx = !!r.settings.noExclude;
  $('noExcludeBtn').textContent = noEx ? '✓ 除外を一時的に解除中（前に出た曲も出る）' : '🔓 除外を一時的に解除';
  $('noExcludeBtn').classList.toggle('on', noEx);
  $('noExcludeBtn').disabled = !canSet;
  $('noExcludeBtn').hidden = false;
  $('startBtn').hidden = !isHost; $('waitHost').hidden = isHost;
  $('nextBtn').hidden = !isHost; $('waitNext').hidden = isHost || r.settings.autoNext > 0; // 自動で進むときは待ちの文言を出さない
  $('lobbyBtn').hidden = !isHost; $('againBtn').hidden = !isHost;
  $('quitBtn').hidden = !(isHost && r.state === 'playing' && r.paused); // 一時停止の設定画面から、結果発表なしでロビーへ
  // ゲーム中のホスト用ボタン。一時停止中は設定画面を出す
  const playing = r.state === 'playing';
  $('gameCtrl').hidden = !(playing && !r.paused); // メニュー：レイアウトはだれでも。設定を変える・ルームに戻るはホストだけ
  $('pauseBtn').hidden = $('abortBtn').hidden = !isHost;
  if ($('gameCtrl').hidden) $('menuPop').hidden = true;
  if (playing && r.paused && !shownBeforePause) {
    shownBeforePause = ['quiz', 'result'].find(x => !$(x).hidden) || 'quiz';
    show('lobby');
  } else if (!(playing && r.paused) && shownBeforePause) {
    if (playing) show(shownBeforePause);
    shownBeforePause = null;
  }
  if (playing && r.paused) {
    $('startBtn').hidden = true; $('resumeBtn').hidden = !isHost;
    $('waitHost').hidden = isHost; $('waitHost').textContent = '一時停止中：ホストが設定を変えています…';
  } else {
    $('resumeBtn').hidden = true; $('waitHost').textContent = 'ホストがゲームを開始するのを待っています…';
  }

  if (r.state === 'lobby') { show('lobby'); document.body.classList.remove('revealing', 'playing', 'fading'); reloadIfPending(); }
  else if (r.state === 'playing' && prevState !== 'playing' && !question && r.phase !== 'picking') {
    // 途中参加：次の問題から
    show('quiz'); $('choices').innerHTML = ''; $('quizNote').textContent = amOut() ? '脱落しました（観戦中）' : '次の問題から参加します';
  }
  if (r.state === 'lobby' && prevState !== 'lobby') { charFx.pose('idle'); charFx.say('lobby'); }
  // 自分の連続正解が3・5・7…と伸びたら、カットイン
  const myStreak = r.players.find(p => p.id === me)?.streak || 0;
  if (myStreak > prevMyStreak && myStreak >= 3 && myStreak % 2 === 1) charFx.say('streak', { streak: myStreak }); // 真ん中のカットインはゲームの始まりと終わりだけ（ゲーム中は左右のキャラのセリフだけ）
  prevMyStreak = myStreak;
  // 待機中のステージは、タイマーの代わりに部屋の情報を出す
  document.body.classList.toggle('in-lobby', r.state === 'lobby');
  if (r.state !== 'playing') document.body.classList.remove('game-started'); // ゲームが終わったら、キャラを真ん中に戻す
  if (r.state === 'lobby') {
    setPhase('', '待機中');
    $('qno').textContent = `${r.name ? r.name + '・' : ''}${r.players.filter(p => p.connected !== false).length}人が参加中${r.createdAt ? `・${madeAt(r.createdAt)} 作成` : ''}`;
  }

  myLifelines = r.players.find(p => p.id === me)?.lifelines || null;
  updateLifelineButtons();

  // 得点が一番の人（0点より上）に王冠をつける
  const top = Math.max(0, ...r.players.map(p => p.score));
  renderBingo(); renderCoop();
  if (r.fill && question?.fill && r.phase !== 'reveal') { renderFill(r.fill); renderQlog(); } // 3つ埋めバトル：埋まった枠・消えた選択肢を全員の画面に
  // サバイバルのライフ（♥）・脱落、チームの色、早押しでいま答えている人
  const survival = r.settings.play === 'survival' && r.state !== 'lobby';
  const extraTags = p => (p.team ? `<span class="team-tag team-${p.team}">${TEAM_LABEL[p.team]}</span>` : '')
    + (survival && p.out ? '<span class="out">脱落</span>' : survival && p.lives != null ? `<span class="lives" title="ライフ">${'♥'.repeat(p.lives)}</span>` : '')
    + (p.buzzing ? '<span class="buzzing">回答中</span>' : '')
    + (p.picker ? '<span class="buzzing">出題者</span>' : '')
    + (p.passed ? '<span class="passed">パス</span>' : '')
    + (p.card && r.state === 'playing' && p.bingo ? '<span class="bingo-tag done">BINGO!</span>' : '')
    + (p.timeline ? `<span class="rush-tag" title="年表の枚数">📅${p.timeline.length}</span>` : '')
    + (p.karutaCount != null ? `<span class="rush-tag" title="取った札">🎴${p.karutaCount}</span>${p.karutaRest ? '<span class="rush-tag" title="お手つき">休み</span>' : ''}` : '')
    + (p.pokerCount != null ? `<span class="rush-tag" title="手札の枚数">🃏${p.pokerCount}</span>` : '')
    + (p.rush ? `<span class="rush-tag" title="${MODE_VIEW[p.rush.mode || 'rush']?.label || 'RUSH'}中（連チャン ${p.rush.chain}・あと${p.rush.left}問）">🔥×${p.rush.mult}</span>` : '');
  renderRush(r, r.players.find(p => p.id === me));
  // ビンゴ：名前の下に、その人のカードの埋まり具合を小さな4×4で（開いたマスに色）
  const miniCard = p => (p.card && r.state === 'playing'
    ? `<span class="mini-bingo${p.bingo ? ' done' : ''}" title="${p.card.filter(c => c.open && c.w !== 'FREE').length}マス開いた">${p.card.map(c =>
      `<i class="${c.w === 'FREE' ? 'free' : c.open ? 'open' : ''}"></i>`).join('')}</span>` : '');
  $('players').innerHTML = r.players.map(p => `
    <li data-id="${p.id}" class="${p.answered ? 'answered' : ''} ${p.connected ? '' : 'off'} ${p.id === me ? 'me' : ''} ${p.team ? 'team-' + p.team : ''} ${survival && p.out ? 'is-out' : ''} ${p.buzzing ? 'is-buzzing' : ''}">
      <span class="pl-face">${avatarImg(p.avatar)}${top > 0 && p.score === top ? icon('crown', 'crown') : ''}</span>
      <span class="pl-name"><b>${esc(p.name)}</b>${p.id === r.hostId || p.id === me || p.streak >= 2 || extraTags(p) ? `<span class="tags">${p.id === r.hostId ? '<span class="host">HOST</span>' : ''}${p.id === me ? '<span class="you">YOU</span>' : ''}${p.streak >= 2 ? `<span class="streak" title="連続正解">${p.streak}連</span>` : ''}${extraTags(p)}</span>` : ''}${miniCard(p)}</span>
      <span class="pts${prevScores.has(p.id) && p.score > prevScores.get(p.id) ? ' bump' : ''}">${p.score}</span>
      ${p.answered ? '<span class="pl-check" title="回答済み"></span>' : ''}
    </li>`).join('');
}

// ── 演出 ──
function flash(kind, text, sub = '') {
  const el = $('flash');
  el.className = 'flash ' + kind;
  el.innerHTML = `<span>${icon(kind === 'ok' ? 'ok' : 'ng', 'flash-icon')}${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
  el.hidden = false;
  clearTimeout(flash.t); flash.t = setTimeout(() => { el.hidden = true; }, 1400);
  charFx.pose(kind === 'ok' ? 'ok' : 'ng');
}
function confetti(count = 80) {
  const colors = ['var(--accent)', 'var(--accent2)', 'var(--warn)', 'var(--ok)', '#fff'];
  const box = $('confetti');
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = 2 + Math.random() * 2.5 + 's';
    p.style.animationDelay = Math.random() * .6 + 's';
    box.appendChild(p);
    setTimeout(() => p.remove(), 5500);
  }
}

function show(id) { ['lobby', 'quiz', 'result', 'over'].forEach(x => $(x).hidden = x !== id); }
// 選択肢の大きさ（PC）：出題中は大きく、答え合わせでは小さく（body.compact）。
// 切り替えは、いったん消して（フェードアウト）から大きさを変えて出す（フェードイン）
let swapTimer = null;
const isWide = () => matchMedia('(min-width: 900px)').matches;
function setCompact(on) {
  clearTimeout(swapTimer);
  if (document.body.classList.contains('compact') === on) return;
  if (!isWide()) { document.body.classList.toggle('compact', on); return; } // スマホは大きさが変わらないので何もしない
  $('quiz').classList.add('swap');
  swapTimer = setTimeout(() => { document.body.classList.toggle('compact', on); $('quiz').classList.remove('swap'); }, 220);
}
// 新しい問題：前の選択肢はもう無いので、消した状態から大きい選択肢をフェードインで出す
function showBigChoices() {
  clearTimeout(swapTimer);
  const q = $('quiz');
  if (isWide()) q.classList.add('swap', 'instant');
  document.body.classList.remove('compact');
  swapTimer = setTimeout(() => q.classList.remove('swap', 'instant'), 40);
}
function setPhase(cls, label) { $('phase').className = 'phase ' + cls; $('phase').textContent = label; }

// 場面の切り替わり演出（動画は tools/gen-effects.js で作ったもの。黒い背景は CSS で消す）
// ステージの絵：場面ごとのループ動画
function coverFx(name) {
  const v = document.createElement('video');
  Object.assign(v, { src: `/assets/fx/${name}.mp4`, autoplay: true, loop: true, muted: true, playsInline: true, className: 'cover-fx' });
  v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); // 自動再生の判定が属性を見るブラウザ向け
  v.onerror = () => { $('cover').innerHTML = '<span>?</span>'; }; // 動画が読めなければ元の「？」
  $('cover').innerHTML = '<span>?</span>'; // エフェクトを0にしたときは「？」が見える
  $('cover').append(v);
}
// マスコット（キャラクター。public/characters.js）。絵は場面（listen/chorus/again/ok/ng…）ごとに /assets/mascot/<キャラ>/<場面>.webp
// キャラは自分の画面用に選ぶ（端末に保存）
let charKey = CHARACTERS[store.get('aq-char')] ? store.get('aq-char') : 'twins';
const charDef = () => CHARACTERS[charKey];
// 絵がない場面は近い場面の絵を使う
const mascotUrl = pose => `/assets/mascot/${charKey}/${charDef().poses.includes(pose) ? pose : FALLBACK[pose] || 'ok'}.webp`;
document.body.dataset.char = charKey;
// キャラの切り替え（ステージの「キャラ選択」とトップ画面の2か所。端末に保存）
function applyChar(key) {
  if (!CHARACTERS[key]) return;
  charKey = key; store.set('aq-char', key);
  document.body.dataset.char = key;
  document.querySelectorAll('.char-sel').forEach(s => { s.value = key; });
  preloadMascot.done = false; if (room) preloadMascot();
  if (typeof charFx !== 'undefined') { charFx.refresh(); charFx.say('lobby'); }
  if (!$('mascot').hidden) stageMascot(stageMascot.last || null);
}
document.querySelectorAll('.char-sel').forEach(s => { s.value = charKey; s.onchange = e => applyChar(e.target.value); });
const charFx = initCharFx({ $, mascotUrl: p => mascotUrl(p), assetUrl: f => `/assets/mascot/${charKey}/${f}.webp`, charDef: () => charDef(),
  getVars: () => ({ name: room?.players?.find(p => p.id === me)?.name || $('nameInput').value || '' }) }); // 常駐・吹き出し・カットイン・カウントダウン
// ステージ：場面ごとに小さく出しておく（null で隠す）
function stageMascot(name) {
  stageMascot.last = name;
  const m = $('mascot');
  if (!name) { m.hidden = true; return; }
  const url = mascotUrl(name);
  if (!m.src.endsWith(url)) m.src = url;
  m.hidden = false; m.classList.remove('hop'); void m.offsetWidth; m.classList.add('hop');
}
// ── 答え合わせの曲ツール：この曲をコピー／この曲は除外しない／イントロ・サビの位置を直す（メモ）──
const KEEP_KEY = 'aq-keep', FIX_KEY = 'aq-fixes';
const readJson = (k, d) => { try { return JSON.parse(store.get(k) || 'null') ?? d; } catch (e) { return d; } };
const keptIds = () => new Set(readJson(KEEP_KEY, []));   // 「除外しない」にした曲（この端末）
const fixes = () => readJson(FIX_KEY, {});                 // 直した位置のメモ（この端末）：id → { t: 曲名, w: 作品, i: イントロ, c: サビ }
const fixText = () => ['アニソンイントロ対戦 イントロ・サビ位置の修正メモ（チェック画面の「ゲーム中に直した位置を取り込む」に貼り付け）',
  ...Object.entries(fixes()).map(([id, f]) => `AQFIX1 ${id} intro=${f.i} chorus=${f.c} ｜ ${f.t} ／ ${f.w}`)].join('\n');
function setupSongTools(s, r) {
  $('copySongBtn').onclick = async () => {
    // 曲名・作品名と YouTube の URL（あとで聴き直したり、人に送ったりする用）
    const text = `${s.title} ／ ${s.work}\nhttps://www.youtube.com/watch?v=${s.id}`;
    toast(await copyText(text) ? `「${s.title}」をコピーしました` : 'コピーできませんでした');
  };
  // 部屋の除外・この端末の記録から外し、この先も除外しない（何度か出てもいい曲）
  $('keepSongBtn').onclick = () => {
    const kept = keptIds(); kept.add(s.id);
    store.set(KEEP_KEY, JSON.stringify([...kept].slice(-3000)));
    store.set(DEVICE_KEY, JSON.stringify(deviceIds().filter(id => id !== s.id)));
    updateDeviceInfo();
    socket.emit('keepSong', s.id);
    $('keepSongBtn').textContent = '✓ 除外しない曲';
    toast(`「${s.title}」は除外しません（また出ることがあります）`);
  };
  // 修正を依頼（答え合わせのボタン）：中身は makeFixPanel（ほかの遊び方の「🛠 修正」窓と同じ）
  const fixUi = makeFixPanel(s, { intro: r.intro, chorus: r.chorus }, {
    label: t => { $('fixToggle').textContent = `🛠 修正を依頼（${t}）`; },
    close: () => { $('fixPanel').hidden = true; socket.emit('fixHold', false); },
  });
  $('fixToggle').onclick = () => {
    const p = $('fixPanel');
    p.hidden = !p.hidden;
    socket.emit('fixHold', !p.hidden); // 開いている間は、自動で次の問題へ進まない（閉じるか送ると再開）
    if (!p.hidden) fixUi(p);
  };
}
// ── 修正を依頼の中身：⏱ イントロ・サビの位置／✏️ 曲名・アニメ名・歌っている人・作者／🔁 曲が違う・削除 をタブで選ぶ ──
// s：曲（id・title・work・artist・type）、pos0：いまのイントロ・サビ（秒）、cb.label：送ったあとのボタンの表示、cb.close：閉じる
// 名前の一覧（作品名・歌っている人・作者）。一度だけ読み込む。検索はひらがな・カタカナ・全角半角・大文字小文字を区別しない
let catsCache = null;
const loadCats = () => catsCache || (catsCache = fetch('/api/categories').then(r => r.json()).catch(() => { catsCache = null; return { works: [], artists: [], authors: [] }; }));
const catNorm = x => String(x || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s・･·\-‐_.,!！?？'"]/g, '');
function makeFixPanel(s, pos0, cb) {
  // 位置を直す：自分の画面のプレーヤーで試し聴きしながら、イントロ・サビの秒数を決めてメモに残す
  const saved = fixes()[s.id];
  const pos = { i: saved?.i ?? pos0.intro ?? 0, c: saved?.c ?? pos0.chorus ?? 0 };
  const round = x => Math.max(0, Math.round(x * 10) / 10);
  const row = (k, label) => `<div class="fix-row"><b>${label}</b><span class="fix-sec" data-sec="${k}">${pos[k]}秒</span>
    <span class="fix-btns"><button class="btn-sub" data-fk="${k}" data-d="-1">−1</button><button class="btn-sub" data-fk="${k}" data-d="-0.1">−0.1</button>`
    + `<button class="btn-sub" data-fk="${k}" data-d="0.1">+0.1</button><button class="btn-sub" data-fk="${k}" data-d="1">+1</button>`
    + `<button class="btn-sub" data-now="${k}">今の位置</button><button class="btn-sub" data-play="${k}">▶ 聴く</button></span></div>`;
  let tab = 'pos';
  const sendReport = async (body, done) => {
    try {
      const res = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id, ...body }) });
      const j = await res.json().catch(() => ({}));
      toast(res.ok ? (j.message || '送りました') : (j.error || '送れませんでした'));
      if (res.ok) { cb.label(done); cb.close(); }
    } catch (e) { toast('送れませんでした（通信エラー）'); }
  };
  const vocaloid = s.type === 'ボカロ', author = String(s.work || '').normalize('NFKC').match(/^ボカロ\((.+)\)$/)?.[1] || '';
  const infoForm = () => {
    const f = (k, label, v) => `<div class="fix-field"><b>${label}</b><div class="fix-pick"><input data-cat="${k}" value="${esc(v)}" data-orig="${esc(v)}" maxlength="100" autocomplete="off" placeholder="入力して一覧から選ぶ"><div class="fix-sugg" hidden></div></div></div>`;
    return '<p class="note">すでにある名前の一覧から検索して選ぶと、その場で直ります（次にこの曲が出たときから）</p>'
      + (vocaloid ? f('author', '作者', author) : f('work', 'アニメ名（作品名）', s.work)) + f('artist', '歌っている人', s.artist)
      + '<div class="fix-actions"><button class="btn-main" data-send="cat" type="button">この内容で直す</button></div>'
      + '<p class="note fix-sep">曲名がちがうとき（確認してから直します）</p>'
      + `<label class="fix-field"><b>曲名</b><input data-info="title" value="${esc(s.title)}" maxlength="100" autocomplete="off"></label>`
      + '<label class="fix-field"><b>ひとこと</b><input data-note maxlength="200" placeholder="（任意）理由や出典など" autocomplete="off"></label>'
      + '<div class="fix-actions"><button class="btn-sub" data-send="info" type="button">曲名の修正を依頼</button></div>';
  };
  const wrongForm = () => '<div class="fix-kind"><label><input type="radio" name="wrongKind" value="wrong" checked> 曲が違う（動画が別の曲・別バージョン）</label>'
    + '<label><input type="radio" name="wrongKind" value="delete"> 削除を依頼（出題しないでほしい）</label></div>'
    + '<label class="fix-field"><b>ひとこと</b><input data-note maxlength="200" placeholder="（任意）どう違うか・正しい曲など" autocomplete="off"></label>'
    + '<div class="fix-actions"><button class="btn-main" data-send="wrong" type="button">送る</button></div>';
  const posForm = () => row('i', 'イントロ') + row('c', 'サビ')
    + `<div class="fix-actions"><button class="btn-main" data-send="pos">この位置で送る</button><button class="btn-sub" data-copy>📋 直した位置をコピー</button></div>`
    + '<p class="note">「この位置で送る」を押すと、みんなの曲データが直ります（次にこの曲が出たときから）。</p>';
  const render = p => {
    const tabs = [['pos', '⏱ イントロ・サビの位置'], ['info', '✏️ 曲名・アニメ名・歌手'], ['wrong', '🔁 曲が違う・削除']]
      .map(([k, l]) => `<button type="button" class="btn-sub${tab === k ? ' on' : ''}" data-ftab="${k}">${l}</button>`).join('');
    p.innerHTML = `<div class="fix-tabs">${tabs}</div>` + (tab === 'info' ? infoForm() : tab === 'wrong' ? wrongForm() : posForm());
    p.querySelectorAll('[data-ftab]').forEach(b => b.onclick = () => { tab = b.dataset.ftab; render(p); });
    const note = () => p.querySelector('[data-note]')?.value.trim() || '';
    if (tab === 'info') {
      // 名前の一覧（カテゴリ）から検索して選ぶ
      const key = { work: 'works', author: 'authors', artist: 'artists' };
      p.querySelectorAll('[data-cat]').forEach(inp => {
        const box = inp.nextElementSibling;
        const show = async () => {
          const list = (await loadCats())[key[inp.dataset.cat]] || [];
          const q = catNorm(inp.value);
          const hits = (q ? list.filter(x => catNorm(x).includes(q)) : list).slice(0, 8);
          box.innerHTML = hits.map(x => `<button type="button" data-v="${esc(x)}">${esc(x)}</button>`).join('') || '<small>一覧にありません（曲名のように依頼してください）</small>';
          box.hidden = false;
          box.querySelectorAll('[data-v]').forEach(b => b.onmousedown = e => { e.preventDefault(); inp.value = b.dataset.v; box.hidden = true; });
        };
        inp.oninput = show; inp.onfocus = show;
        inp.onblur = () => setTimeout(() => { box.hidden = true; }, 150);
      });
      p.querySelector('[data-send="cat"]').onclick = async () => {
        const cats = await loadCats(), body = {};
        for (const inp of p.querySelectorAll('[data-cat]')) {
          const v = inp.value.trim(), k = inp.dataset.cat;
          if (!v || v === inp.dataset.orig) continue;
          if (!(cats[key[k]] || []).includes(v)) return toast('一覧の中から選んでください（入力すると候補が出ます）');
          body[k] = v;
        }
        if (!Object.keys(body).length) return toast('直したいところを一覧から選んでください');
        try {
          const res = await fetch('/api/song-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id, ...body }) });
          const j = await res.json().catch(() => ({}));
          toast(res.ok ? (j.message || '直しました') : (j.error || '直せませんでした'));
          if (res.ok) { Object.assign(s, j.song || {}); cb.label('情報を直しました'); cb.close(); }
        } catch (e) { toast('直せませんでした（通信エラー）'); }
      };
      p.querySelector('[data-send="info"]').onclick = () => {
        const v = p.querySelector('[data-info="title"]').value.trim();
        if (!v || v === s.title) return toast('曲名を書き直してください');
        sendReport({ kind: 'info', fix: { title: v }, note: note() }, '曲名の修正を送信済み');
      };
      return;
    }
    if (tab === 'wrong') {
      p.querySelector('[data-send="wrong"]').onclick = () => {
        const kind = p.querySelector('[name="wrongKind"]:checked')?.value || 'wrong';
        if (kind === 'delete' && !confirm(`「${s.title}」の削除を依頼しますか？`)) return;
        sendReport({ kind, note: note() }, kind === 'delete' ? '削除の依頼を送信済み' : '曲が違うを送信済み');
      };
      return;
    }
    const save = quiet => {
      const all = fixes(); all[s.id] = { t: s.title, w: s.work, i: pos.i, c: pos.c };
      store.set(FIX_KEY, JSON.stringify(all));
      cb.label('位置は直し済み');
      if (!quiet) toast(`「${s.title}」の位置をメモしました（${Object.keys(all).length}曲）`);
    };
    // 変えるたびにメモに残す（自動で次の問題に進んでも消えないように）
    const show = () => { p.querySelector('[data-sec="i"]').textContent = `${pos.i}秒`; p.querySelector('[data-sec="c"]').textContent = `${pos.c}秒`; save(true); };
    p.querySelectorAll('[data-fk]').forEach(b => b.onclick = () => { pos[b.dataset.fk] = round(pos[b.dataset.fk] + +b.dataset.d); show(); });
    p.querySelectorAll('[data-now]').forEach(b => b.onclick = () => { pos[b.dataset.now] = round(player.time()); show(); });
    p.querySelectorAll('[data-play]').forEach(b => b.onclick = () => player.currentId() === s.id ? player.playFrom(pos[b.dataset.play]) : player.playVideoFrom(s.id, pos[b.dataset.play]));
    // サーバーに送る（収録曲一覧の「修正を送る」と同じ受け付け）
    p.querySelector('[data-send="pos"]').onclick = async () => {
      save(true);
      try {
        const res = await fetch('/api/fixes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id, intro: pos.i, chorus: pos.c }) });
        const j = await res.json().catch(() => ({}));
        toast(res.ok ? (j.message || '送りました') : (j.error || '送れませんでした'));
        if (res.ok) { cb.label('位置を送信済み'); cb.close(); }
      } catch (e) { toast('送れませんでした（通信エラー）'); }
    };
    p.querySelector('[data-copy]').onclick = async () => {
      const n = Object.keys(fixes()).length;
      if (!n) return toast('まだメモした曲がありません');
      toast(await copyText(fixText()) ? `直した位置 ${n}曲をコピーしました` : 'コピーできませんでした');
    };
  };
  return render;
}
// ── どの遊び方でも「🛠 修正」：このゲームで出た曲（新しい順）から選んで、修正を依頼する（3つ埋め・ボードゲーム風など、答え合わせの画面がちがう遊び方用）──
let fixRecent = [];
socket.on('fixSongs', list => { if (Array.isArray(list)) { fixRecent = list.slice(0, 30); updateFixFab(); } });
socket.on('fixSong', s => { if (!s?.id) return; fixRecent = [s, ...fixRecent.filter(x => x.id !== s.id)].slice(0, 30); updateFixFab(); });
function updateFixFab() {
  const fab = $('fixFab'); if (!fab) return;
  fab.hidden = !(room && ['playing', 'result'].includes(room.state) && fixRecent.length);
}
$('fixFab').onclick = () => openFixPop(0);
function openFixPop(sel = 0) {
  const pop = $('fixPop'), s = fixRecent[sel]; if (!s) return;
  pop.hidden = false;
  socket.emit('fixHold', true);
  const close = () => { pop.hidden = true; pop.innerHTML = ''; socket.emit('fixHold', false); };
  pop.innerHTML = `<div class="wf-field fix-pop"><div class="wf-head"><b>🛠 曲の修正を依頼</b><span>この部屋で出た曲（新しい順）</span><button class="btn-sub fix-x" type="button" data-close>✕ 閉じる</button></div>
    <div class="fix-songs">${fixRecent.map((x, i) => `<button type="button" class="btn-sub${i === sel ? ' on' : ''}" data-song="${i}"><b>${esc(x.title)}</b><small>${esc(x.work)}／${esc(x.artist)}</small></button>`).join('')}</div>
    <div class="fix-panel" data-fixbox></div></div>`;
  pop.querySelector('[data-close]').onclick = close;
  pop.onclick = e => { if (e.target === pop) close(); };
  pop.querySelectorAll('[data-song]').forEach(b => b.onclick = () => openFixPop(+b.dataset.song));
  makeFixPanel(s, { intro: s.intro, chorus: s.chorus }, { label: t => toast(`「${s.title}」：${t}`), close })(pop.querySelector('[data-fixbox]'));
}
// ── マイページの出し入れ（答え合わせ画面）：♡ お気に入り・🚫 もう聞きたくない・🎯 もう一度出して（苦手の枠） ──
function renderMeTools(s) {
  const box = $('meTools'); if (!box) return;
  if (!meUser()) { box.innerHTML = '<a class="me-hint" href="/me.html" target="_blank" rel="noopener">👤 マイページに名前を登録すると、お気に入り・もう聞きたくない曲を残せます</a>'; return; }
  const has = (list, id) => list === 'fav' || list === 'block' || list === 'again' ? (meData?.[list] || []).includes(id) : false;
  const btn = (list, on, off) => `<button class="btn-sub${has(list, s.id) ? ' on' : ''}" data-me="${list}" type="button">${has(list, s.id) ? on : off}</button>`;
  box.innerHTML = btn('fav', '♥ お気に入り済み', '♡ お気に入り') + btn('block', '🚫 もう聞かない曲', '🚫 もう聞きたくない') + btn('again', '🎯 もう一度出す曲', '🎯 もう一度出して');
  box.querySelectorAll('[data-me]').forEach(b => b.onclick = async () => {
    const list = b.dataset.me, on = !has(list, s.id);
    const err = await meList(list, s.id, on);
    if (err) return toast(err);
    toast({ fav: on ? `「${s.title}」をお気に入りにしました（部屋の除外があっても出ます）` : 'お気に入りから外しました',
            block: on ? `「${s.title}」は、あなたがいる部屋では出なくなります` : 'もう聞きたくない曲から外しました',
            again: on ? `「${s.title}」を苦手な曲（もう一度出す）に入れました` : 'もう一度出す曲から外しました' }[list]);
    renderMeTools(s);
  });
}
loadMe();
addEventListener('focus', () => { loadMe(); if (meUser()) socket.emit('login', meUser()); }); // マイページを別のタブで変えたら読み直す（登録したての名前も部屋の席に結びつける）

// ── 曲リクエスト（トップ画面）：だれでも送れて、一覧はみんなに見える ──
const REQ_LABEL = { open: '受付中', added: '追加済み', notfound: '見つからず' };
let reqAll = [], reqShown = 20, reqGenres = {};
async function loadRequests() {
  let data;
  try { data = await fetch('/api/requests').then(r => r.json()); } catch (e) { return; }
  reqAll = data.requests || [];
  // ジャンルの選択肢（今あるジャンル）。最初の1回だけ作る
  if (data.genres && $('reqGenre').options.length <= 1) {
    reqGenres = Object.fromEntries(data.genres.map(g => [g.key, g.label]));
    $('reqGenre').insertAdjacentHTML('beforeend', data.genres.map(g => `<option value="${esc(g.key)}">${esc(g.label)}</option>`).join(''));
  }
  renderRequests();
}
function renderRequests() {
  const open = reqAll.filter(r => r.status === 'open').length;
  $('reqCount').textContent = reqAll.length ? `（受付中 ${open}件）` : '';
  $('reqList').innerHTML = reqAll.slice(0, reqShown).map(r => `<li class="req-${r.status}">
    <span class="req-status">${REQ_LABEL[r.status] || ''}</span>
    <span class="req-body"><b>${esc(r.title)}</b>${r.work ? `<small>${esc(r.work)}</small>` : ''}${r.artist ? `<small>${esc(r.artist)}</small>` : ''}${r.genre && reqGenres[r.genre] ? `<small class="req-genre">${esc(reqGenres[r.genre])}</small>` : ''}${r.note ? `<em>${esc(r.note)}</em>` : ''}</span>
    ${(r.votes || 1) > 1 ? `<span class="req-votes">${r.votes}票</span>` : ''}
    ${r.status === 'added' && r.songId ? `<a class="btn-sub req-edit" href="songs.html?song=${encodeURIComponent(r.songId)}" title="試し聴きして、イントロ・サビの位置を直して送れます">✏ 位置を直す</a>` : ''}
    ${candCountOf(r.id) ? `<button class="btn-sub req-near${candFor === r.id ? ' on' : ''}" data-req="${esc(r.id)}">🔎 まわりの曲 ${candCountOf(r.id)}</button>` : ''}</li>`).join('') || '<li class="empty">まだリクエストはありません</li>';
  $('reqMore').hidden = reqAll.length <= reqShown;
}
$('reqMore').onclick = () => { reqShown += 30; renderRequests(); };
// リクエストの「まわりの曲」を押したら、そのリクエストの検討中の曲だけを右側に出す（もう一度押すと閉じる）
$('reqList').onclick = e => {
  const b = e.target.closest('.req-near');
  if (!b) return;
  candFor = candFor === b.dataset.req ? null : b.dataset.req;
  candShown = 15; renderRequests(); renderCandidates();
};
// 追加を検討中の曲：「入れてほしい」を押すと1票（票が入った曲は次の更新で追加）
let candAll = [], candShown = 15, candFor = null; // candFor：いま見ているリクエストのID
const candCountOf = id => candAll.filter(c => c.requestId === id).length;
async function loadCandidates() {
  try { candAll = (await fetch('/api/candidates').then(r => r.json())).candidates || []; } catch (e) { return; }
  renderCandidates(); renderRequests(); // リクエストの「まわりの曲」の数を出す
}
const viewsLabel = v => v >= 1e4 ? `${Math.round(v / 1e4)}万回` : v ? `${v}回` : '';
function renderCandidates() {
  const req = reqAll.find(r => r.id === candFor);
  const list = candFor ? candAll.filter(c => c.requestId === candFor) : [];
  $('candCount').textContent = req ? `：「${req.title}」のまわり（${list.length}曲）` : candAll.length ? `（全 ${candAll.length}曲）` : '';
  $('candNote').hidden = !!candFor;
  $('candList').hidden = !candFor;
  $('candList').innerHTML = list.slice(0, candShown).map(c => `<li>
    <span class="req-body"><b>${esc(c.title)}</b><small>${esc(c.work)}${c.type ? `（${esc(c.type)}）` : ''}</small><small>${esc(c.artist)}</small>${c.views ? `<em>再生 ${viewsLabel(c.views)}</em>` : ''}
      <span class="cand-links">${c.videoId ? `<a href="https://www.youtube.com/watch?v=${encodeURIComponent(c.videoId)}" target="_blank" rel="noopener">▶ YouTubeで試し聴き</a>` : ''}<a href="https://www.google.com/search?q=${encodeURIComponent(`${c.title} ${c.work}`)}" target="_blank" rel="noopener">🔍 Googleで調べる</a></span></span>
    <button class="btn-sub cand-vote" data-id="${esc(c.id)}">👍 入れてほしい${c.votes ? ` ${c.votes}` : ''}</button></li>`).join('') || '<li class="empty">いまはありません</li>';
  $('candMore').hidden = !candFor || list.length <= candShown;
}
$('candMore').onclick = () => { candShown += 30; renderCandidates(); };
$('candList').onclick = async e => {
  const b = e.target.closest('.cand-vote');
  if (!b) return;
  b.disabled = true;
  try {
    const j = await fetch('/api/candidates/vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.id }) }).then(r => r.json());
    toast(j.message || j.error || '送れませんでした');
    const c = candAll.find(x => x.id === b.dataset.id);
    if (c && j.votes) { c.votes = j.votes; renderCandidates(); }
  } catch (err) { toast('送れませんでした'); b.disabled = false; }
};
loadCandidates();
$('reqForm').onsubmit = async e => {
  e.preventDefault();
  const body = { title: $('reqTitle').value, work: $('reqWork').value, artist: $('reqArtist').value, genre: $('reqGenre').value, note: $('reqNote').value };
  $('reqSend').disabled = true;
  try {
    const res = await fetch('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json();
    toast(j.message || j.error || '送れませんでした');
    if (res.ok && !j.exists) { $('reqForm').reset(); loadRequests(); }
  } catch (err) { toast('送れませんでした'); }
  $('reqSend').disabled = false;
};
loadRequests();
// ── レイアウト編集（パソコンだけ・自分の画面だけ）とテスト1問（public/layout.js）──
let practice = false;
const layoutApi = initLayout({ socket, player, $, store, toast, getRoom: () => room, getMe: () => me, setPractice: v => { practice = v; } });
// 最初の問題で前もって読み込んでおく（アニメで少し重いので、出る瞬間に遅れないように）
function preloadMascot() {
  if (preloadMascot.done || document.body.classList.contains('mascot-off')) return;
  preloadMascot.done = true;
  for (const n of charDef().poses) new Image().src = mascotUrl(n);
  const sp = charDef().split; // 左右に分けるときの絵も
  if (sp) for (const f of new Set([...Object.values(sp.left), ...Object.values(sp.right)])) new Image().src = `/assets/mascot/${charKey}/${f}.webp`;
}
// 画面の下から、ぴょこっと出て引っ込む
function popMascot(name, ms = 1600) {
  const el = $('mascotPop');
  el.innerHTML = `<img src="${mascotUrl(name)}" alt="">`;
  el.classList.remove('show'); el.hidden = false; void el.offsetWidth; el.classList.add('show');
  clearTimeout(popMascot.t); popMascot.t = setTimeout(() => { el.hidden = true; el.innerHTML = ''; }, ms);
}
// 画面中央に一瞬だけ出す文字（「もう一回！」「サビ！」など）
function cue(text, fx) {
  const el = $('cue');
  el.innerHTML = `<video class="${fx}" src="/assets/fx/${fx}.mp4" autoplay muted playsinline></video><span>${esc(text)}</span>`;
  const v = el.querySelector('video'); v.playbackRate = 1.3; v.onerror = () => v.remove();
  el.classList.remove('show'); el.hidden = false; void el.offsetWidth; el.classList.add('show');
  clearTimeout(cue.t); cue.t = setTimeout(() => { el.hidden = true; el.innerHTML = ''; }, 1600);
}

// ── 出題 ──
const isInput = () => question?.answerMode === 'input';

socket.on('question', q => {
  hidePokerBet(); hideWolf(); hideDixit(); hideDt(); hideBaba(); hideCn(); hideDf(); hideWw(); hideKm(); hideAz();
  if (q.attack) setTimeout(() => charFx.cutin('アタックチャンス！', '白いマスを、この問題の正解者がどこからでも取れます', 'cutin'), 400);
  if (q.qNo === 1 && !practice) playLog = []; // 新しいゲーム（テスト1問では曲ログを消さない）
  question = q; myAnswer = null; answering = false;
  stopTick();
  showBigChoices(); hintSeen = false; introLeft = 0;
  document.body.classList.remove('rush-reach'); // 激アツRUSH：前の問題のリーチの光を消す
  $('timer').textContent = ''; $('barFill').style.width = '0';
  clearInterval(nextTick); $('nextCount').textContent = ''; clearTimeout(goTimer); fadingOut = false; document.body.classList.remove('fading');
  $('barMark').style.left = (q.settings.hintAt / (q.settings.hintAt + q.settings.chorusLen) * 100) + '%';
  if (q.final && !practice) charFx.say('final');
  else if (q.qNo > 1 && !practice) {
    const left = q.qTotal - q.qNo + 1;
    if (left <= 3) charFx.say('remain', { left });
    else if (q.qNo - 1 === Math.floor(q.qTotal / 2)) charFx.say('half');
    else charFx.say('qstart', { n: q.qNo, nk: kanjiNum(q.qNo) });
  }
  $('qno').innerHTML = (q.play === 'survival' ? `第 ${q.qNo} 問（サバイバル）` : q.endless ? `第 ${q.qNo} 問（全部そろうまで）` : `第 ${q.qNo} / ${q.qTotal} 問`)
    + (q.kind === 'sabimae' ? '（サビ前問題）' : q.kind === 'random' ? '（どこから？）' : '')
    + (q.target === 'work' ? '・作品を当てよう' : q.target === 'year' ? '・何年の曲？' : q.target === 'artist' ? '・歌っているのは？' : '')
    + (q.speed && q.speed !== 1 ? ` <b class="speed">${q.speed}倍速</b>` : '')
    + (q.pickerName ? ` ・出題：${esc(q.pickerName)}` : '')
    + (q.final ? ' <b class="final">最終問題・得点2倍</b>' : '');
  $('cover').innerHTML = '<span>?</span>'; stageMascot(null); preloadMascot();
  document.body.classList.remove('revealing', 'playing'); // 背景の映像を隠す
  setPhase('', '読み込み中');
  $('quizNote').textContent = '';
  $('clues').innerHTML = ''; $('lifeResults').innerHTML = '';
  $('choices').hidden = isInput(); $('inputForm').hidden = !isInput();
  $('answerInput').value = ''; $('answerInput').disabled = true; $('sendBtn').disabled = true;
  $('answerInput').placeholder = q.target === 'work' ? '作品名を入力' : '曲名か作品名を入力';
  // 年代当て：年のボタンを並べる（選択肢と同じ見た目・同じ答え合わせの表示）
  $('choices').classList.toggle('years', q.answerMode === 'year');
  $('choices').innerHTML = isInput() || q.fill || !q.choices && q.answerMode !== 'year' ? '' : q.answerMode === 'year'
    ? q.years.map((y, i) => `<button class="choice year" data-i="${i}" disabled>${y}</button>`).join('')
    : q.choices.map((c, i) => `<button class="choice${c.gone ? ' gone empty' : ''}${q.play === 'karuta' ? ' ' + ([...(c.title || '')].length > 18 ? 'len3' : [...(c.title || '')].length > 11 ? 'len2' : [...(c.title || '')].length > 6 ? 'len1' : '') : ''}" data-i="${i}" disabled>${esc(c.title)}${c.work ? `<small>${esc(c.work)}</small>` : ''}</button>`).join('');
  $('choices').classList.toggle('karuta', q.play === 'karuta');
  $('choices').style.removeProperty('--kh'); fitKaruta();
  if (q.answerMode === 'nenpyo') { $('choices').hidden = true; $('inputForm').hidden = true; nenpyoSlot = null; }
  if (q.play === 'karuta' && (q.rest || []).includes(me)) setTimeout(() => toast('お手つきのため、この曲はお休みです'), 300);
  $('choices').querySelectorAll('.choice').forEach(b => b.onclick = () =>
    answer(q.answerMode === 'year' ? { year: q.years[+b.dataset.i], index: +b.dataset.i } : { index: +b.dataset.i }));
  // 早押し：押すボタン（押した人だけが答えられる）
  $('buzzRow').hidden = q.play !== 'buzzer' && q.play !== 'fill'; $('buzzBtn').disabled = true; $('buzzInfo').textContent = ''; buzzHolder = null;
  // 3つ埋めバトル：選択肢・入力の欄の代わりに枠を出す
  if (q.fill) { $('choices').hidden = true; $('inputForm').hidden = true; }
  fillLockUntil = 0; fillWaiting = false; fillSlot = null; buzzQueueIds = []; buzzQueueNames = []; $('fillAnswer').hidden = true; renderFill(q.fill);
  qlogEntries = []; renderQlog(); // パスの下の記録はこの問題の分だけ
  if (amOut()) $('quizNote').textContent = '脱落しました。最後まで見て応援しよう！';
  $('pickPanel').hidden = true; clearInterval(pickTick);
  if (q.pickerId === me) $('quizNote').textContent = 'あなたが出題した曲です。みんなが答えるのを見守ろう！';
  renderBingo(); renderCoop();
  $('lifelines').hidden = false;
  updateLifelineButtons();
  show('quiz');
  player.load(q.videoId, q.start ?? q.intro);
});

// offset は途中から戻ってきた人向け（経過秒）
// offset は曲が流れ始めてからの経過秒。マイナスのときは、選択肢を見せてからその秒数待って流す（最初の1秒の待ち）。
// 途中から戻ってきた人はプラスの経過秒が届く
let goTimer = null;
socket.on('go', ({ intro, start = intro, kind, hintAt, total, offset = 0, introLen, plays = 1, gap = 1, speed = 1, t0 = null }) => {
  // 時計合わせ済みなら、サーバーの時計で全員同じ時刻（t0）に流し始める（合図が届くまでの遅れでずれないように）
  const serverNow = () => clientNow() + clockOffset;
  if (t0 && clockOffset != null) offset = (serverNow() - t0) / 1000;
  player.setRate(speed); // 倍速・スロー（問題の間ずっと。答え合わせでふつうに戻す）
  document.body.classList.add('playing'); // 背景に Ambient light 風のぼかし映像
  if (!practice) document.body.classList.add('game-started'); // ここからゲームの終わりまで、キャラは左右のまま（問題の間の読み込み中も）
  clearTimeout(goTimer);
  stopTick();
  $('barMark').style.left = (hintAt / total * 100) + '%';
  $('timer').textContent = total.toFixed(1);
  const wait = Math.max(0, -offset), off = Math.max(0, offset);
  // 本来の再生位置（曲の秒）＝流し始めの位置＋サーバーの時計での経過×速度。until 秒を過ぎたら合わせない
  const syncPlay = (from, until) => {
    if (!t0 || clockOffset == null || practice) return;
    player.sync(() => { const el = (serverNow() - t0) / 1000; return el >= 0 && el < until ? from + el * speed : null; },
                lag => socket.emit('heard', lag), speed);
  };
  if (wait > 0) setPhase('ready', 'まもなく…');
  goTimer = setTimeout(() => {
    if (kind === 'sabimae' || kind === 'random' || kind === 'outro') {
      // サビ前・どこから・アウトロ問題：止めずに流し続ける。戻ってきた人も経過秒ぶん先から
      player.start(start + off);
      syncPlay(start, hintAt);
      setPhase('intro', kind === 'random' ? '曲のどこかを再生中…（わかるかな？）' : kind === 'outro' ? 'アウトロを再生中…（わかるかな？）' : 'サビ前を再生中…（わかるかな？）'); coverFx('fx-intro'); stageMascot('listen'); charFx.pose('listen'); charFx.say('intro');
    } else {
      // 戻ってきた人は、いま何回目のイントロのどこかを計算して、その位置から
      const cycle = introLen + gap, k = Math.floor(off / cycle), within = off - k * cycle;
      if (!off) player.start(intro);
      else if (k < plays && within < introLen && off < hintAt) player.start(intro + within);
      if (k === 0 && within < introLen) syncPlay(intro, introLen - 0.3); // 1回目のイントロの間だけ合わせる
      // 戻ってきた人は、いま何回目かを表示する
      const nth = off ? Math.min(plays, k + 1) : 1;
      introLeft = Math.max(0, plays - nth);
      setPhase('intro', nth > 1 ? `イントロ再生中…（${nth}回目！）` : 'イントロ再生中…（わかるかな？）'); coverFx('fx-intro'); stageMascot('listen'); charFx.pose('listen'); if (!off) charFx.say('intro');
    }
    if (myAnswer === null && !amOut() && question?.pickerId !== me) {
      if (question?.play === 'buzzer' || question?.play === 'fill') {
        // 早押し：押した人だけが答えられる。まずは押すボタンだけ
        buzzOpen = !buzzHolder; $('buzzBtn').disabled = !buzzOpen || fillLocked();
      } else {
        answering = true;
        $('choices').querySelectorAll('.choice:not(.gone)').forEach(b => b.disabled = false);
        $('answerInput').disabled = false; $('sendBtn').disabled = false;
        if (isInput() && !off) $('answerInput').focus();
      }
    }
    updateLifelineButtons(); renderNenpyo();
    timerStart = performance.now() - off * 1000;
    goTotal = total;
    tick = setInterval(() => {
      if (pausedNow) return; // 一時停止中は進めない
      const t = (performance.now() - timerStart) / 1000;
      $('timer').textContent = Math.max(0, goTotal - t).toFixed(1); // 残り時間（3つ埋めバトルで流し続けになると延びる）
      $('barFill').style.width = Math.min(100, t / goTotal * 100) + '%';
      $('barFill').style.background = t >= hintAt ? 'var(--warn)' : 'var(--accent2)';
    }, 50);
  }, wait * 1000);
});
let introLeft = 0; // この問題で、あと何回イントロを流し直すか
let goTotal = 0;   // この問題の制限時間（秒）
// 3つ埋めバトル：イントロ中に誰かが押した → サビへ飛ばずに、そのまま流し続ける（止まっていたらその位置から）
socket.on('flowOn', ({ total }) => {
  if (total) goTotal = total;
  introLeft = 0;
  player.flow();
});
// ゲームの最初の問題：3・2・1・START!
socket.on('countdown', ({ sec }) => charFx.countdown(sec));
socket.on('stopIntro', () => {
  player.stopIntro();
  // 流し直す前の間に「もう一回！」（イントロ→間→「もう一回！」→2回目、の順に見えるように）
  if (introLeft > 0) { introLeft--; cue('もう一回！', 'fx-replay'); stageMascot('again'); charFx.pose('again'); charFx.say('again'); setPhase('intro', 'もう一回！'); }
});
// イントロをもう一度頭から（部屋の設定「イントロの回数」）
socket.on('restartIntro', ({ n, plays }) => {
  player.start(question?.intro || 0);
  setPhase('intro', `イントロ再生中…（${n}回目！）`); coverFx('fx-intro'); stageMascot('listen'); charFx.pose('listen');
});
let hintSeen = false; // この問題でサビ（ヒント）まで流したか。流していなければ、答え合わせでサビへ移動する
socket.on('hint', ({ chorus, known = true, intro = 0, seek = true }) => {
  hintSeen = true;
  if (seek) player.hint(known && chorus !== intro + 50 ? chorus : guessChorus(intro, player.duration())); // サビ前問題は流れのままサビに入る
  cue('サビ！', 'fx-burst');
  setPhase('chorus', 'サビ再生中 ✨（得点×0.7）'); coverFx('fx-chorus'); stageMascot('chorus'); charFx.pose('chorus'); charFx.say('chorus');
});

// ── 早押し：押した人だけが答えられる（曲と残り時間は止めない）。間違えたら、また誰でも押せる ──
let buzzOpen = false, buzzHolder = null, buzzTick = null, buzzPausedAt = 0;
function tryBuzz() {
  if (!buzzOpen || myAnswer !== null || practice || fillLocked()) return;
  buzzOpen = false; $('buzzBtn').disabled = true;
  socket.emit('buzz', clockOffset == null ? null : clientNow() + clockOffset); // 押した時刻（サーバーの時計に直したもの）
}
$('buzzBtn').onclick = tryBuzz;
addEventListener('keydown', e => {
  if (e.code !== 'Space' || !['buzzer', 'fill'].includes(question?.play) || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
  e.preventDefault(); tryBuzz();
});
function clearBuzz() {
  clearInterval(buzzTick); buzzHolder = null; $('buzzInfo').textContent = '';
  if (buzzPausedAt) { pausedNow = false; timerStart += performance.now() - buzzPausedAt; buzzPausedAt = 0; return true; }
  return false;
}
// 3つ埋めバトルの順番待ち（押した順）。自分が並んでいる間は押せない
let buzzQueueIds = [], buzzQueueNames = [];
socket.on('buzzQueue', ({ ids = [], names = [] }) => {
  buzzQueueIds = ids; buzzQueueNames = names;
  if (ids.includes(me)) { buzzOpen = false; $('buzzBtn').disabled = true; return; }
  // 列から外れた（飛ばされた・パスした）：答えている人がいてもいなくても、また押せる（お手つきの秒数が残っていればそれまで）
  if (question?.fill && buzzHolder !== me && myAnswer === null && !amOut()) { buzzOpen = true; $('buzzBtn').disabled = fillLocked(); }
});
socket.on('buzz', ({ id, name, sec, queue = null, stop = false }) => {
  buzzHolder = id; // 設定で「止める」なら、答えている間は曲と残り時間を止める（止めない設定では流れたまま答える）
  if (stop && !buzzPausedAt) { buzzPausedAt = performance.now(); pausedNow = true; player.pause(); }
  if (queue) { buzzQueueNames = queue; buzzQueueIds = buzzQueueIds.filter(x => x !== id); }
  // 3つ埋めバトルは、ほかの人が答えている間も押せる（押した順に並ぶ）
  buzzOpen = !!question?.fill && id !== me && !buzzQueueIds.includes(me) && myAnswer === null && !amOut();
  $('buzzBtn').disabled = !buzzOpen || fillLocked();
  const mine = id === me, until = performance.now() + sec * 1000;
  const show = () => {
    const next = question?.fill && buzzQueueNames.length ? `　次：${buzzQueueNames.join(' → ')}` : '';
    const myTurn = buzzQueueIds.indexOf(me); // 同時に押して順番待ちになった人に、押せていることをはっきり出す
    $('buzzInfo').textContent = `${myTurn >= 0 ? `✋ 押せています（あなたは${myTurn + 2}番目）　` : ''}${mine ? 'あなた' : name + ' さん'}が回答中… 残り ${Math.max(0, (until - performance.now()) / 1000).toFixed(1)} 秒${next}`;
  };
  clearInterval(buzzTick); show(); buzzTick = setInterval(show, 100);
  cue(mine ? 'あなたの番！' : `${name}！`, 'fx-burst');
  setPhase('ready', mine ? 'あなたの番！ 答えて！' : `${name} さんが回答中…`);
  if (question?.fill) { if (mine) openFillAnswer(); updateLifelineButtons(); return; } // 3つ埋めバトル：枠を選んで答える
  if (mine && myAnswer === null) {
    answering = true;
    $('choices').querySelectorAll('.choice:not(.gone)').forEach(b => b.disabled = false);
    $('answerInput').disabled = false; $('sendBtn').disabled = false;
    if (isInput()) $('answerInput').focus();
    updateLifelineButtons();
  }
});
socket.on('buzzEnd', ({ hold = false } = {}) => {
  const wasMine = buzzHolder === me;
  if (hold) { clearInterval(buzzTick); buzzHolder = null; $('buzzInfo').textContent = ''; } // 次の人の番がすぐ始まる：止めたまま
  else if (clearBuzz()) player.resume();
  if (question?.fill) { $('fillAnswer').hidden = true; fillSlot = null; } // 3つ埋めバトルは何度でも押せる（間違えた人は少しの間だけ押せない）
  else if (wasMine && myAnswer === null) markAnswered({ given: '時間切れ' }); // 時間切れ（サーバーではお手つき）
  // 順番待ちが残っていれば、すぐ次の人の番（'buzz'）が来る。自分が並んでいる間は押せない
  if (myAnswer === null && !amOut() && !buzzQueueIds.includes(me)) { buzzOpen = true; $('buzzBtn').disabled = fillLocked(); }
  updateLifelineButtons();
  setPhase(hintSeen ? 'chorus' : 'intro', hintSeen ? 'サビ再生中 ✨（得点×0.7）' : '再開！ わかったら押そう');
});

// ── 出題中の記録（パスの下）：左に出た選択肢、右に選んだ・入力した答え ──
let qlogEntries = [];
const QLOG_MARK = { ok: '○', ng: '×', almost: '惜しい', pass: '' }; // パスは本文に「パス」と出るので印はなし
// 3つ埋めバトル：お手つきで消えた10択（記録では打ち消し線）
const removedOf = l => new Set((l.base ? [] : (room?.fill || question?.fill || []).find(f => f.label === l.label)?.removed) || []);
function renderQlog() {
  const base = question?.choices?.length ? [{ type: 'choices', label: '選択肢', choices: question.choices.map(c => c.title), base: true }]
    : question?.years ? [] : [];
  const lists = [...base, ...qlogEntries.filter(e => e.type === 'choices')];
  const answers = qlogEntries.filter(e => e.type === 'answer');
  // ビンゴのときは出さない（ビンゴカードだけ見せる）
  // 出すのは早押しと3つ埋めバトルだけ（ふつう・サバイバル・ビンゴなどでは出さない）
  $('qlog').hidden = !question || !['buzzer', 'fill'].includes(room?.settings?.play) || (!lists.length && !answers.length);
  $('qlogChoices').hidden = !lists.length;
  $('qlogChoices').innerHTML = lists.map(l => `<div class="qlog-list"><b>${esc(l.label)}${l.name && !l.base ? `<small>（${esc(l.name)} が開いた10択）</small>` : ''}</b>
    <ol>${l.choices.map((c, i) => `<li${removedOf(l).has(i) ? ' class="gone"' : ''}>${esc(c)}</li>`).join('')}</ol></div>`).join('');
  $('qlogInputs').innerHTML = answers.map(e => `<li class="${e.result || ''}${e.id === me ? ' me' : ''}"><span class="who">${esc(e.name)}</span>`
    + `${e.label ? `<span class="slot">${esc(e.label)}</span>` : ''}<span class="how">${e.how === 'choice' ? '選択' : e.how === 'pass' ? '' : '入力'}</span>`
    + `<span class="txt">${esc(e.text ?? '')}</span>${e.result ? `<span class="res">${QLOG_MARK[e.result] || ''}</span>` : ''}</li>`).join('') || '<li class="empty">まだ回答はありません</li>';
  $('qlogInputs').scrollTop = $('qlogInputs').scrollHeight;
}
socket.on('qlog', e => { qlogEntries.push(e); renderQlog(); });


// ── アニソンかるた（PC）：盤の16枚が1画面に収まるように、札の高さを画面の高さに合わせる（上のステージ・下の「わからない」のぶんを引く）──
function fitKaruta() {
  const b = $('choices'), on = !!b && b.classList.contains('karuta') && !b.hidden && room?.settings?.play === 'karuta' && room?.state === 'playing' && matchMedia('(min-width: 900px)').matches;
  document.body.classList.toggle('karuta-play', on); // ステージを小さくして、盤を大きく
  if (!on) { b?.style.removeProperty('--kh'); return; }
  const r = b.getBoundingClientRect(), quiz = $('quiz').getBoundingClientRect();
  const cs = getComputedStyle(b), pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) * 2, gap = parseFloat(cs.rowGap) * 3 || 24;
  const top = r.top + (document.scrollingElement.scrollTop || 0);
  const below = Math.max(0, quiz.bottom - r.bottom); // 盤の下（わからない・ライフライン）
  // 自分のレイアウト：キャンバスごと縮小されているので、画面の高さではなく「選択肢」の枠（縮小前の高さ）に収める。
  // 画面の高さで計算すると、縮小ぶん大きく出て、盤が伸びる → また計算… で、どんどん大きくなっていた
  let kh;
  if (document.body.classList.contains('layout-on')) {
    const qz = $('quiz'), s = quiz.height / (qz.offsetHeight || 1) || 1;
    const topIn = (r.top - quiz.top) / s;
    let belowIn = 0; for (let el = b.nextElementSibling; el; el = el.nextElementSibling) if (el.offsetParent) belowIn += el.offsetHeight + 6; // 盤の下（わからない など）は、盤の大きさに関係なく高さを足す
    kh = Math.max(40, Math.min(130, Math.floor((qz.clientHeight - topIn - belowIn - 12 - pad - gap) / 4)));
  } else kh = Math.max(64, Math.min(130, Math.floor((innerHeight - top - below - 28 - pad - gap) / 4)));
  if (b.style.getPropertyValue('--kh') !== kh + 'px') b.style.setProperty('--kh', kh + 'px');
}
// 札の文字は、札に収まる最大の大きさにする（二分探索。盤の大きさ・曲名が変わったときだけ計算し直す）
function fitKarutaText() {
  const b = $('choices');
  if (!b || !b.classList.contains('karuta') || b.hidden || !b.offsetParent) return;
  const cards = [...b.querySelectorAll('.choice:not(.empty)')];
  if (!cards.length) return;
  const key = [Math.round(cards[0].clientWidth), Math.round(cards[0].clientHeight), ...cards.map(c => c.textContent)].join('|');
  if (b.dataset.fitKey === key) return;
  b.dataset.fitKey = key;
  const maxPx = Math.min(44, Math.floor(cards[0].clientHeight * 0.8));
  for (const c of cards) {
    let lo = 8, hi = maxPx;
    c.style.fontSize = hi + 'px';
    const fits = () => c.scrollHeight <= c.clientHeight + 1 && c.scrollWidth <= c.clientWidth + 1;
    if (!fits()) { while (hi - lo > 1) { const mid = (lo + hi) >> 1; c.style.fontSize = mid + 'px'; if (fits()) lo = mid; else hi = mid; } c.style.fontSize = lo + 'px'; }
  }
}
setInterval(() => { fitKaruta(); fitKarutaText(); }, 400); addEventListener('resize', () => { fitKaruta(); fitKarutaText(); });

// ── アニソン人狼：聴く → ヒント → 話し合い → 投票 →（当てられたら人狼が曲名を当てる）→ 結果 ──
let wolfPending = null, wolfData = null, wolfTick = null, wolfChatLog = [];
const wolfLeft = until => Math.max(0, Math.ceil((until - (Date.now() + (clockOffset || 0))) / 1000));
socket.on('wolfSong', d => {
  wolfPending = { start: d.start, sec: d.sec };
  player.load(d.videoId, d.start);
});
function wolfStartPlayback() {
  const w = wolfPending; wolfPending = null;
  player.start(w.start);
  setTimeout(() => player.fadeOut(1500), Math.max(0, w.sec * 1000 - 1500));
}
function hideWolf() { clearInterval(wolfTick); $('wolfPop').hidden = true; $('wolfPop').innerHTML = ''; wolfData = null; }
const wolfName = id => wolfData?.players.find(p => p.id === id)?.name || '';
let wolfMark = null; // 自分用の目印（どの曲を聴いていそうか。ほかの人には見えない）
function wolfChoicesHtml(d) {
  if (!d.choices) return '';
  return `<div class="wf-cands"><small>曲の候補（聴いている曲は、この中にあります。タップで自分用の目印）</small><div>${d.choices.map((c, i) => `<button type="button" class="wf-cand${wolfMark === i ? ' mine' : ''}" data-cand="${i}"><b>${i + 1}</b>${esc(c.title)}${c.work ? `<small>${esc(c.work)}</small>` : ''}</button>`).join('')}</div></div>`;
}
function wolfChatHtml() { return wolfChatLog.map(c => `<li${c.id === me ? ' class="mine"' : ''}><b>${esc(c.name)}</b>${esc(c.text)}</li>`).join(''); }
socket.on('wolfChat', c => {
  wolfChatLog.push(c); wolfChatLog = wolfChatLog.slice(-80);
  const ul = $('wolfChatList'); if (ul) { ul.innerHTML = wolfChatHtml(); ul.scrollTop = ul.scrollHeight; }
});
socket.on('wolfPhase', d => {
  if (!d) return hideWolf();
  const fresh = !wolfData || wolfData.step !== d.step || wolfData.round !== d.round;
  if (d.round !== wolfData?.round) { wolfChatLog = []; wolfMark = null; }
  if (d.chat) wolfChatLog = d.chat;
  wolfData = d;
  $('wolfPop').hidden = false;
  if (!fresh) { // 同じ段階の更新（だれが済んだか）だけ
    $('wolfPop').querySelectorAll('[data-pid]').forEach(el => el.classList.toggle('done', d.done.includes(el.dataset.pid)));
    return;
  }
  const head = `<div class="wf-head"><b>🐺 アニソン人狼</b><span>第${d.round}/${d.total}回</span><span class="wf-left" id="wolfLeft"></span></div>`;
  const seats = `<div class="wf-seats">${d.players.map(p => `<span data-pid="${esc(p.id)}" class="${d.done.includes(p.id) ? 'done' : ''}">${avatarImg(p.avatar, 'avatar sm')}${esc(p.name)}</span>`).join('')}</div>`;
  const hints = d.hints ? `<div class="wf-hints">${d.hints.map(h => `<div><small>${esc(wolfName(h.id))}</small><b>${esc(h.text)}</b></div>`).join('')}</div>` : '';
  const votesHtml = d.votes ? `<div class="wf-tallybox">${d.players.map(p => `<div><span>${esc(p.name)}</span><i style="--n:${d.votes[p.id] || 0}"></i><b>${d.votes[p.id] || 0}票</b></div>`).join('')}</div>` : '';
  const cands = wolfChoicesHtml(d);
  const chat = `<ul class="wf-chat" id="wolfChatList">${wolfChatHtml()}</ul><form class="wf-say" id="wolfSay"><input id="wolfSayText" maxlength="60" placeholder="話し合い（60文字まで）" autocomplete="off"><button class="btn-sub" type="submit">送る</button></form>`;
  let body = '';
  if (d.step === 'listen') body = `<p class="wf-msg">🎧 曲を聴いてください。<br><small>みんなと同じ曲とは限りません。1人だけ、別の作品の曲が流れています（自分が人狼かどうかは分かりません）</small></p>${cands}`;
  if (d.step === 'hint') body = `<p class="wf-msg">この曲について、ヒントを一言（20文字まで）。<br><small>言いすぎると人狼にばれ、ぼかしすぎると疑われます</small></p>
    <form class="wf-say" id="wolfHintForm"><input id="wolfHintText" maxlength="20" placeholder="例：ロボット、2000年代、エンディング" autocomplete="off"><button class="btn-main" type="submit">出す</button></form>${cands}${seats}`;
  if (d.step === 'talk') body = `${hints}<p class="wf-msg">話し合って、だれが別の曲（人狼）か考えましょう</p>${cands}${chat}<button class="btn-sub" id="wolfReadyBtn" type="button">投票へ進む</button>${seats}`;
  if (d.step === 'vote') body = `${hints}<p class="wf-msg">人狼だと思う人に投票（自分以外）<br><small>人狼も投票できますが、人狼の票は数えません</small></p><div class="wf-votes">${d.players.filter(p => p.id !== me).map(p => `<button class="btn-sub" data-vote="${esc(p.id)}" type="button">${avatarImg(p.avatar, 'avatar sm')}${esc(p.name)}</button>`).join('')}</div>${cands}${chat}${seats}`;
  if (d.step === 'tally') body = `<p class="wf-msg">🗳 投票の結果（人狼の票は数えていません）</p>${votesHtml}${hints}`;
  if (d.step === 'guess') body = d.guess.id === me
    ? `<p class="wf-msg">🐺 あなたが人狼でした！ みんなの曲は？ 当てれば逆転勝ち</p>${votesHtml}<div class="wf-guess">${d.choices.map((c, i) => `<button class="btn-sub" data-guess="${i}" type="button">${esc(c.title)}<small>${esc(c.work || '')}</small></button>`).join('')}</div>`
    : `${votesHtml}${hints}<p class="wf-msg">🐺 人狼は <b>${esc(wolfName(d.guess.id))}</b> さん！ いま、みんなの曲名を当てようとしています…</p>`;
  if (d.step === 'result') {
    const r = d.result, iWolf = r.wolfId === me, win = (r.winner === 'wolf') === iWolf;
    body = `<p class="wf-result ${win ? 'win' : 'lose'}">${r.winner === 'village' ? '🎉 村人の勝ち！' : r.caught ? '🐺 人狼の逆転勝ち！' : '🐺 人狼の勝ち！'}<small>${win ? 'あなたの勝ち' : 'あなたの負け'}（勝った側に 村人+${r.points.village}点／人狼+${r.points.wolf}点）</small></p>
      <p class="wf-msg">人狼は <b>${esc(r.wolfName)}</b> さん${r.caught ? (r.guessed ? '（当てられたけど、曲名を当てて逆転）' : `（曲名は「${esc(r.guessTitle || '答えなし')}」で外れ）`) : '（逃げ切り）'}</p>
      <div class="wf-songs"><div><small>みんなの曲</small><b>${esc(r.song.title)}</b><span>${esc(r.song.work)}／${esc(r.song.artist)}（${r.song.year}）</span></div>
      <div class="wolf"><small>人狼の曲</small><b>${esc(r.wolfSong.title)}</b><span>${esc(r.wolfSong.work)}／${esc(r.wolfSong.artist)}（${r.wolfSong.year}）</span></div></div>
      <div class="wf-tally">${d.players.map(p => `<span>${esc(p.name)}：${r.votes[p.id] || 0}票</span>`).join('')}</div>${hints}`;
  }
  $('wolfPop').innerHTML = `<div class="wf-field">${head}${body}</div>`;
  const left = () => { const el = $('wolfLeft'); if (el) el.textContent = d.until ? `あと ${wolfLeft(d.until)} 秒` : ''; };
  clearInterval(wolfTick); left(); wolfTick = setInterval(left, 500);
  const hf = $('wolfHintForm');
  if (hf) { $('wolfHintText').focus(); hf.onsubmit = e => { e.preventDefault(); const v = $('wolfHintText').value.trim(); if (!v) return; socket.emit('wolfHint', v); hf.querySelectorAll('input,button').forEach(x => x.disabled = true); }; }
  const sf = $('wolfSay');
  if (sf) sf.onsubmit = e => { e.preventDefault(); const v = $('wolfSayText').value.trim(); if (!v) return; socket.emit('wolfChat', v); $('wolfSayText').value = ''; };
  const rb = $('wolfReadyBtn');
  if (rb) rb.onclick = () => { socket.emit('wolfReady'); rb.disabled = true; rb.textContent = 'ほかの人を待っています…'; };
  $('wolfPop').querySelectorAll('[data-cand]').forEach(b => b.onclick = () => { const i = +b.dataset.cand; wolfMark = wolfMark === i ? null : i; $('wolfPop').querySelectorAll('[data-cand]').forEach(x => x.classList.toggle('mine', +x.dataset.cand === wolfMark)); });
  $('wolfPop').querySelectorAll('[data-vote]').forEach(b => b.onclick = () => { socket.emit('wolfVote', b.dataset.vote); $('wolfPop').querySelectorAll('[data-vote]').forEach(x => { x.disabled = true; x.classList.toggle('on', x === b); }); });
  $('wolfPop').querySelectorAll('[data-guess]').forEach(b => b.onclick = () => { socket.emit('wolfGuess', +b.dataset.guess); $('wolfPop').querySelectorAll('[data-guess]').forEach(x => x.disabled = true); });
  const ul = $('wolfChatList'); if (ul) ul.scrollTop = ul.scrollHeight;
});

// ── アニソン・アズール：工房・中央（左）と自分の棚（右）、相手の棚（下） ──
let azData = null, azTick = null, azSel = null;
function hideAz() { clearInterval(azTick); $('azPop').hidden = true; $('azPop').innerHTML = ''; azData = null; azSel = null; }
socket.on('azPhase', d => { if (!d) return hideAz(); azData = d; if (!d.hand.some(x => x.id === azSel)) azSel = null; renderAz(); });
function renderAz() {
  const d = azData; if (!d) return;
  const pop = $('azPop'); pop.hidden = false;
  const icon = c => d.colors.find(x => x.key === c)?.icon || '';
  const myTurn = d.turn === me, take = myTurn && d.step === 'take', place = myTurn && d.step === 'place';
  const chip = (x, src) => `<span class="az-tile c-${x.color}${src != null && take ? ' can' : ''}${azSel === x.id ? ' sel' : ''}" ${src != null ? `data-take="${src}" data-color="${x.color}"` : `data-hand="${esc(x.id)}"`} title="${esc(x.title)}／${esc(x.work)}"><i>${icon(x.color)}</i><b>${esc(x.title)}</b><em data-azprev="${esc(x.id)}">▶</em></span>`;
  const facs = d.factories.map((f, i) => `<div class="az-fac${f.length ? '' : ' empty'}">${f.map(x => chip(x, i)).join('')}</div>`).join('');
  const center = `<div class="az-center"><small>中央${d.marker ? '（先手マーカーあり：最初に取った人は床に1枚・次の先手）' : ''}</small><div>${d.center.map(x => chip(x, -1)).join('') || '<small>（空）</small>'}</div></div>`;
  const myB = d.boards.find(b => b.id === me), turnName = d.boards.find(b => b.id === d.turn)?.name || '';
  const shelf = b => b.rows.map((row, k) => `<div class="az-row${b.filled.includes(k) ? ' done' : ''}${place && b.id === me && azSel ? ' can' : ''}" data-row="${k}"><b>${esc(d.rows[k])}</b><div>${Array.from({ length: d.caps[k] }, (_, j) => row[j] ? `<span class="az-slot c-${row[j].color}" title="${esc(row[j].title)}（${row[j].year}）">${icon(row[j].color)}</span>` : '<span class="az-slot"></span>').join('')}</div></div>`).join('');
  const msg = d.step === 'result' ? '' : take ? 'あなたの番：工房か中央のカードをタップ（同じ色を全部取ります）' : place ? '取ったカードをタップ → 置く段をタップ（年代ちがい・あふれは床へ）' : d.step === 'between' ? '…' : `${esc(turnName)} さんの番です`;
  let body;
  if (d.step === 'result') body = `<div class="dx-list">${d.result.rows.map((r, i) => `<div class="dx-card${i === 0 ? ' teller' : ''}"><div><b>${i + 1}. ${esc(r.name)}</b><small>${r.pts}点${r.bonus ? '＋全年代ボーナス' + r.bonus : ''}（いっぱいにした年代 ${r.filled}/5）</small></div><b>+${r.total}</b></div>`).join('')}</div>`;
  else body = `<p class="wf-msg">${msg}</p><div class="az-main"><div class="az-left"><div class="az-facs">${facs}</div>${center}</div>
    <div class="az-right">${place ? `<div class="az-hand"><small>取ったカード</small>${d.hand.map(x => chip(x)).join('')}<button class="btn-sub" id="azFloor" type="button"${azSel ? '' : ' disabled'}>床に置く</button></div>` : ''}
      <div class="az-board me"><b>あなたの棚（${myB?.pts ?? 0}点・床 ${myB?.floor ?? 0}枚）</b>${myB ? shelf(myB) : ''}</div>
      <div class="az-others">${d.boards.filter(b => b.id !== me).map(b => `<div class="az-mini${b.id === d.turn ? ' turn' : ''}"><b>${esc(b.name)} ${b.pts}点 床${b.floor}</b>${b.rows.map((row, k) => `<i>${row.length}/${d.caps[k]}</i>`).join('')}</div>`).join('')}</div></div></div>`;
  pop.innerHTML = `<div class="wf-field az-field"><div class="wf-head"><b>🧱 アニソン・アズール</b><span>ラウンド ${d.round}/${d.rounds}</span><span class="wf-left" id="azLeft"></span></div>${body}<ul class="bb-log">${d.log.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
  const left = () => { const el = $('azLeft'); if (el) el.textContent = d.until ? `あと ${wolfLeft(d.until)} 秒` : ''; };
  clearInterval(azTick); left(); azTick = setInterval(left, 500);
  pop.querySelectorAll('[data-azprev]').forEach(b => b.onclick = e => { e.stopPropagation(); socket.emit('azPreview', b.dataset.azprev); });
  if (take) pop.querySelectorAll('[data-take]').forEach(el => el.onclick = () => socket.emit('azTake', { f: +el.dataset.take, color: el.dataset.color }));
  if (place) {
    pop.querySelectorAll('[data-hand]').forEach(el => el.onclick = () => { azSel = el.dataset.hand; renderAz(); });
    pop.querySelectorAll('.az-board.me [data-row]').forEach(el => el.onclick = () => { if (!azSel) return toast('先に取ったカードをタップしてください'); socket.emit('azPlace', { id: azSel, row: +el.dataset.row }); azSel = null; });
    const fb = $('azFloor'); if (fb) fb.onclick = () => { if (azSel) socket.emit('azPlace', { id: azSel, row: -1 }); azSel = null; };
  }
}
// ── アニソン帰れま10：トップ10の盤と候補20曲 ──
let kmData = null, kmTick = null;
function hideKm() { clearInterval(kmTick); $('kmPop').hidden = true; $('kmPop').innerHTML = ''; kmData = null; }
socket.on('kmPhase', d => { if (!d) return hideKm(); kmData = d; renderKm(); });
function renderKm() {
  const d = kmData; if (!d) return;
  const pop = $('kmPop'); pop.hidden = false;
  const myTurn = d.step === 'turn' && d.turn === me;
  const board = Array.from({ length: d.top }, (_, i) => { const c = d.cands.find(x => x.rank === i + 1 && (x.picked || d.step === 'result')); return `<div class="km-rank${c?.picked ? ' hit' : c ? ' open' : ''}"><b>${i + 1}</b><span>${c ? esc(c.title) : '？？？'}</span><small>${c ? esc(c.work) + (c.picked ? '　' + esc(c.by) : '') : ''}</small></div>`; }).join('');
  const cands = d.cands.map((c, i) => `<button type="button" class="km-cand${c.picked ? (c.hit ? ' hit' : ' miss') : ''}${!c.picked && d.step === 'result' && c.rank <= d.top ? ' left' : ''}" data-km="${i}"${myTurn && !c.picked ? ' data-can="1"' : ' aria-disabled="true"'}><b>${esc(c.title)}</b><small>${c.work ? '📺 ' + esc(c.work) : esc(c.artist)}</small>${c.rank ? `<i>${c.rank}位</i>` : ''}<em class="km-prev" data-kmprev="${i}" title="自分だけ試聴">▶</em></button>`).join('');
  const status = d.step === 'result' ? `<b class="km-res ${d.result.home ? 'win' : 'lose'}">${d.result.home ? `🎉 帰れる！ トップ${d.top}を全部当てました` : `😱 帰れません…（${d.result.found}/${d.top}）`}</b>`
    : myTurn ? '<b class="km-res">あなたの番：トップ${d.top}に入っていると思う曲を選んでください</b>' : `<b class="km-res">${esc(d.turnName || '')} さんが選んでいます…</b>`;
  pop.innerHTML = `<div class="wf-field km-field"><div class="wf-head"><b>🍜 アニソン帰れま${d.top === 10 ? '10' : d.top}</b><span>第${d.round}/${d.total}回</span><span class="wf-left" id="kmLeft"></span></div>
    <div class="km-topic">お題：<b>${esc(d.topic)}</b> 再生回数トップ${d.top}<small>（全${d.count}曲から）</small>　<span>当たり ${d.found}/${d.top}</span>　<span class="km-miss">外れ ${'✖'.repeat(d.misses)}${'・'.repeat(Math.max(0, d.maxMiss - d.misses))}</span></div>
    ${status}<div class="km-main" style="--bc:${Math.ceil(d.top / 10)}"><div class="km-board">${board}</div><div class="km-cands" style="--cc:${Math.ceil(d.cands.length / 5)}">${cands}</div></div>
    <div class="km-foot"><ul class="bb-log">${d.log.map(l => `<li>${esc(l)}</li>`).join('')}</ul><div class="wf-seats">${d.players.map(p => `<span class="${p.id === d.turn ? 'done' : ''}">${esc(p.name)} +${p.gain}</span>`).join('')}</div></div></div>`;
  const left = () => { const el = $('kmLeft'); if (el) el.textContent = d.until ? `あと ${wolfLeft(d.until)} 秒` : ''; };
  clearInterval(kmTick); left(); kmTick = setInterval(left, 500);
  pop.querySelectorAll('[data-kmprev]').forEach(el => el.onclick = e => { e.stopPropagation(); e.preventDefault(); socket.emit('kmPreview', +el.dataset.kmprev); });
  pop.querySelectorAll('[data-km][data-can]').forEach(b => b.onclick = () => { socket.emit('kmPick', +b.dataset.km); pop.querySelectorAll('[data-km]').forEach(x => { x.removeAttribute('data-can'); x.onclick = null; x.setAttribute('aria-disabled', 'true'); }); });
}
// ── アニソン年当てベット：発売年を予想 → いちばん近い予想に賭ける ──
let wwData = null, wwTick = null, wwMarks = [], wwSent = false, wwKey = '';
function hideWw() { clearInterval(wwTick); $('wwPop').hidden = true; $('wwPop').innerHTML = ''; wwData = null; }
socket.on('wwPhase', d => { if (!d) return hideWw(); const k = d.round + ':' + d.step; if (k !== wwKey) { wwKey = k; wwMarks = []; wwSent = false; } wwData = d; renderWw(); });
function renderWw() {
  const d = wwData; if (!d) return;
  const pop = $('wwPop'); pop.hidden = false;
  const head = `<div class="wf-head"><b>🎲 アニソン年当てベット</b><span>第${d.round}/${d.total}問</span><span class="wf-left" id="wwLeft"></span></div>`;
  const seats = `<div class="wf-seats">${d.players.map(p => `<span class="${d.done.includes(p.id) ? 'done' : ''}">${esc(p.name)} ${p.score}点</span>`).join('')}</div>`;
  const mine = d.done.includes(me);
  let body = '';
  if (d.step === 'guess') {
    body = `<p class="wf-msg">イントロを聴いて、この曲の<b>発売年</b>を予想しましょう</p>
      <form class="wf-say ww-form" id="wwGuessForm"><input id="wwYear" type="number" inputmode="numeric" min="${d.minYear}" max="${d.maxYear}" placeholder="例：2008"${mine ? ' disabled' : ''}><button class="btn-main" type="submit"${mine ? ' disabled' : ''}>${mine ? '出しました' : '出す'}</button></form>
      <div class="ww-quick">${[1985, 1995, 2000, 2005, 2010, 2015, 2020].map(y => `<button type="button" class="btn-sub" data-y="${y}"${mine ? ' disabled' : ''}>${y}</button>`).join('')}</div>`;
  } else if (d.step === 'bet' || d.step === 'result') {
    const r = d.result;
    const slots = `<div class="ww-slots">${d.slots.map((s, i) => { const n = wwMarks.filter(m => m.slot === i).length; return `<button type="button" class="ww-slot${r && r.win === i ? ' win' : ''}${n ? ' on' : ''}" data-slot="${i}"${d.step !== 'bet' || wwSent ? ' disabled' : ''}><b>${s.year ?? '全員より古い'}</b><small>${s.odds}倍</small><span>${s.owners.map(esc).join('・') || '　'}</span>${n ? `<i>${'●'.repeat(n)}</i>` : ''}</button>`; }).join('')}</div>`;
    if (d.step === 'bet') {
      const marks = wwMarks.map((m, k) => `<span class="ww-mark">マーカー${k + 1}：${d.slots[m.slot].year ?? '古い'}　上乗せ <select data-extra="${k}"${wwSent ? ' disabled' : ''}>${d.extras.map(x => `<option value="${x}"${m.extra === x ? ' selected' : ''}>${x}</option>`).join('')}</select></span>`).join('');
      body = `<p class="wf-msg">正解の年を<b>超えない中でいちばん近い</b>予想はどれ？ 枠をタップしてマーカーを2個置く（同じ枠に2個も可）</p>${slots}<div class="ww-marks">${marks || '<small>マーカーを置いてください</small>'}</div>
        <div class="ww-actions"><button class="btn-sub" id="wwClear" type="button"${wwSent ? ' disabled' : ''}>置き直す</button><button class="btn-main" id="wwBetBtn" type="button"${wwSent || !wwMarks.length ? ' disabled' : ''}>${wwSent ? '賭けました' : '賭ける'}</button></div>`;
    } else {
      const myRow = r.rows.find(x => x.id === me);
      body = `<p class="wf-result ${myRow?.points > 0 ? 'win' : 'lose'}">正解は <b>${r.year}年</b><small>${esc(r.song.title)}（${esc(r.song.work)}／${esc(r.song.artist)}）</small></p>${slots}
        <div class="wf-tally">${r.rows.map(x => `<span>${esc(x.name)}${x.guess ? '（' + x.guess + '）' : ''} ${x.points >= 0 ? '+' : ''}${x.points}${x.lines.length ? ' ' + x.lines.join('・') : ''}</span>`).join('')}</div>`;
    }
  }
  pop.innerHTML = `<div class="wf-field ww-field">${head}${body}${seats}</div>`;
  const left = () => { const el = $('wwLeft'); if (el) el.textContent = d.until ? `あと ${wolfLeft(d.until)} 秒` : ''; };
  clearInterval(wwTick); left(); wwTick = setInterval(left, 500);
  const gf = $('wwGuessForm');
  const sendY = y => { if (!(y >= d.minYear && y <= d.maxYear)) return toast(`${d.minYear}〜${d.maxYear} の年を入れてください`); socket.emit('wwGuess', y); };
  if (gf) { if (!mine) $('wwYear').focus(); gf.onsubmit = e => { e.preventDefault(); sendY(+$('wwYear').value); }; }
  pop.querySelectorAll('[data-y]').forEach(b => b.onclick = () => { const inp = $('wwYear'); inp.value = b.dataset.y; inp.focus(); });
  pop.querySelectorAll('[data-slot]').forEach(b => b.onclick = () => { if (wwMarks.length >= 2) wwMarks.shift(); wwMarks.push({ slot: +b.dataset.slot, extra: 0 }); renderWw(); });
  pop.querySelectorAll('[data-extra]').forEach(s => s.onchange = () => { wwMarks[+s.dataset.extra].extra = +s.value; });
  const cl = $('wwClear'); if (cl) cl.onclick = () => { wwMarks = []; renderWw(); };
  const bb = $('wwBetBtn'); if (bb) bb.onclick = () => { socket.emit('wwBet', wwMarks); wwSent = true; renderWw(); };
}

// ── アニソン大富豪：場の曲より新しい年の曲を出す（手札の年は見えない）──
let dfData = null, dfHand = [], dfTick = null;
function hideDf() { clearInterval(dfTick); $('dfPop').hidden = true; $('dfPop').innerHTML = ''; dfData = null; dfHand = []; }
socket.on('dfHand', d => { dfHand = d.hand || []; if (dfData) renderDf(); });
socket.on('dfPhase', d => { if (!d) return hideDf(); dfData = d; renderDf(); });
function renderDf() {
  const d = dfData; if (!d) return;
  const pop = $('dfPop'); pop.hidden = false;
  const nameOf = id => d.players.find(p => p.id === id)?.name || '';
  const myTurn = d.step === 'turn' && d.turn === me;
  const head = `<div class="wf-head"><b>👑 アニソン大富豪</b><span>第${d.round}/${d.total}回</span><span class="wf-left" id="dfLeft"></span></div>`;
  const seats = `<div class="wf-seats bb-seats">${d.players.map(p => `<span class="${p.rank ? 'done' : ''}${p.id === d.turn ? ' bb-turn' : ''}">${esc(p.name)}：${p.rank ? p.rank + '番に上がり' : p.count + '枚'}${p.passed ? '（パス）' : ''}${p.id === d.turn ? '▶' : ''}</span>`).join('')}</div>`;
  let body;
  if (d.step === 'result') {
    body = `<div class="dx-list">${d.result.rows.map(r => `<div class="dx-card${r.rank === 1 ? ' teller' : ''}"><div><b>${r.rank}. ${esc(r.title)}：${esc(r.name)}</b><small>上がり +${r.place}${r.miss ? '／失敗 ' + r.miss : ''}${r.left.length ? '／残り：' + r.left.map(x => esc(x.title) + '(' + x.year + ')').join('・') : ''}</small></div><b>${r.total >= 0 ? '+' : ''}${r.total}点</b></div>`).join('')}</div>`;
  } else {
    const top = d.field[d.field.length - 1];
    const field = top ? `<div class="df-field">${d.field.slice(0, -1).map(f => `<span class="df-old">${f.year}</span>`).join('')}<div class="df-top"><b class="df-year">${top.year}年</b><span><b>${esc(top.title)}</b><small>${esc(top.work)}／${esc(top.by)} さん</small></span></div></div>` : `<div class="df-field"><p class="wf-msg">場は空です${d.lead ? '（' + esc(nameOf(d.turn)) + ' さんが親）' : ''}</p></div>`;
    const msg = myTurn ? (top ? `あなたの番：${top.year}年より新しいと思う曲を出すか、パス` : 'あなたが親です：好きな曲を1枚出してください') : d.step === 'turn' ? `${esc(nameOf(d.turn))} さんの番です` : '…';
    const hand = dfHand.length ? `<div class="dx-list">${dfHand.map(c => `<div class="dx-card"><div><b>${esc(c.title)}</b><small>${esc(c.work)}／${esc(c.artist)}</small></div><div class="dx-btns"><button class="btn-sub" type="button" data-prev="${esc(c.id)}">▶ 聴く</button>${myTurn ? `<button class="btn-main" type="button" data-play="${esc(c.id)}">出す</button>` : ''}</div></div>`).join('')}</div>` : '<p class="wf-msg">上がりました！</p>';
    body = `${field}<p class="wf-msg">${msg}</p>${hand}${myTurn && top ? '<button class="btn-sub" id="dfPassBtn" type="button">パス</button>' : ''}<ul class="bb-log">${d.log.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
  }
  pop.innerHTML = `<div class="wf-field">${head}${seats}${body}</div>`;
  const left = () => { const el = $('dfLeft'); if (el) el.textContent = d.until ? `あと ${wolfLeft(d.until)} 秒` : ''; };
  clearInterval(dfTick); left(); dfTick = setInterval(left, 500);
  pop.querySelectorAll('[data-prev]').forEach(b => b.onclick = () => socket.emit('dfPreview', b.dataset.prev));
  pop.querySelectorAll('[data-play]').forEach(b => b.onclick = () => { socket.emit('dfPlay', b.dataset.play); pop.querySelectorAll('[data-play]').forEach(x => x.disabled = true); });
  const pb = $('dfPassBtn'); if (pb) pb.onclick = () => { socket.emit('dfPass'); pb.disabled = true; };
}

// ── アニソン・コードネーム：赤・青のチーム。スパイマスターのヒントで、作品名の盤面から味方の作品を当てる ──
let cnData = null, cnKey = null, cnTick = null, cnChatLog = [];
function hideCn() { clearInterval(cnTick); $('cnPop').hidden = true; $('cnPop').innerHTML = ''; cnData = null; cnKey = null; cnChatLog = []; }
let cnKeyRound = null;
socket.on('cnKey', d => { cnKey = d.key; cnKeyRound = d.round ?? cnData?.round ?? null; if (cnData) renderCn(); });
socket.on('cnChat', m => { cnChatLog.push(m); cnChatLog = cnChatLog.slice(-3); const el = $('cnChat'); if (el) el.innerHTML = cnChatLog.map(c => `<span>${esc(c.name)}：${esc(c.text)}</span>`).join(''); });
socket.on('cnPhase', d => { if (!d) return hideCn(); if (d.round !== cnData?.round) { cnChatLog = []; if (cnKeyRound !== d.round) cnKey = null; } cnData = d; renderCn(); });
function renderCn() {
  const d = cnData; if (!d) return;
  const pop = $('cnPop'); pop.hidden = false;
  const meP = d.players.find(p => p.id === me), myTeam = meP?.team, amSpy = d.spy.red === me || d.spy.blue === me;
  const TN = { red: '赤', blue: '青' }, nameOf = id => d.players.find(p => p.id === id)?.name || '';
  const myTurn = d.turn === myTeam, spyTurn = amSpy && myTurn;
  const key = amSpy && cnKey ? cnKey : null;
  const head = `<div class="cn-head"><b>🕵️ アニソン・コードネーム</b><span class="cn-score red">赤 あと${d.left.red}</span><span class="cn-score blue">青 あと${d.left.blue}</span><span class="cn-me ${myTeam || ''}">${myTeam ? 'あなた：' + TN[myTeam] + 'チーム（' + (amSpy ? 'スパイマスター' : '当てる人') + '）' : '見学'}</span><span class="wf-left" id="cnLeft"></span></div>`;
  const status = d.step === 'result' ? `<b class="cn-turn ${d.winner}">${TN[d.winner]}チームの勝ち！（${esc(d.reason)}）${(d.result.rows.find(r => r.id === me)?.points) ? ' あなた +' + d.result.rows.find(r => r.id === me).points + '点' : ''}</b>`
    : d.step === 'clue' ? `<b class="cn-turn ${d.turn}">${TN[d.turn]}チームのヒント待ち（スパイマスター：${esc(nameOf(d.spy[d.turn]))}）</b>`
    : `<b class="cn-turn ${d.turn}">${TN[d.turn]}チーム：ヒント「${esc(d.clue?.word || '')}」 ${d.clue?.num || '∞'}　（${d.guesses}/${d.max > 50 ? '∞' : d.max}枚）</b>`;
  const canGuess = d.step === 'guess' && myTurn && !amSpy;
  const role = d.step === 'result' || !myTeam ? '' : `<small class="cn-role">${amSpy ? `色はあなたにだけ見えています。${TN[myTeam]}のパネルを当ててもらえるヒントを出しましょう（黒は暗殺者＝開けたら負け）` : `パネルの色はスパイマスターだけが知っています。ヒントから${TN[myTeam]}チームのパネルを当てましょう`}</small>`;
  const grid = `<div class="cn-grid">${d.cards.map((c, i) => {
    const col = c.color || (key ? key[i] : null), shown = !!c.color;
    return `<button type="button" class="cn-card ${shown ? 'shown ' + c.color : key ? 'peek ' + key[i] : ''}" data-i="${i}"${canGuess && !c.revealed ? '' : ' disabled'}><span>${esc(c.work)}</span>${c.title ? `<small>${esc(c.title)}</small>` : ''}</button>`;
  }).join('')}</div>`;
  let foot = '';
  if (d.step === 'clue' && spyTurn) foot = '<form class="wf-say cn-form" id="cnClueForm"><input id="cnWord" maxlength="12" placeholder="ヒントの言葉（作品名は不可）" autocomplete="off"><select id="cnNum">' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(n => `<option value="${n}">${n || '∞'}</option>`).join('') + '</select><button class="btn-main" type="submit">出す</button></form>';
  else if (d.step === 'guess' && canGuess) foot = `<button class="btn-sub" id="cnEndBtn" type="button"${d.guesses ? '' : ' disabled'}>ここまで（手番を終える）</button>`;
  else if (d.step === 'result') foot = '<small class="cn-note">' + d.result.rows.filter(r => r.team === d.winner).map(r => esc(r.name)).join('・') + ' さんの勝ち</small>';
  const chat = d.step !== 'result' && myTeam ? `<div class="cn-chatbar"><div class="cn-chat" id="cnChat">${cnChatLog.map(c => `<span>${esc(c.name)}：${esc(c.text)}</span>`).join('')}</div><form class="wf-say" id="cnSay"><input id="cnSayText" maxlength="40" placeholder="チームに一言" autocomplete="off"><button class="btn-sub" type="submit">送る</button></form></div>` : '';
  pop.innerHTML = `<div class="wf-field cn-field ${myTeam ? 'team-' + myTeam : ''}">${head}${status}${role}${grid}${foot}${chat}</div>`;
  const left = () => { const el = $('cnLeft'); if (el) el.textContent = d.until ? `あと ${wolfLeft(d.until)} 秒` : ''; };
  clearInterval(cnTick); left(); cnTick = setInterval(left, 500);
  pop.querySelectorAll('.cn-card').forEach(b => b.onclick = () => socket.emit('cnGuess', +b.dataset.i));
  const cf = $('cnClueForm'); if (cf) { $('cnWord').focus(); cf.onsubmit = e => { e.preventDefault(); const w = $('cnWord').value.trim(); if (!w) return toast('ヒントの言葉を入れてください'); if (d.cards.some(c => w.includes(c.work) || c.work.includes(w))) return toast('盤面の作品名は使えません'); socket.emit('cnClue', { word: w, num: +$('cnNum').value }); cf.querySelectorAll('input,select,button').forEach(x => x.disabled = true); }; }
  const eb = $('cnEndBtn'); if (eb) eb.onclick = () => socket.emit('cnEnd');
  const sf = $('cnSay'); if (sf) sf.onsubmit = e => { e.preventDefault(); const v = $('cnSayText').value.trim(); if (!v) return; socket.emit('cnChat', v); $('cnSayText').value = ''; };
}

// ── アニソン・ババ抜き：同じ作品の曲2枚をペアにして出す。右隣から1枚ずつ引く ──
let bbData = null, bbHand = [], bbSel = [], bbTick = null, bbNew = null;
function hideBaba() { clearInterval(bbTick); $('babaPop').hidden = true; $('babaPop').innerHTML = ''; bbData = null; bbHand = []; bbSel = []; }
socket.on('bbHand', d => { bbHand = d.hand || []; bbSel = bbSel.filter(id => bbHand.some(c => c.id === id)); if (bbData) renderBaba(); });
socket.on('bbDrew', d => { bbNew = d.id; setTimeout(() => { bbNew = null; if (bbData) renderBaba(); }, 3000); });
socket.on('bbMsg', m => toast(m.text));
socket.on('bbPhase', d => { if (!d) return hideBaba(); bbData = d; renderBaba(); });
function renderBaba() {
  const d = bbData; if (!d) return;
  const pop = $('babaPop'); pop.hidden = false;
  const nameOf = id => d.players.find(p => p.id === id)?.name || '';
  const isMe = d.turn === me, myTarget = isMe && d.step === 'turn';
  const head = `<div class="wf-head"><b>🃏 アニソン・ババ抜き</b><span>第${d.round}/${d.total}回</span><span class="wf-left" id="bbLeft"></span></div>`;
  const seats = `<div class="wf-seats bb-seats">${d.players.map(p => `<span class="${p.rank ? 'done' : ''}${p.id === d.turn ? ' bb-turn' : ''}">${esc(p.name)}：${p.rank ? p.rank + '番に上がり' : p.count + '枚'}${p.id === d.turn ? '▶' : ''}${p.id === d.target ? '◀' : ''}</span>`).join('')}</div>`;
  const mine = d.players.find(p => p.id === me);
  let msg = '';
  if (d.step === 'pair') msg = '同じ作品の曲2枚をタップして、ペアにして出しましょう（全員の準備ができるか、時間で始まります）';
  else if (d.step === 'turn') msg = isMe ? `あなたの番です。${esc(nameOf(d.target))} さんの手札から1枚引いてください` : `${esc(nameOf(d.turn))} さんが ${esc(nameOf(d.target))} さんから引きます`;
  else if (d.step === 'between') msg = '…';
  let body = '';
  if (d.step === 'result') {
    const r = d.result;
    body = `<p class="wf-result ${r.rows.find(x => x.id === me)?.total > 0 ? 'win' : 'lose'}">${r.loser ? '🃏 ババを持っていたのは ' + esc(r.loser) + ' さん！' : '終了'}</p>
      <div class="dx-list">${r.rows.map(x => `<div class="dx-card${x.loser ? '' : ' teller'}"><div><b>${x.rank}. ${esc(x.name)}${x.loser ? '（ババ）' : ''}</b><small>上がり ${x.place >= 0 ? '+' + x.place : x.place}／ペア +${x.pairs}／まちがい ${x.wrong}${x.joker ? '／ババ ' + x.joker : ''}</small></div><b>${x.total >= 0 ? '+' : ''}${x.total}点</b></div>`).join('')}</div>`;
  } else {
    const tgt = d.players.find(p => p.id === d.target);
    const backs = myTarget && tgt ? `<div class="bb-backs">${Array.from({ length: tgt.count }, (_, i) => `<button type="button" class="bb-back" data-draw="${i}">🂠</button>`).join('')}</div>` : '';
    const hand = bbHand.length ? `<div class="dx-list">${bbHand.map(c => `<div class="dx-card${bbSel.includes(c.id) ? ' sel' : ''}${c.id === bbNew ? ' teller' : ''}" data-card="${esc(c.id)}"><div><b>${c.joker ? '🃏 ババ（ジョーカー）' : esc(c.title)}</b><small>${c.joker ? '最後まで持っていると負け' : esc(c.artist) + (c.id === bbNew ? '　★いま引いたカード' : '')}</small></div>${c.joker ? '' : `<div class="dx-btns"><button class="btn-sub" type="button" data-prev="${esc(c.id)}">▶ 聴く</button></div>`}</div>`).join('')}</div>` : '<p class="wf-msg">あなたは上がりました！</p>';
    body = `<p class="wf-msg">${msg}</p>${backs}${hand}${d.step === 'pair' && !mine?.rank ? '<button class="btn-sub" id="bbReadyBtn" type="button">ペア出し終わり</button>' : ''}<ul class="bb-log">${d.log.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
  }
  pop.innerHTML = `<div class="wf-field">${head}${seats}${body}</div>`;
  const left = () => { const el = $('bbLeft'); if (el) el.textContent = d.until ? `あと ${wolfLeft(d.until)} 秒` : ''; };
  clearInterval(bbTick); left(); bbTick = setInterval(left, 500);
  pop.querySelectorAll('[data-prev]').forEach(b => b.onclick = e => { e.stopPropagation(); socket.emit('bbPreview', b.dataset.prev); });
  pop.querySelectorAll('[data-draw]').forEach(b => b.onclick = () => { socket.emit('bbDraw', +b.dataset.draw); pop.querySelectorAll('[data-draw]').forEach(x => x.disabled = true); });
  pop.querySelectorAll('[data-card]').forEach(el => el.onclick = () => {
    const id = el.dataset.card; if (id === 'JOKER') return;
    bbSel = bbSel.includes(id) ? bbSel.filter(x => x !== id) : [...bbSel, id].slice(-2);
    if (bbSel.length === 2) { socket.emit('bbPair', { a: bbSel[0], b: bbSel[1] }); bbSel = []; }
    renderBaba();
  });
  const rb = $('bbReadyBtn'); if (rb) rb.onclick = () => { socket.emit('bbReady'); rb.disabled = true; rb.textContent = 'ほかの人を待っています…'; };
}

// ── アニソン伝達クイズ：伝える人がヒントを打つ → ほかの人は選択肢から選ぶ → 結果（曲は人狼と同じ wolfSong で、伝える人だけに流れる） ──
let dtData = null, dtTick = null;
function hideDt() { clearInterval(dtTick); $('dtPop').hidden = true; $('dtPop').innerHTML = ''; dtData = null; }
socket.on('dtPhase', d => { if (!d) return hideDt(); dtData = d; renderDt(); });
function renderDt() {
  const d = dtData; if (!d) return;
  const pop = $('dtPop'); pop.hidden = false;
  const tellerName = d.players.find(p => p.id === d.teller)?.name || '';
  const head = `<div class="wf-head"><b>📨 アニソン伝達クイズ</b><span>第${d.round}/${d.total}問　伝える人：${esc(tellerName)}</span><span class="wf-left" id="dtLeft"></span></div>`;
  const hints = `<div class="dt-hints">${d.hints.length ? d.hints.map((h, i) => `<span><i>${i + 1}</i>${esc(h)}</span>`).join('') : '<small class="note">まだヒントはありません</small>'}</div>`;
  const status = `<p class="wf-msg"><small>決定 ${d.answered.length}/${d.answerers}人</small></p>`;
  let body = '';
  if (d.step === 'tell' && d.me === 'teller') {
    const s = d.song || {};
    body = `<p class="wf-msg">あなたが伝える人です。曲名・作品名・歌手名を使わずに、文字のヒントで伝えてください</p>
      <div class="dt-song"><b>${esc(s.title)}</b><small>${esc(s.work)}／${esc(s.artist)}（${s.year}）</small>
        <span><button class="btn-sub" type="button" data-listen="intro">▶ イントロ</button>${s.chorus ? '<button class="btn-sub" type="button" data-listen="chorus">▶ サビ</button>' : ''}</span></div>
      ${hints}
      <form class="wf-say" id="dtHintForm"><input id="dtHintText" maxlength="30" placeholder="ヒント（30文字まで・${10 - d.hints.length}個まで）" autocomplete="off"${d.hints.length >= 10 ? ' disabled' : ''}><button class="btn-main" type="submit"${d.hints.length >= 10 ? ' disabled' : ''}>送る</button></form>${status}`;
  } else if (d.step === 'tell') {
    const picked = d.myLocked, chosen = d.myPick != null;
    body = `${hints}<p class="wf-msg">${picked ? '決定しました。ほかの人を待っています…' : chosen ? '「決定」を押すまで選び直せます（ヒントが増えたら見直しも）' : d.hints.length ? 'ヒントに合う曲を選んでください（▶で自分だけ試聴できます）' : `${esc(tellerName)} さんが曲を聴いて、ヒントを考えています…`}</p>
      <div class="dt-choices">${d.choices.map((c, i) => `<div class="dt-row"><button type="button" class="dt-choice${d.myPick === i ? ' sel' : ''}" data-pick="${i}"${picked || !d.hints.length ? ' disabled' : ''}><b>${esc(c.title)}</b><small>${esc(c.work)}</small></button>${d.canPreview?.[i] ? `<button type="button" class="btn-sub dt-prev" data-prev="${i}" title="自分だけ試聴（20秒）">▶</button>` : ''}</div>`).join('')}</div>${chosen && !picked ? '<button class="btn-main dt-lock" type="button" id="dtLockBtn">これで決定</button>' : ''}${status}`;
  } else if (d.step === 'result') {
    const r = d.result;
    body = `<div class="dt-song"><b>${esc(r.song.title)}</b><small>${esc(r.song.work)}／${esc(r.song.artist)}（${r.song.year}）</small></div>
      ${hints}
      <p class="wf-msg">正解 ${r.nCorrect}/${r.nAnswer}人　伝える人（${esc(r.teller)}）+${r.tellerPts}点</p>
      <div class="dx-list">${r.rows.map(x => `<div class="dx-card${x.correct ? ' teller' : ''}"><div><b>${x.correct ? '⭕' : '❌'} ${esc(x.name)}</b><small>${x.pick == null ? '選ばなかった' : esc(x.pick)}</small></div><b>+${x.pts}</b></div>`).join('')}</div>`;
  }
  const typing = $('dtHintText')?.value || ''; // 打ちかけのヒントは、画面を描き直しても消さない
  pop.innerHTML = `<div class="wf-field">${head}${body}</div>`;
  if (typing && $('dtHintText')) $('dtHintText').value = typing;
  const left = () => { const el = $('dtLeft'); if (el) el.textContent = d.until ? `あと ${wolfLeft(d.until)} 秒` : ''; };
  clearInterval(dtTick); left(); dtTick = setInterval(left, 500);
  pop.querySelectorAll('[data-listen]').forEach(b => b.onclick = () => socket.emit('dtListen', b.dataset.listen));
  pop.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => socket.emit('dtPick', +b.dataset.pick));
  pop.querySelectorAll('[data-prev]').forEach(b => b.onclick = () => socket.emit('dtPreview', +b.dataset.prev)); // 選択肢の試聴（自分だけ）
  if ($('dtLockBtn')) $('dtLockBtn').onclick = () => socket.emit('dtLock');
  const f = $('dtHintForm');
  if (f) { $('dtHintText').focus(); f.onsubmit = e => { e.preventDefault(); const v = $('dtHintText').value.trim(); if (!v) return; socket.emit('dtHint', v); $('dtHintText').value = ''; }; }
}

// ── アニソン・ディクシット：語り手がヒント → 手札から出す → 投票 → 結果（試聴は人狼と同じ wolfSong） ──
let dxPickId = null, dxData = null, dxHand = [], dxTick = null, dxSel = null, dxStepKey = '';
function hideDixit() { clearInterval(dxTick); $('dixitPop').hidden = true; $('dixitPop').innerHTML = ''; dxData = null; dxHand = []; dxSel = null; dxStepKey = ''; }
const dxName = id => dxData?.players.find(p => p.id === id)?.name || '';
socket.on('dixitHand', d => { dxHand = d.hand || []; dxPickId = d.pick || null; if (dxData) renderDixit(); });
socket.on('dixitPhase', d => {
  if (!d) return hideDixit();
  const key = d.round + ':' + d.step;
  if (key !== dxStepKey) { dxSel = null; dxStepKey = key; }
  dxData = d; renderDixit();
});
const dxCard = (c, extra = '', btns = '') => `<div class="dx-card${extra}"><div><b>${esc(c.title)}</b><small>${esc(c.work)}${c.artist ? '／' + esc(c.artist) : ''}</small></div><div class="dx-btns"><button class="btn-sub" type="button" data-prev="${esc(c.id)}">▶ 聴く</button>${btns}</div></div>`;
function renderDixit() {
  const d = dxData; if (!d) return;
  const pop = $('dixitPop'); pop.hidden = false;
  const isTeller = d.teller === me;
  const top = Math.max(...d.players.map(p => p.score || 0));
  const seats = `<div class="wf-seats">${d.players.map(p => `<span data-pid="${esc(p.id)}" class="${d.done.includes(p.id) ? 'done' : ''}${p.id === me ? ' me' : ''}">${top > 0 && p.score === top ? '👑' : ''}${esc(p.name)}${p.id === d.teller ? '（語り手）' : ''}<b class="dx-pts">${p.score || 0}点</b></span>`).join('')}</div>`; // いまの点数（いちばん多い人に👑）
  const head = `<div class="wf-head"><b>🎴 アニソン・ディクシット</b><span>第${d.round}/${d.total}回　語り手：${esc(dxName(d.teller))}</span><span class="wf-left" id="dxLeft"></span></div>`;
  const hint = d.hint ? `<p class="dx-hint">ヒント：<b>${esc(d.hint)}</b></p>` : '';
  let body = '';
  const hand = (pick) => `<div class="dx-list">${dxHand.map(c => dxCard(c, (d.step === "pick" ? dxPickId : dxSel) === c.id ? ' sel' : '', pick ? `<button class="btn-main" type="button" data-sel="${esc(c.id)}">${(d.step === 'pick' ? dxPickId : dxSel) === c.id ? '✔ 選んだ' : pick}</button>` : '')).join('')}</div>`;
  if (d.step === 'tell') {
    body = isTeller
      ? `<p class="wf-msg">あなたが語り手です。手札から1曲を選んで、ヒントを一言（20文字まで）</p>${hand('これにする')}<form class="wf-say" id="dxTellForm"><input id="dxHintText" maxlength="20" placeholder="例：夏の終わり、泣ける、OP" autocomplete="off"><button class="btn-main" type="submit">決める</button></form>`
      : `<p class="wf-msg"><b>${esc(dxName(d.teller))}</b> さんが曲を選んで、ヒントを考えています…<small>（あなたの手札）</small></p>${hand('')}`;
  } else if (d.step === 'pick') {
    const mine = d.done.includes(me);
    body = `${hint}${isTeller ? '<p class="wf-msg">みんなが曲を出すのを待っています…</p>' : `<p class="wf-msg">ヒントに合うと思う曲を、手札から1曲出しましょう${mine ? '（出しました。変えられます）' : ''}</p>${hand(mine ? '変える' : '出す')}`}`;
  } else if (d.step === 'vote') {
    const mineVoted = d.done.includes(me);
    body = `${hint}<p class="wf-msg">${isTeller ? 'みんなが語り手の曲を探しています…' : '語り手の曲だと思う曲に投票！（自分の曲には入れられません）'}</p>
      <div class="dx-list">${d.cands.map((c, i) => dxCard(c, dxSel === i ? ' sel' : '', isTeller ? '' : `<button class="btn-main" type="button" data-vote="${i}"${c.id === dxPickId ? ' disabled' : ''}>${dxSel === i ? '✔ 投票した' : '投票'}</button>`)).join('')}</div>`;
  } else if (d.step === 'result') {
    const r = d.result, gain = r.gains[me] || 0;
    body = `<p class="wf-result ${gain > 0 ? 'win' : 'lose'}">${r.allOrNone ? (r.cards[r.tellerIndex]?.votes === 0 ? '全員外れ…語り手は0点' : '全員正解！語り手は0点') : '語り手の曲、ほどよく伝わりました！'}<small>あなたは ${gain > 0 ? '+' + gain : '0'} 点</small></p>
      <p class="dx-hint">ヒント：<b>${esc(r.hint)}</b></p>
      <div class="dx-list">${r.cards.map((c, i) => `<div class="dx-card${i === r.tellerIndex ? ' teller' : ''}"><div><b>${esc(c.title)}</b><small>${esc(c.work)}／${esc(c.artist)}（${c.year}）</small><small>${i === r.tellerIndex ? '★語り手の曲' : '出した人：' + esc(c.ownerName)}　票 ${c.votes}${c.voters.length ? '（' + c.voters.map(esc).join('・') + '）' : ''}</small></div><div class="dx-btns"><button class="btn-sub" type="button" data-prev="${esc(c.id)}">▶ 聴く</button></div></div>`).join('')}</div>
      <div class="wf-tally">${d.players.map(p => `<span>${esc(p.name)} +${(r.gains[p.id] || 0)}点</span>`).join('')}</div>`;
  }
  pop.innerHTML = `<div class="wf-field">${head}${seats}${body}</div>`; // 点数はいつも上に出す（結果の画面でも）
  const left = () => { const el = $('dxLeft'); if (el) el.textContent = d.until ? `あと ${wolfLeft(d.until)} 秒` : ''; };
  clearInterval(dxTick); left(); dxTick = setInterval(left, 500);
  pop.querySelectorAll('[data-prev]').forEach(b => b.onclick = () => socket.emit('dxPreview', b.dataset.prev));
  pop.querySelectorAll('[data-sel]').forEach(b => b.onclick = () => {
    if (d.step === 'tell') { dxSel = b.dataset.sel; renderDixit(); $('dxHintText')?.focus(); }
    else if (d.step === 'pick') { socket.emit('dxPick', b.dataset.sel); dxSel = b.dataset.sel; renderDixit(); }
  });
  pop.querySelectorAll('[data-vote]').forEach(b => b.onclick = () => { socket.emit('dxVote', +b.dataset.vote); dxSel = +b.dataset.vote; renderDixit(); });
  const tf = $('dxTellForm');
  if (tf) tf.onsubmit = e => { e.preventDefault(); const v = $('dxHintText').value.trim(); if (!dxSel) return toast('先に手札から曲を選んでください'); if (!v) return toast('ヒントを入れてください'); socket.emit('dxTell', { id: dxSel, hint: v }); tf.querySelectorAll('input,button').forEach(x => x.disabled = true); };
}

// ── アニソン年表：自分の年表と、置く場所のボタン ──
let nenpyoSlot = null;
function renderNenpyo() {
  const box = $('nenpyoBox'), r = room;
  const mine = r?.settings?.play === 'nenpyo' && r.state === 'playing' ? r.players.find(p => p.id === me)?.timeline : null;
  box.hidden = !mine;
  if (!mine) return;
  const canPick = question?.answerMode === 'nenpyo' && answering && myAnswer === null;
  const slot = i => `<button type="button" class="ny-slot${nenpyoSlot === i ? ' mine' : ''}" data-s="${i}"${canPick ? '' : ' disabled'}>${nenpyoSlot === i ? '★' : '▼'}<small>ここ</small></button>`;
  box.innerHTML = `<div class="ny-head">📅 あなたの年表 <b>${mine.length}</b>/10枚</div><div class="ny-line">${slot(0)}${mine.map((c, i) => `<div class="ny-card"><b>${c.year}</b><small>${esc(c.title)}</small></div>${slot(i + 1)}`).join('')}</div>`;
  box.querySelectorAll('.ny-slot').forEach(b => b.onclick = () => {
    const s = +b.dataset.s, tl = mine;
    nenpyoSlot = s;
    answer({ slot: s, given: `${s > 0 ? tl[s - 1].year : '…'}〜${s < tl.length ? tl[s].year : '…'}の間` });
    renderNenpyo();
  });
}

// ── アニソン陣取り：盤（問題中は小さく・選ぶときは大きく）──
const PANEL_COLORS = ['#ff5c8a', '#4fb4ff', '#ffd23f', '#5be37d', '#b07cff', '#ff9a3d', '#3de0d0', '#ff7ad9', '#a3a3ff', '#c8e65a', '#ff6b5c', '#7ad1ff'];
let panelPickKey = null, panelPopTimer = null, panelTick = null;
const PANEL_TEAM_COLORS = { red: '#ff5c8a', blue: '#4fb4ff' };
const panelColor = (r, id) => { if (PANEL_TEAM_COLORS[id]) return PANEL_TEAM_COLORS[id];  const i = r.players.findIndex(p => p.id === id); return i < 0 ? '#666' : PANEL_COLORS[i % PANEL_COLORS.length]; };
const panelCells = (r, board, opt = {}) => board.map((id, i) => `<button type="button" class="pn-cell${id ? ' own' : ''}${!id && opt.atk === i ? ' atk' : ''}${opt.allowed?.includes(i) ? ' can' : ''}${opt.flipped?.includes(i) ? ' flip' : ''}${opt.idx === i ? ' put' : ''}" data-i="${i}" style="${id ? `--pc:${panelColor(r, id)}` : ''}"${opt.allowed?.includes(i) && opt.mine ? '' : ' disabled'}>${i + 1}</button>`).join('');
const panelLegend = (r, board) => r.settings.teams && board ? ['red', 'blue'].map(k => `<span style="--pc:${PANEL_TEAM_COLORS[k]}"><i></i>${TEAM_LABEL[k]}チーム ${board.filter(x => x === k).length}</span>`).join('') : r.players.filter(p => p.panelCount != null).map(p => `<span style="--pc:${panelColor(r, p.id)}"><i></i>${esc(p.name)} ${p.panelCount}</span>`).join('');
// ── アニソン・デッキ構築：自分のコイン・カード（問題中は使える）・ショップ ──
let dkShopData = null, dkTick = null, dkDoneIds = [];
const DK_USE = [['fifty', '✂', '50:50'], ['audience', '👥', 'オーディエンス'], ['phone', '📞', 'テレフォン'], ['replay', '🔁', 'もう一度聴く']];
function renderDeck(r) {
  const meP = r.players.find(p => p.id === me), dk = meP?.deck;
  $('dkBox').hidden = !dk || r.state !== 'playing';
  if (!dk) return;
  const playing = ['intro', 'chorus'].includes(r.phase);
  const dg = r.deckGame;
  $('dkBox').innerHTML = `${dg ? `<div class="dk-prog">曲 <b>${dg.qNo}</b> / ${dg.qTotal}　ショップ あと <b>${Math.max(0, dg.shopsTotal - dg.shopsDone)}</b> 回（${dg.nextShopIn > 0 ? `${dg.nextShopIn}問あと` : 'この問題のあと'}）</div>` : ''}<div class="dk-coins">🪙 ${dk.coins}コイン　💰${dk.invest + (dk.invest2 || 0) * 2}　✖2 ${dk.boost}　✖3 ${dk.boost3 || 0}　👑 ${dk.vp + (dk.vp2 || 0)}</div><div class="dk-use">${DK_USE.map(([k, ic, lb]) => { const n = meP.lifelines?.[k] || 0; return `<button type="button" class="btn-sub" data-dkuse="${k}"${n && playing ? '' : ' disabled'}>${ic} ${lb} ×${n}</button>`; }).join('')}</div>`;
  $('dkBox').querySelectorAll('[data-dkuse]').forEach(b => b.onclick = () => { b.disabled = true; socket.emit('lifeline', { type: b.dataset.dkuse }); });
  if (dkShopData) renderDkShop();
}
socket.on('dkShop', d => { dkShopData = d; dkDoneIds = []; renderDkShop(); });
socket.on('dkShopProgress', d => { dkDoneIds = d.done || []; if (dkShopData) renderDkShop(); });
socket.on('dkShopEnd', () => { dkShopData = null; clearInterval(dkTick); $('dkPop').hidden = true; $('dkPop').innerHTML = ''; });
function renderDkShop() {
  const d = dkShopData, r = room; if (!d || !r) return;
  const meP = r.players.find(p => p.id === me), dk = meP?.deck || { coins: 0, vp: 0 }, done = dkDoneIds.includes(me);
  const price = c => (c.key === 'vp' ? dk.vpPrice ?? c.price : c.price);
  const have = c => (['boost', 'boost3', 'invest', 'invest2', 'vp', 'vp2'].includes(c.key) ? dk[c.key] : ['steal', 'gift'].includes(c.key) ? '' : meP?.lifelines?.[c.key]) ?? 0;
  $('dkPop').innerHTML = `<div class="wf-field dk-field"><div class="wf-head"><b>🛒 ショップ（第${d.round}回／全${d.rounds}回・あと ${d.rounds - d.round} 回）</b><span>曲 ${d.qNo} / ${d.qTotal}${d.last ? '・最後のショップ' : ''}</span><span>🪙 ${dk.coins}コイン</span><span class="wf-left" id="dkLeft"></span></div>
    <div class="dk-cards">${d.cards.map(c => `<button type="button" class="dk-card" data-buy="${c.key}"${done || dk.coins < price(c) ? ' disabled' : ''}><b>${c.icon} ${esc(c.label)}</b><small>${esc(c.text)}</small><span>🪙${price(c)}${have(c) === '' ? '' : `　持っている ${have(c)}`}</span></button>`).join('')}</div>
    <div class="wf-seats">${r.players.map(p => `<span class="${dkDoneIds.includes(p.id) ? 'done' : ''}">${esc(p.name)} 🪙${p.deck?.coins ?? 0}</span>`).join('')}</div>
    <button class="btn-main" id="dkDoneBtn" type="button"${done ? ' disabled' : ''}>${done ? 'ほかの人を待っています…' : '買い物を終わる'}</button></div>`;
  $('dkPop').hidden = false;
  $('dkPop').querySelectorAll('[data-buy]').forEach(b => b.onclick = () => socket.emit('dkBuy', b.dataset.buy));
  $('dkDoneBtn').onclick = () => socket.emit('dkDone');
  clearInterval(dkTick); const tick = () => { const el = $('dkLeft'); if (el) el.textContent = `あと ${wolfLeft(d.until)} 秒`; }; tick(); dkTick = setInterval(tick, 500);
}
// ── アニソン・ジャンル制覇：いまのジャンル・全員のピース・次のジャンルを選ぶ窓 ──
let gzTick = null, gzPickKey = null;
// 次のジャンルが決まった：画面の下に小さく出すだけ（邪魔しない）。ランダムのときは、答え合わせが出てから
socket.on('gzChosen', d => setTimeout(() => toast(`${d.icon}「${d.label}」ジャンルが選択されました${d.random ? '（ランダム）' : d.name ? '（' + d.name + ' さん）' : ''}`), d.random ? 1500 : 0));
function renderGenreZone(r) {
  const z = r.genreZone; $('gzBox').hidden = !z;
  if (!z) { $('gzPop').hidden = true; gzPickKey = null; gzSeen = -2; return; }
  const fresh = hlOn() && r.phase === 'reveal' && z.at >= 0 && z.at !== gzSeen && z.gain;
  if (r.phase === 'reveal' && z.at >= 0) gzSeen = z.at;
  const cur = z.cats.find(c => c.key === z.cur);
  // カード（種類ごと）に、とった人の色つきの丸（名前の最初の字）をつける。いまのジャンルは光る。種類が多いとき（EX）は絵文字だけの小さなカード（名前は触ると出る）
  const compact = z.cats.length > 8;
  const owners = c => z.players.filter(p => p.pieces.includes(c.key));
  const dot = p => `<u style="background:${pColor(p.id)}" title="${esc(p.name)}">${esc([...p.name][0] || '?')}</u>`;
  const cards = z.cats.map(c => { const os = owners(c), gained = fresh && z.gain.key === c.key; return `<div class="gz-card${c.key === z.cur ? ' cur' : ''}${os.length ? ' got' : ''}${gained ? ' gain' : ''}${compact ? ' mini' : ''}" title="${esc(c.label)}${os.length ? '：' + os.map(p => esc(p.name)).join('・') : '：まだだれも取っていません'}"><i>${c.icon}</i><b>${esc(c.label)}</b><span class="gz-own">${os.map(dot).join('')}</span></div>`; }).join('');
  const legend = z.players.map(p => { const g = fresh && z.gain.id === p.id ? z.gain : null; return `<span class="${p.id === me ? 'me' : ''}${g ? ' hl' : ''}"${g ? ` data-hl="${g.dup ? '+300点' : `${g.n}/${z.cats.length} ✨`}"` : ''}>${dot(p)}${esc(p.name)} <em>${p.pieces.length}/${z.cats.length}</em></span>`; }).join('');
  $('gzBox').innerHTML = `<b class="gz-cur">${cur ? `いまのジャンル：${cur.icon}${esc(cur.label)}` : 'ジャンル制覇'}</b><div class="gz-cards${compact ? ' compact' : ''}">${cards}</div><div class="gz-legend">${legend}</div>`;
  if (fresh) setTimeout(() => $('gzBox').querySelectorAll('.hl,.gain').forEach(el => { el.classList.remove('hl', 'gain'); el.removeAttribute('data-hl'); }), 4500);
  if (!z.pick) { $('gzPop').hidden = true; gzPickKey = null; clearInterval(gzTick); return; }
  const key = z.pick.id + ':' + z.pick.until; if (key === gzPickKey) return; gzPickKey = key;
  const mine = z.pick.id === me, my = z.players.find(p => p.id === me)?.pieces || [];
  $('gzPop').innerHTML = `<div class="wf-field gz-field"><div class="wf-head"><b>${mine ? '次の問題のジャンルを選んでください' : esc(z.pick.name) + ' さんが次のジャンルを選んでいます…'}</b><span class="wf-left" id="gzLeft"></span></div>
    <div class="gz-cats">${z.cats.map(c => `<button type="button" class="btn-sub gz-cat${my.includes(c.key) ? ' have' : ''}" data-cat="${c.key}"${mine ? '' : ' disabled'}><b>${c.icon}</b>${esc(c.label)}<span class="gz-own">${z.players.filter(p => p.pieces.includes(c.key)).map(p => `<u style="background:${pColor(p.id)}" title="${esc(p.name)}">${esc([...p.name][0] || '?')}</u>`).join('')}</span>${mine && my.includes(c.key) ? '<small>持っている</small>' : ''}</button>`).join('')}</div></div>`;
  $('gzPop').hidden = false;
  $('gzPop').querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { socket.emit('gzChoose', b.dataset.cat); $('gzPop').querySelectorAll('[data-cat]').forEach(x => x.disabled = true); });
  clearInterval(gzTick); const tick = () => { const el = $('gzLeft'); if (el) el.textContent = `あと ${wolfLeft(z.pick.until)} 秒`; }; tick(); gzTick = setInterval(tick, 500);
}
// ── アニソンすごろく：盤（31マス・2段）と全員のコマ ──
const SG_ICON = { fwd: '⏩', back: '⏪', bonus: '💰', rest: '💤', dbl: '✖2', swap: '🔀', hit: '💥' };
// 答え合わせのとき、進んだ分・埋めた分を、プレイヤー一覧の下の小さな欄の中だけでハイライトする（PCのみ。画面の邪魔をしないよう、数秒で消える）
let sgSeen = -2, gzSeen = -2;
const hlOn = () => matchMedia('(min-width: 900px)').matches;
const pColor = id => `hsl(${[...String(id)].reduce((a, c) => a + c.charCodeAt(0) * 37, 0) % 360} 80% 62%)`; // 人ごとの色（すごろくのコマ・ジャンル制覇のカードで共通）
function renderSugoroku(r) {
  const sg = r.sugoroku; $('sgBox').hidden = !sg;
  if (!sg) { sgSeen = -2; return; }
  const fresh = hlOn() && r.phase === 'reveal' && sg.at >= 0 && sg.at !== sgSeen;
  if (r.phase === 'reveal' && sg.at >= 0) sgSeen = sg.at;
  const trail = new Set(), badge = new Map();
  if (fresh) for (const m of sg.moves || []) { for (let i = m.from + 1; i <= m.to; i++) trail.add(i); badge.set(m.id, `+${Math.max(0, m.to - m.from)}マス${m.ev && SG_ICON[m.ev] ? ' ' + SG_ICON[m.ev] : ''}`); }
  const color = id => `hsl(${[...id].reduce((a, c) => a + c.charCodeAt(0) * 37, 0) % 360} 80% 62%)`;
  const cells = sg.board.map((ev, i) => {
    const here = sg.pos.filter(p => p.pos === i);
    return `<div class="sg-cell${i === 0 ? ' start' : i === sg.goal ? ' goal' : ''}${ev ? ' ev' : ''}${trail.has(i) ? ' trail' : ''}" title="${i}"><small>${i === 0 ? 'S' : i === sg.goal ? '🏁' : i}</small><span>${SG_ICON[ev] || ''}</span><div class="sg-tokens">${here.map(p => `<i class="${p.id === me ? 'me' : ''}${sg.last.includes(p.id) ? ' moved' : ''}" style="background:${color(p.id)}" title="${esc(p.name)}">${esc([...p.name][0] || '?')}</i>`).join('')}</div></div>`;
  }).join('');
  const legend = [...sg.pos].sort((a, b) => b.pos - a.pos).map(p => `<span${badge.has(p.id) ? ` class="hl" data-hl="${esc(badge.get(p.id))}"` : ''}><i style="background:${color(p.id)}"></i>${esc(p.name)} ${p.pos}${p.rest ? '💤' : ''}${p.dbl ? '✖2' : ''}</span>`).join('');
  $('sgBox').innerHTML = `<div class="sg-board">${cells}</div><div class="sg-legend">${legend}</div>`;
  if (fresh) setTimeout(() => $('sgBox').querySelectorAll('.trail,.hl').forEach(el => { el.classList.remove('trail', 'hl'); el.removeAttribute('data-hl'); }), 4500);
}
function renderPanel(r) {
  const pn = r.panel;
  $('panelMini').hidden = !pn;
  if (!pn) { $('panelPop').hidden = true; panelPickKey = null; return; }
  $('panelMini').innerHTML = `<div class="pn-board sm">${panelCells(r, pn.board, { atk: pn.attackCell })}</div><div class="pn-legend">${panelLegend(r, pn.board)}</div>`;
  // だれかが選んでいる：大きな盤を出す（選ぶ人だけ押せる）
  if (pn.pick) {
    const key = pn.pick.id + ':' + pn.pick.until;
    if (key === panelPickKey) return;
    panelPickKey = key; clearTimeout(panelPopTimer); clearInterval(nextTick); $('nextCount').textContent = '';
    const mine = pn.pick.id === me;
    const atk = pn.pick.stage === 'attack';
    $('panelPop').innerHTML = `<div class="pn-field${pn.pick.attack ? ' attack' : ''}"><h3>${pn.pick.attack ? (mine ? '⚡ アタックチャンス！ 白いマスも、どこからでも取れます' : `⚡ アタックチャンス！ ${esc(pn.pick.name)} さんがパネルを選んでいます`) : mine ? '🎯 パネルを選んでください' : `${esc(pn.pick.name)} さんがパネルを選んでいます`}</h3>
      <div class="pn-board">${panelCells(r, pn.board, { allowed: pn.pick.allowed, mine, atk: pn.attackCell })}</div>
      <div class="pn-legend">${panelLegend(r, pn.board)}</div><p class="pn-left" id="panelLeft"></p></div>`;
    $('panelPop').hidden = false;
    $('panelPop').querySelectorAll('.pn-cell.can').forEach(b => b.onclick = () => { if (!mine) return; socket.emit('panelChoose', +b.dataset.i); $('panelPop').querySelectorAll('.pn-cell').forEach(x => x.disabled = true); });
    clearInterval(panelTick);
    const tick = () => { const s = Math.max(0, Math.ceil((pn.pick.until - (Date.now() + (clockOffset || 0))) / 1000)); const el = $('panelLeft'); if (el) el.textContent = `あと ${s} 秒（時間切れは自動で選びます）`; };
    tick(); panelTick = setInterval(tick, 500);
  }
}
socket.on('panelAttack', d => {
  charFx.cutin('アタックチャンス！', `${d.idx + 1}番が白いマスに！ 次の問題の正解者が、どこからでも取れます`, 'celebrate');
  toast(`⚡ ${d.idx + 1}番のパネルが白くなりました（次の問題で取れます）`);
});
socket.on('panelUpdate', d => {
  clearInterval(panelTick);
  const r = room; if (!r) return;
  $('panelPop').innerHTML = `<div class="pn-field"><h3>${d.attack ? `⚡ ${esc(d.name)} さんがアタックチャンスの白いマス（${d.idx + 1}番）を取った！${d.flipped.length ? ` ${d.flipped.length}枚 裏返し！` : ''}` : `${esc(d.name)} さんが ${d.idx + 1}番 を取った！${d.flipped.length ? ` ${d.flipped.length}枚 裏返し！` : ''}`}</h3>
    <div class="pn-board">${panelCells(r, d.board, { flipped: d.flipped, idx: d.idx, atk: room?.panel?.attackCell })}</div><div class="pn-legend">${panelLegend(r, d.board)}</div></div>`;
  $('panelPop').hidden = false;
  if (d.attack) charFx.cutin('アタックチャンス成功！', `${d.name} さんが白いマスを取った！`, 'celebrate');
  else if (d.flipped.length >= 3) charFx.cutin(`${d.flipped.length}枚 裏返し！`, d.name, 'celebrate');
  clearTimeout(panelPopTimer);
  panelPopTimer = setTimeout(() => { $('panelPop').hidden = true; panelPickKey = null; }, 2500);
  if (!d.done && room?.settings?.autoNext > 0) startNextCount(Math.max(2.5, room.settings.autoNext / 2));
});

// ── アニソン・ポーカー：手札・捨てる・ショーダウン ──
const POKER_RULES = [['ロイヤルストレートフラッシュ', '10・J・Q・K・A が同じマーク'], ['ストレートフラッシュ', '数字が5枚連続で、同じマーク'], ['フォーカード', '同じ数字が4枚'], ['フルハウス', '同じ数字が3枚＋2枚'],
  ['フラッシュ', '5枚とも同じマーク'], ['ストレート', '数字が5枚連続（A-2-3-4-5 〜 10-J-Q-K-A）'], ['スリーカード', '同じ数字が3枚'], ['ツーペア', '同じ数字のペアが2組'], ['ワンペア', '同じ数字が2枚'], ['ハイカード', '役なし（いちばん強い数字で比べる）']];
$('pokerRules').innerHTML = '<li class="note">数字が同じ＝同じ作品（同じ数字・マークのカードは場に1枚だけ）。同じ役なら数字が強い方が勝ち（A＞K＞Q＞…＞2）</li>' + POKER_RULES.map(([n, d]) => `<li><b>${n}</b> ${d}</li>`).join('');
const SUITS = ['♠', '♥', '♦', '♣'], NUMS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const pokerTip = c => `${c.title}
作品：${c.work}
歌手：${c.artistLabel}
${c.year}年・${c.type || '—'}`;
const pokerCard = (c, opt = {}) => `<div class="pk-card suit${c.suit}${opt.sm ? ' sm' : ''}${opt.used ? ' used' : ''}${opt.drop ? ' drop' : ''}${opt.fresh ? ' fresh' : ''}${opt.down ? ' facedown' : ''}" data-id="${esc(c.id)}" title="${esc(pokerTip(c))}">
  <div class="pk-face"><b>${NUMS[c.num]}<small>${SUITS[c.suit]}</small></b><b class="br">${NUMS[c.num]}<small>${SUITS[c.suit]}</small></b><span class="pk-mid">${SUITS[c.suit]}</span><i>${esc(c.seriesLabel)}</i></div><div class="pk-back"></div></div>`;
const pokerInfoOf = id => { const c = pokerHandData.hand.find(x => x.id === id); return c ? `${NUMS[c.num]}${SUITS[c.suit]}　${pokerTip(c).split(String.fromCharCode(10)).join("／")}` : ''; };
let pokerHandData = { hand: [], over: false, usedIds: [], kept: [] }, pokerDrop = new Set(), pokerFresh = new Set();
function renderPokerHand() {
  const { hand, over, usedIds, best } = pokerHandData;
  $('pokerKept').textContent = (pokerHandData.kept || []).length ? `🏦 保管 ${pokerHandData.kept.length}枚（最後に +${pokerHandData.kept.length * 50}点）` : '';
  $('pokerBest').textContent = hand.length ? `（いまの役：${best}）` : '（まだカードがありません）';
  $('pokerHand').innerHTML = hand.map(c => pokerCard(c, { used: usedIds.includes(c.id), drop: pokerDrop.has(c.id), fresh: pokerFresh.has(c.id) })).join('') || '<p class="note">正解すると、その曲のカードが入ります</p>';
  $('pokerDiscard').hidden = !over;
  if (over) $('pokerDiscardMsg').textContent = `${hand.length}枚あります。捨てるカードを選んで（${hand.length - 5}枚）。選ばなければ、強い5枚が残ります`;
}
socket.on('pokerHand', d => {
  const before = new Set(pokerHandData.hand.map(c => c.id));
  pokerFresh = new Set(d.hand.filter(c => !before.has(c.id)).map(c => c.id));
  pokerHandData = d; pokerDrop = new Set([...pokerDrop].filter(id => d.hand.some(c => c.id === id)));
  renderPokerHand();
  setTimeout(() => { pokerFresh.clear(); renderPokerHand(); }, 1800);
});
$('pokerHand').onmouseover = e => { const el = e.target.closest('.pk-card'); if (el) $('pokerInfo').textContent = pokerInfoOf(el.dataset.id); };
$('pokerHand').onclick = e => {
  const el = e.target.closest('.pk-card'); if (!el) return;
  $('pokerInfo').textContent = pokerInfoOf(el.dataset.id);
  if (!pokerHandData.over) return;
  const id = el.dataset.id;
  if (pokerDrop.has(id)) pokerDrop.delete(id); else if (pokerDrop.size < pokerHandData.hand.length - 5) pokerDrop.add(id);
  renderPokerHand();
  if (pokerDrop.size === pokerHandData.hand.length - 5) { socket.emit('pokerDiscard', [...pokerDrop]); pokerDrop.clear(); }
};
$('pokerAuto').onclick = () => { socket.emit('pokerDiscard', []); pokerDrop.clear(); };
const POKER_KEEP_PTS = 50;
// ── ポーカー：10問ごとの中間オープン。ポーカー卓（フィールド）に全員を座らせて、賭け→オープン ──
const betPop = $('pokerBetPop');
let betTick = null, betSeats = [], betTimers = [];
function hidePokerBet() { clearInterval(betTick); betTimers.forEach(clearTimeout); betTimers = []; betPop.hidden = true; betPop.innerHTML = ''; }
// 卓の席の位置（楕円）。人数が多い・画面が狭いときは縦に並べる
const tableOval = n => n <= 6 && innerWidth >= 760;
const seatPos = (i, n) => { const a = Math.PI / 2 + i * 2 * Math.PI / n; return `--x:${(50 + 40 * Math.cos(a)).toFixed(1)}%;--y:${(50 + 38 * Math.sin(a)).toFixed(1)}%`; };
// 自分の席がいちばん手前（下）に来るように並べる
const meFirst = seats => { const i = seats.findIndex(s => s.id === me); return i > 0 ? [...seats.slice(i), ...seats.slice(0, i)] : seats; };
function fieldHtml(seats, center, seatInner) {
  const oval = tableOval(seats.length);
  return `<div class="pk-table field${oval ? '' : ' list'}"><div class="pk-felt-title">${center}</div>
    ${seats.map((s, i) => `<div class="pk-seat${s.id === me ? ' mine' : ''}" data-id="${esc(s.id)}" style="${oval ? seatPos(i, seats.length) : ''}">
      <div class="pk-plate">${avatarImg(s.avatar, 'avatar sm')}<span>${esc(s.name)}</span></div>${seatInner(s)}</div>`).join('')}</div>`;
}
socket.on('pokerBet', d => {
  hidePokerBet();
  let left = d.sec;
  const h = pokerHandData, max = Math.max(...d.options);
  betSeats = meFirst(d.seats || []);
  const inner = s => s.id === me
    ? `<div class="pk-seat-cards">${h.hand.map(c => pokerCard(c, { sm: true, used: h.usedIds.includes(c.id) })).join('') || '<small class="pk-empty">カードなし</small>'}</div><div class="pk-seat-bet" id="pbMine">${esc(h.best || '—')}</div>`
    : `<div class="pk-seat-cards">${Array.from({ length: s.count }, () => '<div class="pk-card sm facedown"><div class="pk-back"></div></div>').join('') || '<small class="pk-empty">カードなし</small>'}</div><div class="pk-seat-bet">考え中…</div>`;
  betPop.innerHTML = `<div class="pk-field">
    ${fieldHtml(betSeats, `<span>MID OPEN</span><em>${d.round ? `${d.round}回目の中間オープン` : '中間オープン'}</em><div class="pk-chips" aria-hidden="true"><i></i><i></i><i></i><i></i></div><small class="pk-pot" id="pbPot">賭け金を決めてください</small>`, inner)}
    <div class="pk-ctrl">
      <p class="pk-sub">手札に点を賭けて勝負！ 賭けた人が2人以上なら、役が強い人が総取り。オープンした手札は<b>保管</b>に回り、最後に1枚 +${POKER_KEEP_PTS}点。</p>
      <p class="pk-now">いまの役：<b>${esc(h.best || '—')}</b>　持ち点：<b>${d.score}</b></p>
      <div class="pk-bets">${d.options.map(v => `<button class="btn pk-bet" data-v="${v}" type="button">${v === 0 ? '見送り' : v === max ? `ALL IN ${v}点` : `${v}点`}</button>`).join('')}</div>
      <p class="pk-prog"><span id="pbDone">0/${d.total}</span>人が決めました　あと <span id="pbLeft">${left}</span>秒</p>
    </div></div>`;
  betPop.hidden = false;
  betPop.querySelectorAll('.pk-bet').forEach(b => b.onclick = () => {
    socket.emit('pokerBet', +b.dataset.v);
    betPop.querySelectorAll('.pk-bet').forEach(x => x.disabled = true); b.classList.add('chosen');
    const m = betPop.querySelector('.pk-seat.mine .pk-seat-bet'); if (m) m.textContent = +b.dataset.v ? `🪙 ${b.dataset.v}点` : '見送り';
  });
  betTick = setInterval(() => { left--; const el = $('pbLeft'); if (el) el.textContent = Math.max(0, left); if (left <= 0) clearInterval(betTick); }, 1000);
});
socket.on('pokerBetProgress', ({ done, total, decided = [] }) => {
  const el = $('pbDone'); if (el) el.textContent = `${done}/${total}`;
  for (const id of decided) { const b = betPop.querySelector(`.pk-seat[data-id="${CSS.escape(id)}"]:not(.mine) .pk-seat-bet`); if (b) b.textContent = '✔ 決めた'; }
});
socket.on('pokerBetResult', d => {
  clearInterval(betTick); betTimers.forEach(clearTimeout); betTimers = [];
  const byId = new Map(d.rows.map(r => [r.id, r]));
  const seats = betSeats.length ? betSeats.filter(s => byId.has(s.id)).concat(d.rows.filter(r => !betSeats.some(s => s.id === r.id))) : meFirst(d.rows);
  const inner = s => {
    const r = byId.get(s.id);
    if (!d.duel || !r.bet) return `<div class="pk-seat-bet">${!r.bet ? (d.duel ? 'フォールド' : '見送り') : `🪙 ${r.bet}点（勝負なしで戻る）`}</div>`;
    return `<div class="pk-seat-cards">${r.hand.map(c => pokerCard(c, { sm: true, down: true })).join('')}</div><div class="pk-seat-bet">🪙 ${r.bet}点</div>
      <div class="pk-seat-hand" hidden><b>${esc(r.handName)}</b><strong class="${r.delta >= 0 ? 'plus' : 'minus'}">${r.delta > 0 ? '+' : ''}${r.delta}点</strong></div>`;
  };
  const winners = d.rows.filter(r => r.win);
  betPop.innerHTML = `<div class="pk-field">
    ${fieldHtml(seats, `<span>OPEN!</span><em id="pbWin">${d.duel ? 'オープン…' : '賭けた人が1人以下なので、勝負なし'}</em><div class="pk-chips" aria-hidden="true"><i></i><i></i><i></i><i></i></div>${d.duel ? `<small class="pk-pot">POT ${d.pot}点</small>` : ''}`, inner)}
    <div class="pk-ctrl"><p class="pk-sub">${d.duel ? 'オープンした手札は保管に回ります（最後に1枚 +' + POKER_KEEP_PTS + '点）' : '手札はそのまま、次の問題へ進みます'}</p></div></div>`;
  betPop.hidden = false;
  if (d.duel) {
    // 弱い順にめくって、最後に勝った人
    const order = seats.filter(s => byId.get(s.id).bet).sort((a, b) => byId.get(a.id).win - byId.get(b.id).win || byId.get(a.id).delta - byId.get(b.id).delta);
    order.forEach((s, step) => betTimers.push(setTimeout(() => {
      const el = betPop.querySelector(`.pk-seat[data-id="${CSS.escape(s.id)}"]`); if (!el) return;
      const r = byId.get(s.id);
      el.querySelectorAll('.pk-card').forEach((c, ci) => setTimeout(() => { c.classList.remove('facedown'); c.classList.add('flip'); if (r.used.includes(c.dataset.id)) c.classList.add('used'); }, ci * 140));
      setTimeout(() => { el.querySelector('.pk-seat-hand').hidden = false; }, 800);
      if (step === order.length - 1) setTimeout(() => {
        for (const w of winners) betPop.querySelector(`.pk-seat[data-id="${CSS.escape(w.id)}"]`)?.classList.add('winner');
        const t = $('pbWin'); if (t) t.textContent = `👑 ${winners.map(w => w.name).join('・')} が ${d.pot}点を獲得！`;
      }, 1200);
    }, 500 + step * 1500)));
  }
  betTimers.push(setTimeout(hidePokerBet, d.sec * 1000));
});

// ショーダウン：ポーカー場のテーブルに席を並べて、最下位から順にカードをめくる
let sdTimers = [];
function renderShowdown(sd) {
  const box = $('showdown');
  sdTimers.forEach(clearTimeout); sdTimers = [];
  box.hidden = !sd;
  if (!sd) return;
  const n = sd.length, oval = n <= 6 && innerWidth >= 760;
  const seat = (x, i) => {
    const ang = Math.PI / 2 + i * 2 * Math.PI / n;
    const style = oval ? `--x:${(50 + 40 * Math.cos(ang)).toFixed(1)}%;--y:${(50 + 38 * Math.sin(ang)).toFixed(1)}%` : '';
    return `<div class="pk-seat" data-k="${i}" style="${style}">
      <div class="pk-plate">${avatarImg(x.avatar, 'avatar sm')}<span>${esc(x.name)}</span></div>
      <div class="pk-seat-cards">${x.hand.map(c => pokerCard(c, { sm: true, down: true })).join('') || '<small class="pk-empty">カードなし</small>'}</div>
      <div class="pk-seat-hand" hidden><b>${esc(x.handName)}</b><small>基本 ${x.base} ＋ 役 ${x.handBonus} ＋ 保管${x.keptCards.length}枚 ${x.keptBonus} ＝</small><strong>${x.total}点</strong></div></div>`;
  };
  box.innerHTML = `<div class="pk-table${oval ? '' : ' list'}"><div class="pk-felt-title"><span>SHOWDOWN</span><em id="pkWinner">いざ、オープン…</em><div class="pk-chips" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div>${sd.map(seat).join('')}</div>`;
  const seats = [...box.querySelectorAll('.pk-seat')];
  [...sd.keys()].reverse().forEach((k, step) => {
    sdTimers.push(setTimeout(() => {
      const el = seats[k];
      el.querySelectorAll('.pk-card').forEach((c, ci) => setTimeout(() => { c.classList.remove('facedown'); c.classList.add('flip'); if (sd[k].used.includes(c.dataset.id)) c.classList.add('used'); }, ci * 160));
      setTimeout(() => { el.querySelector('.pk-seat-hand').hidden = false; el.classList.add('opened'); }, 5 * 160 + 200);
      if (k === 0) setTimeout(() => {
        el.classList.add('winner'); $('pkWinner').textContent = `👑 ${sd[0].name}　${sd[0].handName}`;
        charFx.cutin('WINNER！', `${sd[0].name}　${sd[0].handName}`, 'celebrate');
      }, 5 * 160 + 900);
    }, 800 + step * 2200));
  });
}


// ── アニソン激アツRUSH：保留ランプ・自分のRUSH・リーチ・大当たり ──
const RUSH_LABEL = { blue: '青', green: '緑', red: '赤', gold: '金', rainbow: '虹' };
// RUSH専用キャラ：通常中の確率変動（状態0〜3）でキャラが入れ替わる。モードが進むと「そのときのキャラ」で衣装が変わる（通常服→巫女服→浴衣→ステージ衣装→白い清楚な服）
const RUSH_CHARAS = [
  { id: 'runa', name: 'ルナ', say: ['今日は当たるかな？', 'ドキドキするね！', 'リーチ来い〜！'], lines: { chance: 'ふふっ、チャンスだよ！', rush: 'わーい！大当たりだー！', super: 'すっごーい！超RUSHだよ！！', heaven: 'えへへ、天国だぁ♪' } },
  { id: 'mikoto', name: 'ミコト', say: ['…気配がします', '流れが来ています', '落ち着いて…'], lines: { chance: '…チャンス、来ましたね', rush: 'これが…大当たり、ですね', super: '力が…あふれます…！', heaven: 'ふふ…とても穏やかです' } },
  { id: 'hinata', name: 'ヒナタ', say: ['いっけぇー！', 'もっともっと！', 'この調子っ！'], lines: { chance: 'チャンスだ！いくよー！', rush: '大当たりだー！！', super: '超RUSHだーっ！！最高ー！！', heaven: 'やったね！天国だよ〜♪' } },
  { id: 'miyabi', name: 'ミヤビ', say: ['ふふっ、いい調子ですよ', 'ゆったり楽しみましょう', 'とっても素敵です♪'], lines: { chance: 'あら、チャンスですね', rush: 'まあ、大当たりですよ♪', super: '素晴らしい…超RUSHです！', heaven: 'ふふっ、天国ですよ♪' } },
];
let raySayTimer = null, rushCurChara = null;
function rushSay(text, ms = 2600, expr = 'joy') {
  const s = $('rushSay'); if (!text) { s.hidden = true; return; }
  if (rushCurChara) $('rushSayFace').src = `assets/rush/face/${rushCurChara.id}-${expr}.webp`;
  $('rushSayText').textContent = text; s.hidden = false; clearTimeout(raySayTimer); raySayTimer = setTimeout(() => { s.hidden = true; }, ms);
}
const MODE_VIEW = {
  normal: { label: 'NORMAL', sub: 'リーチを狙え', enter: '' },
  chance: { label: 'CHANCE', sub: '連続正解のチャンス！ 当たれば大きい', enter: 'チャンス突入！' },
  rush: { label: 'RUSH', sub: '大当たり継続中！ 当てるほど加速', enter: 'RUSH突入！' },
  super: { label: 'SUPER RUSH', sub: '超RUSH！ 倍率MAX級', enter: '超RUSH突入！！' },
  heaven: { label: 'HEAVEN', sub: '天国モード：1回だけミスOK', enter: '天国モード！' },
};
// 予兆（あたるかも？）：サーバーがイントロの間に順番に送る。強さ lv 1〜3。当たりかどうかは分からない（ガセもある）
const OMEN_TEXT = { flash: ['ん？', 'あれ…？', 'きた…？'], voice: ['なんか来そう…', 'ドキドキする…', 'ざわ…ざわ…'], ripple: ['…！'], shake: ['揺れた！？', 'これは…！'], redout: ['赤い…！', '熱くなってきた！'], lightning: ['激アツ！！', 'きたきたきた！'], group: ['みんな集まってきた！', '群予告！！'], rainbow: ['虹色の光が…！', '全回転の予感！！'] };
let omenTimer = null;
socket.on('rushOmen', ({ kind, lv, step }) => {
  if (!document.body.classList.contains('rush-machine')) return;
  const fx = $('omenFx'), q = $('quiz');
  fx.className = ''; void fx.offsetWidth; // 前の予兆を切って、もう一度動かす
  fx.classList.add('omen', 'omen-' + kind, 'omen-lv' + lv);
  if (kind === 'shake' || kind === 'lightning') { document.body.classList.remove('omen-shake'); void document.body.offsetWidth; document.body.classList.add('omen-shake'); }
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const text = kind === 'step' ? `STEP ${step}${step === 3 ? '！！' : ' ▶'}` : pick(OMEN_TEXT[kind] || OMEN_TEXT.voice);
  $('omenText').textContent = text; $('omenText').dataset.lv = lv; $('omenText').hidden = false;
  rushSay(text, 2200, lv >= 3 ? 'excited' : lv === 2 ? 'surprise' : 'smug');
  if (lv >= 3) charFx.cutin(kind === 'group' ? '群予告！' : kind === 'rainbow' ? '全回転の予感…' : '激アツ！', text, 'cutin');
  clearTimeout(omenTimer); omenTimer = setTimeout(() => { $('omenText').hidden = true; fx.className = ''; document.body.classList.remove('omen-shake'); }, 1800);
});
function renderRush(r, mine) {
  const on = r.settings?.play === 'rush' && r.state === 'playing' && !!r.rush;
  $('rushBar').hidden = !on;
  document.body.classList.toggle('rush-on', !!(on && mine?.rush)); // 自分がRUSH中は画面が燃える
  document.body.classList.toggle('rush-machine', on); // RUSH専用の台の見た目（背景・枠・ランプ）
  $('rushMarquee').hidden = !on;
  if (!on) { delete document.body.dataset.rushMode; $('rushChara').hidden = true; $('rushCharaImg').removeAttribute('data-id'); $('rushCharaImg').removeAttribute('data-key'); return; }
  const mode = mine?.rush?.mode || 'normal'; // 背景・電飾・マーキーはモードで変わる（リーチ中は body.rush-reach で「チャンス」の背景）
  document.body.dataset.rushMode = mode;
  // 通常中は、いまの問題の「状態」のキャラ。モード中は、突入したときのキャラのまま、モードに合った衣装
  const ch = RUSH_CHARAS[Math.max(0, Math.min(3, mine?.rush ? (mine.rush.chara || 0) : (r.rush.state || 0)))];
  rushCurChara = ch;
  $('rushChara').hidden = false;
  const key = ch.id + '-' + mode;
  if ($('rushCharaImg').dataset.key !== key) {
    const sameChara = $('rushCharaImg').dataset.id === ch.id;
    $('rushCharaImg').src = `assets/rush/chara/${key}.webp`; $('rushCharaImg').dataset.key = key; $('rushCharaImg').dataset.id = ch.id; $('rushCharaName').textContent = ch.name;
    $('rushChara').classList.remove('swap', 'outfit'); void $('rushChara').offsetWidth; $('rushChara').classList.add(sameChara ? 'outfit' : 'swap');
  }
  $('rushMode').textContent = MODE_VIEW[mode].label;
  $('rushModeSub').textContent = MODE_VIEW[mode].sub;
  $('rushNow').dataset.color = r.rush.color || 'blue';
  $('rushNow').textContent = `保留 ${RUSH_LABEL[r.rush.color] || ''}`;
  $('rushNext').innerHTML = (r.rush.next || []).map(c => `<i data-color="${c}" title="${RUSH_LABEL[c]}"></i>`).join('');
  $('rushMe').hidden = !mine?.rush;
  if (mine?.rush) $('rushMe').textContent = `🔥 ${MODE_VIEW[mine.rush.mode]?.label || 'RUSH'} ×${mine.rush.mult}（あと${mine.rush.left}問）`;
}
// リーチ：当たりの問題は、サビに入るところで知らされる
socket.on('rushReach', ({ color, again }) => {
  document.body.classList.add('rush-reach');
  if (!again) { charFx.cutin('リーチ！', color === 'rainbow' ? '全回転！ 当てれば大当たり' : 'ここで当てれば大当たり！', 'cutin'); charFx.say('chorus'); }
});

// ── 3つ埋めバトル：枠の表示・押した人の回答（枠を選ぶ → 書く／10択）・間違えたあと押せない時間・パス ──
let fillLockUntil = 0, fillSlot = null, fillLockTick = null, fillWaiting = false;
// 連続解答なし：ほかに押せる人（つながっていて、パスしていない人）がいる間は待つ
// （チーム戦は、お手つきをチームで共有するので、同じチームの人は数えない）
const othersCanBuzz = () => {
  const myTeam = room?.settings?.teams ? room.players.find(p => p.id === me)?.team : null;
  return (room?.players || []).some(p => p.id !== me && p.connected && p.inGame && !p.passed && (!myTeam || p.team !== myTeam));
};
const fillLocked = () => !!question?.fill && (performance.now() < fillLockUntil || (fillWaiting && othersCanBuzz()));
function renderFill(slots) {
  $('fillBox').hidden = !slots;
  if (!slots) return;
  const holderMine = buzzHolder === me && !$('fillAnswer').hidden;
  $('fillSlots').innerHTML = slots.map(f => `<button type="button" class="fill-slot${f.by != null ? ' done' : ''}${fillSlot === f.key ? ' on' : ''}" data-slot="${f.key}"
    ${holderMine && f.by == null ? '' : 'disabled'}><small>${esc(f.label)}${f.peeked && f.by == null ? '<i class="fill-peeked">10択のみ</i>' : ''}</small><b>${f.by != null ? esc(f.given) : '？'}</b>${f.by != null ? `<em>${f.team ? `<span class="team-tag team-${f.team}">${TEAM_LABEL[f.team]}</span> ` : ''}${esc(f.by)}</em>` : ''}</button>`).join('');
}
const fillSlots = () => room?.fill || question?.fill || [];
function openFillAnswer() {
  fillSlot = null;
  $('fillAnswer').hidden = false; $('fillForm').hidden = true; $('fillChoiceBtn').hidden = true; $('fillChoices').innerHTML = '';
  const open = fillSlots().filter(f => f.by == null);
  $('fillHead').textContent = 'どの枠に答える？（下の枠を選んでね）';
  renderFill(fillSlots());
  if (open.length === 1) chooseFillSlot(open[0].key); // 残り1つなら選ぶ手間を省く
}
function chooseFillSlot(key) {
  const f = fillSlots().find(x => x.key === key);
  if (!f || f.by != null) return;
  fillSlot = key;
  renderFill(fillSlots());
  if (f.peeked) return showFillChoices(f); // 10択がもう出た枠は、手で打てない（10択だけ）
  $('fillHead').textContent = `「${f.label}」を書いて答えよう`;
  $('fillForm').hidden = false; $('fillInput').value = ''; $('fillInput').placeholder = `${f.label}を入力`; $('fillInput').focus();
  $('fillChoiceBtn').hidden = false; $('fillChoices').innerHTML = '';
}
// 10択を出す。出したら、その枠はもう手で打てない（自分もほかの人も）
function showFillChoices(f) {
  $('fillForm').hidden = true; $('fillChoiceBtn').hidden = true;
  $('fillHead').textContent = `「${f.label}」を10択で選ぼう（点数は半分・もう手では打てません）`;
  const removed = new Set(f.removed || []); // お手つきで消えた選択肢は出さない（番号はそのまま）
  $('fillChoices').innerHTML = f.choices.map((c, i) => removed.has(i) ? '' : `<button class="choice" type="button" data-i="${i}">${esc(c)}</button>`).join('');
}
$('fillSlots').onclick = e => { const b = e.target.closest('button[data-slot]'); if (b && !b.disabled) chooseFillSlot(b.dataset.slot); };
$('fillChoiceBtn').onclick = () => {
  const f = fillSlots().find(x => x.key === fillSlot);
  if (!f) return;
  socket.emit('fillChoices', f.key); // 出た10択を記録（パスの下の左側）。この枠はもう手で打てなくなる
  showFillChoices(f);
};
$('fillChoices').onclick = e => {
  const b = e.target.closest('button[data-i]');
  if (!b || !fillSlot) return;
  socket.emit('answer', { slot: fillSlot, index: +b.dataset.i });
  $('fillAnswer').hidden = true;
};
let fillComposing = false, fillComposeEnd = 0;
$('fillInput').addEventListener('compositionstart', () => { fillComposing = true; });
$('fillInput').addEventListener('compositionend', () => { fillComposing = false; fillComposeEnd = performance.now(); });
$('fillForm').onsubmit = e => {
  e.preventDefault();
  if (fillComposing || performance.now() - fillComposeEnd < 80) return; // 日本語変換の確定で送らない
  const text = $('fillInput').value.trim();
  if (!text || !fillSlot) return;
  socket.emit('answer', { slot: fillSlot, text });
  $('fillForm').hidden = true;
};
// 誰かが答えた（正解・お手つき）
socket.on('fillResult', ({ id, name, label, given, correct, choice, points }) => {
  const mine = id === me;
  if (correct) {
    cue(`${mine ? 'あなた' : name}：${label} 正解！`, 'fx-burst');
    if (mine) { flash('ok', `${label} 正解！`, `+${points}${choice ? '（10択）' : ''}`); confetti(20); }
  } else if (mine) flash('ng', 'お手つき', `${points}`);
  else cue(`${name}：お手つき`, 'fx-burst');
});
// 自分が間違えた：少しの間だけ押せない
socket.on('fillLock', ({ sec, wait = false, by = null }) => {
  fillLockUntil = performance.now() + sec * 1000; fillWaiting = wait;
  if (by) cue(`${by}：チームのお手つき`, 'fx-burst'); // チーム戦：仲間が間違えたので自分も押せない
  $('buzzBtn').disabled = true;
  clearInterval(fillLockTick);
  fillLockTick = setInterval(() => {
    const left = (fillLockUntil - performance.now()) / 1000;
    if (!question?.fill) { clearInterval(fillLockTick); return; }
    if (!fillLocked()) { clearInterval(fillLockTick); if (buzzOpen) $('buzzBtn').disabled = false; if (!buzzHolder) $('buzzInfo').textContent = ''; return; }
    $('buzzBtn').disabled = true;
    const others = room?.settings?.teams ? 'ほかのチーム' : 'ほかの人';
    if (!buzzHolder) $('buzzInfo').textContent = left > 0 ? `お手つき：あと ${left.toFixed(1)} 秒押せません${fillWaiting ? `（そのあとも、${others}が押すまで待ち）` : ''}` : `お手つき：${others}が押すまで押せません`;
  }, 100);
});
// 連続解答なし：ほかの人が押したので、また押せる（秒数の制限が残っていればそれまで）
socket.on('fillWaitEnd', () => { fillWaiting = false; });

// ── 出題者モード：順番に1人が収録曲から曲を選ぶ（ほかの人は待つ） ──
let pickTick = null, pickCatalog = null;
socket.on('picking', async ({ id, name, sec, qNo, qTotal }) => {
  question = null; myAnswer = null; answering = false; stopTick();
  document.body.classList.remove('revealing', 'playing');
  show('quiz');
  $('choices').innerHTML = ''; $('clues').innerHTML = ''; $('inputForm').hidden = true; $('buzzRow').hidden = true; $('lifelines').hidden = true;
  $('qlog').hidden = true; $('fillBox').hidden = true;
  $('quizNote').textContent = '';
  $('qno').textContent = `第 ${qNo} / ${qTotal} 問`; $('timer').textContent = ''; $('barFill').style.width = '0';
  const mine = id === me, until = performance.now() + sec * 1000;
  setPhase('ready', mine ? 'あなたが出題者！ 曲を選んでね' : `${name} さんが曲を選んでいます…`);
  $('pickPanel').hidden = false; $('pickSearch').hidden = !mine;
  const tickHead = () => { $('pickHead').textContent = `${mine ? 'みんなが「分かりそうで分からない」曲を選ぼう（半分くらい正解で最高点）' : `${name} さんが出題する曲を選んでいます`}… 残り ${Math.max(0, Math.ceil((until - performance.now()) / 1000))} 秒`; };
  clearInterval(pickTick); tickHead(); pickTick = setInterval(tickHead, 250);
  if (mine) {
    if (!pickCatalog) { try { pickCatalog = (await fetch('/api/catalog').then(x => x.json())).songs; } catch (e) { pickCatalog = []; } }
    $('pickInput').value = ''; renderPickList(); $('pickInput').focus();
  }
  renderBingo(); renderCoop();
});
function renderPickList() {
  const q = $('pickInput').value.trim().toLowerCase();
  const list = (pickCatalog || []).filter(s => !q || `${s.title} ${s.work} ${s.artist}`.toLowerCase().includes(q)).slice(0, 40);
  $('pickList').innerHTML = list.map(s => `<li><button class="btn-sub" type="button" data-id="${esc(s.id)}"><b>${esc(s.title)}</b><small>${esc(s.work)}／${esc(s.artist)}（${s.year}）</small></button></li>`).join('')
    || '<li class="note">見つかりませんでした</li>';
}
$('pickInput').oninput = () => { clearTimeout(renderPickList.t); renderPickList.t = setTimeout(renderPickList, 150); };
$('pickList').onclick = e => { const b = e.target.closest('button[data-id]'); if (b) { socket.emit('pickSong', b.dataset.id); $('pickSearch').hidden = true; $('pickHead').textContent = '選びました！'; } };
$('pickRandom').onclick = () => { socket.emit('pickSong', null); $('pickSearch').hidden = true; };

// ── ビンゴ：自分のカード（4×4）。開いたマスは色がつく ──
function renderBingo() {
  const mineCard = room?.settings?.play === 'bingo' && room.state === 'playing' ? room.players.find(p => p.id === me)?.card : null;
  $('bingoBox').hidden = !mineCard;
  if (!mineCard) return;
  $('bingoCard').innerHTML = mineCard.map(c => `<span class="${c.open ? 'open' : ''}${c.w === 'FREE' ? ' free' : ''}">${esc(c.w)}</span>`).join('');
}
// ── 協力：みんなの正解数と目標 ──
function renderCoop() {
  const c = room?.state === 'playing' ? room.coop : null;
  $('coopBar').hidden = !c;
  if (!c) return;
  $('coopText').textContent = `みんなの正解 ${c.count} ／ 目標 ${c.goal}${c.count >= c.goal ? '　達成！' : ''}`;
  $('coopFill').style.width = Math.min(100, c.count / c.goal * 100) + '%';
}

// 再接続したとき、すでに答えていた問題の表示を戻す
socket.on('answered', a => markAnswered(a));

// payload: { index } / { text } / { pass: true }
function answer(payload) {
  if (myAnswer !== null || !(answering || (buzzOpen && payload.pass))) return; // 早押しで押す前でも「この問題は押さない（パス）」はできる
  if (practice) layoutApi.onAnswer(payload); else socket.emit('answer', payload);
  markAnswered(payload);
}
function markAnswered({ index = null, text = null, given = null, pass = false }) {
  myAnswer = pass ? 'pass' : index ?? (text ?? given);
  answering = false; buzzOpen = false; $('buzzBtn').disabled = true;
  $('choices').querySelectorAll('.choice').forEach(b => {
    b.disabled = true;
    if (index !== null && +b.dataset.i === index) b.classList.add('mine');
  });
  $('answerInput').disabled = true; $('sendBtn').disabled = true;
  if (text ?? given) $('answerInput').value = text ?? given;
  $('quizNote').textContent = pass ? 'パスしました。全員がそろうと答え合わせです…' : '回答しました。答え合わせを待っています…';
  updateLifelineButtons();
}

// 入力で回答。日本語変換の確定（Enter）で送信されないようにする
let composing = false, compositionEndedAt = 0;
$('answerInput').addEventListener('compositionstart', () => { composing = true; });
$('answerInput').addEventListener('compositionend', () => { composing = false; compositionEndedAt = performance.now(); });
$('inputForm').onsubmit = e => {
  e.preventDefault();
  if (composing || performance.now() - compositionEndedAt < 80) return; // Safari は確定直後に submit が来る
  const text = $('answerInput').value.trim();
  if (!text) return;
  answer({ text });
};
$('passBtn').onclick = () => {
  if (!question?.fill) return answer({ pass: true });
  // 3つ埋めバトル：押して答えている最中は「わからない」（お手つき）。それ以外は「もう終わってOK」の合図（押せば取り消し）
  if (buzzHolder === me) { socket.emit('answer', { pass: true }); $('fillAnswer').hidden = true; return; }
  const passed = room?.players?.find(p => p.id === me)?.passed;
  socket.emit('fillPass', !passed);
};

// ── 時間で増えるヒント ──
socket.on('clue', c => {
  if ([...$('clues').children].some(li => li.dataset.level === String(c.level))) return;
  const li = document.createElement('li');
  li.dataset.level = c.level;
  li.innerHTML = `<b>ヒント${c.level}</b>${esc(c.text)}`;
  $('clues').appendChild(li);
});

// ── ライフライン ──
const LIFE_LABEL = { fifty: '50:50', audience: 'オーディエンス', phone: 'テレフォン', replay: 'もう一度聴く' };
$('lifelines').querySelectorAll('[data-life]').forEach(b => b.onclick = () => {
  if (!answering) return;
  b.disabled = true;
  socket.emit('lifeline', { type: b.dataset.life });
});
function updateLifelineButtons() {
  $('lifelines').querySelectorAll('[data-life]').forEach(b => {
    const left = myLifelines?.[b.dataset.life] || 0;
    b.disabled = !answering || left <= 0;
    b.hidden = !room?.settings.lifelines;
  });
  $('passBtn').disabled = !(answering || buzzOpen);
  if (question?.fill) {
    // 3つ埋めバトル：曲が流れている間はいつでもパス（取り消し）できる
    const passed = room?.players?.find(p => p.id === me)?.passed;
    const playing = ['intro', 'chorus'].includes(room?.phase) && !amOut();
    $('passBtn').disabled = !playing || (!!buzzHolder && buzzHolder !== me);
    $('passBtn').lastChild.textContent = buzzHolder === me ? 'わからない（−200）' : passed ? 'パスを取り消す' : 'パス（全員パスで次へ）';
  } else if ($('passBtn').lastChild.textContent !== 'わからない（パス）') $('passBtn').lastChild.textContent = 'わからない（パス）';
}
socket.on('lifelineResult', r => {
  let text = '';
  if (r.type === 'fifty') {
    if (r.hidden) {
      $('choices').querySelectorAll('.choice').forEach(b => {
        if (r.hidden.includes(+b.dataset.i)) { b.classList.add('gone'); b.disabled = true; }
      });
      text = '不正解の選択肢を半分消しました';
    } else {
      text = `曲名は ${r.length} 文字、最初の文字は「${r.first}」`;
    }
  } else if (r.type === 'audience') {
    if (r.answered === 0) text = 'まだ誰も答えていません';
    else if (r.counts) {
      $('choices').querySelectorAll('.choice').forEach(b => {
        const n = r.counts[+b.dataset.i];
        b.querySelector('small.count')?.remove();
        if (n) b.insertAdjacentHTML('beforeend', `<small class="count">👥 ${n}人</small>`);
      });
      text = `ここまでに ${r.answered} 人が回答しています（選択肢に人数を表示）`;
    } else {
      text = `ここまでに ${r.answered} 人が回答して、${r.correct} 人が正解`;
    }
  } else if (r.type === 'phone') {
    text = `📞 ${r.text}`;
  } else if (r.type === 'replay') {
    player.replay(r.intro, question.settings.introLen);
    text = 'イントロをもう一度流しています';
  }
  const li = document.createElement('li');
  li.textContent = `${LIFE_LABEL[r.type]}：${text}`;
  $('lifeResults').appendChild(li);
});

// ── 答え合わせ ──
socket.on('promoted', p => toast(`${p.by}さんが「${p.title}」をゲームデータに入れる候補にしました（${p.votes}人）`));

socket.on('reveal', r => {
  player.setRate(1);
  stopTick(); if (clearBuzz()) player.resume(); buzzOpen = false; $('buzzBtn').disabled = true;
  if (!practice) { // テスト1問は曲ログ・端末の記録に残さない
    if (Array.isArray(r.log)) playLog = r.log; // サーバーが持っている「ここまでの曲」
    if (r.song?.id && !room?.settings?.noRecord) rememberIds([r.song.id]); // 「除外に追加しない」のときは端末にも記録しない
    else if (question?.qNo && r.song) playLog[question.qNo - 1] = r.song;
  }
  answering = false; updateLifelineButtons();
  $('answerInput').disabled = true; $('sendBtn').disabled = true;
  setPhase('reveal', '答え合わせ');
  $('cover').innerHTML = icon('note', 'cover-icon'); stageMascot(null);
  document.body.classList.remove('playing'); document.body.classList.add('revealing'); // 背景全体に映像を出す
  $('timer').textContent = ''; $('barFill').style.width = '0'; // 問題の残り時間は消す（自動で進むときは「次の問題まで」を出す）
  setCompact(true);
  // サビの位置が仮（イントロ＋50秒）の曲は、動画の長さから推定した位置にする
  const unknown = r.chorusKnown === false || (r.chorusKnown === undefined && r.chorus === r.intro + 50);
  // サビまで流れていたらそのまま流し続ける。イントロのうちに答え合わせになったらサビへ移動（サビ前問題は流れのまま）
  player.reveal(r.intro, unknown ? guessChorus(r.intro, player.duration()) : r.chorus, !hintSeen && question?.kind !== 'sabimae');
  // だれがどの選択肢を押したか（アバターと名前を選択肢の中に出す）
  const pickers = new Map();
  for (const x of r.results) if (Number.isInteger(x.index) && !x.pass) pickers.set(x.index, [...(pickers.get(x.index) || []), x]);
  $('choices').querySelectorAll('.choice').forEach(b => {
    b.disabled = true;
    const i = +b.dataset.i, who = pickers.get(i);
    if (i === r.correctIndex) b.classList.add('correct');
    else if (i === myAnswer) b.classList.add('wrong');
    else if (who) b.classList.add('wrong-other'); // ほかの人が選んだ不正解
    if (who) {
      b.classList.add('picked');
      b.insertAdjacentHTML('beforeend', `<span class="pickers">${who.map(x =>
        `<span class="picker${x.id === me ? ' me' : ''}">${avatarImg(x.avatar, 'avatar xs')}${esc(x.name)}</span>`).join('')}</span>`);
    }
  });
  if (Array.isArray(r.qlog)) { qlogEntries = r.qlog; renderQlog(); } // 答え合わせ：全員の答えと正解かどうか
  if (r.fill) { // 3つ埋めバトル：枠ごとの正解と、埋めた人
    $('fillAnswer').hidden = true; fillSlot = null;
    $('fillSlots').innerHTML = r.fill.map(f => `<div class="fill-slot ${f.by != null ? 'done' : 'missed'}"><small>${esc(f.label)}</small><b>${esc(f.answer)}</b><em>${f.by != null ? esc(f.by) : '誰も埋められず'}</em></div>`).join('');
  }
  const s = r.song;
  $('answer').innerHTML =`${esc(s.title)}<small>${s.work === 'ボカロ（プロセカ）' ? `プロセカ書き下ろし ボカロ／作曲：${esc(s.artist)}` : `${esc(s.work)} ${esc(s.type || '')}／${esc(s.artist)}`}（${s.year}）</small>`
    + (s.staged ? '<button class="btn-main promote-btn" id="promoteBtn" type="button">✅ これはゲームデータに入れる</button><small class="promote-note">お試し中の曲です。押すと、ふだんの出題に入れる候補になります</small>' : '')
    + (s.id ? `<div class="song-tools"><button class="btn-sub" id="copySongBtn">📋 この曲をコピー</button>`
      + `<button class="btn-sub" id="keepSongBtn">${keptIds().has(s.id) ? '✓ 除外しない曲' : '🔁 この曲は除外しない'}</button>`
      + `<button class="btn-sub" id="fixToggle">🛠 修正を依頼${fixes()[s.id] ? '（位置は直し済み）' : ''}</button></div>`
      + `<div class="song-tools me-tools" id="meTools"></div><div class="fix-panel" id="fixPanel" hidden></div>` : '');
  if (s.id) { setupSongTools(s, r); renderMeTools(s); }
  if (s.staged) $('promoteBtn').onclick = () => { socket.emit('promote', s.id); $('promoteBtn').disabled = true; $('promoteBtn').textContent = '✅ 入れる候補にしました'; };
  $('results').innerHTML = r.results.map(x => `
    <tr>
      <td class="who">${avatarImg(x.avatar, 'avatar sm')}${esc(x.name)}</td>
      <td class="${x.correct || x.points > 0 ? 'ok' : 'ng'}">${!x.answered ? '未回答' : x.pass ? 'スキップ' : x.correct ? '正解' + (x.hint ? '（サビ）' : '') : x.miss ? 'お手つき' : x.diff != null ? `${x.diff}年ずれ` : '不正解'}${x.out && (r.eliminated || []).includes(x.name) ? '<small>脱落</small>' : x.lives != null && !x.out ? `<small>${'♥'.repeat(x.lives)}</small>` : ''}${x.given ? `<small>「${esc(x.given)}」</small>` : ''}${!x.correct && Number.isInteger(x.index) && question?.choices?.[x.index] ? `<small>「${esc(question.choices[x.index].title)}」を選択</small>` : ''}</td>
      <td class="num">${x.elapsed === null ? '' : x.elapsed.toFixed(2) + '秒'}</td>
      <td class="num">${x.points < 0 ? x.points : '+' + x.points}${x.rush?.mult > 1 ? `<small class="rush-x">×${x.rush.mult}</small>` : ''}${x.rush?.jackpot ? '<small class="rush-x">大当たり</small>' : ''}</td>
    </tr>`).join('');
  // 自分の結果を大きく表示
  const mine = r.results.find(x => x.id === me);
  if (mine) {
    if (mine.correct) { flash('ok', '正解！', `+${mine.points}`); confetti(40); }
    else if ((r.eliminated || []).includes(mine.name)) flash('ng', '脱落…');
    else if (mine.miss) flash('ng', 'お手つき', `${mine.points}`);
    else if (mine.diff != null && mine.points > 0) flash('ok', `${mine.diff}年ずれ`, `+${mine.points}`);
    else if (mine.pass) flash('ng', 'スキップ');
    else if (!mine.answered) flash('ng', '時間切れ');
    else flash('ng', '不正解');
  }
  // キャラのセリフ：みんなの結果 → 自分の結果。少しあとで順位のこと
  if (r.results.length > 1 && r.results.every(x => x.correct)) charFx.say('allok');
  else if (r.results.length > 1 && r.results.every(x => !x.correct)) charFx.say('allng');
  else if (mine?.correct && mine.elapsed != null && mine.elapsed < 3) charFx.say('fast', { sec: mine.elapsed.toFixed(1) });
  else if (mine) charFx.say(mine.correct ? 'ok' : mine.pass ? 'pass' : !mine.answered ? 'timeout' : 'ng');
  if (!practice) setTimeout(talkRanking, 2600);
  // ビンゴ：そろった人がいたらカットイン
  if ((r.bingoBonus || []).length) setTimeout(() => charFx.cutin(r.bingoBonus.some(b => b.first) ? 'BINGO!' : 'もう1列！', r.bingoBonus.map(b => `${b.name} +${b.bonus}点`).join('・'), 'celebrate'), 600);
  else if ((r.reach || []).length) setTimeout(() => charFx.cutin('リーチ！', r.reach.join('・'), 'cutin'), 600); // あと1マスでそろう列ができた
  document.body.classList.remove('rush-reach');
  // 激アツRUSH：大当たり・RUSH終了
  if (r.poker?.card) {
    const mineGain = r.poker.gains?.find(g => g.id === me);
    if (mineGain) setTimeout(() => { toast(`🃏 「${r.poker.card.seriesLabel}」のカードを引いた${mineGain.bonus ? '！ いちばん早い正解のボーナスで、もう1枚！' : ''}`); if (mineGain.bonus) charFx.cutin('ボーナスカード！', 'いちばん早い正解', 'celebrate'); }, 600);
    else if (r.poker.fastest) setTimeout(() => toast(`${r.poker.fastest}さんが、いちばん早い正解（ボーナスカード）`), 600);
  }
  const myRush = r.results?.find(x => x.id === me)?.rush;
  if (myRush?.entered && rushCurChara?.lines?.[myRush.entered]) setTimeout(() => rushSay(rushCurChara.lines[myRush.entered], 3500, 'joy'), 1500);
  else if (r.rush?.jackpot?.length && rushCurChara) setTimeout(() => rushSay('やったー！ 大当たり！', 3000, 'joy'), 1500);
  else if (r.rush?.hit && rushCurChara) setTimeout(() => rushSay('あぁ…惜しかった…', 3000, 'sad'), 1500);
  else if (myRush?.ended && rushCurChara) setTimeout(() => rushSay('終わっちゃった…', 3000, 'sad'), 1500);
  if (myRush?.entered && MODE_VIEW[myRush.entered]) setTimeout(() => { charFx.cutin(MODE_VIEW[myRush.entered].enter, MODE_VIEW[myRush.entered].sub, 'celebrate'); confetti(myRush.entered === 'super' ? 120 : 60); }, myRush.jackpot ? 1900 : 700);
  if (r.rush?.jackpot?.length) setTimeout(() => { charFx.cutin('大当たり！', r.rush.jackpot.join('・') + ' ボーナス！', 'celebrate'); confetti(60); }, 500);
  else if (r.rush?.hit) setTimeout(() => flash('ng', 'ハズレ…', '当たりの問題でした'), 400);
  for (const e of r.rush?.ended || []) if (e.name === room?.players?.find(p => p.id === me)?.name) setTimeout(() => flash(e.done ? 'ok' : 'ng', e.done ? 'RUSH完走！' : 'RUSH終了', `連チャン・点`), 1400);
  if (r.picker?.id === me) flash('ok', '出題者ボーナス', `+${r.picker.points}（${r.picker.of}人中 ${r.picker.correct}人正解）`);
  $('nextBtn').textContent = r.last ? '結果発表へ' : '次の問題へ';
  $('highlights').innerHTML = (r.highlights || []).map(h => `<li>${esc(h)}</li>`).join('');
  // 自動で次へ進むまでのカウント（ホストは「次へ」で早送りできる）
  clearInterval(nextTick); $('nextCount').textContent = ''; listenBy = '';
  $('listenBtn').hidden = !(r.autoNext > 0); $('listenBtn').disabled = false; $('listenBtn').textContent = '♪ サビを聞く（10秒）';
  if (r.autoNext > 0) startNextCount(r.autoNext, r.last);
  // 選択肢を見せたまま結果を下に出す
  $('quiz').hidden = false; $('result').hidden = false;
});

// 惜しい：回答にはならないので、打ち直せるように戻す
socket.on('almost', ({ text, left, slot }) => {
  if (question?.fill) { // 3つ埋めバトル：同じ枠でもう一度書ける
    fillSlot = slot; $('fillForm').hidden = false; $('fillInput').value = text; $('fillInput').select();
    $('fillHead').textContent = `惜しい！ もう一度（あと${left + 1}回まで）`; flash('ng', '惜しい！');
    return;
  }
  myAnswer = null; answering = true;
  $('answerInput').disabled = false; $('sendBtn').disabled = false;
  $('answerInput').value = text; $('answerInput').select();
  $('quizNote').textContent = `惜しい！ もう一度（あと${left + 1}回まで）`;
  flash('ng', '惜しい！');
});
// 誰かがスタンプを押した：画面の中央から「アイコン＋名前＋スタンプ」が浮き上がり、放物線を描いて落ちる
socket.on('react', ({ id, name, kind }) => {
  const avatar = room?.players?.find(p => p.id === id)?.avatar;
  const el = document.createElement('div');
  el.className = 'react-pop';
  el.innerHTML = `${avatarImg(avatar, 'avatar sm')}<span>${esc(name)}</span><b>${esc(kind)}</b>`;
  document.body.appendChild(el);
  const dx = (Math.random() * 2 - 1) * Math.min(innerWidth * 0.3, 260); // 同時に押されても重ならないよう左右に散らす
  const rot = dx / 20;
  el.animate([
    { transform: 'translate(-50%, -50%) scale(.5)', opacity: 0, offset: 0 },
    { transform: `translate(calc(-50% + ${dx * 0.25}px), calc(-50% - 16vh)) scale(1.1) rotate(${rot * 0.3}deg)`, opacity: 1, offset: 0.25, easing: 'ease-in' },
    { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% - 19vh)) scale(1) rotate(${rot * 0.5}deg)`, opacity: 1, offset: 0.4, easing: 'ease-in' },
    { transform: `translate(calc(-50% + ${dx}px), calc(-50% + 60vh)) scale(.9) rotate(${rot}deg)`, opacity: 0, offset: 1 },
  ], { duration: 2500, easing: 'linear', fill: 'forwards' });
  setTimeout(() => el.remove(), 2600);
});

socket.on('gameover', ({ ranking, titles = [], log, roomLog: rl, total, teams, survival, coop, bingo, showdown }) => {
  hidePokerBet(); hideWolf(); hideDixit(); hideDt(); hideBaba(); hideCn(); hideDf(); hideWw(); hideKm(); hideAz(); renderShowdown(showdown);
  pokerHandData = { hand: [], over: false, usedIds: [], kept: [] }; pokerDrop.clear();
  $('pickPanel').hidden = true; clearInterval(pickTick); $('coopBar').hidden = true; $('bingoBox').hidden = true;
  if (Array.isArray(log)) playLog = log;
  if (Array.isArray(rl)) roomLog = rl;
  clearInterval(nextTick); $('nextCount').textContent = ''; // 「結果発表まで」のカウントを止める
  stageMascot(null);
  $('qno').textContent = ''; $('timer').textContent = ''; $('barFill').style.width = '0';
  // 称号は人ごとにまとめる（順位の順）
  const byWho = new Map();
  for (const x of titles) { if (!byWho.has(x.id)) byWho.set(x.id, { ...x, list: [] }); byWho.get(x.id).list.push(x); }
  const order = new Map(ranking.map((r, i) => [r.id, i]));
  $('titles').innerHTML = [...byWho.values()].sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
    .map(w => `<li>${avatarImg(w.avatar)}<div><span>${esc(w.name)}</span><p class="title-chips">${w.list.map(x => `<em title="${esc(x.why)}"><b>${esc(x.title)}</b><small>${esc(x.why)}</small></em>`).join('')}</p></div></li>`).join('');
  document.body.classList.remove('revealing', 'playing');
  question = null;
  player.stop(); stopTick();
  setPhase('', '終了');
  // 上位3人は表彰台に、全員の順位は下の一覧に
  // チーム戦：勝ったチーム（合計点）を表彰台の上に
  $('teamResult').hidden = !teams && !coop;
  if (coop) $('teamResult').innerHTML = coop.done ? `<b class="team-red">協力 達成！</b><span>みんなの正解 ${coop.count} ／ 目標 ${coop.goal}</span>`
    : `<b>あと ${coop.goal - coop.count}問…</b><span>みんなの正解 ${coop.count} ／ 目標 ${coop.goal}</span>`;
  if (teams) {
    const draw = teams.length > 1 && teams[0].score === teams[1].score;
    $('teamResult').innerHTML = (draw ? '<b>引き分け！</b>' : `<b class="team-${teams[0].team}">${TEAM_LABEL[teams[0].team]}チームの勝ち！</b>`)
      + teams.map(x => `<span class="team-${x.team}">${TEAM_LABEL[x.team]} ${x.score}${x.unit || '点'}（${x.members}人）</span>`).join('');
  }
  $('places').innerHTML = ranking.slice(0, 3).map((p, i) =>
    `<div class="place p${i + 1}">${i === 0 ? icon('crown', 'crown') : ''}${avatarImg(p.avatar, 'avatar lg')}<b>${i + 1}位</b>${esc(p.name)}<span>${p.score}点</span></div>`).join('');
  // ふりかえり：正解数・正解したときの平均タイム・いちばん長い連続正解
  const recap = p => [
    survival && (p.out ? `${p.survived}問目で脱落` : `最後まで残った（${p.survived}問）`),
    bingo && p.bingoAt && `${p.bingoAt}問目で BINGO!`,
    p.team && `${TEAM_LABEL[p.team]}チーム`,
    p.jackpots > 0 && `大当たり ${p.jackpots}回・最長 ${p.rushMax}連チャン`,
    p.correct !== undefined && `正解 ${p.correct}${total ? ` / ${total}` : ''}問`,
    p.avg != null && `平均 ${p.avg.toFixed(2)}秒`,
    p.maxStreak >= 2 && `最長 ${p.maxStreak}連続`,
  ].filter(Boolean).join('・');
  $('ranking').innerHTML = ranking.map(p =>
    `<li>${avatarImg(p.avatar, 'avatar sm')}<div class="rk-name">${esc(p.name)}<small>${esc(recap(p))}</small></div><span>${p.score}点</span></li>`).join('');
  show('over');
  confetti(160);
  if (ranking[0]?.id === me) flash('ok', '優勝！');
  // お祝い：優勝した人の名前でカットイン。自分が全問正解なら、それも
  const mine = ranking.find(p => p.id === me);
  charFx.pose('celebrate'); charFx.say('win', { top: ranking[0]?.name });
  // 真ん中の「優勝！」の文字のあとに出す
  if (ranking[0]) setTimeout(() => charFx.cutin(`優勝 ${ranking[0].name}`, `${ranking[0].score}点`, 'celebrate'), 1500);
  if (mine && total && mine.correct === total) setTimeout(() => charFx.cutin('全問正解!!', 'パーフェクト！', 'celebrate'), 3800);
});

socket.on('notice', msg => toast(msg));

function stopTick() { clearInterval(tick); tick = null; }
let nextTick = null; // 答え合わせ後の自動で次へのカウント
let nextUntil = 0, nextIsLast = false, listenBy = '';
const FADE_BEFORE_NEXT_MS = 1500;
let fadingOut = false;
function startNextCount(seconds, last = nextIsLast) {
  if (fadingOut) { fadingOut = false; player.fadeBack(); document.body.classList.remove('fading'); } // 「サビを聞く」で延びたら音量と映像を戻す
  nextUntil = performance.now() + seconds * 1000; nextIsLast = last;
  const total = seconds * 1000;
  clearInterval(nextTick);
  const draw = () => {
    if (pausedNow) return; // 一時停止中はカウントもフェードも止める
    const left = nextUntil - performance.now();
    const s = Math.ceil(left / 1000);
    // ステージのタイマーは、答え合わせ中は「次の問題まで」の秒数にする
    $('timer').innerHTML = s > 0 ? `<span class="timer-label">${nextIsLast ? '結果発表' : '次の問題'}まで</span>${s}<span class="timer-unit">秒</span>` : '';
    $('barFill').style.width = Math.max(0, Math.min(100, (1 - left / total) * 100)) + '%';
    $('barFill').style.background = 'var(--ok)';
    // PCはステージのタイマーに秒数が出ているので、結果の欄には「サビを聞いています」のときだけ出す
    $('nextCount').textContent = s > 0 && (listenBy || !isWide())
      ? `${listenBy ? `${listenBy}さんがサビを聞いています・` : ''}${s}秒後に${nextIsLast ? '結果発表' : '次の問題'}へ` : '';
    // 次へ進む少し前からサビをフェードアウト
    if (!fadingOut && nextUntil - performance.now() <= FADE_BEFORE_NEXT_MS) { fadingOut = true; player.fadeOut(FADE_BEFORE_NEXT_MS); document.body.classList.add('fading'); }
    if (s <= 0) clearInterval(nextTick);
  };
  draw(); nextTick = setInterval(draw, 250);
}
// だれかが「サビを聞く」を押した：次へ進むまでの時間が延びる
socket.on('nextAt', ({ seconds, by }) => { listenBy = by; startNextCount(seconds); });
// だれかが「位置を直す」を開いた：直し終わるまで次へ進まない（カウントを止めて、だれが直しているか出す）
socket.on('nextHold', ({ by }) => {
  clearInterval(nextTick);
  if (fadingOut) { fadingOut = false; player.fadeBack(); document.body.classList.remove('fading'); }
  $('timer').innerHTML = '<span class="timer-label">一時停止中</span>⏸';
  $('nextCount').textContent = `⏸ ${by}さんがイントロ・サビの位置を直しています（直し終わると次へ進みます）`;
});
$('listenBtn').onclick = () => { socket.emit('listen'); $('listenBtn').disabled = true; };
// 押した後は「もっと聞く」に変わる。回数を使い切ったら押せない
socket.on('listenLeft', left => {
  $('listenBtn').textContent = left < 0 ? '♪ ＋10秒 もっと聞く' : left > 0 ? `♪ ＋10秒 もっと聞く（あと${left}回）` : '♪ もう延ばせません';
  if (left !== 0) setTimeout(() => { $('listenBtn').disabled = false; }, 1000);
});

let toastTimer = null;
function toast(msg) {
  $('toast').textContent = msg; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500);
}
