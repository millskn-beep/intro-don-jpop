// アニソンBGM：収録曲を条件（ジャンル・年代・種類・知名度・アニメのタイトル・お気に入り・プレイリスト）で選んで流し続ける
// お気に入り・プレイリストはマイページ（名前だけのログイン）に保存。歌詞は合言葉を入れた端末だけ（サーバーのメモリにある歌詞）
// データ節約：YouTube は音だけを流せないので、プレーヤーを小さくして低い画質で送らせる
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できなくても続ける */ } } };
const getName = () => { try { return localStorage.getItem('aq-user') || ''; } catch (e) { return ''; } };
const setName = n => { try { localStorage.setItem('aq-user', n); } catch (e) { /* 続ける */ } };
let toastTimer = null;
const toast = msg => { $('toast').textContent = msg; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600); };
const fmt = t => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s・！!？?「」『』（）()〜~ー－-]/g, '');

const LENS = [['full', 'フル'], ['tv', 'TVサイズ（約1分30秒）'], ['chorus', 'サビだけ（約45秒）']];
const ORDERS = [['shuffle', 'シャッフル'], ['new', '新しい順'], ['old', '古い順']];
const SAVES = [['auto', '自動'], ['on', 'オン'], ['off', 'オフ']];
const PIPS = [['off', 'オフ'], ['on', 'オン']];
const TYPES = [['OP', 'OP'], ['ED', 'ED'], ['挿入歌', '挿入歌'], ['other', 'その他']];
const typeOf = s => (/^OP/i.test(s.type) ? 'OP' : /^ED/i.test(s.type) ? 'ED' : /挿入/.test(s.type) ? '挿入歌' : 'other');

let cat = { songs: [], genres: [], fame: [] }, byId = new Map();
let user = null;
let cfg = Object.assign({ src: 'all', genres: [], decades: [], types: [], fame: [], work: '', len: 'full', order: 'shuffle', save: 'auto', pip: 'off' }, store.get('aq-bgm', {}));
let queue = [], qi = -1, history = [], cur = null, seg = { start: 0, end: null };
let yt = null, ytReady = false, playing = false;

// ── データ節約：自動なら、Android はモバイル回線・節約モードで判断。分からない端末（iPhone など）は、スマホなら節約する ──
function saving() {
  if (cfg.save !== 'auto') return cfg.save === 'on';
  const c = navigator.connection;
  if (c && (c.saveData || c.type === 'cellular' || /(^|-)2g|3g/.test(c.effectiveType || ''))) return true;
  if (c && c.type && c.type !== 'unknown') return false; // wifi・ethernet など
  return matchMedia('(pointer: coarse)').matches;
}
function applySave() {
  const s = saving();
  $('videoBox').classList.toggle('small', s && cfg.pip !== 'on'); // PiP用のときは小さくしない（全画面・PiP のボタンを押せるように）
  $('saveHint').textContent = cfg.save === 'auto' ? `いまは${s ? 'オン（小さい画面・低い画質）' : 'オフ（ふつうの画質）'}。iPhone は回線を見分けられないので、Wi-Fi のときはオフにしてください` : '';
  if (yt && ytReady && yt.setPlaybackQuality) yt.setPlaybackQuality(s ? 'tiny' : 'default');
}

