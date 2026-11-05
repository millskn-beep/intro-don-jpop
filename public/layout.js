// レイアウト編集（パソコンだけ・自分の画面だけ）とテスト1問
// ・画面の大きさ（キャンバス）を選び、その中で部品（ステージ・プレイヤー一覧・選択肢・答え合わせ・結果の表）を
//   ドラッグで移動、右下の角で大きさを変える。実際の画面にはキャンバスごと拡大・縮小して表示する。
// ・配置は「出題中」と「答え合わせ」で別々に持つ。編集中は見本（選択肢・答え・結果の表）を出して見え方を確かめられる。
// ・部屋を作る前（トップ画面）からも編集できる（部屋の画面を見本として出す）。
// ・配置は端末に保存（localStorage）。位置はキャンバスに対する割合で持つので、画面の大きさを変えても形が崩れない。
// ・テスト1問：サーバーには送らず、本物の出題と同じ合図（question/go/hint/reveal）を手元で順に起こして、自分の画面だけで1問流す。
//   得点・除外・曲ログ・端末の記録には残らない。

const PRESETS = { '1280x720': [1280, 720], '1600x900': [1600, 900], '1920x1080': [1920, 1080], window: null };
const PARTS = [
  { key: 'side', label: 'プレイヤー一覧', sel: '.room-side' },
  { key: 'stage', label: 'ステージ', sel: '.room-main > .stage' },
  { key: 'quiz', label: '選択肢', sel: '#quiz' },
  { key: 'result', label: '答え合わせ', sel: '#result' },
  { key: 'results', label: '結果の表', sel: '#results' },
];
// 初めの配置（キャンバスに対する割合 x, y, 幅, 高さ）。出題中と答え合わせで別々
const DEFAULT = {
  // 出題中：選択肢を大きく
  play: { side: [0, 0, 0.17, 1], stage: [0.18, 0, 0.82, 0.17], quiz: [0.18, 0.19, 0.82, 0.81],
          result: [0.18, 0.19, 0.54, 0.38], results: [0.73, 0.19, 0.27, 0.38] },
  // 答え合わせ：選択肢も（薄く）出ているので、答え合わせ・結果の表を上、選択肢を下に分けて重ならないようにする
  reveal: { side: [0, 0, 0.17, 1], stage: [0.18, 0, 0.82, 0.17], quiz: [0.18, 0.59, 0.82, 0.41],
            result: [0.18, 0.19, 0.54, 0.38], results: [0.73, 0.19, 0.27, 0.38] },
};
// 「今のウインドウ」の初めの配置：選択肢を真ん中に、左にプレイヤー一覧、上にステージ、右に答え合わせ（上）と結果の表（下）
const WIN_RECTS = { side: [0, 0, 0.2, 1], stage: [0.215, 0, 0.57, 0.22], quiz: [0.215, 0.235, 0.57, 0.765],
                    result: [0.8, 0, 0.2, 0.6], results: [0.8, 0.615, 0.2, 0.385] };
const DEFAULT_WIN = { play: WIN_RECTS, reveal: WIN_RECTS };
const BASE = [1280, 720]; // 「今のウインドウ」は、この大きさを基準に中身（文字・ボタン）ごと拡大・縮小する
const PHASE_LABEL = { play: '出題中', reveal: '答え合わせ' };
const MIN = { w: 0.08, h: 0.06 };
const KEY = 'aq-layout';
// 編集中に出す見本
const SAMPLE_CHOICES = ['イントロの曲', 'となりの曲', 'あの名曲', '主題歌', 'オープニング', 'エンディング', '挿入歌', '劇場版の曲']
  .map((t, i) => ({ title: `${t}（見本）`, work: `作品 ${String.fromCharCode(65 + i)}` }));

