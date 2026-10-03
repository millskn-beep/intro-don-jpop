import { createPlayer } from './player.js';

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

// ── テーマ（背景・アイコン・表彰台の画像を切り替える）──
const THEMES = ['neon', 'studio', 'pop', 'retro'];
let currentTheme = null;
function applyTheme(t) {
  if (!THEMES.includes(t) || t === currentTheme) return;
  currentTheme = t;
  document.documentElement.dataset.theme = t;
  $('emblem').src = `assets/${t}/emblem.webp`;
  $('podiumImg').src = `assets/${t}/podium.webp`;
  document.querySelectorAll('[data-icon]').forEach(img => { img.src = `assets/${t}/icon-${img.dataset.icon}.webp`; });
}
applyTheme(THEMES[Math.floor(Math.random() * THEMES.length)]); // 入室前はランダム

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

// ── ホーム ──
function enter(event, payload) {
  const name = $('nameInput').value.trim();
  if (!name) { $('homeError').textContent = '名前を入れてください'; return; }
  store.set('aq-name', name);
  player.prime(WARMUP_VIDEO); // タップの中で一度再生して、スマホの音声制限を解除する
  socket.emit(event, { ...payload, token, name }, res => {
    if (!res.ok) { $('homeError').textContent = res.error; return; }
    joined(res);
  });
}
$('createBtn').onclick = () => enter('create', {});
$('joinBtn').onclick = () => enter('join', { code: $('codeInput').value });
$('codeInput').onkeydown = e => { if (e.key === 'Enter') $('joinBtn').click(); };

function joined(res) {
  me = res.you;
  store.set('aq-room', res.code);
  history.replaceState(null, '', '?room=' + res.code);
  $('home').hidden = true; $('room').hidden = false;
  $('roomCode').hidden = false; $('roomCode').textContent = res.code;
  $('inviteUrl').value = location.origin + location.pathname + '?room=' + res.code;
  renderRoom(res.room);
}

