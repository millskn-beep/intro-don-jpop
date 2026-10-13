# サビの学習用：確認画面で決めたサビ（data/auto-review.json）と、手で直したサビ（data/fix-history.json）の曲について、
# 曲全体の「1 秒ごとの音の特徴」を取っておく（曲データは変えない）。
#   emb：EmbeddingGemma 2 の埋め込み（2 秒の区間・1 秒おき、768 次元・float16）
#   rms：1 秒ごとの音の大きさ
# 結果は data/chorus-feat/<動画ID>.npz（gitに入れない）。もう一度動かすと、取っていない曲だけ続きから
#   .venv-embed/Scripts/python tools/chorus_features.py
import json
import sys
import time
from pathlib import Path

import numpy as np
import librosa

sys.path.insert(0, str(Path(__file__).resolve().parent))
import estimate_chorus_audio as ec  # noqa: E402
from embed_scan import load_model  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'chorus-feat'
WIN = 2.0


def targets():
    ids = []
    rv = json.loads((ROOT / 'data' / 'auto-review.json').read_text(encoding='utf8'))
    ids += [k.split(':', 1)[1] for k in rv if k.startswith('chorus:')]
    for h in json.loads((ROOT / 'data' / 'fix-history.json').read_text(encoding='utf8')):
        if h.get('after', {}).get('chorus') is not None:
            ids.append(h['id'])
    return list(dict.fromkeys(ids))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    argv = sys.argv[1:]
    src = argv[argv.index('--ids') + 1].split(',') if '--ids' in argv else targets()  # --ids a,b,c：指定した曲だけ
    ids = [v for v in src if not (OUT / f'{v}.npz').exists()]
    print(f'{len(ids)} 曲', flush=True)
    model = load_model()
    for n, vid in enumerate(ids, 1):
        t0 = time.time()
        try:
            y = ec.load_audio(vid)
            y16 = librosa.resample(y, orig_sr=ec.SR, target_sr=16000).astype(np.float32)
            starts = np.arange(0, max(1, len(y16) / 16000 - WIN), 1.0)
            clips = [y16[int(t * 16000):int((t + WIN) * 16000)] for t in starts]
            # まとめて渡すと 1 つずつより 20 倍ほど速い（結果はほぼ同じ）
            E = np.asarray(model.encode([{'text': '<|audio|>', 'audio': [c]} for c in clips], normalize_embeddings=True, batch_size=32),
                           dtype=np.float32).reshape(len(clips), -1)
            rms = np.array([np.sqrt(np.mean(y16[int(t * 16000):int((t + 1) * 16000)] ** 2) + 1e-12) for t in starts], dtype=np.float32)
            np.savez_compressed(OUT / f'{vid}.npz', emb=E.astype(np.float16), rms=rms, dur=len(y16) / 16000)
            print(f'[{n}/{len(ids)}] {vid} {len(starts)}秒分 {time.time() - t0:.0f}s', flush=True)
        except Exception as e:
            print(f'[{n}/{len(ids)}] {vid} 失敗: {e}', flush=True)
        time.sleep(1)


if __name__ == '__main__':
    main()
