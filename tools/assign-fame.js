// 全曲に知名度（超有名・有名・普通・マイナー・オタク）を割り振る。
// 目安は2つ：
//   ・YouTube の再生回数（tools/fetch-views.js で取得。動画の種類ごとに比べる。Topic やファン投稿は少なく出るため）
//   ・アニソン人気投票の順位（data/ranking-anison.json。「アニメ好きには知られている」の目安）
// 「オタク」＝アニメ好きには知られているが、世間的な再生回数は多くない曲（＋キャラソン・ギャルゲー曲など）
// 手で変えた曲（fameManual: true）は触らない。
//
// 使い方: node tools/assign-fame.js [--dry-run]
// 保存: 手元のサーバー（http://localhost:3000）が動いていればその API で、止まっていれば songs.json に直接書く

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SONGS_PATH = path.join(ROOT, 'data', 'songs.json');
const SERVER = 'http://localhost:3000';
const DRY = process.argv.includes('--dry-run');

const songs = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
const ranks = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'ranking-anison.json'), 'utf8'));
const GENRES = require(path.join(ROOT, 'data', 'genres.json'));
const inGenre = (s, k) => GENRES[k].keywords.some(w => String(s.work).includes(w));

const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s!！・〜~～()（）\-♪【】.。,、\/'"「」『』?？&＆*＊☆★♡:：…･]/g, '');
const rankOf = new Map();
for (const r of ranks) { const k = norm(r.title); if (!rankOf.has(k)) rankOf.set(k, r.rank); }

// 動画の種類。再生回数はこの中で比べる
const classOf = s => /- Topic$/i.test(s.channel || '') || s.source === 'Topic' ? 'topic'
  : /非公式|ファン/.test(`${s.source || ''}${s.note || ''}`) ? 'fan'
  : /TVサイズ|ショート|short/i.test(s.source || '') ? 'short' : 'video';
// アニソン以外のまとまり（その中の再生回数だけで分ける）
const bucketOf = s => inGenre(s, 'vocaloid') ? 'vocaloid' : inGenre(s, 'jpop') ? 'jpop' : inGenre(s, 'lol') ? 'lol' : 'anime';