// 再接続：同じ部屋・同じ席に戻る
socket.on('connect', () => {
  const code = me ? store.get('aq-room') : null;
  if (code) socket.emit('join', { code, token, name: store.get('aq-name') }, res => res.ok ? joined(res) : leaveToHome(res.error));
});
function leaveToHome(msg) {
  me = null; $('room').hidden = true; $('home').hidden = false; $('roomCode').hidden = true;
  $('homeError').textContent = msg || '';
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
const STRING_KEYS = ['mode', 'answerMode', 'theme'], BOOL_KEYS = ['clues', 'lifelines'];
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
$('startBtn').onclick = () => socket.emit('start');
$('nextBtn').onclick = () => socket.emit('next');
$('lobbyBtn').onclick = () => socket.emit('backToLobby');

// ── 部屋の状態 ──
socket.on('room', renderRoom);
function renderRoom(r) {
  const prevState = room?.state;
  const prevScores = new Map((room?.players || []).map(p => [p.id, p.score]));
  room = r;
  applyTheme(r.theme);
  const isHost = r.hostId === me;
  document.querySelectorAll('#settings select').forEach(sel => {
    sel.value = String(r.settings[sel.dataset.key]);
    sel.disabled = !isHost;
  });
  $('presets').hidden = !isHost;
  $('poolInfo').textContent = `${r.settings.yearFrom}〜${r.settings.yearTo}年：出題できる曲 ${r.poolSize} 曲` +
    (r.poolSize < r.settings.questions ? `（${r.settings.questions}問に足りないので ${r.poolSize} 問で出題します）` : '');
  $('startBtn').disabled = r.poolSize === 0;
  $('startBtn').hidden = !isHost; $('waitHost').hidden = isHost;
  $('nextBtn').hidden = !isHost; $('waitNext').hidden = isHost;
  $('lobbyBtn').hidden = !isHost;

  if (r.state === 'lobby') show('lobby');
  else if (r.state === 'playing' && prevState !== 'playing' && !question) {
    // 途中参加：次の問題から
    show('quiz'); $('choices').innerHTML = ''; $('quizNote').textContent = '次の問題から参加します';
  }
  if (r.state === 'lobby') { setPhase('', '待機中'); $('qno').textContent = ''; }

  myLifelines = r.players.find(p => p.id === me)?.lifelines || null;
  updateLifelineButtons();

  $('players').innerHTML = r.players.map(p => `
    <li class="${p.answered ? 'answered' : ''} ${p.connected ? '' : 'off'}">
      <span>${esc(p.name)}${p.id === r.hostId ? '<span class="host">HOST</span>' : ''}${p.id === me ? '（あなた）' : ''}</span>
      <span class="pts${prevScores.has(p.id) && p.score > prevScores.get(p.id) ? ' bump' : ''}">${p.score}</span>
    </li>`).join('');
}

// ── 演出 ──
function flash(kind, text, sub = '') {
  const el = $('flash');
  el.className = 'flash ' + kind;
  el.innerHTML = `<span>${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
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
  question = q; myAnswer = null; answering = false;
  stopTick();
  $('timer').textContent = '0.0'; $('barFill').style.width = '0';
  $('barMark').style.left = (q.settings.hintAt / (q.settings.hintAt + q.settings.chorusLen) * 100) + '%';
  $('qno').textContent = `第 ${q.qNo} / ${q.qTotal} 問`;
  $('cover').hidden = false; $('cover').textContent = '？';
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
  player.load(q.videoId, q.intro);
});

// offset は途中から戻ってきた人向け（経過秒）
socket.on('go', ({ intro, hintAt, total, offset = 0, introLen }) => {
  if (!offset) player.start(intro);
  else if (offset < introLen && offset < hintAt) player.start(intro + offset);
  setPhase('intro', 'イントロ');
  if (myAnswer === null) {
    answering = true;
    $('choices').querySelectorAll('.choice:not(.gone)').forEach(b => b.disabled = false);
    $('answerInput').disabled = false; $('sendBtn').disabled = false;
    if (isInput() && !offset) $('answerInput').focus();
  }
  updateLifelineButtons();
  stopTick();
  timerStart = performance.now() - offset * 1000;
  tick = setInterval(() => {
    const t = (performance.now() - timerStart) / 1000;
    $('timer').textContent = Math.min(t, total).toFixed(1);
    $('barFill').style.width = Math.min(100, t / total * 100) + '%';
    $('barFill').style.background = t >= hintAt ? 'var(--warn)' : 'var(--accent2)';
  }, 50);
});
socket.on('stopIntro', () => player.stopIntro());
socket.on('hint', ({ chorus }) => { player.hint(chorus); setPhase('chorus', 'サビ（ヒント・得点半分）'); });

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
  $('quizNote').textContent = pass ? 'パスしました。答え合わせを待っています…' : '回答しました。答え合わせを待っています…';
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
  answering = false; updateLifelineButtons();
  $('answerInput').disabled = true; $('sendBtn').disabled = true;
  setPhase('reveal', '答え合わせ');
  $('cover').hidden = true;
  player.reveal(r.intro, r.chorus);
  $('choices').querySelectorAll('.choice').forEach(b => {
    b.disabled = true;
    if (+b.dataset.i === r.correctIndex) b.classList.add('correct');
    else if (+b.dataset.i === myAnswer) b.classList.add('wrong');
  });
  const s = r.song;
  $('answer').innerHTML = `${esc(s.title)}<small>${esc(s.work)} ${esc(s.type || '')}／${esc(s.artist)}（${s.year}）</small>`;
  $('results').innerHTML = r.results.map(x => `
    <tr>
      <td>${esc(x.name)}</td>
      <td class="${x.correct ? 'ok' : 'ng'}">${!x.answered ? '未回答' : x.pass ? 'パス' : x.correct ? '正解' + (x.hint ? '（サビ）' : '') : '不正解'}${x.given ? `<small>「${esc(x.given)}」</small>` : ''}</td>
      <td class="num">${x.elapsed === null ? '' : x.elapsed.toFixed(2) + '秒'}</td>
      <td class="num">+${x.points}</td>
    </tr>`).join('');
  // 自分の結果を大きく表示
  const mine = r.results.find(x => x.id === me);
  if (mine) {
    if (mine.correct) { flash('ok', '正解！', `+${mine.points}`); confetti(40); }
    else if (mine.pass) flash('ng', 'パス');
    else if (!mine.answered) flash('ng', '時間切れ');
    else flash('ng', '不正解');
  }
  $('nextBtn').textContent = r.last ? '結果発表へ' : '次の問題へ';
  // 選択肢を見せたまま結果を下に出す
  $('quiz').hidden = false; $('result').hidden = false;
});

socket.on('gameover', ({ ranking }) => {
  question = null;
  player.stop(); stopTick();
  setPhase('', '終了');
  // 上位3人は表彰台に、全員の順位は下の一覧に
  $('places').innerHTML = ranking.slice(0, 3).map((p, i) =>
    `<div class="place p${i + 1}"><b>${['🥇', '🥈', '🥉'][i]}</b>${esc(p.name)}<span><br>${p.score}点</span></div>`).join('');
  $('ranking').innerHTML = ranking.map(p => `<li>${esc(p.name)}<span>${p.score}点</span></li>`).join('');
  show('over');
  confetti(160);
  if (ranking[0]?.id === me) flash('ok', '優勝！');
});

socket.on('notice', msg => toast(msg));

function stopTick() { clearInterval(tick); tick = null; }

let toastTimer = null;
function toast(msg) {
  $('toast').textContent = msg; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500);
}
