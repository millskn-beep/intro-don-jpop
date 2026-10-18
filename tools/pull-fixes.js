// 収録曲一覧から送られた「イントロ・サビ位置の修正」と「曲が違う／削除を依頼」の報告を公開サイトから取り込む。
// 反映（再起動）の前に必ず行う。再起動すると公開側の受付分は消えるため。
//   修正 → 曲データ（data/songs.json）に入れ、data/fixes.json は空に戻す。
//          直す前と後の位置は data/fix-history.json に残す（自動計測の答え合わせ・調整に使う）
//   削除を依頼 → 消さずに出題から外す（retired: true。戻すときは retired を消す）
//   曲が違う → data/reports.json に残す。正しい動画を探して差し替えたら --done <id> で消す
// 使い方: node tools/pull-fixes.js [--dry-run]
//         node tools/pull-fixes.js --done <id>   （「曲が違う」を対応済みにする）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SONGS_PATH = path.join(ROOT, 'data', 'songs.json');
const FIXES_PATH = path.join(ROOT, 'data', 'fixes.json');
const REPORTS_PATH = path.join(ROOT, 'data', 'reports.json');
const HISTORY_PATH = path.join(ROOT, 'data', 'fix-history.json');
const SITE = 'https://anison-intro-vs.onrender.com';
const DRY = process.argv.includes('--dry-run');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const writeJson = (p, v) => { fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 1) + '\n'); fs.renameSync(p + '.tmp', p); };

async function remote(name) {
  const res = await fetch(`${SITE}/api/${name}`);
  return (res.headers.get('content-type') || '').includes('json') ? (await res.json())[name] || {} : null;
}

