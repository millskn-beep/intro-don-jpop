import { createPlayer } from './player.js';
import { guessChorus } from './chorus-guess.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
let me = null, room = null, question = null, myAnswer = null, timerStart = 0, tick = null;
let myLifelines = null, answering = false; // answering: イントロ/サビ中で、まだ答えられる状態

const player = createPlayer('player', {
  onReadyToPlay: () => socket.emit('ready'),
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
  socket.emit('create', { token, name, roomName, password }, res => {
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
  socket.emit('join', { code: info.code, token, name, password: pw }, res => {
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
      <div class="rc-meta"><span>👤 ${r.players}/${r.max}</span><span>HOST ${esc(r.host)}</span><span>${r.questions}問</span><span>${ANSWER_LABEL[r.answerMode] || ''}・${MODE_LABEL[r.mode] || ''}</span><span>${years}</span></div>
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
  $('home').hidden = true; $('roomListPanel').hidden = true; $('room').hidden = false;
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
  if (code) socket.emit('join', { code, token, name: store.get('aq-name'), password: store.get(passKey.code(code)) || '' },
    res => res.ok ? joined(res) : leaveToHome(res.error));
  else socket.emit('watchRooms');
});
function leaveToHome(msg) {
  me = null; $('room').hidden = true; $('home').hidden = false; $('roomListPanel').hidden = false; $('roomCode').hidden = true;
  $('homeError').textContent = msg || '';
  socket.emit('watchRooms');
}

$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText($('inviteUrl').value); toast('コピーしました'); }
  catch (e) { $('inviteUrl').select(); }
};

// ── 設定 ──
const SETTING_OPTIONS = {
  questions: [5, 10, 20, 30].map(n => [n, n + '問']),
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
const STRING_KEYS = ['mode', 'answerMode', 'quizType', 'topic', 'series'], BOOL_KEYS = ['clues', 'lifelines', 'bonus'];
function sendSettings(extra = {}) {
  const s = {};
  document.querySelectorAll('#settings select').forEach(x => {
    const k = x.dataset.key;
    s[k] = STRING_KEYS.includes(k) ? x.value : BOOL_KEYS.includes(k) ? x.value === 'true' : +x.value;
  });
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
const topicLabel = S => S.topic === 'series' ? (S.series || '作品') : S.topic === 'all' ? '全部' : (TOPIC_DATA.genres.find(g => g.key === S.topic)?.label || 'お題');
fetch('/api/topics').then(r => r.json()).then(d => {
  TOPIC_DATA = d;
  const tp = document.querySelector('[data-key="topic"]');
  d.genres.forEach(g => tp.add(new Option(`${g.label}（${g.count}曲）`, g.key)));
  const se = document.querySelector('[data-key="series"]');
  d.series.forEach(s => se.add(new Option(`${s.name}（${s.count}曲）`, s.name)));
  // 除外するジャンルのチェック欄
  $('genreExList').innerHTML = d.genres.map(g =>
    `<label><input type="checkbox" value="${esc(g.key)}">${esc(g.label)}<small>${g.count}</small></label>`).join('');
  $('genreExList').querySelectorAll('input').forEach(cb => cb.onchange = () =>
    socket.emit('excludeGenres', [...$('genreExList').querySelectorAll('input:checked')].map(x => x.value)));
  if (room) renderRoom(room); // 選択肢がそろったので選ばれている値を入れ直す
}).catch(() => {});

// おまかせ設定（細かい設定はまとめて変える）
const MODES = {
  easy:   { choices: 4,  introLen: 10, hintAt: 15, chorusLen: 20, clues: true,  answerMode: 'choice', mode: 'score', typingExtra: 20 },
  normal: { choices: 8,  introLen: 5,  hintAt: 10, chorusLen: 15, clues: true,  answerMode: 'choice', mode: 'score', typingExtra: 10 },
  hard:   { choices: 12, introLen: 3,  hintAt: 5,  chorusLen: 10, clues: false, answerMode: 'input',  mode: 'buzz',  typingExtra: 10 },
};
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { sendSettings(MODES[b.dataset.mode]); toast(`「${b.textContent}」の設定にしました`); });
// リアクションスタンプ
document.querySelectorAll('[data-react]').forEach(b => b.onclick = () => socket.emit('react', b.dataset.react));
$('startBtn').onclick = () => socket.emit('start');
$('nextBtn').onclick = () => socket.emit('next');
$('lobbyBtn').onclick = () => socket.emit('backToLobby');
// 出題した曲のログ：コピーしてどこかに貼り付けて残せるように
let playLog = [];
function playLogText(list = playLog, title = '出題曲') {
  const d = new Date();
  const head = `アニソンイントロ対戦 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${title}`;
  const lines = list.map((s, i) => s && `${i + 1}. ${s.title} ／ ${s.work}${s.type ? `（${s.type}）` : ''} ／ ${s.artist}${s.year ? `（${s.year}）` : ''}`).filter(Boolean);
  const ids = list.filter(s => s?.id).map(s => s.id).join('');
  return [head, ...lines, ...(ids ? [`除外コード（新しい部屋に貼ると、この曲を出題しません）：AQX1:${ids}`] : [])].join('\n');
}
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
  for (const id of ids) if (/^[\w-]{11}$/.test(id) && !set.has(id)) { set.add(id); added = true; }
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

// ── 一時停止・途中でやめる ──
let shownBeforePause = null, pausedNow = false, pausedAt = 0;
$('pauseBtn').onclick = () => socket.emit('pause');
$('resumeBtn').onclick = () => socket.emit('resume');
$('abortBtn').onclick = () => { if (confirm('ゲームをやめて部屋に戻りますか？（得点は残りません）')) socket.emit('abort'); };
socket.on('paused', () => { pausedNow = true; pausedAt = performance.now(); player.pause(); setPhase('ready', '一時停止中'); });
socket.on('resumed', ({ ms, qTotal }) => {
  pausedNow = false;
  const d = performance.now() - pausedAt; // 止まっていたぶん、残り時間の計算を後ろへずらす
  timerStart += d; nextUntil += d;
  player.resume();
  setPhase(document.body.classList.contains('revealing') ? 'reveal' : 'intro', document.body.classList.contains('revealing') ? '答え合わせ' : '再開');
  if (question && qTotal) { question.qTotal = qTotal; $('qno').innerHTML = $('qno').innerHTML.replace(/\/ \d+ 問/, `/ ${qTotal} 問`); }
});
socket.on('aborted', () => {
  player.stop(); stopTick(); clearInterval(nextTick); clearTimeout(goTimer);
  $('nextCount').textContent = ''; question = null; pausedNow = false; shownBeforePause = null;
  toast('ゲームを中断して部屋に戻りました');
});

// ── 部屋の状態 ──
socket.on('room', renderRoom);
function renderRoom(r) {
  const prevState = room?.state;
  const prevScores = new Map((room?.players || []).map(p => [p.id, p.score]));
  room = r;
  const isHost = r.hostId === me;
  document.querySelectorAll('#settings select').forEach(sel => {
    sel.value = String(r.settings[sel.dataset.key] ?? '');
    sel.disabled = !isHost;
  });
  $('seriesLabel').hidden = r.settings.topic !== 'series';
  $('presets').hidden = !isHost;
  $('modes').hidden = !isHost;
  const ex = r.settings.excludeGenres || [];
  $('genreExList').querySelectorAll('input').forEach(cb => { cb.checked = ex.includes(cb.value); cb.disabled = r.state === 'playing' && !r.paused; });
  const exLabels = ex.map(k => TOPIC_DATA.genres.find(g => g.key === k)?.label || k);
  $('genreExInfo').textContent = exLabels.length ? `（${exLabels.join('・')}）` : '（なし）';
  $('poolInfo').textContent = `${topicLabel(r.settings)}${r.settings.topic === 'all' && exLabels.length ? `（${exLabels.join('・')}を除く）` : ''}・${r.settings.yearFrom}〜${r.settings.yearTo}年：出題できる曲 ${r.poolSize} 曲` +
    (r.poolSize < r.settings.questions ? `（${r.settings.questions}問に足りないので ${r.poolSize} 問で出題します）` : '');
  $('startBtn').disabled = r.poolSize === 0;
  $('excludeCount').textContent = r.excluded ? `（除外中 ${r.excluded}曲）` : '';
  if (r.excluded !== excludedCount) { excludedCount = r.excluded; refreshExcluded(); }
  $('excludeCopy').hidden = !r.excluded;
  $('excludeClear').hidden = !(isHost && r.excluded);
  $('startBtn').hidden = !isHost; $('waitHost').hidden = isHost;
  $('nextBtn').hidden = !isHost; $('waitNext').hidden = isHost || r.settings.autoNext > 0; // 自動で進むときは待ちの文言を出さない
  $('lobbyBtn').hidden = !isHost;
  // ゲーム中のホスト用ボタン。一時停止中は設定画面を出す
  const playing = r.state === 'playing';
  $('gameCtrl').hidden = !(isHost && playing && !r.paused);
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
  else if (r.state === 'playing' && prevState !== 'playing' && !question) {
    // 途中参加：次の問題から
    show('quiz'); $('choices').innerHTML = ''; $('quizNote').textContent = '次の問題から参加します';
  }
  if (r.state === 'lobby') { setPhase('', '待機中'); $('qno').textContent = ''; }

  myLifelines = r.players.find(p => p.id === me)?.lifelines || null;
  updateLifelineButtons();

  // 得点が一番の人（0点より上）に王冠をつける
  const top = Math.max(0, ...r.players.map(p => p.score));
  $('players').innerHTML = r.players.map(p => `
    <li data-id="${p.id}" class="${p.answered ? 'answered' : ''} ${p.connected ? '' : 'off'} ${p.id === me ? 'me' : ''}">
      <span class="pl-face">${avatarImg(p.avatar)}${top > 0 && p.score === top ? icon('crown', 'crown') : ''}</span>
      <span class="pl-name"><b>${esc(p.name)}</b>${p.id === r.hostId || p.id === me || p.streak >= 2 ? `<span class="tags">${p.id === r.hostId ? '<span class="host">HOST</span>' : ''}${p.id === me ? '<span class="you">YOU</span>' : ''}${p.streak >= 2 ? `<span class="streak" title="連続正解">${p.streak}連</span>` : ''}</span>` : ''}</span>
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
function setPhase(cls, label) { $('phase').className = 'phase ' + cls; $('phase').textContent = label; }

// ── 出題 ──
const isInput = () => question?.answerMode === 'input';

socket.on('question', q => {
  if (q.qNo === 1) playLog = []; // 新しいゲーム
  question = q; myAnswer = null; answering = false;
  stopTick();
  $('timer').textContent = ''; $('barFill').style.width = '0';
  clearInterval(nextTick); $('nextCount').textContent = ''; clearTimeout(goTimer); fadingOut = false; document.body.classList.remove('fading');
  $('barMark').style.left = (q.settings.hintAt / (q.settings.hintAt + q.settings.chorusLen) * 100) + '%';
  $('qno').innerHTML = `第 ${q.qNo} / ${q.qTotal} 問` + (q.kind === 'sabimae' ? '（サビ前問題）' : '')
    + (q.final ? ' <b class="final">最終問題・得点2倍</b>' : '');
  $('cover').innerHTML = '<span>?</span>';
  document.body.classList.remove('revealing', 'playing'); // 背景の映像を隠す
  setPhase('', '読み込み中');
  $('quizNote').textContent = '';
  $('clues').innerHTML = ''; $('lifeResults').innerHTML = '';
  $('choices').hidden = isInput(); $('inputForm').hidden = !isInput();
  $('answerInput').value = ''; $('answerInput').disabled = true; $('sendBtn').disabled = true;
  $('choices').innerHTML = isInput() ? '' : q.choices.map((c, i) =>
    `<button class="choice" data-i="${i}" disabled>${esc(c.title)}<small>${esc(c.work)}</small></button>`).join('');
  $('choices').querySelectorAll('.choice').forEach(b => b.onclick = () => answer({ index: +b.dataset.i }));
  $('lifelines').hidden = false;
  updateLifelineButtons();
  show('quiz');
  player.load(q.videoId, q.start ?? q.intro);
});

// offset は途中から戻ってきた人向け（経過秒）
// offset は曲が流れ始めてからの経過秒。マイナスのときは、選択肢を見せてからその秒数待って流す（最初の1秒の待ち）。
// 途中から戻ってきた人はプラスの経過秒が届く
let goTimer = null;
socket.on('go', ({ intro, start = intro, kind, hintAt, total, offset = 0, introLen, plays = 1, gap = 1 }) => {
  document.body.classList.add('playing'); // 背景に Ambient light 風のぼかし映像
  clearTimeout(goTimer);
  stopTick();
  $('barMark').style.left = (hintAt / total * 100) + '%';
  $('timer').textContent = total.toFixed(1);
  const wait = Math.max(0, -offset), off = Math.max(0, offset);
  if (wait > 0) setPhase('ready', 'まもなく…');
  goTimer = setTimeout(() => {
    if (kind === 'sabimae') {
      // サビ前問題：止めずに流し続ける。戻ってきた人も経過秒ぶん先から
      player.start(start + off);
      setPhase('intro', 'サビ前');
    } else {
      // 戻ってきた人は、いま何回目のイントロのどこかを計算して、その位置から
      const cycle = introLen + gap, k = Math.floor(off / cycle), within = off - k * cycle;
      if (!off) player.start(intro);
      else if (k < plays && within < introLen && off < hintAt) player.start(intro + within);
      setPhase('intro', plays > 1 ? `イントロ（1 / ${plays}回目）` : 'イントロ');
    }
    if (myAnswer === null) {
      answering = true;
      $('choices').querySelectorAll('.choice:not(.gone)').forEach(b => b.disabled = false);
      $('answerInput').disabled = false; $('sendBtn').disabled = false;
      if (isInput() && !off) $('answerInput').focus();
    }
    updateLifelineButtons();
    timerStart = performance.now() - off * 1000;
    tick = setInterval(() => {
      if (pausedNow) return; // 一時停止中は進めない
      const t = (performance.now() - timerStart) / 1000;
      $('timer').textContent = Math.max(0, total - t).toFixed(1); // 残り時間
      $('barFill').style.width = Math.min(100, t / total * 100) + '%';
      $('barFill').style.background = t >= hintAt ? 'var(--warn)' : 'var(--accent2)';
    }, 50);
  }, wait * 1000);
});
socket.on('stopIntro', () => player.stopIntro());
// イントロをもう一度頭から（部屋の設定「イントロの回数」）
socket.on('restartIntro', ({ n, plays }) => {
  player.start(question?.intro || 0);
  setPhase('intro', `イントロ（${n} / ${plays}回目）`);
});
socket.on('hint', ({ chorus, known = true, intro = 0, seek = true }) => {
  if (seek) { player.hint(known && chorus !== intro + 50 ? chorus : guessChorus(intro, player.duration())); setPhase('chorus', 'サビ（ヒント・得点×0.7）'); }
  else setPhase('chorus', 'サビ（得点×0.7）'); // サビ前問題は流れのままサビに入る
});

// 再接続したとき、すでに答えていた問題の表示を戻す
socket.on('answered', a => markAnswered(a));

// payload: { index } / { text } / { pass: true }
function answer(payload) {
  if (myAnswer !== null || !answering) return;
  socket.emit('answer', payload);
  markAnswered(payload);
}
function markAnswered({ index = null, text = null, given = null, pass = false }) {
  myAnswer = pass ? 'pass' : index ?? (text ?? given);
  answering = false;
  $('choices').querySelectorAll('.choice').forEach(b => {
    b.disabled = true;
    if (index !== null && +b.dataset.i === index) b.classList.add('mine');
  });
  $('answerInput').disabled = true; $('sendBtn').disabled = true;
  if (text ?? given) $('answerInput').value = text ?? given;
  $('quizNote').textContent = pass ? '「次の曲へ」を押しました。全員がそろうと答え合わせです…' : '回答しました。答え合わせを待っています…';
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
$('passBtn').onclick = () => answer({ pass: true });

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
  $('passBtn').disabled = !answering;
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
socket.on('reveal', r => {
  stopTick();
  if (Array.isArray(r.log)) playLog = r.log; // サーバーが持っている「ここまでの曲」
  if (r.song?.id) rememberIds([r.song.id]);
  else if (question?.qNo && r.song) playLog[question.qNo - 1] = r.song;
  answering = false; updateLifelineButtons();
  $('answerInput').disabled = true; $('sendBtn').disabled = true;
  setPhase('reveal', '答え合わせ');
  $('cover').innerHTML = icon('note', 'cover-icon');
  document.body.classList.remove('playing'); document.body.classList.add('revealing'); // 背景全体に映像を出す
  // サビの位置が仮（イントロ＋50秒）の曲は、動画の長さから推定した位置にする
  const unknown = r.chorusKnown === false || (r.chorusKnown === undefined && r.chorus === r.intro + 50);
  player.reveal(r.intro, unknown ? guessChorus(r.intro, player.duration()) : r.chorus);
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
  const s = r.song;
  $('answer').innerHTML = `${esc(s.title)}<small>${esc(s.work)} ${esc(s.type || '')}／${esc(s.artist)}（${s.year}）</small>`;
  $('results').innerHTML = r.results.map(x => `
    <tr>
      <td class="who">${avatarImg(x.avatar, 'avatar sm')}${esc(x.name)}</td>
      <td class="${x.correct ? 'ok' : 'ng'}">${!x.answered ? '未回答' : x.pass ? 'スキップ' : x.correct ? '正解' + (x.hint ? '（サビ）' : '') : '不正解'}${x.given ? `<small>「${esc(x.given)}」</small>` : ''}${!x.correct && Number.isInteger(x.index) && question?.choices?.[x.index] ? `<small>「${esc(question.choices[x.index].title)}」を選択</small>` : ''}</td>
      <td class="num">${x.elapsed === null ? '' : x.elapsed.toFixed(2) + '秒'}</td>
      <td class="num">+${x.points}</td>
    </tr>`).join('');
  // 自分の結果を大きく表示
  const mine = r.results.find(x => x.id === me);
  if (mine) {
    if (mine.correct) { flash('ok', '正解！', `+${mine.points}`); confetti(40); }
    else if (mine.pass) flash('ng', 'スキップ');
    else if (!mine.answered) flash('ng', '時間切れ');
    else flash('ng', '不正解');
  }
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
socket.on('almost', ({ text, left }) => {
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

socket.on('gameover', ({ ranking, titles = [], log }) => {
  if (Array.isArray(log)) playLog = log;
  $('qno').textContent = ''; $('timer').textContent = ''; $('barFill').style.width = '0';
  $('titles').innerHTML = titles.map(x => `<li>${avatarImg(x.avatar)}<div><b>${esc(x.title)}</b><span>${esc(x.name)}</span><small>${esc(x.why)}</small></div></li>`).join('');
  document.body.classList.remove('revealing', 'playing');
  question = null;
  player.stop(); stopTick();
  setPhase('', '終了');
  // 上位3人は表彰台に、全員の順位は下の一覧に
  $('places').innerHTML = ranking.slice(0, 3).map((p, i) =>
    `<div class="place p${i + 1}">${i === 0 ? icon('crown', 'crown') : ''}${avatarImg(p.avatar, 'avatar lg')}<b>${i + 1}位</b>${esc(p.name)}<span>${p.score}点</span></div>`).join('');
  $('ranking').innerHTML = ranking.map(p => `<li>${avatarImg(p.avatar, 'avatar sm')}${esc(p.name)}<span>${p.score}点</span></li>`).join('');
  show('over');
  confetti(160);
  if (ranking[0]?.id === me) flash('ok', '優勝！');
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
  clearInterval(nextTick);
  const draw = () => {
    if (pausedNow) return; // 一時停止中はカウントもフェードも止める
    const s = Math.ceil((nextUntil - performance.now()) / 1000);
    $('nextCount').textContent = s > 0 ? `${listenBy ? `${listenBy}さんがサビを聞いています・` : ''}${s}秒後に${nextIsLast ? '結果発表' : '次の問題'}へ` : '';
    // 次へ進む少し前からサビをフェードアウト
    if (!fadingOut && nextUntil - performance.now() <= FADE_BEFORE_NEXT_MS) { fadingOut = true; player.fadeOut(FADE_BEFORE_NEXT_MS); document.body.classList.add('fading'); }
    if (s <= 0) clearInterval(nextTick);
  };
  draw(); nextTick = setInterval(draw, 250);
}
// だれかが「サビを聞く」を押した：次へ進むまでの時間が延びる
socket.on('nextAt', ({ seconds, by }) => { listenBy = by; startNextCount(seconds); });
$('listenBtn').onclick = () => { socket.emit('listen'); $('listenBtn').disabled = true; };
// 押した後は「もっと聞く」に変わる。回数を使い切ったら押せない
socket.on('listenLeft', left => {
  $('listenBtn').textContent = left > 0 ? `♪ ＋10秒 もっと聞く（あと${left}回）` : '♪ もう延ばせません';
  if (left > 0) setTimeout(() => { $('listenBtn').disabled = false; }, 1000);
});

let toastTimer = null;
function toast(msg) {
  $('toast').textContent = msg; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500);
}
