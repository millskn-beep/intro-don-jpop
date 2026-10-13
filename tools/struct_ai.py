# 構造解析AI（all-in-one-infer）でサビの始まりを出す（曲データは変えない）。専用の環境 .venv-struct で動かす
#   .venv-struct/Scripts/python tools/struct_ai.py <動画ID,動画ID,...>   … 指定した曲（音は data/audio-cache にあるもの）
#   .venv-struct/Scripts/python tools/struct_ai.py --truth                … 正解のある曲で当たり具合を測る
# 結果は data/struct-ai/<動画ID>.json（segments：[start,label]）
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'struct-ai'
TMP = ROOT / 'data' / 'struct-tmp'
read = lambda p: json.loads((ROOT / 'data' / p).read_text(encoding='utf8'))


def run(ids):
    from allin1_infer import analyze
    OUT.mkdir(exist_ok=True)
    TMP.mkdir(exist_ok=True)
    for vid in ids:
        if (OUT / f'{vid}.json').exists():
            continue
        npy = ROOT / 'data' / 'audio-cache' / f'{vid}.npy'
        if not npy.exists():
            print(vid, '音なし')
            continue
        wav = TMP / f'{vid}.wav'
        sf.write(wav, np.load(npy), 22050)
        try:
            r = analyze(str(wav))
            segs = [[round(float(s.start), 1), s.label] for s in r.segments]
            (OUT / f'{vid}.json').write_text(json.dumps(segs), encoding='utf8')
            print(vid, [x for x in segs if x[1] == 'chorus'][:3], flush=True)
        except Exception as e:
            print(vid, '失敗', e, flush=True)
        wav.unlink(missing_ok=True)


def chorus_of(vid, intro=0):
    p = OUT / f'{vid}.json'
    if not p.exists():
        return None
    ch = [s for s, l in json.loads(p.read_text(encoding='utf8')) if l == 'chorus' and s > intro + 5]
    return ch[0] if ch else None


if __name__ == '__main__':
    if '--truth' in sys.argv:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import chorus_learn as cl
        songs = {s['id']: s for s in read('songs.json')}
        tr = {v: t for v, t in cl.truths().items() if (ROOT / 'data' / 'audio-cache' / f'{v}.npy').exists()}
        run(list(tr))
        n = hit = got = 0
        for v, (t, b) in tr.items():
            c = chorus_of(v, songs[v].get('intro', 0) or 0)
            n += 1
            if c is not None:
                got += 1
                hit += abs(c - t) <= cl.OK
        print(f'正解のある {n} 曲：サビが出た {got}、当たり {hit}')
    else:
        run(sys.argv[1].split(','))
