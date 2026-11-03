// マイページ：名前だけで登録・ログイン。お気に入り・苦手な曲・もう聞きたくない曲・成績・称号を見て、出し入れする
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = 'aq-user';
const getName = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
const setName = n => { try { n ? localStorage.setItem(KEY, n) : localStorage.removeItem(KEY); } catch (e) { /* 保存できなくても続ける */ } };
let toastTimer = null;
const toast = msg => { $('toast').textContent = msg; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600); };

const PLAY_NAME = { normal: 'ふつう', buzzer: '早押し', survival: 'サバイバル', picker: '出題者', coop: '協力', bingo: 'ビンゴ', fill: '3つ埋めバトル', fillmany: 'たくさん埋めバトル', rush: '激アツRUSH', poker: 'ポーカー', dixit: 'ディクシット', baba: 'ババ抜き', daifugo: '大富豪', codenames: 'コードネーム', wits: '年代ベット', bluff: 'アニソンベット', monopoly: 'モノポリー', sugoroku: 'すごろく', genre: 'ジャンル制覇', genreex: 'ジャンル制覇EX', deck: 'デッキ構築', kaerema: '帰れま10', azul: 'アズール', panel: '陣取り', karuta: 'かるた', nenpyo: '年表', wolf: '人狼' };
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
  showPrefs(u);
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
// 保存した設定の見えるところ
const PREF_LABEL = { play: '遊び方', questions: '問題数', topic: 'お題', target: '答えるもの', answerMode: '答え方', quizType: '出題', choices: '選択肢の数', yearFrom: '年代（から）', yearTo: '年代（まで）', teams: 'チーム戦', lives: 'ライフ', speed: '再生速度', introPlays: 'イントロの回数', clues: 'ヒント', lifelines: 'ライフライン', bonus: 'ボーナス', maxPlayers: '定員', autoNext: '自動で次へ（秒）', mode: '得点方式', typingExtra: '入力の追加時間' };
const PREF_ANS = { choice: '選択式', input: '入力式', song: '曲名', work: '作品', artist: '歌手', year: '年', intro: 'イントロ', sabimae: 'サビ前', true: 'あり', false: 'なし', all: '全部', series: '作品を選ぶ', multi: '自由に選ぶ', score: '得点制' };
function showPrefs(u) {
  const pf = u.prefs;
  $('prefClear').hidden = !pf;
  if (!pf) { $('mePrefs').innerHTML = '<span class="note">まだ保存した設定がありません</span>'; return; }
  const s = pf.settings || {};
  const chips = Object.keys(PREF_LABEL).filter(k => s[k] !== undefined).map(k => {
    const v = s[k]; const txt = k === 'play' ? (PLAY_NAME[v] || v) : PREF_ANS[String(v)] ?? v;
    return `<span><small>${PREF_LABEL[k]}</small><b>${esc(txt)}</b></span>`;
  });
  const ex = (pf.excludeGenres || []).length;
  $('mePrefs').innerHTML = chips.join('') + (ex ? `<span><small>出題しないジャンル</small><b>${ex}個</b></span>` : '') + `<span class="note">保存：${esc(String(pf.at || '').slice(0, 10))}</span>`;
}
$('prefClear').onclick = async () => {
  const r = await fetch('/api/user/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: getName(), clear: true }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error || '削除できませんでした');
  toast('保存した設定を削除しました'); show(j.user);
};
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
