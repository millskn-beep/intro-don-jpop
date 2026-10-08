# サビの学習（曲データは変えない）：確認画面で決めたサビ・手で直したサビを正解に、
# 「サビの候補（Songle のサビの区切り・元の値・音の盛り上がり）」のどれが正解かを選ぶ方法を学んで、当たり具合を比べる。
# 特徴は tools/chorus_features.py で取ったもの（EmbeddingGemma 2 の埋め込み・音の大きさ）
#   .venv-embed/Scripts/python tools/chorus_learn.py
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
FEAT = ROOT / 'data' / 'chorus-feat'
read = lambda p: json.loads((ROOT / 'data' / p).read_text(encoding='utf8'))
OK = 3.0  # 正解から ±3 秒以内なら当たり


def truths():
    """曲 → (正解のサビ, 直す前の値)"""
    t = {}
    for h in read('fix-history.json'):
        a, b = h.get('after', {}).get('chorus'), h.get('before', {}).get('chorus')
        if a is not None and h.get('by') != 'review':
            t[h['id']] = (a, b)
    fixed = {x['id']: x for x in read('auto-fixes.json')['fixed'] if x.get('kind') == 'chorus'}
    for k, r in read('auto-review.json').items():
        kind, vid = k.split(':', 1)
        if kind == 'chorus':
            t[vid] = (r['value'], fixed[vid]['before'] if vid in fixed else None)
    return t


def song_feats(vid, intro, cands, model_text):
    f = np.load(FEAT / f'{vid}.npz')
    E = f['emb'].astype(np.float32)
    rms = f['rms']
    n = len(rms)
    lr = np.log(rms + 1e-6)
    lr = (lr - np.median(lr)) / (lr.std() + 1e-6)
    # 繰り返し：区間 [t, t+8) が、20 秒以上離れたどこかとどれだけ似ているか
    S = E @ E.T
    L = 8
    rep = np.zeros(n)
    for k in range(20, n - L):
        d = np.diagonal(S, k)
        m = np.convolve(d, np.ones(L) / L, mode='valid')
        np.maximum(rep[:len(m)], m, out=rep[:len(m)])
        np.maximum(rep[k:k + len(m)], m, out=rep[k:k + len(m)])
    txt = E @ model_text.T  # 秒 × 文章（chorus, verse, intro）
    chor = txt[:, 0] - txt[:, 1:].max(1)
    out = []
    for c, src in cands:
        i = int(round(c))
        if i < 0 or i >= n - 3:
            out.append(None)
            continue
        seg = lambda a, lo, hi: float(np.mean(a[max(0, i + lo):max(i + lo + 1, min(n, i + hi))]))
        out.append([
            (c - intro) / 60, c / max(1, n), seg(lr, 0, 10), seg(lr, 0, 3) - seg(lr, -4, 0),
            seg(rep, 0, 8), seg(chor, 0, 8), seg(chor, 0, 8) - seg(chor, -8, 0),
            float(src == 'songle'), float(src == 'before'), float(src == 'songle-first'),
            float((c - intro) < 30),
        ])
    return out


NAMES = ['イントロからの分', '曲の中の位置', '大きさ', '盛り上がり', '繰り返し', 'サビらしさ(AI)', 'サビらしさの上がり(AI)',
         'Songleの区切り', '元の値', 'Songleの最初', 'イントロから30秒未満']


def main():
    songs = {s['id']: s for s in read('songs.json')}
    sg = read('songle.json')
    from embed_scan import load_model
    model = load_model()
    texts = ['the chorus of a song, the catchy climax with powerful singing',
             'the verse of a song, calm singing before the chorus',
             'the instrumental introduction of a song']
    T = np.stack([np.asarray(model.encode(t, prompt_name='SearchQuery', normalize_embeddings=True), dtype=np.float32).reshape(-1) for t in texts])
    data = []
    for vid, (truth, before) in truths().items():
        if vid not in songs or not (FEAT / f'{vid}.npz').exists():
            continue
        intro = songs[vid].get('intro', 0) or 0
        reps = sorted(sg.get(vid, {}).get('chorus', []))
        cands = [(c, 'songle-first' if j == 0 else 'songle') for j, c in enumerate([r for r in reps if r > intro + 10])]
        if before:
            cands.append((before, 'before'))
        # 音の大きさが上がる所（候補を足す）
        f = np.load(FEAT / f'{vid}.npz')
        lr = np.log(f['rms'] + 1e-6)
        rise = np.array([lr[i:i + 3].mean() - lr[max(0, i - 4):i].mean() if i > 3 else 0 for i in range(len(lr))])
        for i in np.argsort(-rise)[:8]:
            if i > intro + 15:
                cands.append((float(i), 'rise'))
        X = song_feats(vid, intro, cands, T)
        rows = [(c, s, x) for (c, s), x in zip(cands, X) if x is not None]
        if rows:
            data.append(dict(vid=vid, truth=truth, before=before, songle=bool(reps), rows=rows,
                             reach=any(abs(c - truth) <= OK for c, _, _ in rows)))
    print(f'{len(data)} 曲（Songle あり {sum(d["songle"] for d in data)}・候補に正解がある {sum(d["reach"] for d in data)}）')

    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import KFold

    def fit(train):
        X = np.array([x for d in train for _, _, x in d['rows']])
        y = np.array([abs(c - d['truth']) <= OK for d in train for c, _, _ in d['rows']])
        return LogisticRegression(max_iter=2000, C=1.0, class_weight='balanced').fit(X, y)

    def pick(m, d):
        p = m.predict_proba(np.array([x for _, _, x in d['rows']]))[:, 1]
        return d['rows'][int(np.argmax(p))][0]

    def rule(d):
        reps = [c for c, s, _ in d['rows'] if s.startswith('songle')]
        if d['before'] is not None and reps:
            near = min(reps, key=lambda c: abs(c - d['before']))
            if abs(near - d['before']) <= 3:
                return near
        intro = 0
        for c, s, x in d['rows']:
            if s.startswith('songle') and x[0] * 60 >= 30:
                return c
        return d['before'] if d['before'] is not None else d['rows'][0][0]

    hit = lambda d, v: abs(v - d['truth']) <= OK
    for name, sel in [('Songle あり', [d for d in data if d['songle']]), ('Songle なし', [d for d in data if not d['songle']]), ('全部', data)]:
        if not sel:
            continue
        cv = 0
        for tr, te in KFold(5, shuffle=True, random_state=0).split(sel):
            m = fit([sel[i] for i in tr])
            cv += sum(hit(sel[i], pick(m, sel[i])) for i in te)
        base_b = sum(d['before'] is not None and hit(d, d['before']) for d in sel)
        base_f = sum(hit(d, next((c for c, s, _ in d['rows'] if s == 'songle-first'), d['before'] or -99)) for d in sel)
        print(f'{name}: {len(sel)} 曲｜元の値 {base_b}｜Songleの最初 {base_f}｜時間の決まり {sum(hit(d, rule(d)) for d in sel)}｜学習（5分割で確かめ）{cv}｜上限 {sum(d["reach"] for d in sel)}')
    m = fit(data)
    print('効いている特徴（大きいほどサビ寄り）:')
    for nme, w in sorted(zip(NAMES, m.coef_[0]), key=lambda z: -abs(z[1])):
        print(f'  {nme}: {w:+.2f}')


if __name__ == '__main__':
    main()