export function initLayout({ socket, player, $, store, toast, getRoom, getMe, setPractice }) {
  const wide = { matches: false, addEventListener() {}, removeEventListener() {} }; // J-POP 版はスマホ専用（広い画面の配置は使わない）
  const load = () => { try { return JSON.parse(store.get(KEY) || 'null') || {}; } catch (e) { return {}; } };
  // 「自分の配置を使う」は最初からオン。ただし配置を一度も編集していなければ、ふつうの画面のまま（edited で判断）
  let cfg = { on: true, preset: '1280x720', rects: {}, ...load() };
  // 前の形（出題中・答え合わせの区別なし）から移す
  if (cfg.rects && !cfg.rects.play && !cfg.rects.reveal && Object.keys(cfg.rects).length) cfg.rects = { play: { ...cfg.rects }, reveal: { ...cfg.rects } };
  cfg.rects = { play: {}, reveal: {}, ...cfg.rects };
  cfg.rectsWin = { play: {}, reveal: {}, ...cfg.rectsWin }; // 「今のウインドウ」で編集した配置（ほかの大きさとは別に持つ）
  const save = () => store.set(KEY, JSON.stringify(cfg));
  let editing = false, practicing = false, editPhase = 'play', preview = false;
  const room = $('room'), results = $('results'), resultsHome = results.parentNode, resultsNext = results.nextSibling;
  const phase = () => (editing && !practicing) ? editPhase : (document.body.classList.contains('revealing') ? 'reveal' : 'play');
  const isWin = () => cfg.preset === 'window';
  const myRects = () => (isWin() ? cfg.rectsWin : cfg.rects); // いまの大きさで使う・保存する配置
  const rectOf = k => myRects()[phase()][k] || (isWin() ? DEFAULT_WIN : DEFAULT)[phase()][k];

  // ── ツールバー ──
  const bar = document.createElement('div');
  bar.className = 'layout-bar'; bar.hidden = true;
  bar.innerHTML = `<b>レイアウト（この端末だけ）</b>
    <label><input type="checkbox" id="lyOn"> 自分の配置を使う</label>
    <label>画面の大きさ <select id="lyPreset"><option value="1280x720">1280×720</option><option value="1600x900">1600×900</option><option value="1920x1080">1920×1080</option><option value="window">今のウインドウ</option></select></label>
    <button class="btn-sub" id="lyEdit" type="button">配置を編集</button>
    <span class="ly-phase" id="lyPhase" hidden><button type="button" data-phase="play">出題中</button><button type="button" data-phase="reveal">答え合わせ</button></span>
    <button class="btn-sub" id="lyTest" type="button">▶ テスト1問</button>
    <button class="btn-sub" id="lyReset" type="button">元に戻す</button>
    <button class="btn-sub" id="lyClose" type="button">閉じる</button>`;
  document.body.appendChild(bar);
  // 開くボタン：部屋のステージと、トップ画面（部屋を作る前）の2か所
  const addOpen = (parent, where) => {
    const b = document.createElement('button');
    b.className = 'btn-sub layout-open'; b.type = 'button'; b.textContent = '🧩 レイアウト';
    b.title = '画面の配置を自分用に変える（パソコンだけ）';
    b.onclick = () => openBar(where);
    parent.appendChild(b);
  };
  addOpen(document.querySelector('.stage-tools'), 'room');
  addOpen(document.querySelector('#roomListPanel .list-head'), 'home');
  function openBar(where) {
    if (!bar.hidden) return closeBar();
    bar.hidden = false;
    if (where === 'home' && room.hidden) enterPreview();
  }
  function closeBar() { bar.hidden = true; if (practicing) endPractice(); setEditing(false); exitPreview(); }
  $('lyClose').onclick = closeBar;
  $('lyOn').checked = cfg.on; $('lyPreset').value = cfg.preset;
  $('lyOn').onchange = e => { cfg.on = e.target.checked; save(); apply(); };
  $('lyPreset').onchange = e => { cfg.preset = e.target.value; save(); apply(); };
  $('lyEdit').onclick = () => setEditing(!editing);
  $('lyPhase').onclick = e => { const b = e.target.closest('button[data-phase]'); if (b) { editPhase = b.dataset.phase; samples(); apply(); } };
  $('lyReset').onclick = () => {
    if (!confirm(`「${PHASE_LABEL[phase()]}」の配置を初めの状態に戻しますか？`)) return;
    myRects()[phase()] = {}; save(); apply();
  };
  $('lyTest').onclick = () => practicing ? endPractice() : startPractice();

  // ── 部屋を作る前の見本表示（トップ画面から開いたとき）──
  const homeParts = ['home', 'roomListPanel', 'requestPanel'];
  function enterPreview() {
    if (preview || !room.hidden) return;
    preview = true;
    homeParts.forEach(id => { $(id).hidden = true; });
    room.hidden = false;
    document.body.classList.add('ly-preview');
    $('lobby').hidden = true;
    if (!$('players').children.length) {
      const name = ($('nameInput').value || store.get('aq-name') || 'あなた').trim();
      $('players').innerHTML = `<li class="me ly-sample"><span class="pl-name"><b>${name.replace(/[<>&]/g, '')}</b></span><span class="pts">0</span></li>`;
    }
  }
  function exitPreview() {
    if (!preview) return;
    preview = false;
    document.body.classList.remove('ly-preview');
    $('players').querySelectorAll('.ly-sample').forEach(li => li.remove());
    room.hidden = true;
    homeParts.forEach(id => { $(id).hidden = false; });
  }

  // ── 編集中の見本（選択肢・答え・結果の表）。本物の出題中（テスト1問など）は出さない ──
  let saved = null;
  function samples() {
    if (saved) { // いったん元に戻してから、出すかどうかを決める
      for (const [id, v] of Object.entries(saved.html)) $(id).innerHTML = v;
      for (const [id, v] of Object.entries(saved.hidden)) $(id).hidden = v;
      saved.classes.forEach(c => document.body.classList.remove(c));
      saved = null;
    }
    const b = document.body.classList;
    // 編集中で、本物の出題・答え合わせ（テスト1問を含む）が出ていないときだけ見本を出す
    if (!editing || practicing || b.contains('playing') || b.contains('revealing')) return;
    const ids = ['choices', 'answer', 'results', 'highlights', 'clues', 'phase', 'qno', 'timer'];
    saved = { html: Object.fromEntries(ids.map(id => [id, $(id).innerHTML])), hidden: { quiz: $('quiz').hidden, result: $('result').hidden, lobby: $('lobby').hidden, over: $('over').hidden }, classes: [] };
    document.body.classList.add('ly-sample'); saved.classes.push('ly-sample'); // 見本のあいだは背景の動画（空）を隠す
    $('choices').innerHTML = SAMPLE_CHOICES.map((c, i) => `<button class="choice${editPhase === 'reveal' && i === 2 ? ' correct' : ''}" data-i="${i}" disabled>${c.title}<small>${c.work}</small></button>`).join('');
    $('quiz').hidden = false; $('lobby').hidden = true; $('over').hidden = true;
    $('qno').textContent = '見本'; $('timer').textContent = editPhase === 'play' ? '12.3' : '';
    if (editPhase === 'reveal') {
      $('phase').textContent = '答え合わせ';
      $('answer').innerHTML = 'あの名曲（見本）<small>作品 C OP／歌手（2024）</small>';
      $('results').innerHTML = ['あなた', 'プレイヤー2', 'プレイヤー3'].map((n, i) =>
        `<tr><td class="who">${n}</td><td class="${i < 2 ? 'ok' : 'ng'}">${i < 2 ? '正解' : '不正解'}</td><td class="num">${(3.2 + i * 1.7).toFixed(2)}秒</td><td class="num">+${[920, 780, 0][i]}</td></tr>`).join('');
      $('result').hidden = false;
      for (const c of ['revealing', 'compact']) if (!document.body.classList.contains(c)) { document.body.classList.add(c); saved.classes.push(c); }
    } else {
      $('phase').textContent = 'イントロ再生中…（見本）';
      $('result').hidden = true;
    }
  }

  // ── 枠（編集中だけ表示。ドラッグで移動、右下の角で大きさ）──
  const frames = PARTS.map(p => {
    const f = document.createElement('div');
    f.className = 'layout-frame'; f.dataset.key = p.key;
    f.innerHTML = `<span>${p.label}</span><i class="layout-resize"></i>`;
    room.appendChild(f);
    return f;
  });

  // 表示できる広さ（真ん中の画面の幅 × 上のバーより下の高さ）
  function avail() {
    const top = document.querySelector('main > .top');
    return [document.querySelector('main').clientWidth - 32, innerHeight - (top ? top.getBoundingClientRect().bottom : 0) - 20];
  }
  // 「今のウインドウ」：広さいっぱいのキャンバス。中身は 1280×720 を基準にした倍率で拡大・縮小する（大きい画面ほど文字・ボタンも大きく）
  function winScale() { const [aw, ah] = avail(); return Math.max(0.5, Math.min(aw / BASE[0], ah / BASE[1])); }
  function canvasSize() {
    if (isWin()) { const [aw, ah] = avail(), s = winScale(); return [Math.round(aw / s), Math.round(ah / s)]; }
    return PRESETS[cfg.preset] || PRESETS['1280x720'];
  }
  let scale = 1, lastPhase = null;
  function active() {
    const b = document.body.classList;
    // 編集した配置がある、または「今のウインドウ」（選択肢を真ん中にした初めの配置をそのまま使う）
    const edited = isWin() || Object.keys(cfg.rects.play).length + Object.keys(cfg.rects.reveal).length > 0;
    // ゲーム中ずっと（読み込み中・まもなく… の間も）。playing/revealing だけで見ると、曲の読み込み中はふつうの画面に戻ってしまい、流れ始めた瞬間に配置が跳ぶ
    const inGame = b.contains('playing') || b.contains('revealing') || (getRoom()?.state === 'playing' && !getRoom()?.paused && !b.contains('in-lobby'));
    return wide.matches && (editing || (cfg.on && (edited || practicing) && (practicing || inGame)));
  }
  function apply() {
    const on = active();
    lastPhase = phase();
    document.body.classList.toggle('layout-on', on);
    document.body.classList.toggle('layout-editing', on && editing);
    document.body.classList.toggle('layout-win', on && isWin()); // 選択肢を枠いっぱいに（layout.css）
    $('lyPhase').hidden = !editing;
    $('lyPhase').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.phase === phase()); b.disabled = practicing; });
    // 結果の表は、答え合わせの中から出してキャンバスに直接置く（別々に動かせるように）
    if (on && results.parentNode !== room) room.appendChild(results);
    if (!on && results.parentNode !== resultsHome) resultsHome.insertBefore(results, resultsNext);
    if (!on) {
      room.style.cssText = '';
      for (const p of PARTS) { const el = document.querySelector(p.sel); if (el) el.style.left = el.style.top = el.style.width = el.style.height = ''; }
      return;
    }
    const [W, H] = canvasSize();
    const [availW, availH] = avail();
    scale = isWin() ? winScale() : Math.min(availW / W, availH / H, 4);
    room.style.cssText = `width:${W}px;height:${H}px;transform:scale(${scale});margin-left:${Math.max(0, (availW - W * scale) / 2)}px;`;
    for (const p of PARTS) {
      const [x, y, w, h] = rectOf(p.key);
      const css = `left:${x * W}px;top:${y * H}px;width:${w * W}px;height:${h * H}px;`;
      const el = document.querySelector(p.sel);
      if (el) Object.assign(el.style, { left: `${x * W}px`, top: `${y * H}px`, width: `${w * W}px`, height: `${h * H}px` });
      frames.find(f => f.dataset.key === p.key).style.cssText = css;
    }
  }
  function setEditing(on) {
    editing = on;
    $('lyEdit').textContent = on ? '編集を終える' : '配置を編集';
    if (on && !cfg.on) { cfg.on = true; $('lyOn').checked = true; save(); }
    samples(); apply();
  }
  // 出題・答え合わせ・ロビーの切り替え（body のクラス）に合わせて付け外し・配置の切り替え
  new MutationObserver(() => {
    const want = active();
    if (want !== document.body.classList.contains('layout-on') || (want && phase() !== lastPhase)) apply();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', () => { if (document.body.classList.contains('layout-on')) apply(); });
  // 真ん中の画面の幅が変わったら（双子が左右に分かれて狭くなる・戻るなど）、キャンバスの大きさと位置を計算し直す。
  // ウインドウの大きさは変わらないので resize だけでは気づけず、広いままの計算で右にはみ出していた
  new ResizeObserver(() => { if (document.body.classList.contains('layout-on')) apply(); }).observe(document.querySelector('main'));
  wide.addEventListener('change', apply);
  // 一時停止の設定画面に入るときは、body のクラスが変わった時点ではまだ部屋の状態（paused）が古い。
  // 部屋の更新でも判定し直して、配置を外す（外さないと設定画面がキャンバスからはみ出して、スクロールできない）
  socket.on('room', () => setTimeout(() => { if (active() !== document.body.classList.contains('layout-on')) apply(); }, 0));

  // ドラッグ（移動・大きさ）。キャンバスの縮小ぶん（scale）で割って、割合で保存する（いま見ている場面の配置に）
  room.addEventListener('pointerdown', e => {
    const f = e.target.closest('.layout-frame');
    if (!f || !editing) return;
    e.preventDefault();
    const key = f.dataset.key, resize = e.target.classList.contains('layout-resize'), ph = phase();
    const [W, H] = canvasSize();
    const start = [...rectOf(key)], sx = e.clientX, sy = e.clientY;
    f.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = (ev.clientX - sx) / scale / W, dy = (ev.clientY - sy) / scale / H;
      let [x, y, w, h] = start;
      if (resize) { w = Math.max(MIN.w, Math.min(1 - x, w + dx)); h = Math.max(MIN.h, Math.min(1 - y, h + dy)); }
      else { x = Math.max(0, Math.min(1 - w, x + dx)); y = Math.max(0, Math.min(1 - h, y + dy)); }
      myRects()[ph][key] = [x, y, w, h].map(v => Math.round(v * 1000) / 1000);
      apply();
    };
    const up = () => { f.removeEventListener('pointermove', move); f.removeEventListener('pointerup', up); save(); };
    f.addEventListener('pointermove', move); f.addEventListener('pointerup', up);
  });

  // ── テスト1問（自分の画面だけ）──
  let timers = [], catalog = null, pq = null, firing = false;
  const fire = (ev, data) => { firing = true; try { socket.listeners(ev).forEach(fn => fn(data)); } finally { firing = false; } };
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // 部屋を作る前（見本表示）は、ふつうの設定で流す
  const BASE_SETTINGS = { introLen: 5, hintAt: 10, chorusLen: 15, introPlays: 1, choices: 8, answerMode: 'choice', clues: true, bonus: true, autoNext: 0 };
  async function startPractice() {
    const r = getRoom();
    if (!preview && (!r || r.state !== 'lobby')) return toast('テストは部屋の待機中か、トップ画面のレイアウトから使えます');
    if (!catalog) { try { catalog = (await fetch('/api/catalog').then(x => x.json())).songs; } catch (e) { return toast('曲を読み込めませんでした'); } }
    const pool = catalog.filter(s => s.chorusKnown && (s.fame === 'top' || s.fame === 'famous'));
    const song = pool[Math.floor(Math.random() * pool.length)];
    const near = shuffle(catalog.filter(s => s.id !== song.id && s.work !== song.work && Math.abs(s.year - song.year) <= 5));
    const choices = shuffle([song, ...near.slice(0, 7)]).map(s => ({ title: s.title, work: s.work }));
    // テスト1問は、部屋の遊び方（早押し・サバイバル・作品／年代当てなど）にかかわらず、いつもの1問
    const S = { ...BASE_SETTINGS, ...(preview ? {} : r.settings), answerMode: 'choice', play: 'normal', target: 'song', speed: '1' };
    const plays = S.introPlays || 1;
    const hintAt = plays <= 1 ? S.hintAt : Math.max(S.hintAt, plays * S.introLen + (plays - 1) + 1.5);
    pq = { song, S, plays, hintAt, total: hintAt + S.chorusLen, correctIndex: choices.findIndex(c => c.title === song.title && c.work === song.work), t0: 0, done: false };
    practicing = true; setPractice(true);
    samples(); // 見本は外す（本物の表示にする）
    document.body.classList.remove('in-lobby'); // 待機中の表示（ステージの絵・残り時間を隠す）を外す。終わったら部屋の描き直しで戻る
    $('lyTest').textContent = '■ テストを終える';
    fire('question', { qNo: 1, qTotal: 1, videoId: song.id, intro: song.intro, start: song.intro, kind: 'intro', final: false, answerMode: 'choice', choices, settings: S });
    $('qno').textContent = 'テスト（得点・記録には残りません）';
    apply();
  }
  // 動画の準備ができたら（本来はサーバーへ ready を送るところ）流し始める
  function onReady() {
    if (!pq || pq.t0) return;
    const { song, S, plays, hintAt, total } = pq;
    // 本物と同じく、最初の問題は 3・2・1・START! のあとに流す
    const CD = 3;
    fire('countdown', { sec: CD });
    pq.t0 = performance.now() + CD * 1000 + 1000;
    later(() => fire('go', { intro: song.intro, start: song.intro, kind: 'intro', hintAt, total, offset: -1, introLen: S.introLen, plays, gap: 1 }), CD * 1000);
    const base = CD * 1000 + 1000;
    for (let i = 0; i < plays; i++) {
      const at = i * (S.introLen + 1);
      if (i > 0) later(() => fire('restartIntro', { n: i + 1, plays }), base + at * 1000);
      if (at + S.introLen < hintAt) later(() => fire('stopIntro'), base + (at + S.introLen) * 1000);
    }
    later(() => fire('hint', { chorus: song.chorus, known: song.chorusKnown, intro: song.intro, seek: true }), base + hintAt * 1000);
    later(reveal, base + total * 1000);
  }
  function onAnswer(a) {
    if (!pq || pq.done) return;
    pq.answer = { ...a, elapsed: Math.max(0, (performance.now() - pq.t0) / 1000) };
    timers.forEach(clearTimeout); timers = [];
    later(reveal, 600);
  }
  function reveal() {
    if (!pq || pq.done) return;
    pq.done = true;
    const { song, correctIndex } = pq, a = pq.answer, r = getRoom(), me = r?.players.find(p => p.id === getMe());
    fire('reveal', {
      correctIndex,
      song: { id: song.id, title: song.title, work: song.work, artist: song.artist, year: song.year, type: song.type },
      intro: song.intro, chorus: song.chorus, chorusKnown: song.chorusKnown,
      results: [{ id: getMe(), name: me?.name || ($('nameInput').value || 'あなた'), avatar: me?.avatar, answered: !!a, index: a?.index ?? null, given: null, pass: !!a?.pass,
                  elapsed: a ? a.elapsed : null, correct: a?.index === correctIndex, points: 0, hint: false }],
      highlights: [], last: true, autoNext: 0,
    });
    if (preview) $('nextBtn').hidden = false; // 見本表示では「結果発表へ」でテストを終える
  }
  function endPractice() {
    timers.forEach(clearTimeout); timers = [];
    pq = null; practicing = false; setPractice(false);
    $('lyTest').textContent = '▶ テスト1問';
    player.stop();
    document.body.classList.remove('playing', 'revealing', 'fading', 'compact');
    const r = getRoom();
    if (r && !preview) fire('room', r); // 部屋の待機中の表示に戻す
    else { $('quiz').hidden = true; $('result').hidden = true; }
    samples(); apply();
  }
  // 本物の出題が始まったら（ホストが開始した）、テストはやめる。手元で起こした合図（fire）のときは無視
  socket.on('question', () => {
    if (!practicing || firing) return;
    timers.forEach(clearTimeout); timers = []; pq = null; practicing = false; setPractice(false);
    $('lyTest').textContent = '▶ テスト1問';
  });
  return { onReady, onAnswer, end: endPractice, isPracticing: () => practicing };
}
