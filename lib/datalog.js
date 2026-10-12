// 公開サーバーで受け付けたもの（リクエスト・投票・位置とジャンルの修正・報告）を GitHub の別ブランチに記録する。
// Render は再起動するとファイルが消えるので、受け付けるたびに（少しまとめて）保存し、起動したときに読み直す。
// 記録先：リポジトリの data-log ブランチの datalog/state.json（本番は main だけを見ているので、ここに書いてもデプロイされない）。
// 環境変数 GITHUB_DATA_TOKEN（このリポジトリの Contents を読み書きできるトークン）がないときは何もしない。
//
// 読み直すのは「同じ版（コミット）のまま再起動したとき」だけ。新しい版をデプロイしたときは、反映の前に
// tools/pull-requests.js・pull-fixes.js で手元に取り込んで曲データに入れているので、古い記録は使わない。

const TOKEN = process.env.GITHUB_DATA_TOKEN || '';
const REPO = process.env.GITHUB_DATA_REPO || 'millskn-beep/anison-intro-vs';
const BRANCH = process.env.GITHUB_DATA_BRANCH || 'data-log';
const FILE = 'datalog/state.json';
const BASE = process.env.RENDER_GIT_COMMIT || 'local';
const DELAY_MS = 15 * 1000; // 受け付けてから保存するまで（続けて来たらまとめて1回）

const enabled = !!TOKEN;
let sha = null, timer = null, saving = false, again = false, getState = () => ({}), getUsers = () => ({});

const api = (p, opt = {}) => fetch(`https://api.github.com/repos/${REPO}/${p}`, {
  ...opt,
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'anison-intro-vs', ...(opt.body ? { 'Content-Type': 'application/json' } : {}) },
});

// ブランチがなければ main から作る
async function ensureBranch() {
  const r = await api(`git/ref/heads/${BRANCH}`);
  if (r.ok) return;
  const main = await (await api('git/ref/heads/main')).json();
  await api('git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: main.object.sha }) });
}

async function readRemote() {
  const r = await api(`contents/${FILE}?ref=${BRANCH}`);
  if (r.status === 404) { sha = null; return null; }
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  sha = j.sha;
  return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
}

// 起動時：{ data, users } を返す。data（リクエスト・修正など）は同じ版のまま再起動したときだけ。
// users（マイページ：お気に入り・成績など）は手元に取り込まないので、版が変わっても毎回読み直す
async function restore(state, users = () => ({})) {
  getState = state; getUsers = users;
  if (!enabled) return { data: null, users: null };
  try {
    await ensureBranch();
    const st = await readRemote();
    if (!st) return { data: null, users: null };
    return { data: st.base === BASE ? st.data || null : null, users: st.users || null };
  } catch (e) { console.log('記録の読み込みに失敗:', e.message); return { data: null, users: null }; }
}

async function write() {
  if (saving) { again = true; return; }
  saving = true;
  try {
    const body = JSON.stringify({ base: BASE, savedAt: new Date().toISOString(), data: getState(), users: getUsers() }, null, 1);
    const put = () => api(`contents/${FILE}`, { method: 'PUT', body: JSON.stringify({
      message: `記録 ${new Date().toISOString()}`, branch: BRANCH, content: Buffer.from(body).toString('base64'), ...(sha ? { sha } : {}) }) });
    let r = await put();
    if (r.status === 409 || r.status === 422) { await readRemote().catch(() => {}); r = await put(); } // ほかから書かれていた
    if (r.ok) sha = (await r.json()).content?.sha || sha;
    else console.log('記録の保存に失敗:', r.status);
  } catch (e) { console.log('記録の保存に失敗:', e.message); }
  saving = false;
  if (again) { again = false; touch(); }
}

// 変わったことを知らせる（少し待ってまとめて保存）
function touch() {
  if (!enabled) return;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; write(); }, DELAY_MS);
}

// すぐ保存する（止められる前：Render は再起動の前に SIGTERM を送る）
async function flush() {
  if (!enabled || !timer) return;
  clearTimeout(timer); timer = null;
  await write();
}

module.exports = { enabled, restore, touch, flush };