(async () => {
  const doneIdx = process.argv.indexOf('--done');
  if (doneIdx > 0) {
    const id = process.argv[doneIdx + 1], reports = readJson(REPORTS_PATH, {});
    if (!reports[id]) return console.log(`報告がありません: ${id}`);
    console.log(`対応済みにしました: ${reports[id].title}`);
    delete reports[id]; writeJson(REPORTS_PATH, reports);
    return;
  }

  // ── イントロ・サビ位置の修正 ──
  const fixes = readJson(FIXES_PATH, {});
  const rf = await remote('fixes');
  if (rf) {
    for (const [id, f] of Object.entries(rf)) if (!fixes[id] || fixes[id].at < f.at) fixes[id] = f; // 新しい方を使う
  } else console.log('公開サイトにはまだ修正の受け付けがありません');
  const songs = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
  const byId = new Map(songs.map(s => [s.id, s]));
  const history = readJson(HISTORY_PATH, []);
  let n = 0;
  for (const [id, f] of Object.entries(fixes)) {
    const s = byId.get(id);
    if (!s) { console.log(`  （曲が見つからない）${id}`); continue; }
    const before = { intro: s.intro || 0, chorus: s.chorus || 0, introMethod: s.introMethod || null, chorusSource: s.chorusSource || null };
    if (f.intro === before.intro && f.chorus === before.chorus) continue; // 取り込み済み（公開側は再起動まで残る）
    if (f.intro !== (s.intro || 0)) { s.intro = f.intro; s.introMeasured = false; delete s.introMethod; delete s.introUnsure; delete s.introSource; delete s.introBefore; } // 手で直したら自動の印は外す // 手で直した印（チェック画面と同じ）
    if (f.chorus !== s.chorus) { s.chorus = f.chorus; s.chorusSource = 'manual'; delete s.chorusBefore; }
    history.push({ id, title: s.title, work: s.work, channel: s.channel || '', at: f.at, before, after: { intro: f.intro, chorus: f.chorus } });
    console.log(`  ${s.title}（${s.work}）: イントロ ${before.intro} / サビ ${before.chorus} → イントロ ${f.intro} / サビ ${f.chorus}${f.count > 1 ? `（${f.count}回送信）` : ''}`);
    n++;
  }
  console.log(`修正 ${n} 曲${DRY ? '（保存しない）' : ''}`);

  // ── 曲の情報（アニメ名・歌っている人・作者）の直し：曲データに入れて、data/info-fixes.json は空に戻す ──
  const INFO_PATH = path.join(ROOT, 'data', 'info-fixes.json');
  const info = readJson(INFO_PATH, {});
  for (const [id, f] of Object.entries((await remote('song-info')) || {})) if (!info[id] || info[id].at < f.at) info[id] = f;
  let iN = 0;
  for (const [id, f] of Object.entries(info)) {
    const s = byId.get(id); if (!s) continue;
    const w = f.work && f.work !== s.work, a = f.artist && f.artist !== s.artist;
    if (!w && !a) continue;
    console.log(`  情報：${s.title}　${w ? `作品 ${s.work} → ${f.work}` : ''}${w && a ? '／' : ''}${a ? `歌 ${s.artist} → ${f.artist}` : ''}`);
    if (w) s.work = f.work; if (a) s.artist = f.artist;
    iN++;
  }
  console.log(`曲の情報の修正 ${iN} 曲`);
  if (!DRY) { if (iN) { fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH); } fs.writeFileSync(INFO_PATH, '{}\n'); }

  // ── ジャンルの修正（曲ごと）：新しい方を使う。自動に戻した曲は消す ──
  const SG_PATH = path.join(ROOT, 'data', 'song-genres.json');
  const sg = readJson(SG_PATH, {});
  const rsg = await remote('song-genres');
  let gN = 0;
  for (const [id, g] of Object.entries(rsg || {})) {
    if (sg[id] && sg[id].at >= g.at) continue;
    if (g.reset) { if (sg[id]) { console.log(`  ジャンルを自動に戻す：${g.title}`); delete sg[id]; gN++; } continue; }
    sg[id] = g; gN++; console.log(`  ジャンル：${g.title} → ${(g.genres || []).join('・') || '（なし）'}`);
  }
  if (!DRY && gN) writeJson(SG_PATH, sg);
  console.log(`ジャンルの修正 ${gN} 曲`);

  // ── 知名度の修正（曲ごと）：曲データの fame に入れて、手で決めた印（fameManual）を付ける。自動に戻した曲は印を外して assign-fame で付け直す ──
  const rfm = await remote('song-fame');
  let fN = 0, fReset = 0;
  const rfr = await (async () => { try { const r = await fetch(`${SITE}/api/song-fame`); return (await r.json()).resets || {}; } catch (e) { return {}; } })();
  if (!DRY) {
    const songs2 = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8')), by2 = new Map(songs2.map(s => [s.id, s]));
    for (const [id, f] of Object.entries(rfm || {})) { const s = by2.get(id); if (s && (s.fame !== f.fame || !s.fameManual)) { s.fame = f.fame; s.fameManual = true; fN++; console.log(`  知名度：${f.title} → ${f.fame}`); } }
    for (const [id, f] of Object.entries(rfr || {})) { const s = by2.get(id); if (s?.fameManual && !(rfm || {})[id]) { delete s.fameManual; fReset++; console.log(`  知名度を自動に戻す：${f.title}`); } }
    if (fN || fReset) { fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(songs2, null, 2) + '\n'); fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH); }
    if (fReset) console.log('  （自動に戻した曲があるので、node tools/assign-fame.js を実行してください）');
  }
  console.log(`知名度の修正 ${fN} 曲${fReset ? `、自動に戻す ${fReset} 曲` : ''}`);

  // ── カップリング曲の提案（coupling.html から：「カップリング曲です」「ふつうの曲に戻して」）。確認してから反映するので、ここでは取り込むだけ（承認は手元の coupling.html の「届いた提案」で）──
  const CW_PATH = path.join(ROOT, 'data', 'coupling-reports.json');
  const cwFile = readJson(CW_PATH, { pending: {}, resolved: {} });
  cwFile.pending = cwFile.pending || {}; cwFile.resolved = cwFile.resolved || {};
  const rcw = await remote('coupling-reports');
  let cwN = 0;
  for (const [id, r] of Object.entries(rcw || {})) {
    if ((cwFile.resolved[id] || '') >= r.at) continue; // 確認済み
    const cur = cwFile.pending[id];
    if (!cur || cur.at < r.at) { cwFile.pending[id] = r; cwN++; console.log(`  カップリング曲の提案：${r.title}（${r.artist}）→ ${r.on ? 'カップリング曲です' : 'ふつうの曲に戻して'}（${r.n}件）`); }
  }
  if (!DRY) writeJson(CW_PATH, cwFile);
  console.log(`カップリング曲の提案 ${cwN} 件（承認待ち ${Object.keys(cwFile.pending).length} 件。http://localhost:3001/coupling.html の「届いた提案」で確認）`);

  // ── 再生の統計（流れた回数・正解率）：公開サイトの数を手元の data/play-stats.json に取り込む（公開側は、手元のファイルの数から数え始めるので、公開側のほうが多い）──
  const PS_PATH = path.join(ROOT, 'data', 'play-stats.json');
  try {
    const r = await fetch(`${SITE}/api/play-stats`);
    const ps = (await r.json())['play-stats'];
    const sum = x => Object.values(x?.songs || {}).reduce((a, v) => a + v[0], 0);
    if (ps && sum(ps) >= sum(readJson(PS_PATH, {}))) { if (!DRY) writeJson(PS_PATH, ps); console.log(`再生の統計：出題 ${sum(ps)}回（${Object.keys(ps.songs).length}曲）${ps.since} から`); }
    else console.log('再生の統計：公開サイトの数が少ないので、取り込みません');
  } catch (e) { console.log('再生の統計：取り込めませんでした'); }

  // ── 曲が違う／削除を依頼 ──
  const reports = readJson(REPORTS_PATH, {});
  const rr = await remote('reports');
  for (const [id, r] of Object.entries(rr || {})) {
    const cur = reports[id] || { title: r.title, work: r.work, wrong: 0, delete: 0, notes: [] };
    const seen = new Set(cur.notes.map(x => x.at));
    for (const x of r.notes || []) if (!seen.has(x.at)) { cur.notes.push(x); cur[x.kind] = (cur[x.kind] || 0) + 1; }
    reports[id] = cur;
  }
  let retired = 0;
  for (const [id, r] of Object.entries(reports)) {
    const s = byId.get(id);
    if (r.delete > 0) {
      if (s && !s.retired) {
        s.retired = true; s.retiredNote = r.notes.filter(x => x.kind === 'delete').map(x => x.note).filter(Boolean).join(' / ');
        retired++;
        console.log(`  出題から外す：${s.title}（${s.work}）${s.retiredNote ? ` …${s.retiredNote}` : ''}`);
      }
      r.delete = 0; r.notes = r.notes.filter(x => x.kind !== 'delete');
    }
    if (!(r.wrong > 0) && !(r.info > 0)) delete reports[id];
  }
  const wrong = Object.entries(reports).filter(([, r]) => r.wrong > 0);
  if (wrong.length) {
    console.log(`曲が違う（探し直す）${wrong.length} 曲：`);
    for (const [id, r] of wrong) console.log(`  ${id} ${r.title}（${r.work}）${r.notes.filter(x => x.kind !== 'info' && x.note).map(x => ` …${x.note}`).join('')}`);
  }
  // 曲の情報の直し（曲名・作品名・歌っている人・作者）：確認してから songs.json を直し、--done <id> で消す
  const infoReq = Object.entries(reports).filter(([, r]) => r.info > 0);
  if (infoReq.length) {
    console.log(`曲の情報の修正の依頼 ${infoReq.length} 曲（確認して直す）：`);
    const L = { title: '曲名', work: '作品名', artist: '歌っている人', author: '作者' };
    for (const [id, r] of infoReq) for (const x of r.notes.filter(x => x.kind === 'info')) console.log(`  ${id} ${r.title}（${r.work}）→ ${Object.entries(x.fix || {}).map(([k, v]) => `${L[k] || k}「${v}」`).join('・')}${x.note ? ` …${x.note}` : ''}`);
  }
  console.log(`出題から外す ${retired} 曲`);

  if (DRY) return;
  if (n || retired) { fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(songs, null, 2) + '\n'); fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH); }
  if (n) { writeJson(HISTORY_PATH, history); fs.writeFileSync(FIXES_PATH, '{}\n'); console.log('修正を songs.json に入れて、修正待ちを空にしました（直す前後は fix-history.json）'); }
  writeJson(REPORTS_PATH, reports);
})().catch(e => { console.error('取り込めませんでした:', e.message); process.exit(1); });
