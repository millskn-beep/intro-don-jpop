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

// 「ヴァ」と「バ」、「ぢ」と「じ」、「を」と「お」、小さい「ぁ」と大きい「あ」など、IMEや人によって打ち分けがばらばらな仮名は、同じものとして比べる
// （比べる両側に同じ変換をかけるので、曲名の側の表記も同じにそろう）
const KANA_FOLD = {
  'ゔぁ': 'ば', 'ゔぃ': 'び', 'ゔぇ': 'べ', 'ゔぉ': 'ぼ', 'ゔゅ': 'びゅ', 'ゔ': 'ぶ',
  'ぢ': 'じ', 'づ': 'ず', 'を': 'お', 'ゐ': 'い', 'ゑ': 'え',
  'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お', 'っ': 'つ', 'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'ゎ': 'わ',
};
const KANA_RE = /ゔ[ぁぃぇぉゅ]?|[ぢづをゐゑぁぃぅぇぉっゃゅょゎ]/g;

// 比較用に文字列をそろえる
function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(VARIANT_RE, c => VARIANTS[c])
    .replace(/[〇一二三四五六七八九]/g, c => KANJI_DIGITS[c])
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)) // カタカナ→ひらがな
    .replace(/[\s\p{P}\p{S}ー〜～]/gu, '') // 空白・記号・長音を除く
    .replace(KANA_RE, c => KANA_FOLD[c] ?? c); // 打ち分けにくい仮名（ゔぁ・ば、ぢ・じ など）は区別しない
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
const VOCAL_ALIASES = {
  '初音ミク': ['ミク', '初音', 'Hatsune Miku', 'miku', 'はつねみく'], '鏡音リン': ['リン', 'Kagamine Rin', 'かがみねりん', '鏡音'], '鏡音レン': ['レン', 'Kagamine Len', 'かがみねれん', '鏡音'],
  '巡音ルカ': ['ルカ', 'Megurine Luka'], 'GUMI': ['グミ', 'Megpoid'], 'IA': ['イア'], 'v flower': ['flower', 'フラワー'],
  'KAITO': ['カイト'], 'MEIKO': ['メイコ'], '歌愛ユキ': ['ユキ'], '重音テト': ['テト', 'Kasane Teto'], '可不': ['KAFU', 'カフ'],
};

// 呼び方の短い形（選択肢の「ミク×リン」用）
const VOCAL_SHORT = { '初音ミク': 'ミク', '鏡音リン': 'リン', '鏡音レン': 'レン', '巡音ルカ': 'ルカ', 'v flower': 'flower' };
const vocalShort = v => VOCAL_SHORT[v] || v;
// 2人以上で歌っている曲の、選択肢用の表記（「ミク×リン」）
const vocalCombo = vs => vs.map(vocalShort).join('×');

function acceptedAnswers(song, target = 'song') {
  const workNoPrefix = String(song.work ?? '').normalize('NFKC').replace(/^(劇場版|映画)\s*/, '');
  // 読みがな・略称（tools/apply-readings.js が data/readings.json から入れる）：曲名は aliases、作品名は workAliases、歌手名は artistAliases
  const works = [song.work, shortForm(song.work), workNoPrefix, shortForm(workNoPrefix), workBase(song.work),
                 withoutSequel(shortForm(workNoPrefix)), ...(song.workAliases || [])];
  // 歌手当て：歌手名と、×・&・feat. などで区切った一人ひとりの名前
  const artistParts = String(song.artist ?? '').normalize('NFKC').split(/\s*(?:×|&|＆|feat\.?|ft\.|、|,|\/|with)\s*|\s+(?:from|starring)\s+/i);
  // キャラ名義「神原駿河(沢城みゆき)」「戦場ヶ原ひたぎ(CV:斎藤千和)」：キャラ名とカッコの中の名前（声優）のどちらでも正解
  const inParens = [String(song.artist ?? '').normalize('NFKC'), ...artistParts].flatMap(p => {
    const m = p.match(/^(.*?)\s*\((?:CV\s*[.:]?\s*)?([^()]+)\)\s*$/i);
    return m ? [m[1], ...m[2].split(/\s*[・,、]\s*/)] : [];
  });
  const artists = [song.artist, shortForm(song.artist), ...artistParts, ...inParens, ...(song.artistAliases || [])];
  // ボカロの作者：作品欄の「ボカロ（ryo）」のカッコの中と、歌手名（supercell など）
  const author = String(song.work ?? '').normalize('NFKC').match(/^ボカロ\((.+)\)$/)?.[1];
  // プロセカの書き下ろし：「プロセカ」でも作曲者（歌手の欄）でも正解
  const sekai = author === 'プロセカ' ? [song.artist, shortForm(song.artist)] : [];
  // ボカロの VOCALOID：歌っている VOCALOID のどれか1つ（呼び方の違いも受け付ける）
  const vocals = (song.vocal || []).flatMap(v => [v, ...(VOCAL_ALIASES[v] || [])]);
  // 2人以上で歌っている曲：どの組み合わせの書き方でも正解（ミク×リン／ミクxリン／リン・ミク／みくりん など。順番も問わない）
  const vs = song.vocal || [];
  if (vs.length >= 2 && vs.length <= 4) {
    const perms = a => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(r => [x, ...r]));
    for (const p of perms(vs)) for (const sep of ['×', 'x', '&', '・', '']) {
      vocals.push(p.map(v => vocalShort(v)).join(sep), p.join(sep));
    }
  }
  const raw = target === 'artist' ? artists : target === 'work' ? works : target === 'author' ? [author, ...artists]
    : target === 'vocal' ? vocals
    : target === 'singer' ? (song.singer || []) // 本人が歌っている動画の歌手（米津玄師／ハチ など、別名も）
    : target === 'title' ? [song.title, shortForm(song.title), ...(song.aliases || [])] // 3つ埋めバトルの曲名（作品名では正解にしない）
    : [song.title, shortForm(song.title), ...works, ...(song.aliases || []), ...(song.type === 'ボカロ' && author ? [author, ...sekai] : [])]; // ボカロ曲は、作者名（プロセカ原曲なら「プロセカ」）でも正解
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

module.exports = { vocalShort, vocalCombo, normalize, shortForm, acceptedAnswers, isCorrectText, isAlmostText };
