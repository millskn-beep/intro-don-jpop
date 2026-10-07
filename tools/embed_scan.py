# EmbeddingGemma 2 の試験1：「原曲そのままでない動画」（ライブ・再録・会話入りなど）を、音の埋め込みで見分けられるか。
# 正解が分かっている曲だけで試す（曲データは変えない。結果は data/embed-trial-scan.json）。
#
#   1. 音を取る（システムの Python。yt-dlp と librosa を使う。キャッシュは data/audio-cache/<id>.npy、22050Hz）
#        python tools/embed_scan.py --fetch
#   2. 判定する（専用の環境。torch と sentence-transformers を使う）
#        .venv-embed/Scripts/python tools/embed_scan.py --run
#
# 判定の方法
#   B：音と「文章」（ライブの歓声、会話、スタジオ録音…）の近さ。追加のダウンロードは要らない
#   A：差し替え前の動画（ライブ・再録）と差し替え後の原曲の音の近さを、別の曲どうしの近さと比べる
import json
import random
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
ROOT = Path(__file__).resolve().parent.parent
SONGS_PATH = ROOT / 'data' / 'songs.json'
CACHE = ROOT / 'data' / 'audio-cache'
OUT_PATH = ROOT / 'data' / 'embed-trial-scan.json'
SR = 22050

# 原曲そのままでない動画（差し替え前の動画 → 差し替え後の原曲）。git の 5d9ef87・27d2ff0 から
SWAPPED = {
    'n8mONVi2egU': 'IwYZTBzbsYs',  # GO! GO! MANIAC
    'JkU_QtJNajA': 'asSqfb7YP4Y',  # DAYS of DASH
    'b5-BiwtGTn4': 'hbSVyUbVojA',  # ルミナス
    'pzbtfG2OfIk': 'MmnU-s1TdsI',  # BLACK SHOUT
    '-PRjas_vdoQ': 'ac66DA0pDbg',  # FIRE BIRD
    '0JuI1v1eIuM': '63UdhR6WyQA',  # 祝祭
    'CYIZA7W50sk': 'VuOFPfxxmx4',  # DICE
    '7EuTPTVpuNI': 'eNvD-D6Gw6c',  # コネクト
}
# 原曲がないので、ライブ・セルフカバーのまま残している動画
KEPT = ['QYMP3JTE-Qg', 'Sxa0jHNFdOA', 'Glftu1GFPS8', 'YzoNZ-ozS3o']
# 頭にセリフが入っている動画（イントロは 24 秒から）
DIALOGUE = ['cREAHvB02RQ']
# 公式音源（Topic）で、自動チェックに引っかかっていない曲から 30 曲
N_GOOD = 30

# 音と比べる文章（B）。query 側に付ける
LABELS = {
    'studio': 'a clean studio recording of a pop song with vocals',
    'live': 'a live concert recording with crowd cheering and applause',
    'speech': 'people talking, spoken dialogue from an anime scene',
    'sfx': 'sound effects, footsteps, explosions, ambient noise',
    'cover': 'an amateur cover song recorded at home',
    'piano': 'a solo piano arrangement',
}


def labeled():
    songs = json.loads(SONGS_PATH.read_text(encoding='utf8'))
    by = {s['id']: s for s in songs}
    flags = json.loads((ROOT / 'data' / 'scan-flags.json').read_text(encoding='utf8'))
    items = []
    for old, new in SWAPPED.items():
        s = by[new]
        items.append({'id': old, 'label': 'bad', 'kind': 'swapped-old', 'title': s['title'], 'pair': new})
        items.append({'id': new, 'label': 'good', 'kind': 'swapped-new', 'title': s['title'], 'pair': old,
                      'intro': s.get('intro', 0), 'chorus': s.get('chorus', 0)})
    for i in KEPT:
        items.append({'id': i, 'label': 'bad', 'kind': 'kept-live', 'title': by[i]['title'], 'intro': by[i].get('intro', 0), 'chorus': by[i].get('chorus', 0)})
    for i in DIALOGUE:
        items.append({'id': i, 'label': 'bad', 'kind': 'dialogue', 'title': by[i]['title'], 'intro': 0, 'chorus': by[i].get('chorus', 0)})
    topic = [s for s in songs if (s.get('channel') or '').endswith('- Topic') and s['id'] not in flags and s['id'] not in SWAPPED.values()]
    random.seed(1)
    for s in random.sample(topic, N_GOOD):
        items.append({'id': s['id'], 'label': 'good', 'kind': 'topic', 'title': s['title'], 'intro': s.get('intro', 0), 'chorus': s.get('chorus', 0)})
    return items


