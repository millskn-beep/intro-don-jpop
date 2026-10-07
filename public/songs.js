// 収録曲一覧：並べ替え・絞り込み・表示の切り替えと、イントロ・サビ位置の修正（修正待ちとして送る）
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = msg => { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600); };

let songs = [], genreLabel = {}, fameLabel = {}, fameOrder = {}, shown = 200, asc = true, selected = null;
const PAGE = 200;
const collator = new Intl.Collator('ja');

async function load() {
  const data = await fetch('/api/catalog').then(r => r.json());
  songs = data.songs;
  data.genres.forEach(g => { genreLabel[g.key] = g.label; $('genre').insertAdjacentHTML('beforeend', `<option value="${g.key}">${esc(g.label)}</option>`); });
  $('genre').insertAdjacentHTML('beforeend', '<option value="-">ジャンルなし</option>');
  data.fame.forEach((f, i) => { fameLabel[f.key] = f.label; fameOrder[f.key] = i; $('fame').insertAdjacentHTML('beforeend', `<option value="${f.key}">${esc(f.label)}</option>`); });
  const decades = [...new Set(songs.map(s => Math.floor(s.year / 10) * 10))].sort();
  decades.forEach(d => $('decade').insertAdjacentHTML('beforeend', `<option value="${d}">${d}年代</option>`));
  render();
}

const genreOf = s => s.genres.length ? s.genres.map(k => genreLabel[k]).join('・') : '';
const KEY = {
  title: s => s.title, work: s => s.work, artist: s => s.artist, year: s => s.year,
  genre: s => genreOf(s) || '￿', fame: s => fameOrder[s.fame] ?? 9,
};
function filtered() {
  const q = $('q').value.trim().toLowerCase(), g = $('genre').value, f = $('fame').value, d = $('decade').value;
  return songs.filter(s => (!q || `${s.title} ${s.work} ${s.artist}`.toLowerCase().includes(q))
    && (!g || (g === '-' ? !s.genres.length : s.genres.includes(g)))
    && (!f || s.fame === f) && (!d || Math.floor(s.year / 10) * 10 === +d) && (!$('fixOnly').checked || s.fix) && (!$('warnOnly').checked || s.warn));
}
function sorted(list) {
  const k = KEY[$('sort').value];
  return list.sort((a, b) => {
    const x = k(a), y = k(b);
    const c = typeof x === 'number' ? x - y : collator.compare(x, y);
    return (asc ? c : -c) || collator.compare(a.title, b.title);
  });
}
const row = s => `<li data-id="${s.id}" class="${selected?.id === s.id ? 'on' : ''}">
  <span class="sg-main"><b>${esc(s.title)}</b><small>${esc(s.work)}${s.type ? `（${esc(s.type)}）` : ''}／${esc(s.artist)}</small></span>
  <span class="sg-tags">${s.year ? `<i>${s.year}</i>` : ''}${genreOf(s) ? `<i>${esc(genreOf(s))}</i>` : ''}<i class="fame-${s.fame}">${esc(fameLabel[s.fame] || '')}</i>${s.fix ? '<i class="pending">修正待ち</i>' : ''}${s.warn && !s.fix ? '<i class="warn">要確認</i>' : ''}${s.report ? '<i class="reported">報告あり</i>' : ''}</span>
  <span class="sg-sec">イントロ ${s.fix ? s.fix.intro : s.intro}秒<br>サビ ${s.fix ? s.fix.chorus : s.chorus}秒${!s.chorusKnown && !s.fix ? '（仮）' : ''}</span></li>`;

function render() {
  const list = sorted(filtered());
  $('count').textContent = `（${list.length} / ${songs.length}曲）`;
  const view = $('view').value;
  let html = '';
  if (view === 'list') {
    html = `<ul class="sg-rows">${list.slice(0, shown).map(row).join('')}</ul>`;
    $('more').hidden = list.length <= shown;
  } else {
    // まとまりごと：作品（または ジャンル）の見出しの下に曲を並べる。まとまりの順は並べ替えの向きに合わせる
    const groups = new Map();
    for (const s of list) {
      const keys = view === 'work' ? [s.work] : (s.genres.length ? s.genres.map(k => genreLabel[k]) : ['ジャンルなし']);
      for (const k of keys) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    }
    const names = [...groups.keys()].sort((a, b) => (asc ? 1 : -1) * collator.compare(a, b));
    let n = 0;
    for (const name of names) {
      if (n >= shown) break;
      const items = groups.get(name);
      html += `<details class="sg-group" ${names.length <= 30 ? 'open' : ''}><summary>${esc(name)} <span>${items.length}曲</span></summary><ul class="sg-rows">${items.map(row).join('')}</ul></details>`;
      n += items.length;
    }
    $('more').hidden = n >= list.length;
  }
  $('list').innerHTML = html || '<p class="note">見つかりませんでした</p>';
}

