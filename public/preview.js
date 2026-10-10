// 曲の追加プレビュー：検討中の曲と、プレイリストにあって未収録の曲を、試し聴きしながら追加・見送りする（このPCから開いたときだけ）
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtV = v => (v >= 1e8 ? `${(v / 1e8).toFixed(1)}億回` : v >= 1e4 ? `${(v / 1e4).toFixed(v >= 1e6 ? 0 : 1)}万回` : `${v}回`);
const api = async (url, body) => {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || '失敗しました');
  return j;
};

let data = { rows: [], candidates: [], unmeasured: [] }, cur = null, shownN = 60;
const stateOf = x => x.state?.status || 'todo';

async function load() {
  try { data = await api('/api/preview'); } catch (e) { $('list').innerHTML = `<li>${esc(e.message)}</li>`; $('candList').innerHTML = ''; return; }
  render();
}

const tags = (x, kind) => {
  const t = [];
  if (x.fame) t.push(`<i class="fame-${x.fame.key}" title="再生回数が収録曲の上位${100 - x.fame.pct}%（目安）">${x.fame.label}（目安）</i>`);
  if (kind === 'row') {
    const top = x.yt?.find(v => !v.bad && !v.inCatalog) || x.yt?.[0];
    if (x.stagedId && stateOf(x) === 'todo') t.push('<i class="auto">お試し中（オンラインで遊べる）</i>');
    if (!x.searched) t.push('<i>検索待ち</i>');
    else if (!top) t.push('<i class="yt-no">YouTube なし</i>');
    else t.push(`<i class="yt-ok">YouTube ${fmtV(top.views)}${top.official ? '・公式' : ''}</i>`);
    if (x.plays) t.push(`<i>あなた ${x.plays}回</i>`);
    if (x.noise) t.push(`<i class="warn">${esc(x.noise)}</i>`);
    if (x.flag || x.similar?.length) t.push('<i class="warn">同じ曲名で別の歌手が収録済み</i>');
  } else {
    t.push(`<i class="pending">${x.votes || 0}票</i>`);
    if (x.views) t.push(`<i>${fmtV(x.views)}</i>`);
  }
  const s = stateOf(x);
  if (s !== 'todo') t.push(`<i class="${s === 'added' ? 'auto' : 'warn'}">${s === 'added' ? '追加済み' : '見送り'}</i>`);
  return t.join('');
};
const li = (x, kind, main, sub) => `<li data-k="${esc(kind === 'row' ? x.key : 'cand:' + x.id)}" class="${cur?.k === (kind === 'row' ? x.key : 'cand:' + x.id) ? 'on' : ''}${stateOf(x) !== 'todo' ? ' done' : ''}">
  <span class="sg-main"><b>${esc(main)}</b><small>${esc(sub)}</small></span><span class="sg-tags">${tags(x, kind)}</span></li>`;

function render() {
  // 検討中
  const cq = $('cq').value.trim().toLowerCase(), cs = $('cstate').value;
  const cl = data.candidates.filter(c => (cs === 'all' || stateOf(c) === cs || (cs === 'todo' && stateOf(c) === 'todo')) && (!cq || `${c.title}${c.work}${c.artist}`.toLowerCase().includes(cq)));
  $('candCount').textContent = `（${cl.length}曲）`;
  $('candList').innerHTML = cl.map(c => li(c, 'cand', c.title, `${c.work || '作品なし'}／${c.artist}（${c.year || '?'}）${c.reason ? '・' + c.reason : ''}`)).join('') || '<li>ありません</li>';
  // 未収録
  const q = $('q').value.trim().toLowerCase(), st = $('state').value, yf = $('ytf').value, noise = $('noise').checked;
  const topOf = r => r.yt?.find(v => !v.bad && !v.inCatalog) || r.yt?.[0];
  let rl = data.rows.filter(r => (st === 'all' || stateOf(r) === st) && (noise || !r.noise)
    && (!q || `${r.title}${r.artist}${r.album}`.toLowerCase().includes(q))
    && (!yf || (yf === 'yes') === !!topOf(r)));
  const so = $('sort').value;
  rl.sort((a, b) => so === 'plays' ? b.plays - a.plays : so === 'title' ? a.title.localeCompare(b.title, 'ja') : so === 'year' ? (a.year || 9999) - (b.year || 9999) : (topOf(b)?.views || 0) - (topOf(a)?.views || 0));
  $('count').textContent = `（${rl.length}曲／全${data.rows.length}曲）`;
  $('list').innerHTML = rl.slice(0, shownN).map(r => li(r, 'row', r.title, `${r.artist || '歌手なし'}／${r.album || ''}${r.year ? `（${r.year}）` : ''}${r.sec ? `・${Math.floor(r.sec / 60)}:${String(r.sec % 60).padStart(2, '0')}` : ''}`)).join('') || '<li>ありません</li>';
  $('more').hidden = rl.length <= shownN;
  $('mCount').textContent = data.unmeasured?.length ? `（未測定 ${data.unmeasured.length}曲）` : '';
}
['cq', 'cstate', 'q', 'state', 'ytf', 'sort', 'noise'].forEach(id => { $(id).oninput = $(id).onchange = () => { shownN = 60; render(); }; });
$('more').onclick = () => { shownN += 100; render(); };
const find = k => k.startsWith('cand:') ? data.candidates.find(c => 'cand:' + c.id === k) : data.rows.find(r => r.key === k);
document.addEventListener('click', e => { const l = e.target.closest('li[data-k]'); if (l) open(l.dataset.k); });