// まとまりの中での再生回数の順位（0〜1。1がいちばん多い）
function percentiles(list, keyFn) {
  const groups = new Map();
  for (const s of list) { const k = keyFn(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  const out = new Map();
  for (const g of groups.values()) {
    const withViews = g.filter(s => s.views > 0).sort((a, b) => a.views - b.views);
    withViews.forEach((s, i) => out.set(s.id, withViews.length > 1 ? i / (withViews.length - 1) : 0.5));
  }
  return out;
}
const anime = songs.filter(s => bucketOf(s) === 'anime');
const pubAnime = percentiles(anime, classOf);
const pubOther = percentiles(songs.filter(s => bucketOf(s) !== 'anime'), s => bucketOf(s) + ':' + classOf(s));

// 数字だけでは外れる曲を、曲名で直す（一覧を見て決めたもの）
const OVERRIDES = {
  'メルト': 'top', '君をのせて': 'top', 'いつも何度でも': 'top', 'ドラえもんのうた': 'top', '愛をとりもどせ!!': 'top',
  '風の谷のナウシカ': 'famous', '水の星へ愛をこめて': 'famous', 'ふわふわ時間': 'famous', '桜流し': 'famous', '一輪の花': 'famous',
  'Share The World': 'normal', 'from the edge': 'normal', 'ニルスのふしぎな旅': 'normal', '太陽の真ん中へ': 'normal',
  '私の彼はパイロット': 'otaku', '旅の途中': 'otaku', 'Crow Song': 'otaku', 'わが臈たし悪の華': 'otaku',
};

// キャラソン・ギャルゲー曲など、もともと「オタク向け」の曲
const isOtakuKind = s => inGenre(s, 'galge') || /キャラクターソング|イメージソング|BGM/.test(s.type || '') || /（パチスロ）|^その他（/.test(s.work)
  || (/挿入歌|劇中歌/.test(s.type || '') && /[(（]CV|[(（][^)）]*[)）]|starring/.test(s.artist || ''));

function fameOf(s) {
  if (OVERRIDES[s.title]) return OVERRIDES[s.title];
  const bucket = bucketOf(s);
  if (bucket !== 'anime') {
    const p = pubOther.get(s.id);
    if (p === undefined) return 'normal';
    // ボカロ・J-POP は年代ごとの有名曲だけを入れているので、いちばん下でも「普通」
    if (bucket !== 'lol') return p >= 0.75 ? 'top' : p >= 0.35 ? 'famous' : 'normal';
    return p >= 0.8 ? 'top' : p >= 0.45 ? 'famous' : p >= 0.15 ? 'normal' : 'minor';
  }
  const p = pubAnime.get(s.id), rk = rankOf.get(norm(s.title));
  const pub = p === undefined ? 0.5 : p; // 再生回数が分からない曲は真ん中として扱う
  if (rk && rk <= 60) return 'top';
  if ((rk && rk <= 160 && pub >= 0.55) || pub >= 0.96) return 'top';
  if (rk && rk <= 320) return 'famous';     // 投票の上位は、動画の再生回数が少なくても（古い曲・ファン投稿など）よく知られている
  // 子ども向け・ジブリは「オタク向け」ではないので、知られていなければマイナー寄りにする
  const family = inGenre(s, 'kids') || inGenre(s, 'ghibli');
  const otaku = () => (family ? (rk && rk <= 700 ? 'normal' : 'minor') : 'otaku');
  if (pub >= 0.72) return isOtakuKind(s) && pub < 0.9 ? otaku() : 'famous';
  if (isOtakuKind(s)) return otaku();
  if (rk && pub < 0.5) return otaku();      // 投票には入っているが、再生回数は少ない＝アニメ好きには知られている
  if (!rk && pub < 0.2) return 'minor';
  return 'normal';
}

const LABEL = { top: '超有名', famous: '有名', normal: '普通', minor: 'マイナー', otaku: 'オタク' };
const result = songs.map(s => ({ s, fame: s.fameManual && s.fame ? s.fame : fameOf(s) }));
const count = {};
for (const r of result) count[r.fame] = (count[r.fame] || 0) + 1;
console.log(Object.entries(LABEL).map(([k, l]) => `${l} ${count[k] || 0}`).join(' / '), `（全 ${songs.length} 曲、再生回数あり ${songs.filter(s => s.views > 0).length} 曲）`);

if (DRY) {
  const show = k => result.filter(r => r.fame === k).map(r => `${r.s.title}〔${r.s.work.slice(0, 14)}〕`).join(' / ');
  if (process.argv.includes('--list')) for (const k of ['top', 'otaku', 'minor']) console.log(`\n■ ${LABEL[k]}\n${show(k)}`);
  process.exit(0);
}

(async () => {
  const changed = result.filter(r => r.s.fame !== r.fame).map(r => ({ ...r.s, fame: r.fame }));
  console.log(`変更 ${changed.length} 曲を保存します`);
  try {
    for (let i = 0; i < changed.length; i += 200) {
      const res = await fetch(`${SERVER}/api/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ songs: changed.slice(i, i + 200) }) });
      if (!res.ok) throw new Error((await res.json()).error);
    }
    console.log('保存しました（サーバー経由）');
  } catch (e) {
    const all = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
    const byId = new Map(changed.map(s => [s.id, s.fame]));
    for (const s of all) if (byId.has(s.id)) s.fame = byId.get(s.id);
    fs.writeFileSync(SONGS_PATH + '.tmp', JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(SONGS_PATH + '.tmp', SONGS_PATH);
    console.log('保存しました（ファイルに直接）');
  }
})();