// ── 曲の条件 ──
function filtered() {
  const block = new Set(user?.block || []);
  let list;
  if (cfg.src === 'fav') list = (user?.fav || []).map(id => byId.get(id)).filter(Boolean);
  else if (cfg.src.startsWith('pl:')) list = (user?.playlists?.[cfg.src.slice(3)] || []).map(id => byId.get(id)).filter(Boolean);
  else list = cat.songs.filter(s => !block.has(s.id));
  const g = new Set(cfg.genres), d = new Set(cfg.decades), t = new Set(cfg.types), f = new Set(cfg.fame), w = norm(cfg.work);
  return list.filter(s => (!g.size || s.genres.some(x => g.has(x))) && (!d.size || d.has(Math.floor(s.year / 10) * 10)) && (!t.size || t.has(typeOf(s))) && (!f.size || f.has(s.fame)) && (!w || norm(s.work).includes(w)));
}
function buildQueue() {
  const list = filtered();
  if (cfg.order === 'shuffle') { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } }
  else list.sort((a, b) => cfg.order === 'new' ? b.year - a.year : a.year - b.year);
  queue = list; qi = -1;
}
function srcLabel() { return cfg.src === 'fav' ? 'お気に入り' : cfg.src.startsWith('pl:') ? `プレイリスト「${cfg.src.slice(3)}」` : 'すべての曲'; }
function summary() {
  const parts = [srcLabel()];
  if (cfg.genres.length) parts.push(cfg.genres.map(k => cat.genres.find(g => g.key === k)?.label || k).join('・'));
  if (cfg.decades.length) parts.push(cfg.decades.map(x => `${x}年代`).join('・'));
  if (cfg.types.length) parts.push(cfg.types.map(x => x === 'other' ? 'その他' : x).join('・'));
  if (cfg.fame.length) parts.push(cfg.fame.map(k => cat.fame.find(x => x.key === k)?.label || k).join('・'));
  if (cfg.work) parts.push(`「${cfg.work}」`);
  parts.push(LENS.find(x => x[0] === cfg.len)[1]);
  $('pickSum').textContent = `${parts.join('／')}（${filtered().length}曲）`;
}

// ── 再生 ──
function segOf(s) {
  const intro = s.intro || 0, ch = s.chorus || 0;
  if (cfg.len === 'chorus' && ch > 0) return { start: Math.max(0, ch - 1), end: ch + 44 };
  if (cfg.len === 'tv') return { start: intro, end: intro + 90 };
  return { start: intro, end: null };
}
function playSong(s, push = true) {
  if (!s) return;
  if (push && cur) history.push(cur.id);
  cur = s; seg = segOf(s);
  $('nowTitle').textContent = s.title;
  $('nowSub').textContent = `${s.work}／${s.artist}（${s.year}）`;
  $('bgArt').style.backgroundImage = `url(https://i.ytimg.com/vi/${s.id}/mqdefault.jpg)`;
  showFav(); renderQueue();
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.artist, album: s.work, artwork: [{ src: `https://i.ytimg.com/vi/${s.id}/mqdefault.jpg`, sizes: '320x180', type: 'image/jpeg' }] });
  lyrics = null; if (!$('lyBox').hidden) loadLyrics();
  if (!ytReady) return;
  yt.loadVideoById({ videoId: s.id, startSeconds: seg.start, ...(seg.end ? { endSeconds: seg.end } : {}), suggestedQuality: saving() ? 'tiny' : 'default' });
}
function next() {
  if (!queue.length) buildQueue();
  if (!queue.length) return toast('条件に合う曲がありません');
  qi++;
  if (qi >= queue.length) { buildQueue(); qi = 0; }
  playSong(queue[qi]);
}
function prev() {
  if (yt && ytReady && yt.getCurrentTime() - seg.start > 5) return yt.seekTo(seg.start, true); // 曲の途中なら頭から
  const id = history.pop(); if (!id) return;
  const s = byId.get(id); const i = queue.indexOf(s); if (i >= 0) qi = i;
  playSong(s, false);
}
function toggle() {
  if (!cur) return next();
  if (!ytReady) return;
  if (playing) yt.pauseVideo(); else yt.playVideo();
}

// YouTube プレーヤー
// PiP用（画面を消しても聞きたいとき）：YouTube 自身のボタン（全画面など）を出す。iPhone の Safari は全画面から PiP にできることがある
let ytPip = null;
function makePlayer() {
  ytPip = cfg.pip === 'on';
  if (yt) { yt.destroy(); $('videoBox').innerHTML = '<div id="yt"></div>'; }
  ytReady = false; playing = false;
  $('pipHint').hidden = !ytPip;
  yt = new YT.Player('yt', {
    width: '100%', height: '100%',
    playerVars: ytPip ? { controls: 1, rel: 0, playsinline: 1, fs: 1, modestbranding: 1, iv_load_policy: 3, origin: location.origin }
      : { controls: 0, disablekb: 1, rel: 0, playsinline: 1, fs: 0, modestbranding: 1, iv_load_policy: 3, origin: location.origin },
    events: {
      onReady: () => { ytReady = true; applySave(); if (cur) playSong(cur, false); },
      onStateChange: e => {
        playing = e.data === YT.PlayerState.PLAYING;
        $('playIcon').setAttribute('href', playing ? '#i-pause' : '#i-play');
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
        if (e.data === YT.PlayerState.ENDED) next();
      },
      onError: () => { toast('この曲は流せないので次へ'); setTimeout(next, 800); },
    },
  });
}
window.onYouTubeIframeAPIReady = makePlayer;
const tag = document.createElement('script'); tag.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(tag);