// ── 編集 ──
let vids = [], yt = null, ytReady = false, pendingId = null;
function open(k) {
  const x = k ? find(k) : null;
  cur = { k: k || '', x, isNew: !k };
  $('ed').hidden = false; $('msg').textContent = '';
  const isCand = k?.startsWith('cand:');
  $('edHead').textContent = x?.title || '新しい曲を足す';
  $('edSub').textContent = x ? (isCand ? `${x.artist}・検討中（${x.votes || 0}票）` : `${x.artist || '歌手なし'}／${x.album || ''}・あなたの再生 ${x.plays}回${x.similar?.length ? '・似た曲：' + x.similar.join('、') : ''}`) : '曲名・歌手を入れて、動画を選んでください';
  $('fTitle').value = x?.title || ''; $('fArtist').value = x?.artist || ''; $('fWork').value = x?.work || ''; $('fYear').value = x?.year || ''; $('fType').value = x?.type || '';
  $('fIntro').value = ''; $('fChorus').value = ''; $('fId').value = '';
  $('sq').value = x ? `${x.title} ${x.artist || x.album || ''}` : '';
  vids = isCand ? (x.videoId ? [{ id: x.videoId, ch: x.source || '', title: x.title, views: x.views || 0 }] : []) : (x?.yt || []).slice();
  $('edNone').hidden = !!vids.length;
  if (x?.stagedSong) { // お試し中の曲：入っている動画・測った位置を出す。「追加」で本採用になる
    pick(x.stagedSong.id, false);
    $('fIntro').value = x.stagedSong.intro || ''; $('fChorus').value = x.stagedSong.chorus || '';
    if (x.stagedSong.work && x.stagedSong.work !== 'その他') $('fWork').value = x.stagedSong.work; $('fType').value = x.stagedSong.type || '';
  } else if (vids.length) pick((vids.find(v => !v.bad && !v.inCatalog) || vids[0]).id, false);
  else { $('fId').value = ''; }
  renderVids();
  const st = x ? stateOf(x) : 'todo';
  $('addBtn').hidden = st === 'added'; $('skipBtn').hidden = !x || st !== 'todo'; $('undoBtn').hidden = st !== 'skipped';
  $('candBtn').hidden = !cur.isNew;
  $('addBtn').textContent = x?.stagedSong ? '本採用にする（ゲームデータに入れる）' : '追加';
  render();
}
function renderVids() {
  $('vids').innerHTML = vids.map(v => `<li data-id="${esc(v.id)}" class="${v.id === $('fId').value ? 'on' : ''}${v.bad ? ' bad' : ''}">
    <input type="radio" name="vid" ${v.id === $('fId').value ? 'checked' : ''}><span>${esc(v.title)}<small>${esc(v.ch)}・${fmtV(v.views)}${v.dur ? `・${Math.floor(v.dur / 60)}:${String(v.dur % 60).padStart(2, '0')}` : ''}${v.official ? '・公式っぽい' : ''}${v.bad ? '・カバー等かも' : ''}${v.inCatalog ? '・収録済み' : ''}</small></span>
    <button class="btn-sub" data-play-id="${esc(v.id)}" type="button">▶</button></li>`).join('');
}
$('vids').onclick = e => {
  const b = e.target.closest('[data-play-id]'); const l = e.target.closest('li[data-id]');
  if (l) pick(l.dataset.id, !!b);
};
function pick(id, play) { $('fId').value = id; $('edNone').hidden = true; renderVids(); cue(id, play); }
function cue(id, play) {
  if (!ytReady) { pendingId = id; return; }
  if (play) yt.loadVideoById({ videoId: id }); else yt.cueVideoById({ videoId: id });
}
const ytId = s => { const m = String(s).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/) || String(s).trim().match(/^([A-Za-z0-9_-]{11})$/); return m && m[1]; };
$('urlBtn').onclick = () => {
  const id = ytId($('urlIn').value); if (!id) { $('msg').textContent = 'URL から動画IDを読み取れません'; return; }
  if (!vids.some(v => v.id === id)) vids.unshift({ id, ch: 'URL で指定', title: '（URL で指定した動画）', views: 0 });
  pick(id, true); $('msg').textContent = '';
};
$('sBtn').onclick = async () => {
  $('msg').textContent = '検索中…（10秒ほど）'; $('sBtn').disabled = true;
  try { const j = await api('/api/preview/search', { q: $('sq').value }); vids = j.results; $('edNone').hidden = !!vids.length; renderVids(); $('msg').textContent = `${vids.length}件見つかりました`; if (vids.length) pick((vids.find(v => !v.bad && !v.inCatalog) || vids[0]).id, false); }
  catch (e) { $('msg').textContent = e.message; }
  $('sBtn').disabled = false;
};
$('edClose').onclick = () => { $('ed').hidden = true; cur = null; render(); };

