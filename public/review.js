// 自動で直した曲の確認：直す前／自動の値を聴き比べて、OK・元に戻す・手で決める（このPCから開いたときだけ）
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = msg => { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2200); };
const r1 = x => Math.max(0, Math.round(x * 10) / 10);

let items = [], tab = 'intro', cur = null, manual = 0;
const shown = () => items.filter(it => tab === 'done' ? it.review : !it.review && (tab === 'pending' ? it.bucket === 'pending' : it.bucket === 'fixed' && it.kind === tab))
  .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)); // 大きく動いた曲から

async function load() {
  const res = await fetch('/api/review');
  const j = await res.json();
  if (!res.ok) { $('list').innerHTML = `<li>${esc(j.error || '読み込めませんでした')}</li>`; return; }
  items = j.items;
  render();
}
function render() {
  const list = shown();
  const n = k => items.filter(it => !it.review && (k === 'pending' ? it.bucket === 'pending' : it.bucket === 'fixed' && it.kind === k)).length;
  $('tabs').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.tab === tab);
    const c = b.dataset.tab === 'done' ? items.filter(it => it.review).length : n(b.dataset.tab);
    b.textContent = b.textContent.replace(/（\d+）$/, '') + `（${c}）`;
  });
  $('count').textContent = `（未確認 ${items.filter(it => !it.review).length} 件）`;
  $('list').innerHTML = list.map(it => `<li data-key="${esc(it.key)}" class="${cur?.key === it.key ? 'on' : ''}${it.review ? ' done' : ''}">
    <span><b>${esc(it.title)}</b><br><small>${esc(it.work)}／${it.kind === 'intro' ? 'イントロ' : 'サビ'}${it.by === 'songle' ? '（Songle）' : ''}${it.review ? `・${{ ok: 'OK', revert: '元に戻した', set: '手で決めた' }[it.review.action]}` : ''}</small></span>
    <span class="chg${Math.abs(it.after - it.before) > 40 ? ' big' : ''}">${it.before} → ${it.after}秒</span></li>`).join('') || '<li>ありません</li>';
}
$('tabs').onclick = e => { const b = e.target.closest('button[data-tab]'); if (b) { tab = b.dataset.tab; render(); } };
$('list').onclick = e => { const li = e.target.closest('li[data-key]'); if (li) open(items.find(it => it.key === li.dataset.key)); };

function open(it) {
  cur = it; manual = it.review?.value ?? it.after;
  $('side').hidden = false;
  $('sTitle').textContent = it.title;
  $('sMeta').textContent = `${it.work}／${it.artist}（${it.year}）・${it.kind === 'intro' ? 'イントロの開始位置' : 'サビの位置'}`;
  $('vBefore').textContent = `${it.before}秒`; $('vAfter').textContent = `${it.after}秒`; showManual();
  $('sNote').textContent = [it.bucket === 'pending' ? '大きく動くので、自動では直していません（OK で自動の値にします）' : 'いまは自動の値になっています',
    it.by === 'songle' ? 'Songle の解析を使った値です' : '', it.songleBeat != null ? `Songle の最初の拍：${it.songleBeat.toFixed(1)}秒` : '',
    it.review ? `確認済み（${it.review.value}秒）` : ''].filter(Boolean).join('・');
  if (ytReady) yt.cueVideoById({ videoId: it.id, startSeconds: it.after });
  render();
}
const showManual = () => { $('vManual').textContent = `${manual}秒`; };
document.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { manual = r1(manual + +b.dataset.d); showManual(); });

// プレーヤー
let yt = null, ytReady = false;
window.onYouTubeIframeAPIReady = () => {
  yt = new YT.Player('player', { width: 352, height: 198, playerVars: { rel: 0, playsinline: 1, modestbranding: 1, origin: location.origin },
    events: { onReady: () => { ytReady = true; if (cur) yt.cueVideoById({ videoId: cur.id, startSeconds: cur.after }); } } });
};
const tag = document.createElement('script'); tag.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(tag);
const playAt = t => { if (ytReady && cur) { yt.seekTo(t, true); yt.playVideo(); } };
$('playBefore').onclick = () => playAt(cur.before);
$('playAfter').onclick = () => playAt(cur.after);
$('playManual').onclick = () => playAt(manual);
$('nowBtn').onclick = () => { if (ytReady) { manual = r1(yt.getCurrentTime()); showManual(); } };

async function decide(action) {
  if (!cur) return;
  const res = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: cur.id, kind: cur.kind, action, value: manual }) });
  const j = await res.json();
  if (!res.ok) return toast(j.error || '保存できませんでした');
  const v = cur.kind === 'intro' ? j.intro : j.chorus;
  cur.review = { action, value: v };
  toast(`${cur.title}：${{ ok: 'OK', revert: '元に戻しました', set: '決めました' }[action]}（${v}秒）`);
  // 次の未確認の曲へ
  const list = shown();
  if (list.length) open(list[0]); else { cur = null; $('side').hidden = true; render(); }
  if (ytReady) yt.pauseVideo();
}
$('okBtn').onclick = () => decide('ok');
$('revertBtn').onclick = () => decide('revert');
$('setBtn').onclick = () => decide('set');

addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || !cur) return;
  const k = e.key;
  if (k === '1') $('playBefore').click();
  else if (k === '2') $('playAfter').click();
  else if (k === '3') $('playManual').click();
  else if (k === 'Enter') { e.preventDefault(); decide('ok'); }
  else if (k === 'Backspace') { e.preventDefault(); decide('revert'); }
  else if (k === 'n' || k === 'N') $('nowBtn').click();
  else if (k === ' ') { e.preventDefault(); if (ytReady) (yt.getPlayerState() === 1 ? yt.pauseVideo() : yt.playVideo()); }
  else if (k === 'j' || k === 'k') {
    const list = shown(), i = list.findIndex(x => x.key === cur.key);
    const next = list[Math.max(0, Math.min(list.length - 1, i + (k === 'j' ? 1 : -1)))];
    if (next) open(next);
  }
});

load().catch(() => { $('list').innerHTML = '<li>読み込めませんでした</li>'; });
