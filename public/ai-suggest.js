// AIの修正案（サビ）：いまの値・学習で選んだ値・構造解析AIの値を聴き比べて決める（このPCから開いたときだけ）
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = msg => { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2200); };
const r1 = x => Math.max(0, Math.round(x * 10) / 10);
const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

let items = [], tab = 'todo', cur = null, manual = 0;
const shown = () => items.filter(it => tab === 'done' ? it.review : !it.review);

async function load() {
  const res = await fetch('/api/ai-suggest');
  const j = await res.json();
  if (!res.ok) { $('list').innerHTML = `<li>${esc(j.error || '読み込めませんでした')}</li>`; return; }
  items = j.items;
  if (j.made) $('intro').textContent += `（案の作成：${j.made}）`;
  render();
  if (!cur && shown()[0]) open(shown()[0]);
}
function render() {
  const list = shown();
  $('tabs').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.tab === tab); });
  $('count').textContent = `（未確認 ${items.filter(it => !it.review).length} 曲／確認済み ${items.filter(it => it.review).length} 曲）`;
  $('list').innerHTML = list.map(it => `<li data-id="${esc(it.id)}" class="${cur?.id === it.id ? 'on' : ''}${it.review ? ' done' : ''}">
    <b>${esc(it.title)}</b><small>${esc(it.work)}／${esc(it.artist)}</small>
    <small>${it.cands.map(c => `${esc(c.short || c.label)} ${fmt(c.t)}`).join('　')}${it.review ? `　→ 決めた ${fmt(it.review.value)}（${esc(it.review.pick)}）` : ''}</small></li>`).join('') || '<li>ありません</li>';
}
$('tabs').onclick = e => { const b = e.target.closest('button[data-tab]'); if (b) { tab = b.dataset.tab; render(); } };
$('list').onclick = e => { const li = e.target.closest('li[data-id]'); if (li) open(items.find(it => it.id === li.dataset.id)); };

function open(it) {
  if (!it) return;
  cur = it; manual = it.review?.value ?? it.chorus;
  $('side').hidden = false;
  $('sTitle').textContent = it.title;
  $('sMeta').textContent = `　${it.work}／${it.artist}（${it.year}）・イントロ ${it.intro}秒`;
  const all = it.cands;
  $('cands').innerHTML = all.map((c, i) => {
    const agree = all.filter((o, j) => j !== i && Math.abs(o.t - c.t) <= 3).length;
    return `<div class="as-cand${c.key === 'now' ? ' cur' : ''}${agree ? ' agree' : ''}"><div><b>${i + 1}. ${esc(c.label)}</b><small>${esc(c.note || '')}${agree ? '　（ほかの案と一致）' : ''}</small></div>
      <span class="val">${fmt(c.t)}<small>${c.t}秒</small></span>
      <button class="btn-sub" data-play="${i}" type="button">▶ 聴く</button><button class="btn-main" data-pick="${i}" type="button" style="padding:6px 12px;font-size:13px;width:auto;margin:0">これに決める</button></div>`;
  }).join('');
  $('cands').querySelectorAll('[data-play]').forEach(b => b.onclick = () => playAt(all[+b.dataset.play].t));
  $('cands').querySelectorAll('[data-pick]').forEach(b => b.onclick = () => decide(all[+b.dataset.pick].t, all[+b.dataset.pick].key));
  showManual();
  $('sNote').textContent = [it.review ? `確認済み（${it.review.pick}・${it.review.value}秒）` : '', `いまの値の出どころ：${{ heatmap: 'よく再生される部分', manual: '手で決めた', songle: 'Songle', audio: '音から推定', audio2: '音から推定（再）' }[it.chorusSource] || it.chorusSource || '仮の値'}`].filter(Boolean).join('・');
  if (ytReady) yt.cueVideoById({ videoId: it.id, startSeconds: Math.max(0, all[0].t - 2) });
  render();
}
const showManual = () => { $('vManual').textContent = `${manual}秒`; };
document.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { manual = r1(manual + +b.dataset.d); showManual(); });
$('playManual').onclick = () => playAt(manual);
$('nowBtn').onclick = () => { if (ytReady) { manual = r1(yt.getCurrentTime()); showManual(); } };
$('setBtn').onclick = () => decide(manual, 'manual');

async function decide(value, pick) {
  if (!cur) return;
  const res = await fetch('/api/ai-suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cur.id, value, pick }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return toast(j.error || '決められませんでした');
  toast(`${cur.title}：サビを ${j.chorus}秒に決めました`);
  cur.review = { pick, value: j.chorus }; cur.chorus = j.chorus; cur.chorusSource = 'manual';
  const next = shown().find(x => x.id !== cur.id);
  if (next) open(next); else { render(); }
}

// プレーヤー
let yt = null, ytReady = false;
window.onYouTubeIframeAPIReady = () => {
  yt = new YT.Player('player', { width: 352, height: 198, playerVars: { rel: 0, playsinline: 1, modestbranding: 1, origin: location.origin },
    events: { onReady: () => { ytReady = true; if (cur) yt.cueVideoById({ videoId: cur.id, startSeconds: Math.max(0, cur.cands[0].t - 2) }); } } });
};
const tag = document.createElement('script'); tag.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(tag);
const playAt = t => { if (ytReady && cur) { yt.seekTo(t, true); yt.playVideo(); } };

addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || !cur) return;
  const n = '1234'.indexOf(e.key) >= 0 ? +e.key - 1 : '!"#$'.indexOf(e.key) >= 0 ? '!"#$'.indexOf(e.key) : -1; // Shift+数字（日本語配列）
  if (/^[1-4]$/.test(e.key) && cur.cands[+e.key - 1]) { e.preventDefault(); playAt(cur.cands[+e.key - 1].t); }
  else if (n >= 0 && e.shiftKey && cur.cands[n]) { e.preventDefault(); decide(cur.cands[n].t, cur.cands[n].key); }
  else if (e.key === 'n' || e.key === 'N') { if (ytReady) { manual = r1(yt.getCurrentTime()); showManual(); } }
  else if (e.key === ' ') { e.preventDefault(); if (ytReady) (yt.getPlayerState() === 1 ? yt.pauseVideo() : yt.playVideo()); }
  else if (e.key === 'j' || e.key === 'k') { const l = shown(), i = l.findIndex(x => x.id === cur.id), nx = l[i + (e.key === 'j' ? 1 : -1)]; if (nx) open(nx); }
});
load();
