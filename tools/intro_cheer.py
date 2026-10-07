# イントロの頭に「音楽以外の音」（歓声・MC・セリフ・効果音・風などの環境音）が入っていて、
# それもイントロとして数えられてしまう曲を見つけ、「音楽が始まる秒数」を提案する（曲データは変えない）。
# いまの無音カット（tools/measure-intro.js）は音の大きさで判断するので、大きな音なら音楽でなくても始まりとみなしてしまう。
#
# 判定（1 秒ずつ・0.5 秒おき、頭から 45 秒）
#   text：区間の音を「音楽」「歓声・拍手」「話し声」「効果音・環境音」の文章と比べる
#   self：その曲のサビの音を「この曲の音楽」の見本にして、似ている区間を音楽とみなす
# 「音楽」が 3 秒続いた最初の位置を、音楽の始まりとする。
#
# 使い方（専用の環境。音は data/audio-cache から）
#   .venv-embed/Scripts/python tools/intro_cheer.py --test     正解の分かる曲で当たり具合を見る
# 結果は data/intro-cheer.json
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from embed_scan import load_model, to16k, CACHE, labeled  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SONGS_PATH = ROOT / 'data' / 'songs.json'
OUT_PATH = ROOT / 'data' / 'intro-cheer.json'
WIN, STEP, HEAD = 1.0, 0.5, 45
RUN = 3.0  # 音楽がこの秒数続いたら始まりとみなす
LABELS = {
    'music': 'music playing, a song with instruments and singing',
    'cheer': 'crowd cheering, screaming and applause at a concert',
    'speech': 'people talking, spoken dialogue',
    'sfx': 'sound effects and ambient environmental sounds, wind, footsteps, nature',
}
# 正解（収録曲一覧から手で直したイントロ）。Love wing bell は逆に、静かな出だしを切りすぎていた曲
POSITIVE = {'lHWVOfC41L4': 19.6, 'cREAHvB02RQ': 24, 'CbH2F0kXgTY': 9, 'B3JAxDoYOs4': 15.2, '-6j8kizolIc': 4, 'tDHcemDdDYw': 0}


def emb(model, clips):
    return np.stack([np.asarray(model.encode({'text': '<|audio|>', 'audio': [c]}, normalize_embeddings=True),
                                dtype=np.float32).reshape(-1) for c in clips])


def onset(is_music, starts):
    """音楽が RUN 秒続いた最初の位置（なければ None）"""
    need = int(RUN / STEP)
    for i in range(len(is_music) - need + 1):
        if is_music[i:i + need].mean() >= 0.8:
            return float(starts[i])
    return None


def analyze(model, T, y16, chorus):
    sr = 16000
    starts = np.arange(0, min(HEAD, len(y16) / sr - WIN), STEP)
    E = emb(model, [y16[int(t * sr):int((t + WIN) * sr)] for t in starts])
    S = E @ T.T  # 区間 × 文章
    text_music = S[:, 0] - S[:, 1:].max(1)
    # サビの 20 秒を見本にする
    c0 = chorus if chorus and chorus + 20 < len(y16) / sr else max(30.0, len(y16) / sr * 0.3)
    cs = np.arange(c0, c0 + 20, 1.0)
    C = emb(model, [y16[int(t * sr):int((t + WIN) * sr)] for t in cs])
    cen = C.mean(0); cen /= np.linalg.norm(cen)
    ref = C @ cen
    self_sim = E @ cen
    return starts, text_music, self_sim, float(ref.mean()), float(ref.std())


def main():
    songs = {s['id']: s for s in json.loads(SONGS_PATH.read_text(encoding='utf8'))}
    model = load_model()
    T = np.stack([np.asarray(model.encode(v, prompt_name='SearchQuery', normalize_embeddings=True), dtype=np.float32).reshape(-1)
                  for v in LABELS.values()])
    targets = [(i, t, 'pos') for i, t in POSITIVE.items()]
    targets += [(it['id'], songs[it['id']].get('intro', 0) or 0, 'neg') for it in labeled() if it['kind'] == 'topic']
    rows = []
    for vid, truth, kind in targets:
        p = CACHE / f'{vid}.npy'
        if not p.exists() or vid not in songs:
            continue
        s = songs[vid]
        y16 = to16k(np.load(p))
        starts, tm, ss, mu, sd = analyze(model, T, y16, s.get('chorus'))
        rows.append({'id': vid, 'title': s['title'], 'kind': kind, 'truth': truth, 'starts': starts.tolist(),
                     'textMusic': tm.round(4).tolist(), 'selfSim': ss.round(4).tolist(), 'refMean': mu, 'refStd': sd})
        print(f"{kind} {s['title'][:16]:16} 正解 {truth}", flush=True)
    OUT_PATH.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf8')
    evaluate(rows)


def evaluate(rows):
    """しきい値を変えて当たり具合を見る。当たり：正解との差が 1.5 秒以内"""
    def pred(r, method, k):
        st = np.array(r['starts'])
        if method == 'text':
            m = np.array(r['textMusic']) > k
        else:
            m = np.array(r['selfSim']) >= r['refMean'] - k * max(r['refStd'], 0.005)
        return onset(m, st)
    print('\n方法・しきい値ごと：頭に音楽以外がある曲の当たり／ふつうの曲で余計に遅らせた数')
    for method, ks in (('text', [-0.03, -0.02, -0.01, 0, 0.01]), ('self', [1, 2, 3, 4, 6])):
        for k in ks:
            hit = sum(1 for r in rows if r['kind'] == 'pos' and (p := pred(r, method, k)) is not None and abs(p - r['truth']) <= 1.5)
            npos = sum(1 for r in rows if r['kind'] == 'pos')
            late = [r['title'] for r in rows if r['kind'] == 'neg' and ((p := pred(r, method, k)) is None or p > r['truth'] + 1.5)]
            nneg = sum(1 for r in rows if r['kind'] == 'neg')
            print(f'  {method} k={k:<5} 当たり {hit}/{npos}  誤検出 {len(late)}/{nneg} ' +
                  ' / '.join(f"{r['title'][:8]}→{pred(r, method, k)}" for r in rows if r['kind'] == 'pos'))


if __name__ == '__main__':
    if '--eval' in sys.argv:
        evaluate(json.loads(OUT_PATH.read_text(encoding='utf8')))
    else:
        main()
