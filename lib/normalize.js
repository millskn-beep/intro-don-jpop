// 入力回答の照合用。表記ゆれ（全角半角・ひらがなカタカナ・記号・空白・長音）をそろえてから完全一致で比べる。

// 比較用に文字列をそろえる
function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
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
  return new Set(raw.map(normalize).filter(s => [...s].length >= 2));
}

function isCorrectText(text, song) {
  const n = normalize(text);
  return [...n].length >= 2 && acceptedAnswers(song).has(n);
}

module.exports = { normalize, shortForm, acceptedAnswers, isCorrectText };
