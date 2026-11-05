// 公開サイトの曲リクエストを手元の data/requests.json に取り込む（反映＝再起動の前に必ず行う。再起動すると公開側のリクエストは消えるため）。
// 手元で状態を変えた（追加済み・見つからず）ものは手元の状態を残す。
// 使い方: node tools/pull-requests.js                 （取り込んで、受付中の一覧を出す）
//         node tools/pull-requests.js --mark <id> added [曲の動画ID]   （追加済みにする）
//         node tools/pull-requests.js --mark <id> notfound          （見つからずにする）
// 追加を検討中の曲（data/candidates.json）の票も取り込む。票が入った曲は --promote でカタログ（additions-candidates.csv）に移して追加する。
//         node tools/pull-requests.js --promote   （票の入った検討中の曲を追加。このあと import-catalog と計測を行う）

const fs = require('fs');
const path = require('path');

const PATH = path.join(__dirname, '..', 'data', 'requests.json');
const SITE = 'https://intro-don-jpop.onrender.com';
const CAND_PATH = path.join(__dirname, '..', 'data', 'candidates.json');
const CAND_CSV = path.join(__dirname, '..', 'data', 'catalog', 'additions-candidates.csv');
const readCand = () => { try { return JSON.parse(fs.readFileSync(CAND_PATH, 'utf8')); } catch (e) { return []; } };
const writeCand = list => { fs.writeFileSync(CAND_PATH + '.tmp', JSON.stringify(list, null, 1) + '\n'); fs.renameSync(CAND_PATH + '.tmp', CAND_PATH); };
async function pullCandidates() {
  const cand = readCand();
  const res = await fetch(`${SITE}/api/candidates`);
  if (!(res.headers.get('content-type') || '').includes('json')) { console.log('公開サイトにはまだ検討中の曲の受け付けがありません'); return cand; }
  const remote = (await res.json()).candidates || [];
  const byId = new Map(cand.map(c => [c.id, c]));
  for (const r of remote) { const c = byId.get(r.id); if (c) c.votes = Math.max(c.votes || 0, r.votes || 0); }
  writeCand(cand);
  const voted = cand.filter(c => c.status === 'pending' && c.votes > 0);
  console.log(`検討中 ${cand.filter(c => c.status === 'pending').length} 曲／票が入った曲 ${voted.length} 曲`);
  for (const c of voted) console.log(`  [${c.votes}票] ${c.title} ／ ${c.work} ／ ${c.artist}`);
  return cand;
}
const read = () => { try { return JSON.parse(fs.readFileSync(PATH, 'utf8')); } catch (e) { return []; } };
const write = list => { fs.writeFileSync(PATH + '.tmp', JSON.stringify(list, null, 1) + '\n'); fs.renameSync(PATH + '.tmp', PATH); };

(async () => {
  const args = process.argv.slice(2);
  const list = read();
  if (args[0] === '--promote') {
    const cand = await pullCandidates();
    const voted = cand.filter(c => c.status === 'pending' && c.votes > 0);
    if (!voted.length) { console.log('追加する曲はありません'); return; }
    const head = 'year,title,work,artist,type,confidence,videoId,source,note';
    const old = fs.existsSync(CAND_CSV) ? fs.readFileSync(CAND_CSV, 'utf8').trim().split(/\r?\n/).slice(1) : [];
    const rows = voted.map(c => [c.year, c.title, c.work, c.artist, c.type, '中', c.videoId, c.source, `検討中から追加（${c.votes}票）`].map(x => String(x ?? '').replace(/,/g, '・')).join(','));
    fs.writeFileSync(CAND_CSV, [head, ...old, ...rows].join('\n') + '\n');
    for (const c of voted) { c.status = 'added'; c.doneAt = new Date().toISOString(); }
    writeCand(cand);
    console.log(`${voted.length} 曲をカタログに移しました（次に node tools/import-catalog.js と計測を行う）`);
    return;
  }
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
  await pullCandidates();
  for (const r of open) console.log(`  ${r.id}  ${r.title}${r.work ? ` ／ ${r.work}` : ''}${r.artist ? ` ／ ${r.artist}` : ''}${r.note ? `（${r.note}）` : ''}${r.votes > 1 ? ` [${r.votes}票]` : ''}`);
})().catch(e => { console.error('取り込めませんでした:', e.message); process.exit(1); });
