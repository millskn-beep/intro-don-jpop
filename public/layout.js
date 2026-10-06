// レイアウト編集（パソコンだけ・自分の画面だけ）とテスト1問
// ・画面の大きさ（キャンバス）を選び、その中で部品（ステージ・プレイヤー一覧・選択肢・答え合わせ・結果の表）を
//   ドラッグで移動、右下の角で大きさを変える。実際の画面にはキャンバスごと拡大・縮小して表示する。
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
// 初めの配置（キャンバスに対する割合 x, y, 幅, 高さ）
const DEFAULT = {
  // 答え合わせ中も選択肢は（薄く）出ているので、答え合わせ・結果の表を上、選択肢を下に分けて重ならないようにする
  side: [0, 0, 0.17, 1], stage: [0.18, 0, 0.82, 0.17],
  result: [0.18, 0.19, 0.54, 0.38], results: [0.73, 0.19, 0.27, 0.38], quiz: [0.18, 0.59, 0.82, 0.41],
};
const MIN = { w: 0.08, h: 0.06 };
const KEY = 'aq-layout';

export function initLayout({ socket, player, $, store, toast, getRoom, getMe, setPractice }) {
  const wide = matchMedia('(min-width: 900px)');
  const load = () => { try { return JSON.parse(store.get(KEY) || 'null') || {}; } catch (e) { return {}; } };
  let cfg = { on: false, preset: '1280x720', rects: {}, ...load() };
  const save = () => store.set(KEY, JSON.stringify(cfg));
  const rectOf = k => cfg.rects[k] || DEFAULT[k];
  let editing = false, practicing = false;
  const room = $('room'), results = $('results'), resultsHome = results.parentNode, resultsNext = results.nextSibling;

  // ── ツールバー ──
  const bar = document.createElement('div');
  bar.className = 'layout-bar'; bar.hidden = true;
  bar.innerHTML = `<b>レイアウト（この端末だけ）</b>
    <label><input type="checkbox" id="lyOn"> 自分の配置を使う</label>
    <label>画面の大きさ <select id="lyPreset"><option value="1280x720">1280×720</option><option value="1600x900">1600×900</option><option value="1920x1080">1920×1080</option><option value="window">今のウインドウ</option></select></label>
    <button class="btn-sub" id="lyEdit" type="button">配置を編集</button>
    <button class="btn-sub" id="lyTest" type="button">▶ テスト1問</button>
    <button class="btn-sub" id="lyReset" type="button">元に戻す</button>
    <button class="btn-sub" id="lyClose" type="button">閉じる</button>`;
  document.body.appendChild(bar);
  const openBtn = document.createElement('button');
  openBtn.className = 'btn-sub layout-open'; openBtn.type = 'button'; openBtn.textContent = '🧩 レイアウト';
  openBtn.title = '画面の配置を自分用に変える（パソコンだけ）';
  document.querySelector('.stage-tools').appendChild(openBtn);
  openBtn.onclick = () => { bar.hidden = !bar.hidden; };
  $('lyClose').onclick = () => { bar.hidden = true; setEditing(false); };
  $('lyOn').checked = cfg.on; $('lyPreset').value = cfg.preset;
  $('lyOn').onchange = e => { cfg.on = e.target.checked; save(); apply(); };
  $('lyPreset').onchange = e => { cfg.preset = e.target.value; save(); apply(); };
  $('lyEdit').onclick = () => setEditing(!editing);
  $('lyReset').onclick = () => { if (confirm('配置を初めの状態に戻しますか？')) { cfg.rects = {}; save(); apply(); } };
  $('lyTest').onclick = () => practicing ? endPractice() : startPractice();

  // ── 枠（編集中だけ表示。ドラッグで移動、右下の角で大きさ）──
  const frames = PARTS.map(p => {
    const f = document.createElement('div');
    f.className = 'layout-frame'; f.dataset.key = p.key;
    f.innerHTML = `<span>${p.label}</span><i class="layout-resize"></i>`;
    room.appendChild(f);
    return f;
  });

  function canvasSize() {
    if (cfg.preset === 'window') return [Math.round(innerWidth - 32), Math.round(innerHeight - 90)];
    return PRESETS[cfg.preset] || PRESETS['1280x720'];
  }
  let scale = 1;
  function active() {
    const b = document.body.classList;
    return wide.matches && (editing || (cfg.on && (practicing || b.contains('playing') || b.contains('revealing'))));
  }
  function apply() {
    const on = active();
    document.body.classList.toggle('layout-on', on);
    document.body.classList.toggle('layout-editing', on && editing);
    // 結果の表は、答え合わせの中から出してキャンバスに直接置く（別々に動かせるように）
    if (on && results.parentNode !== room) room.appendChild(results);
    if (!on && results.parentNode !== resultsHome) resultsHome.insertBefore(results, resultsNext);
    if (!on) {
      room.style.cssText = '';
      for (const p of PARTS) { const el = document.querySelector(p.sel); if (el) el.style.left = el.style.top = el.style.width = el.style.height = ''; }
      return;
    }
    const [W, H] = canvasSize();
    const top = document.querySelector('main > .top');
    const availW = document.querySelector('main').clientWidth - 32;
    const availH = innerHeight - (top ? top.getBoundingClientRect().bottom : 0) - 20;
    scale = Math.min(availW / W, availH / H, 4);
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
    apply();
  }
  // 出題・答え合わせ・ロビーの切り替え（body のクラス）に合わせて付け外し
  new MutationObserver(() => {
    const want = active();
    if (want !== document.body.classList.contains('layout-on')) apply();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', () => { if (document.body.classList.contains('layout-on')) apply(); });
  wide.addEventListener('change', apply);

  // ドラッグ（移動・大きさ）。キャンバスの縮小ぶん（scale）で割って、割合で保存する
  room.addEventListener('pointerdown', e => {
    const f = e.target.closest('.layout-frame');
    if (!f || !editing) return;
    e.preventDefault();
    const key = f.dataset.key, resize = e.target.classList.contains('layout-resize');
    const [W, H] = canvasSize();
    const start = [...rectOf(key)], sx = e.clientX, sy = e.clientY;
    f.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = (ev.clientX - sx) / scale / W, dy = (ev.clientY - sy) / scale / H;
      let [x, y, w, h] = start;
      if (resize) { w = Math.max(MIN.w, Math.min(1 - x, w + dx)); h = Math.max(MIN.h, Math.min(1 - y, h + dy)); }
      else { x = Math.max(0, Math.min(1 - w, x + dx)); y = Math.max(0, Math.min(1 - h, y + dy)); }
      cfg.rects[key] = [x, y, w, h].map(v => Math.round(v * 1000) / 1000);
      apply();
    };
    const up = () => { f.removeEventListener('pointermove', move); f.removeEventListener('pointerup', up); save(); };
    f.addEventListener('pointermove', move); f.addEventListener('pointerup', up);
  });

  // ── テスト1問（自分の画面だけ）──
  let timers = [], catalog = null, pq = null;
  let firing = false;
  const fire = (ev, data) => { firing = true; try { socket.listeners(ev).forEach(fn => fn(data)); } finally { firing = false; } };
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  async function startPractice() {
    const r = getRoom();
    if (!r || r.state !== 'lobby') return toast('テストは部屋の待機中に使えます');
    if (!catalog) { try { catalog = (await fetch('/api/catalog').then(x => x.json())).songs; } catch (e) { return toast('曲を読み込めませんでした'); } }
    const pool = catalog.filter(s => s.chorusKnown && (s.fame === 'top' || s.fame === 'famous'));
    const song = pool[Math.floor(Math.random() * pool.length)];
    const near = shuffle(catalog.filter(s => s.id !== song.id && s.work !== song.work && Math.abs(s.year - song.year) <= 5));
    const choices = shuffle([song, ...near.slice(0, 7)]).map(s => ({ title: s.title, work: s.work }));
    const S = { ...r.settings, answerMode: 'choice' };
    const plays = S.introPlays || 1;
    const hintAt = plays <= 1 ? S.hintAt : Math.max(S.hintAt, plays * S.introLen + (plays - 1) + 1.5);
    pq = { song, S, plays, hintAt, total: hintAt + S.chorusLen, correctIndex: choices.findIndex(c => c.title === song.title && c.work === song.work), t0: 0, done: false };
    practicing = true; setPractice(true);
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
    pq.t0 = performance.now() + 1000;
    fire('go', { intro: song.intro, start: song.intro, kind: 'intro', hintAt, total, offset: -1, introLen: S.introLen, plays, gap: 1 });
    const base = 1000;
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
      results: [{ id: getMe(), name: me?.name || 'あなた', avatar: me?.avatar, answered: !!a, index: a?.index ?? null, given: null, pass: !!a?.pass,
                  elapsed: a ? a.elapsed : null, correct: a?.index === correctIndex, points: 0, hint: false }],
      highlights: [], last: true, autoNext: 0,
    });
  }
  function endPractice() {
    timers.forEach(clearTimeout); timers = [];
    pq = null; practicing = false; setPractice(false);
    $('lyTest').textContent = '▶ テスト1問';
    player.stop();
    document.body.classList.remove('playing', 'revealing', 'fading');
    const r = getRoom();
    if (r) fire('room', r); // 部屋の待機中の表示に戻す
    apply();
  }
  // 本物の出題が始まったら（ホストが開始した）、テストはやめる。手元で起こした合図（fire）のときは無視
  socket.on('question', () => {
    if (!practicing || firing) return;
    timers.forEach(clearTimeout); timers = []; pq = null; practicing = false; setPractice(false);
    $('lyTest').textContent = '▶ テスト1問';
  });
  return { onReady, onAnswer, end: endPractice, isPracticing: () => practicing };
}
