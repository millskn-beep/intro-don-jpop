// 入力回答の照合用。表記ゆれ（全角半角・ひらがなカタカナ・記号・空白・長音）をそろえてから完全一致で比べる。

// 入力方法によって出たり出なかったりする異体字（スマホや新しいIMEは左側を出すことがある）
const VARIANTS = {
  '噓': '嘘', '髙': '高', '﨑': '崎', '嵜': '崎', '邊': '辺', '邉': '辺', '遙': '遥', '剝': '剥', '頰': '頬',
  '摑': '掴', '繫': '繋', '𠮷': '吉', '德': '徳', '曾': '曽', '濵': '浜', '濱': '浜', '冨': '富', '櫻': '桜',
  '龍': '竜', '國': '国', '澤': '沢', '眞': '真', '學': '学', '戀': '恋', '彌': '弥', '廣': '広', '靑': '青',
};
const VARIANT_RE = new RegExp(`[${Object.keys(VARIANTS).join('')}]`, 'gu');
// 「四月」と「4月」を同じにする（両方を数字にそろえる。比べる両側に同じ変換をかけるので副作用はない）
const KANJI_DIGITS = { '〇': '0', '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };

// 比較用に文字列をそろえる
function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(VARIANT_RE, c => VARIANTS[c])
    .replace(/[〇一二三四五六七八九]/g, c => KANJI_DIGITS[c])
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)) // カタカナ→ひらがな
    .replace(/[\s\p{P}\p{S}ー〜～]/gu, ''); // 空白・記号・長音を除く
}

// 「みんなが実際に打ちそうな短い形」を作る（feat. やシーズン表記、括弧書きなどを落とす）
function shortForm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/\s*feat\..*$/i, '')
    .replace(/\s*[(（][^()（）]*[)）]\s*$/, '')
    .replace(/\s*[〜～][^〜～]*[〜～]?\s*$/, '')
    .replace(/\s+-.+-\s*$/, '')
    .replace(/\s*(the final season.*|season\s*\d+.*|\d+(st|nd|rd|th)\s*season.*|第\s*\d+\s*期.*|\d+\s*期.*|part\.?\s*\d+.*)$/i, '')
    .trim();
}

// 作品名の最初の区切りまで（「呪術廻戦 懐玉・玉折」→「呪術廻戦」）。
// 「劇場版」「映画」は飛ばし、英字だけの語（ONE など）は短すぎて紛らわしいので使わない
function workBase(work) {
  const first = String(work ?? '').normalize('NFKC').replace(/^(劇場版|映画)\s*/, '').split(/\s+/)[0] || '';
  return /[^\x00-\x7f]/.test(first) ? first : '';
}

// 続編の番号を外した作品名（「無職転生II」→「無職転生」、「北斗の拳2」→「北斗の拳」、「キングダム 第3シリーズ」→「キングダム」など）。
// 番号まで打たなくても正解にするため。英字・数字の直後の数字（「ガンダム00」「らんま1/2」）は作品名の一部なので外さない
function withoutSequel(w) {
  let s = String(w ?? '').normalize('NFKC').trim(), prev;
  do {
    prev = s;
    s = s.replace(/\s*(第\s*\d+\s*(シリーズ|シーズン|クール|期)|\d+\s*(st|nd|rd|th)\s*(シーズン|season)|R\d)$/i, '')
         .replace(/(?<=[^\x00-\x7f]|\s)\s*(II|III|IV|V|VI|Ⅱ|Ⅲ|Ⅳ|Ⅴ)$/, '')
         .replace(/(?<=[^\x00-\x7f\d]|\s)\s*[2-9]$/, '')
         .replace(/[。\s]*(続|完)$/, '')
         .trim();
  } while (s !== prev && s);
  return s;
}

// 1曲に対して正解として受け付ける文字列（そろえた後）の集合。target が 'work'（作品当て）のときは作品名だけ
function acceptedAnswers(song, target = 'song') {
  const workNoPrefix = String(song.work ?? '').normalize('NFKC').replace(/^(劇場版|映画)\s*/, '');
  const works = [song.work, shortForm(song.work), workNoPrefix, shortForm(workNoPrefix), workBase(song.work),
                 withoutSequel(shortForm(workNoPrefix))];
  const raw = target === 'work' ? works : [song.title, shortForm(song.title), ...works, ...(song.aliases || [])];
  // 短すぎる別名は誤判定のもとなので2文字以上。ただし曲名そのものが1文字（「炎」など）なら受け付ける
  const title = normalize(song.title);
  return new Set(raw.map(normalize).filter(s => [...s].length >= 2 || (s && s === title)));
}

function isCorrectText(text, song, target) {
  const n = normalize(text);
  return n.length > 0 && acceptedAnswers(song, target).has(n);
}

// 文字列のちがい（1文字の追加・削除・置き換えを1とした回数）
function editDistance(a, b) {
  a = [...a]; b = [...b];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// 正解ではないが「惜しい」（正解のどれかと1文字ちがい。長い答えは2文字まで）
function isAlmostText(text, song, target) {
  const n = normalize(text);
  if ([...n].length < 3) return false;
  for (const ans of acceptedAnswers(song, target)) {
    const len = [...ans].length;
    if (len < 3) continue;
    if (editDistance(n, ans) <= (len >= 8 ? 2 : 1)) return true;
  }
  return false;
}

module.exports = { normalize, shortForm, acceptedAnswers, isCorrectText, isAlmostText };
