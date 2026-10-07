# 収録曲一覧から直してもらったイントロ・サビの位置（data/fix-history.json）を正解にして、自動計測の設定を合わせる。
#   サビ：tools/estimate_chorus_audio.py の点数の重み（くり返し・大きさ・盛り上がり・長さからの推定）をいろいろ試し、
#         いちばん当たる組み合わせを探す（当たり：正解の -8〜+3 秒）
#   イントロ：tools/intro_cheer.py の「音楽が N 秒続いた所を始まりとする」の N と、調べる長さを試す（当たり：正解との差 1.5 秒以内）
# 曲データも計測ツールも変えない。結果を表示し、data/learn-from-fixes.json に書く。
# 使い方（専用の環境。音は data/audio-cache から）
#   .venv-embed/Scripts/python tools/learn_from_fixes.py [--chorus] [--intro]
import itertools
import json
import random
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import estimate_chorus_audio as ec  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data' / 'audio-cache'
HISTORY = json.loads((ROOT / 'data' / 'fix-history.json').read_text(encoding='utf8'))
OUT = ROOT / 'data' / 'learn-from-fixes.json'
songs = {s['id']: s for s in json.loads(ec.SONGS_PATH.read_text(encoding='utf8'))}
cached = lambda i: (CACHE / f'{i}.npy').exists()
result = {}


