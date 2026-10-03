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

// 1曲に対して正解として受け付ける文字列（そろえた後）の集合
function acceptedAnswers(song) {
  const workNoPrefix = String(song.work ?? '').normalize('NFKC').replace(/^(劇場版|映画)\s*/, '');
  const raw = [song.title, shortForm(song.title), song.work, shortForm(song.work), workNoPrefix, shortForm(workNoPrefix),
               workBase(song.work), ...(song.aliases || [])];
  // 短すぎる別名は誤判定のもとなので2文字以上。ただし曲名そのものが1文字（「炎」など）なら受け付ける
  const title = normalize(song.title);
  return new Set(raw.map(normalize).filter(s => [...s].length >= 2 || (s && s === title)));
}

function isCorrectText(text, song) {
  const n = normalize(text);
  return n.length > 0 && acceptedAnswers(song).has(n);
}

module.exports = { normalize, shortForm, acceptedAnswers, isCorrectText };
