# AI の修正案（サビ）：学習（tools/chorus_learn.py と同じ方法）で選んだ値を、確認用の曲だけ作る（曲データは変えない）。
# 結果は data/ai-suggest.json（収録曲一覧の「AIの修正案」ページ ai-suggest.html で聴き比べて決める）
#   .venv-embed/Scripts/python tools/ai_suggest_learned.py [--n 24]
# 対象：サビが「よく再生される部分」で、イントロの直後すぎる曲を多めに（半分）＋ほかの「よく再生される部分」の曲
import datetime
import json
import random
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chorus_learn as cl  # noqa: E402

ROOT = cl.ROOT
OUT = ROOT / 'data' / 'ai-suggest.json'


def build(vid, songs, sg, T, truth_before=None):
    s = songs[vid]
    intro = s.get('intro', 0) or 0
    reps = sorted(sg.get(vid, {}).get('chorus', []))
    cands = [(c, 'songle-first' if j == 0 else 'songle') for j, c in enumerate([r for r in reps if r > intro + 10])]
    cur = s.get('chorus')
    if cur:
        cands.append((cur, 'before'))
    f = np.load(cl.FEAT / f'{vid}.npz')
    lr = np.log(f['rms'] + 1e-6)
    rise = np.array([lr[i:i + 3].mean() - lr[max(0, i - 4):i].mean() if i > 3 else 0 for i in range(len(lr))])
    for i in np.argsort(-rise)[:8]:
        if i > intro + 15:
            cands.append((float(i), 'rise'))
    X = cl.song_feats(vid, intro, cands, T)
    return [(c, sr, x) for (c, sr), x in zip(cands, X) if x is not None]


def main():
    n = int(sys.argv[sys.argv.index('--n') + 1]) if '--n' in sys.argv else 24
    songs = {x['id']: x for x in cl.read('songs.json')}
    sg = cl.read('songle.json')
    truth = cl.truths()
    heat = [s for s in songs.values() if s.get('chorusSource') == 'heatmap' and s['id'] not in truth and s.get('chorus') and s.get('fame') in ('top', 'famous') and not s.get('retired')]
    early = [s for s in heat if s['chorus'] - (s.get('intro') or 0) < 30]
    rnd = random.Random(7)
    pick = rnd.sample(early, min(len(early), n // 2))
    rest = [s for s in heat if s not in pick]
    pick += rnd.sample(rest, min(len(rest), n - len(pick)))
    ids = [s['id'] for s in pick]
    print(f'対象 {len(ids)} 曲（イントロ直後すぎ {sum(s in early for s in pick)}）', flush=True)
    subprocess.run([sys.executable, str(ROOT / 'tools' / 'chorus_features.py'), '--ids', ','.join(ids)], check=False)
    ids = [v for v in ids if (cl.FEAT / f'{v}.npz').exists()]

    from embed_scan import load_model
    model = load_model()
    texts = ['the chorus of a song, the catchy climax with powerful singing',
             'the verse of a song, calm singing before the chorus',
             'the instrumental introduction of a song']
    T = np.stack([np.asarray(model.encode(t, prompt_name='SearchQuery', normalize_embeddings=True), dtype=np.float32).reshape(-1) for t in texts])
    data = []
    for vid, (tr, before) in truth.items():
        if vid not in songs or not (cl.FEAT / f'{vid}.npz').exists():
            continue
        intro = songs[vid].get('intro', 0) or 0
        reps = sorted(sg.get(vid, {}).get('chorus', []))
        cands = [(c, 'songle-first' if j == 0 else 'songle') for j, c in enumerate([r for r in reps if r > intro + 10])]
        if before:
            cands.append((before, 'before'))
        f = np.load(cl.FEAT / f'{vid}.npz')
        lr = np.log(f['rms'] + 1e-6)
        rise = np.array([lr[i:i + 3].mean() - lr[max(0, i - 4):i].mean() if i > 3 else 0 for i in range(len(lr))])
        for i in np.argsort(-rise)[:8]:
            if i > intro + 15:
                cands.append((float(i), 'rise'))
        X = cl.song_feats(vid, intro, cands, T)
        rows = [(c, s, x) for (c, s), x in zip(cands, X) if x is not None]
        if rows:
            data.append(dict(truth=tr, rows=rows))
    from sklearn.linear_model import LogisticRegression
    X = np.array([x for d in data for _, _, x in d['rows']])
    y = np.array([abs(c - d['truth']) <= cl.OK for d in data for c, _, _ in d['rows']])
    m = LogisticRegression(max_iter=2000, C=1.0, class_weight='balanced').fit(X, y)
    print(f'学習：正解のある {len(data)} 曲', flush=True)

    items = []
    for vid in ids:
        s = songs[vid]
        rows = build(vid, songs, sg, T)
        if not rows:
            continue
        p = m.predict_proba(np.array([x for _, _, x in rows]))[:, 1]
        order = np.argsort(-p)
        best = rows[int(order[0])][0]
        cands = [{'key': 'now', 'label': 'いまの値', 't': round(s['chorus'], 1), 'short': 'いま', 'note': 'よく再生される部分から決めた値'},
                 {'key': 'learned', 'label': '学習で選んだ値', 't': round(float(best), 1), 'short': '学習',
                  'note': f'音の特徴から、サビらしさが一番高い候補（{p[order[0]]:.0%}）'}]
        for j in order[1:]:  # 別の有力候補（離れているもの）
            c = rows[int(j)][0]
            if all(abs(c - o['t']) > 5 for o in cands):
                cands.append({'key': 'learned2', 'label': '学習の2番目', 't': round(float(c), 1), 'short': '2番目', 'note': f'次に高い候補（{p[j]:.0%}）'})
                break
        items.append({'id': vid, 'cands': cands})
    OUT.write_text(json.dumps({'made': datetime.date.today().isoformat(), 'methods': {'learned': '音の埋め込み＋ロジスティック回帰'}, 'items': items}, ensure_ascii=False, indent=1) + '\n', encoding='utf8')
    print(f'{len(items)} 曲を {OUT.name} に書きました')


if __name__ == '__main__':
    main()