let timer;
for (const id of ['genre', 'fame', 'decade', 'sort', 'view', 'fixOnly', 'warnOnly']) $(id).onchange = () => { shown = PAGE; render(); };
$('q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { shown = PAGE; render(); }, 200); };
$('order').onclick = () => { asc = !asc; $('order').textContent = asc ? '↑ 昇順' : '↓ 降順'; render(); };
$('more').onclick = () => { shown += PAGE; render(); };
$('list').onclick = e => {
  const li = e.target.closest('li[data-id]');
  if (li) openEditor(songs.find(s => s.id === li.dataset.id));
};

// ── 編集：YouTube で試し聴きしながら秒数を決めて、修正待ちとして送る ──
let yt = null, ytReady = false, pos = { intro: 0, chorus: 0 };
window.onYouTubeIframeAPIReady = () => {
  yt = new YT.Player('player', { width: 320, height: 180, playerVars: { rel: 0, playsinline: 1, modestbranding: 1, origin: location.origin },
    events: { onReady: () => { ytReady = true; if (selected) yt.cueVideoById({ videoId: selected.id, startSeconds: pos.intro }); } } });
};
const tag = document.createElement('script'); tag.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(tag);

const r1 = x => Math.max(0, Math.round(x * 10) / 10);
function showPos() {
  $('edIntro').textContent = `${pos.intro}秒`; $('edChorus').textContent = `${pos.chorus}秒`;
  const changed = pos.intro !== (selected.fix?.intro ?? selected.intro) || pos.chorus !== (selected.fix?.chorus ?? selected.chorus);
  $('edSend').disabled = !changed;
}
function openEditor(s) {
  selected = s;
  pos = { intro: s.fix?.intro ?? s.intro, chorus: s.fix?.chorus ?? s.chorus };
  $('edTitle').textContent = s.title;
  $('edMeta').textContent = `${s.work}${s.type ? `（${s.type}）` : ''}／${s.artist}（${s.year}）`;
  $('edNote').textContent = s.fix ? `修正待ち（${new Date(s.fix.at).toLocaleDateString('ja-JP')}に送られた位置）`
    : s.warn ? `自動チェックで要確認：${s.warn.join('、')}` : (s.chorusKnown ? '' : 'サビの位置はまだ仮の値です');
  $('editor').hidden = false; document.body.classList.add('editing');
  if (ytReady) yt.cueVideoById({ videoId: s.id, startSeconds: pos.intro });
  showPos();
  $('repForm').hidden = true; showReportInfo();
  document.querySelectorAll('.sg-rows li.on').forEach(li => li.classList.remove('on'));
  document.querySelector(`.sg-rows li[data-id="${s.id}"]`)?.classList.add('on');
}
$('edClose').onclick = () => { $('editor').hidden = true; document.body.classList.remove('editing'); if (ytReady) yt.stopVideo(); };
$('editor').querySelectorAll('[data-k]').forEach(b => b.onclick = () => { pos[b.dataset.k] = r1(pos[b.dataset.k] + +b.dataset.d); showPos(); });
$('editor').querySelectorAll('[data-now]').forEach(b => b.onclick = () => { if (ytReady) { pos[b.dataset.now] = r1(yt.getCurrentTime()); showPos(); } });
$('editor').querySelectorAll('[data-play]').forEach(b => b.onclick = () => { if (ytReady) { yt.seekTo(pos[b.dataset.play], true); yt.playVideo(); } });
$('edReset').onclick = () => { pos = { intro: selected.fix?.intro ?? selected.intro, chorus: selected.fix?.chorus ?? selected.chorus }; showPos(); };
$('edSend').onclick = async () => {
  $('edSend').disabled = true;
  try {
    const res = await fetch('/api/fixes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: selected.id, ...pos }) });
    const j = await res.json();
    toast(j.message || j.error || '送れませんでした');
    if (res.ok) { selected.fix = { intro: pos.intro, chorus: pos.chorus, at: new Date().toISOString() }; openEditor(selected); render(); return; }
  } catch (e) { toast('送れませんでした'); }
  showPos();
};

// ── 曲が違う（探し直す）／削除を依頼：一言（任意）を添えて送る。次の更新で、探し直す・出題から外す ──
let repKind = null;
const REP = {
  wrong: { title: '🔁 曲が違う（探し直す）', ph: '任意：正しい曲名や、動画の URL など' },
  delete: { title: '🗑 削除を依頼', ph: '任意：理由（アニソンではない・重複している など）' },
};
function showReportInfo() {
  const r = selected?.report;
  $('repInfo').textContent = r ? `報告が届いています：${[r.wrong ? `曲が違う ${r.wrong}件` : '', r.delete ? `削除の依頼 ${r.delete}件` : ''].filter(Boolean).join('・')}（次の更新で対応します）` : '';
}
function openReport(kind) {
  repKind = kind;
  $('repTitle').textContent = REP[kind].title;
  $('repNote').placeholder = REP[kind].ph; $('repNote').value = '';
  $('repForm').hidden = false; $('repNote').focus();
}
$('repWrong').onclick = () => openReport('wrong');
$('repDelete').onclick = () => openReport('delete');
$('repCancel').onclick = () => { $('repForm').hidden = true; };
$('repSend').onclick = async () => {
  $('repSend').disabled = true;
  try {
    const res = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selected.id, kind: repKind, note: $('repNote').value }) });
    const j = await res.json();
    toast(j.message || j.error || '送れませんでした');
    if (res.ok) {
      const r = selected.report || { wrong: 0, delete: 0 };
      r[repKind]++; selected.report = r;
      $('repForm').hidden = true; showReportInfo(); render();
    }
  } catch (e) { toast('送れませんでした'); }
  $('repSend').disabled = false;
};

load().catch(() => { $('list').innerHTML = '<p class="note">読み込めませんでした</p>'; });