// 進み具合（0.25秒ごと）。終わりの時刻を過ぎたら次へ（endSeconds が効かないときの保険）
let seeking = false;
setInterval(() => {
  if (!ytReady || !cur) return;
  const t = yt.getCurrentTime() || 0, dur = yt.getDuration() || 0;
  const a = seg.start, b = seg.end ? Math.min(seg.end, dur || seg.end) : dur;
  if (!seeking) { $('seek').max = Math.max(1, b - a); $('seek').value = Math.max(0, t - a); }
  $('tCur').textContent = fmt(t - a); $('tEnd').textContent = fmt(b - a);
  if (playing && seg.end && t >= seg.end + 0.5) next();
  if (lyrics?.sync) markLine(t);
}, 250);
$('seek').addEventListener('input', () => { seeking = true; });
$('seek').addEventListener('change', () => { seeking = false; if (ytReady) yt.seekTo(seg.start + +$('seek').value, true); });

$('play').onclick = toggle; $('next').onclick = next; $('prev').onclick = prev;
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => yt?.playVideo()); ms.setActionHandler('pause', () => yt?.pauseVideo());
  ms.setActionHandler('nexttrack', next); ms.setActionHandler('previoustrack', prev);
}

// ── ログイン・お気に入り・プレイリスト ──
async function api(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.error || 'うまくいきませんでした'); return null; }
  return j;
}
let afterLogin = null;
function needLogin(fn) { if (user) return fn(); afterLogin = fn; openSheet('loginSheet'); $('loginName').focus(); }
$('loginForm').onsubmit = async e => {
  e.preventDefault();
  const j = await api('/api/user/login', { name: $('loginName').value }); if (!j) return;
  user = j.user; setName(user.name); closeSheets(); toast(`${user.name} さんで保存します`);
  const fn = afterLogin; afterLogin = null; fn && fn();
};
function showFav() { const on = !!(cur && user?.fav.includes(cur.id)); $('fav').classList.toggle('on', on); $('favIcon').setAttribute('href', on ? '#i-heart-on' : '#i-heart'); }
$('fav').onclick = () => cur && needLogin(async () => {
  const on = !user.fav.includes(cur.id);
  const j = await api('/api/user/list', { name: user.name, list: 'fav', id: cur.id, on }); if (!j) return;
  user = j.user; showFav(); toast(on ? 'お気に入りに入れました' : 'お気に入りから外しました');
});
function renderPl() {
  const P = user?.playlists || {};
  $('plList').innerHTML = Object.entries(P).map(([n, ids]) => `<li><button data-pl="${esc(n)}" class="${ids.includes(cur?.id) ? 'on' : ''}"><span>${ids.includes(cur?.id) ? '✓ ' : ''}${esc(n)}</span><small>${ids.length}曲</small></button></li>`).join('') || '<li class="hint">まだプレイリストがありません</li>';
}
$('addPl').onclick = () => cur && needLogin(() => { renderPl(); openSheet('plSheet'); });
$('plList').onclick = async e => {
  const b = e.target.closest('[data-pl]'); if (!b || !cur) return;
  const n = b.dataset.pl, on = !user.playlists[n].includes(cur.id);
  const j = await api('/api/user/playlist', { name: user.name, pl: n, id: cur.id, on }); if (!j) return;
  user = j.user; renderPl(); toast(on ? `「${n}」に入れました` : `「${n}」から外しました`);
};
$('plNew').onsubmit = async e => {
  e.preventDefault(); const n = $('plName').value.trim(); if (!n || !cur) return;
  const j = await api('/api/user/playlist', { name: user.name, pl: n, id: cur.id, on: true }); if (!j) return;
  user = j.user; $('plName').value = ''; renderPl(); toast(`「${n}」に入れました`);
};

