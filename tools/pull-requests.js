// 公開サイトの曲リクエストを手元の data/requests.json に取り込む（反映＝再起動の前に必ず行う。再起動すると公開側のリクエストは消えるため）。
// 手元で状態を変えた（追加済み・見つからず）ものは手元の状態を残す。
// 使い方: node tools/pull-requests.js                 （取り込んで、受付中の一覧を出す）
//         node tools/pull-requests.js --mark <id> added [曲の動画ID]   （追加済みにする）
//         node tools/pull-requests.js --mark <id> notfound          （見つからずにする）

const fs = require('fs');
const path = require('path');

const PATH = path.join(__dirname, '..', 'data', 'requests.json');
const SITE = 'https://anison-intro-vs.onrender.com';
const read = () => { try { return JSON.parse(fs.readFileSync(PATH, 'utf8')); } catch (e) { return []; } };
const write = list => { fs.writeFileSync(PATH + '.tmp', JSON.stringify(list, null, 1) + '\n'); fs.renameSync(PATH + '.tmp', PATH); };

(async () => {
  const args = process.argv.slice(2);
  const list = read();
  if (args[0] === '--mark') {
    const [, id, status, songId] = args;
    const r = list.find(x => x.id === id);
    if (!r || !['open', 'added', 'notfound'].includes(status)) { console.error('id か状態が正しくありません'); process.exit(1); }
    r.status = status;
    if (songId) r.songId = songId;
    r.doneAt = new Date().toISOString();
    write(list);
    console.log(`${r.title} → ${status}`);
    return;
  }
  const res = await fetch(`${SITE}/api/requests`);
  if (!(res.headers.get('content-type') || '').includes('json')) { console.log('公開サイトにはまだリクエスト機能がありません（取り込むものなし）'); return; }
  const remote = (await res.json()).requests || [];
  const byId = new Map(list.map(r => [r.id, r]));
  let added = 0;
  for (const r of remote.slice().reverse()) { // 古い順に足す
    const cur = byId.get(r.id);
    if (!cur) { list.push(r); byId.set(r.id, r); added++; continue; }
    cur.votes = Math.max(cur.votes || 1, r.votes || 1);
    if (cur.status === 'open' && r.status !== 'open') cur.status = r.status;
  }
  write(list);
  const open = list.filter(r => r.status === 'open');
  console.log(`公開サイトから ${remote.length} 件（新しく ${added} 件）／受付中 ${open.length} 件`);
  for (const r of open) console.log(`  ${r.id}  ${r.title}${r.work ? ` ／ ${r.work}` : ''}${r.artist ? ` ／ ${r.artist}` : ''}${r.note ? `（${r.note}）` : ''}${r.votes > 1 ? ` [${r.votes}票]` : ''}`);
})().catch(e => { console.error('取り込めませんでした:', e.message); process.exit(1); });
