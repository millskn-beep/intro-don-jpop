// キャラクター（双子・うさぎ・ねこ）の一覧。絵は /assets/mascot/<key>/<場面>.webp
// 場面（pose）: idle 待機 / listen イントロ / chorus サビ / again もう一回 / ok 正解 / ng 不正解 / celebrate お祝い / cutin カットイン
// 絵がない場面は、近い場面の絵を使う（FALLBACK）
// lines：吹き出しのセリフ（場面ごとにランダム）。{…} はその場の名前や数字に置きかわる
//   {n} 問題番号 / {nk} 問題番号（漢数字） / {left} 残りの問題数 / {top} トップの人 / {score} トップの点 / {second} 2位の人
//   {rank} 自分の順位 / {sec} 答えた秒数 / {streak} 連続正解の数 / {name} 自分の名前
export const CHARACTERS = {
  twins: {
    label: '双子（青＆赤）',
    poses: ['idle', 'listen', 'chorus', 'again', 'ok', 'ng', 'celebrate', 'cutin'],
    // 出題中・答え合わせ中は左右に分ける（青＝左、赤＝右）。場面 → 絵のファイル名
    split: {
      left: { listen: 'left-listen', again: 'left-listen', chorus: 'left-chorus', ok: 'left-ok', ng: 'left-ng', celebrate: 'left-ok' },
      right: { listen: 'right-listen', again: 'right-listen', chorus: 'right-chorus', ok: 'right-ok', ng: 'right-ng', celebrate: 'right-ok' },
    },
    lines: {
      lobby: ['いっしょに遊ぼ！', '準備はいい？', '今日は何曲いけるかな？', '{name}さん、いらっしゃい！', 'ヘッドホンの準備OK？', '早押しの練習しとく？'],
      start: ['いっくよー！', 'がんばろうね！', 'スタート！耳をすませて！', '楽しんでいこー！'],
      qstart: ['{nk}問目！はじめるよ！', '第{n}問、いくよー！', '次は{nk}問目！', '{nk}問目、わかるかな？', 'さあ{nk}問目！集中〜！'],
      half: ['折り返し地点だよ！', 'もう半分！まだまだこれから！'],
      remain: ['残り{left}問！', 'あと{left}問だよ、がんばって！', '残り{left}問、逆転あるかも！'],
      final: ['最後だよ！', 'ラストいくよー！', '最終問題は得点2倍！', '泣いても笑っても最後の1問！'],
      intro: ['わかるかな？', 'このイントロ…！', '耳をすませて…', '聴いたことあるかも？', 'イントロだけでわかったらすごい！'],
      again: ['もう一回いくよ！', 'よーく聴いてね！', 'もう一回だけね！', '次は当てよう！'],
      chorus: ['サビきたー！', 'ここで当てて！', '盛り上がってきた！', 'サビならわかる？', 'この曲、知ってるでしょ？'],
      ok: ['すごーい！', 'さすが！', 'やったね！', '正解っ！', '天才！？', 'いい耳してる！'],
      fast: ['はやっ！{sec}秒！', '{sec}秒で正解！？すごすぎ！', '一瞬だったね！'],
      ng: ['おしい…！', 'ドンマイ！', '次は当てよ！', '難しかったね…', 'その曲もいい曲だよね！'],
      pass: ['パスもアリだよ！', '次で取り返そ！', 'わからない曲もあるよね〜'],
      timeout: ['時間切れ〜！', 'あとちょっとだったかも！', '迷っちゃった？'],
      allok: ['全員正解！みんなすごい！', 'この曲はみんな知ってたね！'],
      allng: ['誰もわからなかった…難問だね！', '超難問だったね…！'],
      streak: ['{streak}連続だよ！すごい！', '止まらないね！', 'この調子！'],
      lead: ['{top}さんがトップ！追いつけるかな？', 'トップは{top}さん、{score}点！', '{top}さん強い…！', 'みんな、{top}さんを止めて〜！'],
      meTop: ['あなたがトップ！このまま逃げ切ろう！', 'トップだよ！その調子！', 'さすが！1位キープ！'],
      close: ['{top}さんと{second}さん、接戦だよ！', '大接戦！どっちが勝つかな？'],
      rankUp: ['{rank}位に上がったよ！', 'ぐんぐん上がってる！{rank}位！'],
      win: ['優勝おめでとう！', 'かんぱーい！', '{top}さん、優勝！すごーい！', 'みんなおつかれさま！'],
    },
  },
};
// うさぎ・ねこのセリフ：双子のセリフの語尾に「ぴょん」「にゃ」を付けたものに、それぞれの専用セリフを足す
const flavor = (lines, tail) => Object.fromEntries(Object.entries(lines).map(([k, list]) => [k, list.map(l =>
  /[！？]$/.test(l) ? l.slice(0, -1) + tail + l.slice(-1) : /[。…]$/.test(l) ? l : l + tail)]));
const add = (base, extra) => Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [...v, ...(extra[k] || [])]]));
const ANIMAL_POSES = ['idle', 'listen', 'chorus', 'again', 'ok', 'ng', 'celebrate', 'cutin'];
CHARACTERS.rabbit = {
  label: 'うさぎ',
  poses: ANIMAL_POSES,
  lines: add(flavor(CHARACTERS.twins.lines, 'ぴょん'), {
    lobby: ['にんじん食べて待ってるぴょん！', '耳には自信があるぴょん！'],
    intro: ['うさ耳でよーく聴くぴょん…', 'ぴょこっとわかったら押してね！'],
    ok: ['ぴょーん！大正解！', 'にんじんあげるぴょん！'],
    ng: ['しょんぼりぴょん…', '耳がたれちゃうぴょん…'],
    chorus: ['サビでぴょんぴょん跳ねちゃう！'],
    win: ['優勝！にんじんパーティーだぴょん！'],
  }),
};
CHARACTERS.cat = {
  label: 'ねこ',
  poses: ANIMAL_POSES,
  lines: add(flavor(CHARACTERS.twins.lines, 'にゃ'), {
    lobby: ['にゃーん、遊ぼ！', 'ゴロゴロ…準備OKにゃ！'],
    intro: ['ねこ耳ピーン…！', 'しっぽが反応してるにゃ…！'],
    ok: ['にゃっ！大正解！', 'ごほうびのおやつにゃ！'],
    ng: ['にゃーん…', 'しっぽがしょんぼりにゃ…'],
    chorus: ['サビでテンション上がるにゃ！'],
    win: ['優勝にゃ！おさかなパーティーにゃ！'],
  }),
};
export const FALLBACK = { idle: 'listen', celebrate: 'ok', cutin: 'ok' };
// 問題番号を漢数字に（1〜99）
export function kanjiNum(n) {
  const d = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n < 10) return d[n] || String(n);
  const t = Math.floor(n / 10), o = n % 10;
  return (t === 1 ? '' : d[t]) + '十' + d[o];
}
