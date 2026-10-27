// アニソンBGM：収録曲を条件（ジャンル・年代・種類・知名度・アニメのタイトル・お気に入り・プレイリスト）で選んで流し続ける
// 画面は3つ（ミュージックアプリの再生画面のような作り）：大きなジャケット／歌詞／次の曲。下のアイコンで切り替える。どの画面でも再生は止めない
// お気に入り・プレイリストはマイページ（名前だけのログイン）に保存。歌詞は合言葉を入れた端末だけ（サーバーのメモリにある歌詞）
// データ節約：YouTube は音だけを流せないので、プレーヤー（ジャケット）を小さくして低い画質で送らせる
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できなくても続ける */ } } };
const getName = () => { try { return localStorage.getItem('aq-user') || ''; } catch (e) { return ''; } };
const setName = n => { try { localStorage.setItem('aq-user', n); } catch (e) { /* 続ける */ } };
let toastTimer = null;
const toast = msg => { $('toast').textContent = msg; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600); };
const fmt = t => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s・！!？?「」『』（）()〜~ー－-]/g, '');
const thumb = (id, q = 'mqdefault') => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/${q}.jpg`;

const LENS = [['full', 'フル'], ['tv', 'TVサイズ（約1分30秒）'], ['chorus', 'サビだけ（約45秒）']];
const LEN_SHORT = { full: 'フル', tv: 'TVサイズ', chorus: 'サビだけ' };
const ORDERS = [['shuffle', 'シャッフル'], ['new', '新しい順'], ['old', '古い順']];
const SAVES = [['auto', '自動'], ['on', 'オン'], ['off', 'オフ']];
const SAVE_SHORT = { auto: '節約 自動', on: '節約 オン', off: '節約 オフ' };
const PIPS = [['off', 'オフ'], ['on', 'オン']];
const TYPES = [['OP', 'OP'], ['ED', 'ED'], ['挿入歌', '挿入歌'], ['other', 'その他']];
const typeOf = s => (/^OP/i.test(s.type) ? 'OP' : /^ED/i.test(s.type) ? 'ED' : /挿入/.test(s.type) ? '挿入歌' : 'other');

let cat = { songs: [], genres: [], fame: [] }, byId = new Map();
let user = null;
// spans：年代は5年ずつ（1985 = 1985〜1989年）
const spanOf = y => Math.floor(y / 5) * 5;
const spanLabel = x => `${String(Math.floor(x / 10) * 10).slice(2)}年代${x % 10 ? '後半' : '前半'}`;
let cfg = Object.assign({ src: 'all', genres: [], spans: [], types: [], fame: [], work: '', len: 'full', order: 'shuffle', save: 'auto', pip: 'off', rep: false, vol: 80 }, store.get('aq-bgm', {}));
delete cfg.decades; // 前の10年ずつの設定は使わない
const saveCfg = () => store.set('aq-bgm', cfg);
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
  document.body.classList.toggle('saving', s && cfg.pip !== 'on'); // PiP用のときは小さくしない（全画面・PiP のボタンを押せるように）
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
  const g = new Set(cfg.genres), d = new Set(cfg.spans), t = new Set(cfg.types), f = new Set(cfg.fame), w = norm(cfg.work);
  return list.filter(s => (!g.size || s.genres.some(x => g.has(x))) && (!d.size || d.has(spanOf(s.year))) && (!t.size || t.has(typeOf(s))) && (!f.size || f.has(s.fame)) && (!w || norm(s.work).includes(w)));
}
function buildQueue() {
  const list = filtered();
  if (cfg.order === 'shuffle') { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } }
  else list.sort((a, b) => cfg.order === 'new' ? b.year - a.year : a.year - b.year);
  queue = list; qi = -1;
}
// 並べ直す（シャッフルの切り替えなど）。いまの曲はそのまま、続きを新しい順番にする
function reorder() {
  buildQueue();
  if (!cur) return;
  qi = queue.indexOf(cur);
  if (qi < 0) { queue.unshift(cur); qi = 0; }
  else if (cfg.order === 'shuffle') { queue.splice(qi, 1); queue.unshift(cur); qi = 0; }
}
function srcLabel() { return cfg.src === 'fav' ? 'お気に入り' : cfg.src.startsWith('pl:') ? `プレイリスト「${cfg.src.slice(3)}」` : 'すべての曲'; }
function summary() {
  const parts = [srcLabel()];
  if (cfg.genres.length) parts.push(cfg.genres.map(k => cat.genres.find(g => g.key === k)?.label || k).join('・'));
  if (cfg.spans.length) parts.push(cfg.spans.slice().sort().map(spanLabel).join('・'));
  if (cfg.types.length) parts.push(cfg.types.map(x => x === 'other' ? 'その他' : x).join('・'));
  if (cfg.fame.length) parts.push(cfg.fame.map(k => cat.fame.find(x => x.key === k)?.label || k).join('・'));
  if (cfg.work) parts.push(`「${cfg.work}」`);
  parts.push(LEN_SHORT[cfg.len]);
  $('pickSum').textContent = `流しているもの：${parts.join('／')}（${filtered().length}曲）`;
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
  if (push && cur && cur !== s) history.push(cur.id);
  cur = s; seg = segOf(s);
  $('nowTitle').textContent = s.title;
  $('nowSub').textContent = `${s.artist}／${s.work}`;
  $('artEmpty').hidden = true;
  $('bgArt').style.backgroundImage = `url(${thumb(s.id)})`;
  showFav(); renderQueue();
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.artist, album: s.work, artwork: [{ src: thumb(s.id), sizes: '320x180', type: 'image/jpeg' }] });
  lyrics = null; if (view === 'ly') loadLyrics();
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
// ⏮：曲の頭から3秒以上たっていれば頭（0:00）に戻す。3秒未満なら前の曲へ
function prev() {
  if (yt && ytReady && yt.getCurrentTime() - seg.start >= 3) return yt.seekTo(seg.start, true);
  const id = history.pop(); if (!id) return yt && ytReady && yt.seekTo(seg.start, true);
  const s = byId.get(id); const i = queue.indexOf(s); if (i >= 0) qi = i;
  playSong(s, false);
}
// 曲の終わり：1曲リピートなら頭から、そうでなければ次へ
function ended() {
  if (cfg.rep && cur) { yt.seekTo(seg.start, true); yt.playVideo(); return; }
  next();
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
  if (yt) { yt.destroy(); $('videoBox').innerHTML = `<div id="yt"></div><div class="art-empty" id="artEmpty"${cur ? ' hidden' : ''}>♪</div>`; }
  ytReady = false; playing = false;
  $('pipHint').hidden = !ytPip;
  document.body.classList.toggle('pip', ytPip);
  yt = new YT.Player('yt', {
    width: '100%', height: '100%',
    playerVars: ytPip ? { controls: 1, rel: 0, playsinline: 1, fs: 1, modestbranding: 1, iv_load_policy: 3, origin: location.origin }
      : { controls: 0, disablekb: 1, rel: 0, playsinline: 1, fs: 0, modestbranding: 1, iv_load_policy: 3, origin: location.origin },
    events: {
      onReady: () => { ytReady = true; applySave(); setVol(cfg.vol, false); if (cur) playSong(cur, false); },
      onStateChange: e => {
        playing = e.data === YT.PlayerState.PLAYING;
        $('playIcon').setAttribute('href', playing ? '#i-pause' : '#i-play');
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
        if (e.data === YT.PlayerState.ENDED) ended();
      },
      onError: () => { toast('この曲は流せないので次へ'); setTimeout(next, 800); },
    },
  });
}
window.onYouTubeIframeAPIReady = makePlayer;
const tag = document.createElement('script'); tag.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(tag);

// 進み具合（0.25秒ごと）。右は残り時間。終わりの時刻を過ぎたら終わり（endSeconds が効かないときの保険）
let seekTo = null, segLen = 1; // 指で動かしている先（曲の頭からの秒）
setInterval(() => {
  if (!ytReady || !cur) return;
  const t = yt.getCurrentTime() || 0, dur = yt.getDuration() || 0;
  const a = seg.start, b = seg.end ? Math.min(seg.end, dur || seg.end) : dur, len = Math.max(1, b - a);
  segLen = len;
  if (seekTo != null) return; // 指で動かしているあいだは、指の位置を出す
  $('seekFill').style.width = `${Math.min(100, Math.max(0, (t - a) / len * 100))}%`;
  $('tCur').textContent = fmt(t - a); $('tEnd').textContent = '-' + fmt(b - t);
  if (playing && seg.end && t >= seg.end + 0.5) ended();
  if (lyrics?.sync) markLine(t);
}, 250);
// 再生位置のバー：触ったところへ。横に動かすあいだは時刻を出し、指を離したら動かす
function seekAt(e) {
  const r = $('seek').getBoundingClientRect(), p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  seekTo = p * segLen;
  $('seekFill').style.width = `${p * 100}%`;
  $('tCur').textContent = fmt(seekTo); $('tEnd').textContent = '-' + fmt(segLen - seekTo);
}
$('seek').addEventListener('pointerdown', e => {
  if (!cur || !ytReady) return;
  try { $('seek').setPointerCapture(e.pointerId); } catch (x) { /* 続ける */ } $('seek').classList.add('drag'); seekAt(e);
});
$('seek').addEventListener('pointermove', e => { if (seekTo != null) seekAt(e); });
const seekEnd = () => {
  if (seekTo == null) return;
  $('seek').classList.remove('drag');
  if (ytReady) yt.seekTo(seg.start + Math.min(seekTo, segLen - 0.5), true);
  seekTo = null;
};
$('seek').addEventListener('pointerup', seekEnd);
$('seek').addEventListener('pointercancel', seekEnd);
$('seek').addEventListener('keydown', e => { // キーボード：← → で5秒
  if (!ytReady || !cur || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  yt.seekTo(Math.max(seg.start, yt.getCurrentTime() + (e.key === 'ArrowLeft' ? -5 : 5)), true);
});
// 音量（iPhone は本体のボタンだけなので出さない）
// 音量：− ＋ のボタン（10ずつ）と、触ったところへ動くバー。0 で消音。iPhone は YouTube が音量を変えさせないことがあるので、0 のときは消音（mute）も使う
const showVol = () => { $('volFill').style.width = `${cfg.vol}%`; $('volLoIcon').setAttribute('href', cfg.vol ? '#i-vol-lo' : '#i-mute'); };
function setVol(v, save = true) {
  cfg.vol = Math.round(Math.min(100, Math.max(0, v))); showVol();
  if (ytReady) { yt.setVolume(cfg.vol); if (cfg.vol) yt.unMute(); else yt.mute(); }
  if (save) saveCfg();
}
$('volDown').onclick = () => setVol(cfg.vol - 10);
$('volUp').onclick = () => setVol(cfg.vol + 10);
let volDrag = false;
const volAt = e => { const r = $('vol').getBoundingClientRect(); setVol((e.clientX - r.left) / r.width * 100, false); };
$('vol').addEventListener('pointerdown', e => { volDrag = true; try { $('vol').setPointerCapture(e.pointerId); } catch (x) { /* 続ける */ } $('vol').classList.add('drag'); volAt(e); });
$('vol').addEventListener('pointermove', e => { if (volDrag) volAt(e); });
const volEnd = () => { if (!volDrag) return; volDrag = false; $('vol').classList.remove('drag'); saveCfg(); };
$('vol').addEventListener('pointerup', volEnd); $('vol').addEventListener('pointercancel', volEnd);
$('vol').addEventListener('keydown', e => { if (e.key === 'ArrowLeft') setVol(cfg.vol - 10); if (e.key === 'ArrowRight') setVol(cfg.vol + 10); });
showVol();

$('play').onclick = toggle; $('next').onclick = next; $('prev').onclick = prev;
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => yt?.playVideo()); ms.setActionHandler('pause', () => yt?.pauseVideo());
  ms.setActionHandler('nexttrack', next); ms.setActionHandler('previoustrack', prev);
}

// ── 画面の切り替え：art（ジャケット）／ly（歌詞）／q（次の曲）。同じアイコンをもう一度押すとジャケットに戻る ──
let view = 'art';
function setView(v) {
  view = v;
  document.body.classList.remove('v-art', 'v-ly', 'v-q'); document.body.classList.add('v-' + v);
  $('lyBtn').classList.toggle('on', v === 'ly'); $('qBtn').classList.toggle('on', v === 'q');
  if (v === 'q') renderQueue();
}
$('lyBtn').onclick = () => { if (view === 'ly') return setView('art'); loadLyrics(); };
$('qBtn').onclick = () => setView(view === 'q' ? 'art' : 'q');

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
function showFav() { const on = !!(cur && user?.fav.includes(cur.id)); $('fav').classList.toggle('on', on); $('favIcon').setAttribute('href', on ? '#i-star-on' : '#i-star'); }
$('fav').onclick = () => cur && needLogin(async () => {
  const on = !user.fav.includes(cur.id);
  const j = await api('/api/user/list', { name: user.name, list: 'fav', id: cur.id, on }); if (!j) return;
  user = j.user; showFav(); toast(on ? 'お気に入りに入れました' : 'お気に入りから外しました');
});
$('more').onclick = () => { $('moreTitle').textContent = cur ? cur.title : 'アニソンBGM'; $('addPl').hidden = !cur; summary(); openSheet('moreSheet'); };
$('morePick').onclick = () => $('openPick').click();
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
  const pass = store.get('aq-lypass', '');
  if (!pass) { openSheet('passSheet'); $('passIn').focus(); return; }
  setView('ly');
  if (!cur) { $('lyLines').innerHTML = ''; $('lyNote').textContent = '曲を流すと歌詞が出ます'; return; }
  const id = cur.id; lyFor = id;
  $('lyNote').textContent = '読み込み中…'; $('lyLines').innerHTML = '';
  const r = await fetch('/api/bgm/lyrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass, id }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 403) { store.set('aq-lypass', ''); setView('art'); toast('合言葉が違います'); return; }
  if (lyFor !== id) return;
  if (!r.ok || !j.lines) { lyrics = null; $('lyNote').textContent = r.ok ? 'この曲の歌詞はありません' : (j.error || '読み込めませんでした'); return; }
  lyrics = { lines: j.lines, sync: j.sync && j.lines.every(x => x.t != null) };
  $('lyNote').textContent = lyrics.sync ? '' : '時刻のない歌詞です';
  $('lyLines').classList.toggle('plain', !lyrics.sync);
  $('lyLines').innerHTML = j.lines.map((x, i) => `<p data-i="${i}">${esc(x.text)}</p>`).join('');
  $('lyLines').scrollTop = 0;
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
  if (p) { p.classList.add('cur'); box.scrollTop = p.offsetTop - box.clientHeight / 4; }
}
// 曲の中の t 秒へ（TVサイズ・サビだけで流している範囲の外なら、その曲はフルにして流し直す）
function jumpTo(t) {
  if (!ytReady || !cur) return;
  t = Math.max(0, t);
  if (t < seg.start || (seg.end && t > seg.end)) { seg = { start: Math.min(seg.start, t), end: null }; yt.loadVideoById({ videoId: cur.id, startSeconds: t }); }
  else { yt.seekTo(t, true); yt.playVideo(); }
}
// 時刻のある歌詞は、行を押すとそこへ
$('lyLines').onclick = e => {
  const p = e.target.closest('p[data-i]'); if (!p || !lyrics?.sync || !ytReady || !cur) return;
  const t = Math.max(0, lyrics.lines[+p.dataset.i].t - 0.3);
  jumpTo(t);
  curLine = -2; markLine(t + 0.3);
};
// サビへ（サビの1秒前から）
$('toChorus').onclick = () => { if (cur) jumpTo((cur.chorus || (cur.intro || 0) + 50) - 1); };

// ── イントロ・サビの位置を直す（/api/fixes。収録曲一覧と同じ） ──
let fx = null;
const r1 = x => Math.round(x * 10) / 10;
const showFx = () => { $('fx_intro').textContent = `${fx.intro.toFixed(1)}秒`; $('fx_chorus').textContent = `${fx.chorus.toFixed(1)}秒`; };
$('openFix').onclick = () => {
  if (!cur) return toast('曲を流してから直してください');
  fx = { id: cur.id, intro: r1(cur.intro || 0), chorus: r1(cur.chorus || 0), orig: { intro: r1(cur.intro || 0), chorus: r1(cur.chorus || 0) } };
  $('fixTitle').textContent = `位置を直す：${cur.title}`; showFx(); openSheet('fixSheet');
};
$('fixSheet').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !fx) return;
  if (b.dataset.d) { fx[b.dataset.k] = r1(Math.max(0, fx[b.dataset.k] + +b.dataset.d)); showFx(); }
  if (b.dataset.now) { if (ytReady && cur?.id === fx.id) { fx[b.dataset.now] = r1(yt.getCurrentTime()); showFx(); } }
  if (b.dataset.play) { if (cur?.id === fx.id) jumpTo(fx[b.dataset.play] - (b.dataset.play === 'chorus' ? 0.3 : 0)); }
});
$('fixReset').onclick = () => { if (fx) { fx.intro = fx.orig.intro; fx.chorus = fx.orig.chorus; showFx(); } };
$('fixSend').onclick = async () => {
  if (!fx) return;
  const j = await api('/api/fixes', { id: fx.id, intro: fx.intro, chorus: fx.chorus }); if (!j) return;
  const s = byId.get(fx.id); if (s) { s.intro = fx.intro; s.chorus = fx.chorus; }
  closeSheets(); toast(j.message || '位置を直しました');
};
$('passForm').onsubmit = async e => {
  e.preventDefault(); const pass = $('passIn').value.trim(); if (!pass) return;
  const j = await api('/api/bgm/lyrics', { pass }); if (!j) return;
  store.set('aq-lypass', pass); $('passIn').value = ''; closeSheets(); loadLyrics();
};

// ── 次の曲：前の10曲（薄く）・「再生を続ける」次の20曲。押すとその曲へ ──
const Q_PAST = 10, Q_NEXT = 20;
function renderModes() {
  $('mShuffle').classList.toggle('on', cfg.order === 'shuffle');
  $('mRepeat').classList.toggle('on', !!cfg.rep); $('rep1').hidden = !cfg.rep;
  $('mLenLabel').textContent = LEN_SHORT[cfg.len]; $('mLen').classList.toggle('on', cfg.len !== 'full');
  $('mSaveLabel').textContent = SAVE_SHORT[cfg.save]; $('mSave').classList.toggle('on', saving());
}
function renderQueue() {
  if (view !== 'q') return;
  renderModes();
  const row = (s, cls, at) => `<button class="q ${cls}" data-at="${at}"><img loading="lazy" src="${thumb(s.id, 'default')}" alt=""><span class="info"><b>${esc(s.title)}</b><small>${esc(s.artist)}</small></span></button>`;
  const past = history.slice(-Q_PAST).map((id, i, a) => [byId.get(id), history.length - a.length + i]).filter(x => x[0]);
  const nexts = []; for (let k = 1; k <= Q_NEXT && qi + k < queue.length; k++) nexts.push([queue[qi + k], qi + k]);
  $('qList').innerHTML = past.map(([s, i]) => row(s, 'past', 'h' + i)).join('')
    + `<div class="qhead" id="qHead"><b>再生を続ける</b><small>再生元：${esc(srcLabel())}${queue.length ? `（${Math.max(qi + 1, 1)}／${queue.length}曲）` : ''}</small></div>`
    + (nexts.map(([s, i]) => row(s, '', 'q' + i)).join('') || `<div class="qend">${cur ? '最後まで流したら、また最初から並べ直します' : '下の「選曲」から流す曲を決めます'}</div>`);
  $('qList').scrollTop = $('qHead').offsetTop - 4;
}
$('qList').onclick = e => {
  const b = e.target.closest('[data-at]'); if (!b) return;
  const at = b.dataset.at;
  if (at[0] === 'q') { qi = +at.slice(1); playSong(queue[qi]); }
  else { const i = +at.slice(1), s = byId.get(history[i]); history.splice(i, 1); const j = queue.indexOf(s); if (j >= 0) qi = j; playSong(s); }
};
$('mShuffle').onclick = () => { cfg.order = cfg.order === 'shuffle' ? 'new' : 'shuffle'; saveCfg(); reorder(); renderQueue(); toast(cfg.order === 'shuffle' ? 'シャッフルにしました' : '新しい順にしました'); };
$('mRepeat').onclick = () => { cfg.rep = !cfg.rep; saveCfg(); renderModes(); toast(cfg.rep ? 'いまの曲をくり返します' : 'くり返しをやめました'); };
$('mLen').onclick = () => { const k = LENS.map(x => x[0]); cfg.len = k[(k.indexOf(cfg.len) + 1) % k.length]; saveCfg(); renderModes(); toast(`次の曲から「${LEN_SHORT[cfg.len]}」で流します`); };
$('mSave').onclick = () => { const k = SAVES.map(x => x[0]); cfg.save = k[(k.indexOf(cfg.save) + 1) % k.length]; saveCfg(); applySave(); renderModes(); toast(`データ節約：${SAVES.find(x => x[0] === cfg.save)[1]}（いまは${saving() ? 'オン' : 'オフ'}）`); };

// ── 流す曲を選ぶ窓 ──
function openSheet(id) { closeSheets(); $(id).hidden = false; }
function closeSheets() { document.querySelectorAll('.sheet').forEach(s => { s.hidden = true; }); }
document.querySelectorAll('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s || e.target.matches('[data-close]')) s.hidden = true; }));
function chips(id, items, key, one) {
  const val = cfg[key];
  $(id).innerHTML = items.map(([k, label]) => `<button data-k="${esc(k)}" class="${(one ? val === k : val.includes(k)) ? 'on' : ''}">${esc(label)}</button>`).join('');
  $(id).onclick = e => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    const k = /^\d+$/.test(b.dataset.k) && key === 'spans' ? +b.dataset.k : b.dataset.k;
    if (one) cfg[key] = k; else cfg[key] = cfg[key].includes(k) ? cfg[key].filter(x => x !== k) : [...cfg[key], k];
    renderPick();
  };
}
function renderPick() {
  const srcs = [['all', 'すべての曲'], ['fav', `お気に入り（${user?.fav.length || 0}）`], ...Object.entries(user?.playlists || {}).map(([n, ids]) => [`pl:${n}`, `${n}（${ids.length}）`])];
  if (!srcs.some(x => x[0] === cfg.src)) cfg.src = 'all';
  chips('srcChips', srcs, 'src', true);
  chips('genreChips', cat.genres.map(g => [g.key, g.label]), 'genres');
  const spans = [...new Set(cat.songs.map(s => spanOf(s.year)))].filter(Boolean).sort();
  chips('decadeChips', spans.map(x => [x, spanLabel(x)]), 'spans');
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
  saveCfg(); closeSheets();
  if (window.YT?.Player && ytPip !== (cfg.pip === 'on')) makePlayer();
  history = []; buildQueue();
  if (!queue.length) return toast('条件に合う曲がありません');
  next();
};

// ── YouTube のプレイリストにする（watch_videos?video_ids= で名前のない一時プレイリスト。1つ50曲まで） ──
const YT_MAX = 50;
let ytSrc = 'now';
const YT_BYS = [['genre', 'ジャンルごと'], ['work', 'アニメタイトルごと']];
function ytSongs() {
  if (ytSrc === 'now') return filtered();
  const ids = ytSrc === 'fav' ? user?.fav || [] : user?.playlists?.[ytSrc.slice(3)] || [];
  return ids.map(id => byId.get(id)).filter(Boolean);
}
// ジャンル → アニメタイトル → 知名度（→ 年）の順
function ytSorted(list) {
  const gi = new Map(cat.genres.map((g, i) => [g.key, i])), fi = new Map(cat.fame.map((f, i) => [f.key, i]));
  // ジャンルで絞っているときは、選んだジャンルの中で分ける
  const pick = ytSrc === 'now' && cfg.genres.length ? new Set(cfg.genres) : null;
  const g0 = s => Math.min(99, ...s.genres.filter(k => !pick || pick.has(k)).map(k => gi.get(k) ?? 99));
  return list.map(s => [s, g0(s)]).sort((a, b) => a[1] - b[1] || a[0].work.localeCompare(b[0].work, 'ja') || (fi.get(a[0].fame) ?? 9) - (fi.get(b[0].fame) ?? 9) || a[0].year - b[0].year);
}
function ytGroups() {
  const sorted = ytSorted(ytSongs()), groups = new Map();
  for (const [s, g] of sorted) {
    const k = (cfg.ytBy || 'genre') === 'work' ? s.work : (cat.genres[g]?.label || 'ジャンルなし');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const out = [];
  for (const [name, list] of groups) {
    for (let i = 0; i < list.length; i += YT_MAX) {
      const part = list.slice(i, i + YT_MAX);
      out.push({ name: list.length > YT_MAX ? `${name}（${i + 1}〜${i + part.length}曲目）` : name, n: part.length, url: 'https://www.youtube.com/watch_videos?video_ids=' + part.map(s => encodeURIComponent(s.id)).join(',') });
    }
  }
  return out;
}
function renderYt() {
  const srcs = [['now', `今の条件（${filtered().length}）`]];
  if (user) srcs.push(['fav', `お気に入り（${user.fav.length}）`], ...Object.entries(user.playlists || {}).map(([n, ids]) => [`pl:${n}`, `${n}（${ids.length}）`]));
  if (!srcs.some(x => x[0] === ytSrc)) ytSrc = 'now';
  $('ytSrcChips').innerHTML = srcs.map(([k, l]) => `<button data-k="${esc(k)}" class="${k === ytSrc ? 'on' : ''}">${esc(l)}</button>`).join('');
  $('ytByChips').innerHTML = YT_BYS.map(([k, l]) => `<button data-k="${k}" class="${k === (cfg.ytBy || 'genre') ? 'on' : ''}">${l}</button>`).join('');
  const gs = ytGroups();
  $('ytList').innerHTML = gs.map(g => `<li><a class="yt" href="${esc(g.url)}" target="_blank" rel="noopener"><span>${esc(g.name)}</span><small>${g.n}曲 ↗</small></a></li>`).join('') || '<li class="hint">曲がありません</li>';
}
$('ytSrcChips').onclick = e => { const b = e.target.closest('[data-k]'); if (b) { ytSrc = b.dataset.k; renderYt(); } };
$('ytByChips').onclick = e => { const b = e.target.closest('[data-k]'); if (b) { cfg.ytBy = b.dataset.k; saveCfg(); renderYt(); } };
function openYt(src) { ytSrc = src; renderYt(); openSheet('ytSheet'); $('ytList').scrollTop = 0; }
$('pickYt').onclick = () => { saveCfg(); openYt('now'); };
$('moreYt').onclick = () => openYt('now');

// ── はじめ ──
(async () => {
  const d = await (await fetch('/api/catalog')).json();
  cat = { songs: d.songs.filter(s => s.year), genres: d.genres, fame: d.fame };
  byId = new Map(cat.songs.map(s => [s.id, s]));
  $('workList').innerHTML = [...new Set(cat.songs.map(s => s.work))].sort().map(w => `<option value="${esc(w)}">`).join('');
  const n = getName();
  if (n) { const r = await fetch('/api/user?name=' + encodeURIComponent(n)); if (r.ok) user = (await r.json()).user; }
  applySave();
  navigator.connection?.addEventListener?.('change', applySave);
})();