// ── 歌詞（合言葉） ──
let lyrics = null, lyFor = null;
async function loadLyrics() {
  if (!cur) return;
  const pass = store.get('aq-lypass', '');
  if (!pass) { openSheet('passSheet'); $('passIn').focus(); return; }
  showPanel('ly');
  const id = cur.id; lyFor = id;
  $('lyNote').textContent = '読み込み中…'; $('lyLines').innerHTML = '';
  const r = await fetch('/api/bgm/lyrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass, id }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 403) { store.set('aq-lypass', ''); showPanel(null); toast('合言葉が違います'); return; }
  if (lyFor !== id) return;
  if (!r.ok || !j.lines) { lyrics = null; $('lyNote').textContent = r.ok ? 'この曲の歌詞はありません' : (j.error || '読み込めませんでした'); return; }
  lyrics = { lines: j.lines, sync: j.sync && j.lines.every(x => x.t != null) };
  $('lyNote').textContent = lyrics.sync ? '曲に合わせて進みます' : '時刻のない歌詞です';
  $('lyLines').classList.toggle('plain', !lyrics.sync);
  $('lyLines').innerHTML = j.lines.map((x, i) => `<p data-i="${i}">${esc(x.text)}</p>`).join('');
  curLine = -1;
}
let curLine = -1;
function markLine(t) {
  const L = lyrics.lines; let i = -1;
  for (let k = 0; k < L.length; k++) { if (L[k].t <= t + 0.2) i = k; else break; }
  if (i === curLine) return;
  curLine = i;
  const box = $('lyLines'); box.querySelectorAll('p.cur').forEach(p => p.classList.remove('cur'));
  const p = box.querySelector(`p[data-i="${i}"]`);
  if (p) { p.classList.add('cur'); box.scrollTop = p.offsetTop - box.clientHeight / 3; }
}
$('lyBtn').onclick = () => { if (!$('lyBox').hidden) return showPanel(null); loadLyrics(); };

// ── 下の窓：歌詞 か 前後の曲（いまの曲の表示は隠さない・再生は止めない） ──
function showPanel(which) {
  $('lyBox').hidden = which !== 'ly'; $('lyBtn').classList.toggle('on', which === 'ly');
  $('qBox').hidden = which !== 'q'; $('qBtn').classList.toggle('on', which === 'q');
}
$('qBtn').onclick = () => { if (!$('qBox').hidden) return showPanel(null); showPanel('q'); renderQueue(); };
// 前の10曲（聴いた順）・いまの曲・次の20曲。押すとその曲へ
const Q_PAST = 10, Q_NEXT = 20;
function renderQueue() {
  if ($('qBox').hidden) return;
  const row = (s, cls, at, tag = '') => `<button class="q ${cls}" data-at="${at}"><img loading="lazy" src="https://i.ytimg.com/vi/${esc(s.id)}/default.jpg" alt=""><span class="info"><b>${esc(s.title)}</b><small>${esc(s.work)}／${esc(s.artist)}</small></span>${tag}</button>`;
  const past = history.slice(-Q_PAST).map((id, i, a) => [byId.get(id), history.length - a.length + i]).filter(x => x[0]);
  const nexts = []; for (let k = 1; k <= Q_NEXT && qi + k < queue.length; k++) nexts.push([queue[qi + k], qi + k]);
  let h = '';
  if (past.length) h += '<div class="qsep">前の曲</div>' + past.map(([s, i]) => row(s, 'past', 'h' + i)).join('');
  if (cur) h += '<div class="qsep">いま</div>' + row(cur, 'cur', 'cur', '<span class="tag">再生中</span>');
  h += '<div class="qsep">次の曲</div>' + (nexts.map(([s, i]) => row(s, '', 'q' + i)).join('') || '<div class="qsep">（最後まで流したら、また最初から並べ直します）</div>');
  $('qList').innerHTML = h;
  $('qNote').textContent = cur ? `${srcLabel()}・${qi + 1}／${queue.length}曲` : '';
  const c = $('qList').querySelector('.q.cur'); if (c) $('qList').scrollTop = c.offsetTop - 40;
}
$('qList').onclick = e => {
  const b = e.target.closest('[data-at]'); if (!b || b.dataset.at === 'cur') return;
  const at = b.dataset.at;
  if (at[0] === 'q') { qi = +at.slice(1); playSong(queue[qi]); }
  else { const i = +at.slice(1), s = byId.get(history[i]); history.splice(i, 1); const j = queue.indexOf(s); if (j >= 0) qi = j; playSong(s); }
};
$('passForm').onsubmit = async e => {
  e.preventDefault(); const pass = $('passIn').value.trim(); if (!pass) return;
  const j = await api('/api/bgm/lyrics', { pass }); if (!j) return;
  store.set('aq-lypass', pass); $('passIn').value = ''; closeSheets(); loadLyrics();
};

// ── 流す曲を選ぶ窓 ──
function openSheet(id) { closeSheets(); $(id).hidden = false; }
function closeSheets() { document.querySelectorAll('.sheet').forEach(s => { s.hidden = true; }); }
document.querySelectorAll('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s || e.target.matches('[data-close]')) s.hidden = true; }));
function chips(id, items, key, one) {
  const val = cfg[key];
  $(id).innerHTML = items.map(([k, label]) => `<button data-k="${esc(k)}" class="${(one ? val === k : val.includes(k)) ? 'on' : ''}">${esc(label)}</button>`).join('');
  $(id).onclick = e => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    const k = /^\d+$/.test(b.dataset.k) && key === 'decades' ? +b.dataset.k : b.dataset.k;
    if (one) cfg[key] = k; else cfg[key] = cfg[key].includes(k) ? cfg[key].filter(x => x !== k) : [...cfg[key], k];
    renderPick();
  };
}
function renderPick() {
  const srcs = [['all', 'すべての曲'], ['fav', `お気に入り（${user?.fav.length || 0}）`], ...Object.entries(user?.playlists || {}).map(([n, ids]) => [`pl:${n}`, `${n}（${ids.length}）`])];
  if (!srcs.some(x => x[0] === cfg.src)) cfg.src = 'all';
  chips('srcChips', srcs, 'src', true);
  chips('genreChips', cat.genres.map(g => [g.key, g.label]), 'genres');
  const decades = [...new Set(cat.songs.map(s => Math.floor(s.year / 10) * 10))].filter(Boolean).sort();
  chips('decadeChips', decades.map(d => [d, `${String(d).slice(2)}年代`]), 'decades');
  chips('typeChips', TYPES, 'types');
  chips('fameChips', cat.fame.map(f => [f.key, f.label]), 'fame');
  chips('lenChips', LENS, 'len', true);
  chips('orderChips', ORDERS, 'order', true);
  chips('saveChips', SAVES, 'save', true);
  chips('pipChips', PIPS, 'pip', true);
  applySave();
  $('pickCount').textContent = filtered().length;
}
$('openPick').onclick = () => { $('workQ').value = cfg.work; renderPick(); openSheet('pickSheet'); };
$('workQ').oninput = () => { cfg.work = $('workQ').value.trim(); $('pickCount').textContent = filtered().length; };
$('pickGo').onclick = () => {
  store.set('aq-bgm', cfg); closeSheets(); summary();
  if (window.YT?.Player && ytPip !== (cfg.pip === 'on')) makePlayer();
  history = []; buildQueue();
  if (!queue.length) return toast('条件に合う曲がありません');
  next();
};

// ── はじめ ──
(async () => {
  const d = await (await fetch('/api/catalog')).json();
  cat = { songs: d.songs.filter(s => s.year), genres: d.genres, fame: d.fame };
  byId = new Map(cat.songs.map(s => [s.id, s]));
  $('workList').innerHTML = [...new Set(cat.songs.map(s => s.work))].sort().map(w => `<option value="${esc(w)}">`).join('');
  const n = getName();
  if (n) { const r = await fetch('/api/user?name=' + encodeURIComponent(n)); if (r.ok) user = (await r.json()).user; }
  applySave(); summary();
  navigator.connection?.addEventListener?.('change', applySave);
})();
