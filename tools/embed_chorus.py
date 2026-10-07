# EmbeddingGemma 2 の試験2：サビの位置の推定が、いまの方法（tools/estimate_chorus_audio.py）より当たるか。
# いまの方法は「和音（クロマ）のくり返し」＋「音の大きさ」＋「盛り上がりの始まり」＋「長さからの推定」で点数をつける。
# ここでは「くり返し」を、音の埋め込み（6 秒ずつ・1 秒おき）どうしの似ている度合いに置き換えて比べる。
# 曲・正解・当たりの範囲（-8〜+3 秒）は estimate_chorus_audio.py --test と同じ。曲データは変えない。
#
#   1. 音を取る（システムの Python）：python tools/estimate_chorus_audio.py --test 40 --cache data/audio-cache
#      （いまの方法の当たり具合もこのとき出る）
#   2. 比べる（専用の環境）：.venv-embed/Scripts/python tools/embed_chorus.py --test 40
# 結果は data/embed-trial-chorus.json
import json
import random
import sys
from pathlib import Path

import numpy as np
import librosa

sys.path.insert(0, str(Path(__file__).resolve().parent))
import estimate_chorus_audio as ec  # noqa: E402
from embed_scan import load_model, CACHE  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / 'data' / 'embed-trial-chorus.json'
WIN, STEP = 6.0, 1.0  # 埋め込みの区間の長さと間隔（秒）


def embed_track(model, y):
    y16 = librosa.resample(y, orig_sr=ec.SR, target_sr=16000).astype(np.float32)
    sr = 16000
    starts = np.arange(0, max(0, len(y16) / sr - WIN) + 1e-9, STEP)
    E = []
    for t in starts:
        c = y16[int(t * sr):int((t + WIN) * sr)]
        e = model.encode({'text': '<|audio|>', 'audio': [c]}, normalize_embeddings=True)
        E.append(np.asarray(e, dtype=np.float32).reshape(-1))
    return starts, np.stack(E)


def rep_from(sim, w, min_lag):
    """似ている度合いの行列から、区間ごとの「くり返しの強さ」（ec.estimate と同じ考え方）"""
    n = sim.shape[0]
    rep = np.zeros(n)
    kernel = np.ones(w) / w
    for k in range(min_lag, n - w):
        m = np.convolve(np.diagonal(sim, k), kernel, mode='valid')
        np.maximum(rep[:len(m)], m, out=rep[:len(m)])
        np.maximum(rep[k:k + len(m)], m, out=rep[k:k + len(m)])
    return rep


def estimate(y, intro, emb=None, mode='chroma'):
    """mode: chroma（いまの方法）／embed（くり返しを埋め込みで）／both（両方の平均）"""
    SR, HOP, SEG = ec.SR, ec.HOP, ec.SEG
    fps = SR / HOP
    dur = len(y) / SR
    chroma = librosa.util.normalize(librosa.feature.chroma_stft(y=y, sr=SR, hop_length=HOP), axis=0)
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    n = min(chroma.shape[1], len(rms))
    chroma, rms = chroma[:, :n], rms[:n]
    w = int(SEG * fps)
    if n < w * 3:
        return None
    t_idx = np.arange(n) / fps
    rep_c = rep_from(chroma.T @ chroma, w, int(ec.MIN_LAG * fps)) if mode != 'embed' else None
    if mode != 'chroma':
        starts, E = emb
        r = rep_from(E @ E.T, max(1, int(SEG / STEP)), int(ec.MIN_LAG / STEP))
        rep_e = np.interp(t_idx, starts, r)  # 1 秒おき → いまの方法の刻みに合わせる
    lo = int((intro + 15) * fps)
    hi = int(min(dur * 0.75, dur - SEG) * fps)
    if hi <= lo + 2:
        return None
    norm = lambda a: (a - a[lo:hi].min()) / (np.ptp(a[lo:hi]) + 1e-9)
    rep = norm(rep_c) if mode == 'chroma' else norm(rep_e) if mode == 'embed' else (norm(rep_c) + norm(rep_e)) / 2
    kernel = np.ones(w) / w
    loud_seg = np.convolve(rms, kernel, mode='full')[w - 1:w - 1 + n]
    k2 = int(2 * fps)
    after = np.array([rms[i:i + k2].mean() if i + k2 <= n else 0 for i in range(n)])
    before = np.array([rms[max(0, i - k2):i].mean() if i > 0 else 0 for i in range(n)])
    near = np.exp(-((t_idx - ec.guess(intro, dur)) / 20) ** 2)
    W = ec.W
    score = W[0] * rep + W[1] * norm(loud_seg) + W[2] * norm(after - before) + W[3] * near
    cand = np.arange(lo, hi)
    t = int(cand[np.argmax(score[cand])])
    return round(max(0, t / fps - 0.3), 1)


def main():
    args = sys.argv[1:]
    test = int(args[args.index('--test') + 1]) if '--test' in args else 40
    songs = json.loads(ec.SONGS_PATH.read_text(encoding='utf8'))
    # estimate_chorus_audio.py --test と同じ選び方
    pool = [s for s in songs if s.get('chorus', 0) > 0 and s.get('chorusSource') in ('manual', 'heatmap') and s.get('embeddable') is not False]
    random.seed(1)
    targets = random.sample(pool, min(test, len(pool)))
    model = load_model()
    good = lambda x, s: x is not None and -8 <= x - s['chorus'] <= 3
    hits = {'chroma': 0, 'embed': 0, 'both': 0}
    res, done = [], 0
    for i, s in enumerate(targets, 1):
        p = CACHE / f"{s['id']}.npy"
        if not p.exists():
            print(f"[{i}] 音がない: {s['title']}"); continue
        y = np.load(p)
        intro = s.get('intro', 0) or 0
        emb = embed_track(model, y)
        est = {m: estimate(y, intro, emb, m) for m in hits}
        done += 1
        for m in hits:
            hits[m] += good(est[m], s)
        res.append({'id': s['id'], 'title': s['title'], 'answer': s['chorus'], 'src': s.get('chorusSource'), **est})
        print(f"[{i}/{len(targets)}] {s['title'][:20]:20} 正解 {s['chorus']:>6} / " +
              ' '.join(f"{m} {est[m]}{'○' if good(est[m], s) else '×'}" for m in hits), flush=True)
    OUT_PATH.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf8')
    print(f'当たり（-8〜+3秒）/ {done} 曲: ' + ' '.join(f'{m} {v}' for m, v in hits.items()))


if __name__ == '__main__':
    main()
