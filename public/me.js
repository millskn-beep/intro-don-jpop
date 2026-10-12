// マイページ：名前だけで登録・ログイン。お気に入り・苦手な曲・もう聞きたくない曲・成績・称号を見て、出し入れする
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = 'aq-user';
const getName = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
const setName = n => { try { n ? localStorage.setItem(KEY, n) : localStorage.removeItem(KEY); } catch (e) { /* 保存できなくても続ける */ } };
let toastTimer = null;
const toast = msg => { $('toast').textContent = msg; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600); };

const PLAY_NAME = { normal: 'ふつう', buzzer: '早押し', survival: 'サバイバル', picker: '出題者', coop: '協力', bingo: 'ビンゴ', fill: '3つ埋めバトル', rush: '激アツRUSH', poker: 'ポーカー' };
let user = null, songs = new Map();

async function loadCatalog() {
  const d = await (await fetch('/api/catalog')).json();
  songs = new Map(d.songs.map(s => [s.id, s]));
}
async function loadUser() {
  const n = getName();
  if (!n) return show(null);
  const r = await fetch('/api/user?name=' + encodeURIComponent(n));
  show(r.ok ? (await r.json()).user : null);
}
function show(u) {
  user = u;
  $('loginBox').hidden = !!u; $('meBox').hidden = !u;
  if (!u) return;
  $('meName').textContent = u.name;
  const st = u.stats || {};
  const rate = st.answered ? Math.round(st.correct / st.answered * 100) : 0;
  $('meStats').innerHTML = [['遊んだ回数', st.games || 0], ['1位（2人以上）', st.wins || 0], ['正解', st.correct || 0], ['正解率', st.answered ? `${rate}%` : '—']]
    .map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
  $('meByPlay').innerHTML = Object.entries(st.byPlay || {}).map(([k, v]) => `<span>${esc(PLAY_NAME[k] || k)}：${v.games}回${v.wins ? `（1位 ${v.wins}回）` : ''}</span>`).join('') || '<span class="note">まだ遊んだ記録がありません</span>';
  const titles = Object.entries(u.titles || {}).sort((a, b) => b[1] - a[1]);
  $('meTitles').innerHTML = titles.map(([t, n]) => `<em>${esc(t)}<small>×${n}</small></em>`).join('') || '<span class="note">まだ称号がありません</span>';
  const row = (id, extra, buttons) => {
    const s = songs.get(id);
    if (!s) return '';
    return `<li><div><b>${esc(s.title)}</b><small>${esc(s.work)}／${esc(s.artist)}（${s.year}）${extra}</small></div>
      <span class="me-btns"><a class="btn-sub" href="https://www.youtube.com/watch?v=${esc(id)}&t=${Math.floor(s.chorus || 0)}s" target="_blank" rel="noopener">▶ 聴く</a>${buttons}</span></li>`;
  };
  $('favCount').textContent = `${u.fav.length}曲`;
  $('favList').innerHTML = u.fav.slice().reverse().map(id => row(id, '', `<button class="btn-sub" data-list="fav" data-id="${esc(id)}">外す</button>`)).join('') || '<li class="note">答え合わせ画面の「♡ お気に入り」で入ります</li>';
  const weakIds = [...new Set([...u.again, ...Object.keys(u.weak).sort((a, b) => u.weak[b] - u.weak[a])])];
  $('weakCount').textContent = `${weakIds.length}曲`;
  $('weakList').innerHTML = weakIds.map(id => row(id, `${u.again.includes(id) ? '　🎯 もう一度出す' : ''}${u.weak[id] ? `　✕ ${u.weak[id]}回` : ''}`,
    `<button class="btn-sub" data-list="weak" data-id="${esc(id)}">外す</button>`)).join('') || '<li class="note">間違えた曲が入ります</li>';
  $('blockCount').textContent = `${u.block.length}曲`;
  $('blockList').innerHTML = u.block.slice().reverse().map(id => row(id, '', `<button class="btn-sub" data-list="block" data-id="${esc(id)}">戻す</button>`)).join('') || '<li class="note">答え合わせ画面の「🚫 もう聞きたくない」で入ります</li>';
}
async function send(list, id, on) {
  const r = await fetch('/api/user/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: user.name, list, id, on }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error || '送れませんでした');
  show(j.user);
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-list]'); if (!b || !user) return;
  const list = b.dataset.list, id = b.dataset.id;
  if (list === 'weak') { await send('weak', id, false); if (user.again.includes(id)) await send('again', id, false); }
  else await send(list, id, false);
});
$('loginForm').onsubmit = async e => {
  e.preventDefault();
  const name = $('loginName').value.trim();
  const r = await fetch('/api/user/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('loginMsg').textContent = j.error || 'ログインできませんでした'; return; }
  setName(j.user.name);
  toast(j.created ? `「${j.user.name}」で登録しました` : `「${j.user.name}」でログインしました`);
  show(j.user);
};
$('logoutBtn').onclick = () => { setName(''); show(null); };

loadCatalog().then(loadUser);
