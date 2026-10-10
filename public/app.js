import { createPlayer } from './player.js';
import { guessChorus } from './chorus-guess.js';
import { initLayout } from './layout.js';
import { CHARACTERS, FALLBACK, kanjiNum } from './characters.js';
import { initCharFx } from './charfx.js';

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
  onReadyToPlay: () => practice ? layoutApi.onReady() : socket.emit('ready'), // テスト1問のときはサーバーに送らない
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
  if (code) socket.emit('join', { code, token, name: store.get('aq-name'), password: store.get(passKey.code(code)) || '' },
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
const STRING_KEYS = ['mode', 'answerMode', 'quizType', 'topic', 'series', 'play', 'target', 'speed', 'bingoEnd', 'rushRate'], BOOL_KEYS = ['clues', 'lifelines', 'bonus', 'noExclude', 'teams', 'noRepeat'];
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
const topicLabel = S => S.topic === 'series' ? (S.series || '作品') : S.topic === 'all' ? '全部' : S.topic === 'playlist' ? 'プレイリスト（お試し）' : (TOPIC_DATA.genres.find(g => g.key === S.topic)?.label || 'お題');
fetch('/api/topics').then(r => r.json()).then(d => {
  TOPIC_DATA = d;
  const tp = document.querySelector('[data-key="topic"]');
  if (d.playlist > 0) tp.add(new Option(`プレイリスト（お試し・${d.playlist}曲）`, 'playlist'));
  d.genres.forEach(g => tp.add(new Option(`${g.label}（${g.count}曲）`, g.key)));
  const se = document.querySelector('[data-key="series"]');
  d.series.forEach(s => se.add(new Option(`${s.name}（${s.count}曲）`, s.name)));
  // 知名度のチェック欄（ホストが変える）
  $('fameList').innerHTML = (d.fame || []).map(f =>
    `<label><input type="checkbox" value="${esc(f.key)}" checked>${esc(f.label)}<small>${f.count}</small></label>`).join('');
  $('fameList').querySelectorAll('input').forEach(cb => cb.onchange = () => sendSettings());
  // 除外するジャンルのチェック欄
  $('genreExList').innerHTML = d.genres.map(g =>
    `<label><input type="checkbox" value="${esc(g.key)}">${esc(g.label)}<small>${g.count}</small></label>`).join('');
  $('genreExList').querySelectorAll('input').forEach(cb => cb.onchange = () =>
    socket.emit('excludeGenres', [...$('genreExList').querySelectorAll('input:checked')].map(x => x.value)));
  if (room) renderRoom(room); // 選択肢がそろったので選ばれている値を入れ直す
}).catch(() => {});

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
const PLAY_DESC = {
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
$('pauseBtn').onclick = () => socket.emit('pause');
$('resumeBtn').onclick = () => socket.emit('resume');
$('abortBtn').onclick = () => { if (confirm('ゲームをやめて部屋に戻りますか？（得点は残りません）')) socket.emit('abort'); };
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
socket.on('room', renderRoom);
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
  const isHost = r.hostId === me;
  const canSet = !(r.state === 'playing' && !r.paused); // 設定はだれでも変えられる（ゲーム中は一時停止のときだけ）
  if (!lobbyTabChosen) setLobbyTab(isHost ? 'settings' : 'members');
  document.querySelectorAll('#settings select').forEach(sel => {
    sel.value = String(r.settings[sel.dataset.key] ?? '');
    sel.disabled = !canSet;
  });
  $('seriesLabel').hidden = r.settings.topic !== 'series';
  // 新しいモードの設定：サバイバルはライフ（問題数の代わりに終わるまで）、早押しは採点の欄を使わない。できない組み合わせは選べなくする
  $('livesLabel').hidden = r.settings.play !== 'survival';
  $('coopGoalLabel').hidden = r.settings.play !== 'coop';
  $('rushRateLabel').hidden = r.settings.play !== 'rush'; // アニソン激アツRUSH：当たりやすさ
  $('lockSecLabel').hidden = r.settings.play !== 'fill'; // 3つ埋めバトル：間違えたあと押せない秒数
  $('bingoEndLabel').hidden = r.settings.play !== 'bingo'; // ビンゴ：何人・何ビンゴで終わるか
  $('noRepeatLabel').hidden = r.settings.play !== 'fill'; // 3つ埋めバトル：間違えた人は、ほかの人が押すまで押せない
  $('playDesc').textContent = PLAY_DESC[r.settings.play] || '';
  $('questionsLabel').hidden = r.settings.play === 'survival';
  const fillMode = r.settings.play === 'fill'; // 3つ埋めバトルは、答えるもの・回答方法・採点・ヒントを使わない（枠ごとに書くか10択）
  $('modeLabel').hidden = r.settings.play === 'buzzer' || r.settings.target === 'year' || fillMode;
  for (const k of ['target', 'answerMode', 'choices', 'clues']) document.querySelector(`#settings [data-key="${k}"]`).closest('label').hidden = fillMode;
  document.querySelector('[data-key="play"] option[value="buzzer"]').disabled = r.settings.target === 'year';
  document.querySelector('[data-key="teams"] option[value="true"]').disabled = ['survival', 'coop', 'bingo', 'rush'].includes(r.settings.play);
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
  // 位置を直す：自分の画面のプレーヤーで試し聴きしながら、イントロ・サビの秒数を決めてメモに残す
  const saved = fixes()[s.id];
  const pos = { i: saved?.i ?? r.intro ?? 0, c: saved?.c ?? r.chorus ?? 0 };
  const round = x => Math.max(0, Math.round(x * 10) / 10);
  const row = (k, label) => `<div class="fix-row"><b>${label}</b><span class="fix-sec" id="fix-${k}">${pos[k]}秒</span>
    <span class="fix-btns"><button class="btn-sub" data-fk="${k}" data-d="-1">−1</button><button class="btn-sub" data-fk="${k}" data-d="-0.1">−0.1</button>`
    + `<button class="btn-sub" data-fk="${k}" data-d="0.1">+0.1</button><button class="btn-sub" data-fk="${k}" data-d="1">+1</button>`
    + `<button class="btn-sub" data-now="${k}">今の位置</button><button class="btn-sub" data-play="${k}">▶ 聴く</button></span></div>`;
  $('fixToggle').onclick = () => {
    const p = $('fixPanel');
    p.hidden = !p.hidden;
    if (p.hidden) return;
    p.innerHTML = row('i', 'イントロ') + row('c', 'サビ')
      + `<div class="fix-actions"><button class="btn-main" id="fixSave">メモに保存</button><button class="btn-sub" id="fixCopy">📋 直した位置をコピー</button></div>`
      + '<p class="note">直した位置は変えるたびにこの端末にメモとして残ります。手元のチェック画面に貼り付けて取り込むと、曲データに反映されます。</p>';
    const save = quiet => {
      const all = fixes(); all[s.id] = { t: s.title, w: s.work, i: pos.i, c: pos.c };
      store.set(FIX_KEY, JSON.stringify(all));
      $('fixToggle').textContent = '⏱ 位置を直す（直し済み）';
      if (!quiet) toast(`「${s.title}」の位置をメモしました（${Object.keys(all).length}曲）`);
    };
    // 変えるたびにメモに残す（自動で次の問題に進んでも消えないように）
    const show = () => { $('fix-i').textContent = `${pos.i}秒`; $('fix-c').textContent = `${pos.c}秒`; save(true); };
    p.querySelectorAll('[data-fk]').forEach(b => b.onclick = () => { pos[b.dataset.fk] = round(pos[b.dataset.fk] + +b.dataset.d); show(); });
    p.querySelectorAll('[data-now]').forEach(b => b.onclick = () => { pos[b.dataset.now] = round(player.time()); show(); });
    p.querySelectorAll('[data-play]').forEach(b => b.onclick = () => player.playFrom(pos[b.dataset.play]));
    $('fixSave').onclick = () => save(false);
    $('fixCopy').onclick = async () => {
      const n = Object.keys(fixes()).length;
      if (!n) return toast('まだメモした曲がありません');
      toast(await copyText(fixText()) ? `直した位置 ${n}曲をコピーしました` : 'コピーできませんでした');
    };
  };
}
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
  $('qno').innerHTML = (q.play === 'survival' ? `第 ${q.qNo} 問（サバイバル）` : `第 ${q.qNo} / ${q.qTotal} 問`)
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
  $('choices').innerHTML = isInput() || q.fill ? '' : q.answerMode === 'year'
    ? q.years.map((y, i) => `<button class="choice year" data-i="${i}" disabled>${y}</button>`).join('')
    : q.choices.map((c, i) => `<button class="choice" data-i="${i}" disabled>${esc(c.title)}${c.work ? `<small>${esc(c.work)}</small>` : ''}</button>`).join('');
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
socket.on('go', ({ intro, start = intro, kind, hintAt, total, offset = 0, introLen, plays = 1, gap = 1, speed = 1 }) => {
  player.setRate(speed); // 倍速・スロー（問題の間ずっと。答え合わせでふつうに戻す）
  document.body.classList.add('playing'); // 背景に Ambient light 風のぼかし映像
  if (!practice) document.body.classList.add('game-started'); // ここからゲームの終わりまで、キャラは左右のまま（問題の間の読み込み中も）
  clearTimeout(goTimer);
  stopTick();
  $('barMark').style.left = (hintAt / total * 100) + '%';
  $('timer').textContent = total.toFixed(1);
  const wait = Math.max(0, -offset), off = Math.max(0, offset);
  if (wait > 0) setPhase('ready', 'まもなく…');
  goTimer = setTimeout(() => {
    if (kind === 'sabimae' || kind === 'random' || kind === 'outro') {
      // サビ前・どこから・アウトロ問題：止めずに流し続ける。戻ってきた人も経過秒ぶん先から
      player.start(start + off);
      setPhase('intro', kind === 'random' ? '曲のどこかを再生中…（わかるかな？）' : kind === 'outro' ? 'アウトロを再生中…（わかるかな？）' : 'サビ前を再生中…（わかるかな？）'); coverFx('fx-intro'); stageMascot('listen'); charFx.pose('listen'); charFx.say('intro');
    } else {
      // 戻ってきた人は、いま何回目のイントロのどこかを計算して、その位置から
      const cycle = introLen + gap, k = Math.floor(off / cycle), within = off - k * cycle;
      if (!off) player.start(intro);
      else if (k < plays && within < introLen && off < hintAt) player.start(intro + within);
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
    updateLifelineButtons();
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
  socket.emit('buzz');
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
socket.on('buzz', ({ id, name, sec, queue = null }) => {
  buzzHolder = id; // 押しても曲と残り時間は止めない（流れたまま答える）
  if (queue) { buzzQueueNames = queue; buzzQueueIds = buzzQueueIds.filter(x => x !== id); }
  // 3つ埋めバトルは、ほかの人が答えている間も押せる（押した順に並ぶ）
  buzzOpen = !!question?.fill && id !== me && !buzzQueueIds.includes(me) && myAnswer === null && !amOut();
  $('buzzBtn').disabled = !buzzOpen || fillLocked();
  const mine = id === me, until = performance.now() + sec * 1000;
  const show = () => {
    const next = question?.fill && buzzQueueNames.length ? `　次：${buzzQueueNames.join(' → ')}` : '';
    $('buzzInfo').textContent = `${mine ? 'あなた' : name + ' さん'}が回答中… 残り ${Math.max(0, (until - performance.now()) / 1000).toFixed(1)} 秒${next}`;
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
socket.on('buzzEnd', () => {
  const wasMine = buzzHolder === me;
  if (clearBuzz()) player.resume();
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
  $('answer').innerHTML =`${esc(s.title)}<small>${esc(s.work)} ${esc(s.type || '')}／${esc(s.artist)}（${s.year}）</small>`
    + (s.staged ? '<button class="btn-main promote-btn" id="promoteBtn" type="button">✅ これはゲームデータに入れる</button><small class="promote-note">お試し中の曲です。押すと、ふだんの出題に入れる候補になります</small>' : '')
    + (s.id ? `<div class="song-tools"><button class="btn-sub" id="copySongBtn">📋 この曲をコピー</button>`
      + `<button class="btn-sub" id="keepSongBtn">${keptIds().has(s.id) ? '✓ 除外しない曲' : '🔁 この曲は除外しない'}</button>`
      + `<button class="btn-sub" id="fixToggle">⏱ 位置を直す${fixes()[s.id] ? '（直し済み）' : ''}</button></div><div class="fix-panel" id="fixPanel" hidden></div>` : '');
  if (s.id) setupSongTools(s, r);
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

socket.on('gameover', ({ ranking, titles = [], log, roomLog: rl, total, teams, survival, coop, bingo }) => {
  $('pickPanel').hidden = true; clearInterval(pickTick); $('coopBar').hidden = true; $('bingoBox').hidden = true;
  if (Array.isArray(log)) playLog = log;
  if (Array.isArray(rl)) roomLog = rl;
  clearInterval(nextTick); $('nextCount').textContent = ''; // 「結果発表まで」のカウントを止める
  stageMascot(null);
  $('qno').textContent = ''; $('timer').textContent = ''; $('barFill').style.width = '0';
  $('titles').innerHTML = titles.map(x => `<li>${avatarImg(x.avatar)}<div><b>${esc(x.title)}</b><span>${esc(x.name)}</span><small>${esc(x.why)}</small></div></li>`).join('');
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
      + teams.map(x => `<span class="team-${x.team}">${TEAM_LABEL[x.team]} ${x.score}点（${x.members}人）</span>`).join('');
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