// プレーヤーと位置
window.onYouTubeIframeAPIReady = () => {
  yt = new YT.Player('player', { width: 352, height: 198, playerVars: { rel: 0, playsinline: 1, modestbranding: 1, origin: location.origin },
    events: { onReady: () => { ytReady = true; if (pendingId) cue(pendingId, false); } } });
};
const tag = document.createElement('script'); tag.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(tag);
document.querySelectorAll('[data-set]').forEach(b => b.onclick = () => { if (ytReady) $(b.dataset.set).value = Math.round(yt.getCurrentTime() * 10) / 10; });
document.querySelectorAll('[data-play]').forEach(b => b.onclick = () => { const v = parseFloat($(b.dataset.play).value); if (ytReady && v >= 0) { yt.seekTo(v, true); yt.playVideo(); } });

// ── 追加・見送り ──
function form() { return { key: cur?.k || '', videoId: $('fId').value, title: $('fTitle').value, artist: $('fArtist').value, work: $('fWork').value, year: $('fYear').value, type: $('fType').value, intro: $('fIntro').value, chorus: $('fChorus').value }; }
$('addBtn').onclick = async () => {
  try {
    const j = await api('/api/preview/add', form());
    $('msg').textContent = j.needsMeasure ? '追加しました（空のところは「測定を実行」で測ります）' : '追加しました';
    await load(); $('ed').hidden = true; cur = null; render();
  } catch (e) { $('msg').textContent = e.message; }
};
$('candBtn').onclick = async () => {
  try { await api('/api/preview/candidate', form()); $('msg').textContent = '検討中に入れました'; await load(); } catch (e) { $('msg').textContent = e.message; }
};
$('skipBtn').onclick = async () => { await api('/api/preview/skip', { key: cur.k }); await load(); $('ed').hidden = true; cur = null; render(); };
$('undoBtn').onclick = async () => { await api('/api/preview/skip', { key: cur.k, undo: true }); await load(); open(cur.k); };
$('newCand').onclick = () => open('');

// ── 測定 ──
let poll = null;
async function mStatus() {
  const j = await api('/api/preview/measure').catch(() => null); if (!j) return;
  $('mState').textContent = j.running ? '測定中…' : ''; $('mLog').hidden = !j.log; $('mLog').textContent = j.log;
  if (!j.running && poll) { clearInterval(poll); poll = null; load(); }
}
$('measureBtn').onclick = async () => {
  try { const j = await api('/api/preview/measure', {}); $('mState').textContent = j.message; if (!poll) poll = setInterval(mStatus, 5000); } catch (e) { $('mState').textContent = e.message; }
};
load(); mStatus();