def fetch(ids):
    import estimate_chorus_audio as ec
    CACHE.mkdir(parents=True, exist_ok=True)
    ec.CACHE = CACHE
    for n, vid in enumerate(ids, 1):
        hit = (CACHE / f'{vid}.npy').exists()
        try:
            y = ec.load_audio(vid)
            print(f'[{n}/{len(ids)}] {vid} {len(y) / SR:.0f}秒{"（キャッシュ）" if hit else ""}', flush=True)
        except Exception as e:
            print(f'[{n}/{len(ids)}] {vid} 失敗: {e}', flush=True)
        if not hit:
            time.sleep(2)


def load_model():
    import torch
    from sentence_transformers import SentenceTransformer
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
    return SentenceTransformer('google/embeddinggemma-2', device='cuda', model_kwargs={'torch_dtype': dtype},
                               config_kwargs={'vision_config': None})


def to16k(y):
    import librosa
    return librosa.resample(y, orig_sr=SR, target_sr=16000).astype(np.float32)


def embed_audio(model, clips):
    """clips: 16kHz の numpy 配列のリスト → 正規化した埋め込み (n, 768)"""
    out = []
    for c in clips:
        e = model.encode({'text': '<|audio|>', 'audio': [c]}, normalize_embeddings=True)
        out.append(np.asarray(e, dtype=np.float32).reshape(-1))
    return np.stack(out)


def windows(y16, intro, chorus, dur16):
    """比べる区間：イントロから 30 秒、サビから 30 秒、曲の頭から 30 秒ずつ（最大 5 区間）"""
    sr = 16000
    cut = lambda t0: y16[int(t0 * sr):int((t0 + 30) * sr)]
    w = {'intro': cut(max(0, intro or 0))}
    if chorus and chorus + 10 < dur16:
        w['chorus'] = cut(chorus)
    for i in range(5):
        if (i + 1) * 30 <= dur16:
            w[f'part{i}'] = cut(i * 30)
    return {k: v for k, v in w.items() if len(v) > sr * 5}


def run(items):
    model = load_model()
    texts = {k: model.encode(v, prompt_name='SearchQuery', normalize_embeddings=True) for k, v in LABELS.items()}
    T = np.stack([np.asarray(texts[k], dtype=np.float32).reshape(-1) for k in LABELS])
    res = []
    for it in items:
        p = CACHE / f"{it['id']}.npy"
        if not p.exists():
            print('音がない:', it['id'], it['title']); continue
        y16 = to16k(np.load(p))
        dur = len(y16) / 16000
        intro = it.get('intro', 0) if it['kind'] != 'swapped-old' else 0
        chorus = it.get('chorus', 0) if it['kind'] not in ('swapped-old',) else 0
        w = windows(y16, intro, chorus, dur)
        E = embed_audio(model, list(w.values()))
        sims = E @ T.T  # 区間 × 文章
        r = {**it, 'dur': round(dur, 1), 'windows': list(w), 'mean': E.mean(0).tolist(),
             'labelSim': {k: [round(float(x), 4) for x in sims[:, j]] for j, k in enumerate(LABELS)}}
        res.append(r)
        top = {k: round(float(sims[:, j].max()), 3) for j, k in enumerate(LABELS)}
        print(f"{it['label']:4} {it['kind']:11} {it['title'][:18]:18} " + ' '.join(f'{k}={v}' for k, v in top.items()), flush=True)
    OUT_PATH.write_text(json.dumps(res, ensure_ascii=False), encoding='utf8')
    print('保存:', OUT_PATH)