def chorus():
    # 正解：直してもらったサビ（直した後）＋ 前からある正解（手で設定・よく再生される部分）の 40 曲
    truth = {h['id']: h['after']['chorus'] for h in HISTORY if h['after']['chorus'] != h['before']['chorus']}
    pool = [s for s in songs.values() if s.get('chorus', 0) > 0 and s.get('chorusSource') in ('manual', 'heatmap') and s.get('embeddable') is not False]
    random.seed(1)
    for s in random.sample(pool, 40):
        truth.setdefault(s['id'], s['chorus'])
    items = [(i, t, songs[i].get('intro', 0) or 0) for i, t in truth.items() if cached(i) and i in songs]
    print(f'サビ：正解 {len(items)} 曲（うち直してもらった曲 {sum(1 for i, *_ in items if i in {h["id"] for h in HISTORY})}）', flush=True)
    audio = {i: np.load(CACHE / f'{i}.npy') for i, *_ in items}
    grid = [w for w in itertools.product([0, 0.25, 0.5, 0.75, 1], repeat=4) if sum(w) > 0]
    # くり返しの計算は重いので、曲ごとに部品（4 つの点数）を一度だけ作って、重みだけ変えて試す
    parts = {}
    for i, t, intro in items:
        parts[i] = components(audio[i], intro)
    rows = []
    for w in grid:
        hit = sum(1 for i, t, _ in items if parts[i] and -8 <= pick(parts[i], w) - t <= 3)
        rows.append((hit, w))
    rows.sort(key=lambda x: -x[0])
    cur = next(h for h, w in rows if list(w) == list(ec.W))
    print(f'  いまの重み {ec.W}: {cur} / {len(items)} 曲')
    for h, w in rows[:8]:
        print(f'  重み {list(w)}: {h} / {len(items)} 曲')
    # 当てはめすぎの確認：半分で選んで、残り半分で当たり具合を見る
    ids = [i for i, *_ in items]; random.seed(2); random.shuffle(ids)
    a, b = set(ids[:len(ids) // 2]), set(ids[len(ids) // 2:])
    score = lambda w, S: sum(1 for i, t, _ in items if i in S and parts[i] and -8 <= pick(parts[i], w) - t <= 3)
    best_a = max(grid, key=lambda w: score(w, a))
    print(f'  確認：前半で選んだ重み {list(best_a)} → 後半 {score(best_a, b)} / {len(b)} 曲（いまの重みだと {score(ec.W, b)} 曲）')
    result['chorus'] = {'n': len(items), 'current': {'w': ec.W, 'hits': cur}, 'top': [{'w': list(w), 'hits': h} for h, w in rows[:8]],
                        'holdout': {'w': list(best_a), 'hits': score(best_a, b), 'currentHits': score(ec.W, b), 'n': len(b)}}


def components(y, intro):
    """estimate_chorus_audio.estimate と同じ 4 つの点数（正規化済み）と、時間の目盛り"""
    import librosa
    SR, HOP, SEG = ec.SR, ec.HOP, ec.SEG
    fps = SR / HOP
    dur = len(y) / SR
    chroma = librosa.util.normalize(librosa.feature.chroma_stft(y=y, sr=SR, hop_length=HOP), axis=0)
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    n = min(chroma.shape[1], len(rms)); chroma, rms = chroma[:, :n], rms[:n]
    w = int(SEG * fps)
    if n < w * 3:
        return None
    sim = chroma.T @ chroma
    rep = np.zeros(n); kernel = np.ones(w) / w
    for k in range(int(ec.MIN_LAG * fps), n - w):
        m = np.convolve(np.diagonal(sim, k), kernel, mode='valid')
        np.maximum(rep[:len(m)], m, out=rep[:len(m)]); np.maximum(rep[k:k + len(m)], m, out=rep[k:k + len(m)])
    lo = int((intro + 15) * fps); hi = int(min(dur * 0.75, dur - SEG) * fps)
    if hi <= lo + 2:
        return None
    norm = lambda a: (a - a[lo:hi].min()) / (np.ptp(a[lo:hi]) + 1e-9)
    loud_seg = np.convolve(rms, kernel, mode='full')[w - 1:w - 1 + n]
    k2 = int(2 * fps)
    after = np.array([rms[i:i + k2].mean() if i + k2 <= n else 0 for i in range(n)])
    before = np.array([rms[max(0, i - k2):i].mean() if i > 0 else 0 for i in range(n)])
    t_idx = np.arange(n) / fps
    near = np.exp(-((t_idx - ec.guess(intro, dur)) / 20) ** 2)
    return {'P': np.stack([norm(rep), norm(loud_seg), norm(after - before), near]), 'lo': lo, 'hi': hi, 'fps': fps}


def pick(p, w):
    score = np.asarray(w) @ p['P']
    t = p['lo'] + int(np.argmax(score[p['lo']:p['hi']]))
    return round(max(0, t / p['fps'] - 0.3), 1)


def intro():
    from intro_cheer import load_model, emb, SCAN_LABELS
    from embed_scan import to16k
    items = [(h['id'], h['after']['intro'], h['before']['intro']) for h in HISTORY
             if abs(h['after']['intro'] - h['before']['intro']) > 0.3 and cached(h['id'])]
    print(f'\nイントロ：正解 {len(items)} 曲（直す前の値との差が 0.3 秒より大きい曲）', flush=True)
    model = load_model()
    T = np.stack([np.asarray(model.encode(v, prompt_name='SearchQuery', normalize_embeddings=True), dtype=np.float32).reshape(-1)
                  for v in SCAN_LABELS.values()])
    labs = {}
    for i, *_ in items:
        y = to16k(np.load(CACHE / f'{i}.npy'))[:16000 * 120]
        st = np.arange(0, len(y) / 16000 - 1, 1.0)
        labs[i] = np.argmax(emb(model, [y[int(t * 16000):int((t + 1) * 16000)] for t in st]) @ T.T, 1)
        print(f"  {songs[i]['title'][:16]:16} 正解 {_[0]:>5}  {''.join('IVSCE'[k] for k in labs[i][:90])}", flush=True)
    rows = []
    for run, head in itertools.product([2, 3, 5, 8, 12], [45, 90, 120]):
        def pred(i):
            m = labs[i][:head] <= 1
            return next((float(t) for t in range(len(m) - run + 1) if m[t:t + run].all()), None)
        hit = sum(1 for i, t, b in items if (p := pred(i)) is not None and abs(p - t) <= 1.5)
        base = sum(1 for i, t, b in items if abs(b - t) <= 1.5)
        rows.append((hit, run, head))
    rows.sort(key=lambda x: -x[0])
    print(f'  直す前の値（いまの無音カット）の当たり：0 / {len(items)} 曲（直した曲だけなので当然 0）')
    for h, run, head in rows[:6]:
        print(f'  音楽が {run} 秒続いた所・頭から {head} 秒まで：{h} / {len(items)} 曲')
    result['intro'] = {'n': len(items), 'top': [{'run': r, 'head': hd, 'hits': h} for h, r, hd in rows[:6]]}


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args or '--chorus' in args:
        chorus()
    if not args or '--intro' in args:
        intro()
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf8')