def auc(bad, good):
    """原曲でない動画の点数が、原曲の点数より高くなる割合（1.0 で完全に分けられる、0.5 はでたらめ）"""
    if not bad or not good:
        return None
    return sum((b > g) + 0.5 * (b == g) for b in bad for g in good) / (len(bad) * len(good))


def report():
    res = json.loads(OUT_PATH.read_text(encoding='utf8'))
    bad = [r for r in res if r['label'] == 'bad']
    good = [r for r in res if r['label'] == 'good']
    print(f'原曲でない {len(bad)} 曲 / 原曲 {len(good)} 曲')
    # B：文章との近さ。「区間の中で最大」と「平均」、ラベルの差（例 live − studio）
    def score(r, key, agg):
        a = np.array(r['labelSim'][key])
        return float(a.max() if agg == 'max' else a.mean())
    rows = []
    for key in LABELS:
        for agg in ('max', 'mean'):
            rows.append((f'{key}({agg})', auc([score(r, key, agg) for r in bad], [score(r, key, agg) for r in good])))
    for key in ('live', 'speech', 'cover', 'sfx', 'piano'):
        d = lambda r: score(r, key, 'max') - score(r, 'studio', 'max')
        rows.append((f'{key}-studio', auc([d(r) for r in bad], [d(r) for r in good])))
    nonstudio = lambda r: max(score(r, k, 'max') for k in LABELS if k != 'studio') - score(r, 'studio', 'max')
    rows.append(('どれか-studio', auc([nonstudio(r) for r in bad], [nonstudio(r) for r in good])))
    print('\nB（文章との近さ）の分け方の良さ AUC（1.0 が完全、0.5 はでたらめ）')
    for name, a in sorted(rows, key=lambda x: -(x[1] or 0)):
        print(f'  {name:16} {a:.3f}')
    best = max(rows, key=lambda x: x[1] or 0)[0]
    nonstudio_d = {'どれか-studio': nonstudio}
    if best in nonstudio_d or '-studio' in best:
        f = nonstudio if best == 'どれか-studio' else (lambda r, k=best.split('-')[0]: score(r, k, 'max') - score(r, 'studio', 'max'))
    else:
        k, agg = best[:-1].split('(')
        f = lambda r: score(r, k, agg)
    line = min(f(r) for r in bad)
    left = [r['title'] for r in good if f(r) >= line]
    print(f'\nいちばん良い「{best}」で、原曲でない動画を全部拾える線を引くと、原曲 {len(good)} 曲のうち {len(left)} 曲も要確認に残る'
          f'（{len(left) / len(good):.0%}）')
    for r in sorted(bad, key=f):
        print(f'  原曲でない {r["kind"]:11} {r["title"][:20]:20} {f(r):+.3f}')
    # A：差し替え前（ライブ・再録）と差し替え後（原曲）の近さ ↔ 別の曲どうしの近さ
    by = {r['id']: r for r in res}
    mean = lambda r: np.array(r['mean']) / (np.linalg.norm(r['mean']) + 1e-9)
    pairs = [(r['title'], float(mean(r) @ mean(by[r['pair']]))) for r in res if r['kind'] == 'swapped-old' and r.get('pair') in by]
    others = [float(mean(a) @ mean(b)) for i, a in enumerate(good) for b in good[i + 1:]]
    print('\nA（同じ曲の別録音どうしの近さ ↔ 別の曲どうし）')
    for t, v in pairs:
        print(f'  {t[:20]:20} 差し替え前↔後 {v:.3f}')
    if others:
        print(f'  別の曲どうし：平均 {np.mean(others):.3f}・最大 {np.max(others):.3f}・上位5% {np.percentile(others, 95):.3f}')


if __name__ == '__main__':
    items = labeled()
    if '--fetch' in sys.argv:
        fetch([it['id'] for it in items])
    elif '--run' in sys.argv:
        run(items)
    elif '--report' in sys.argv:
        report()
    else:
        print(__doc__ or '使い方は先頭のコメントを見てください')
