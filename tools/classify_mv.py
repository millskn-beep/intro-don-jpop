# MVフラッシュ用：動画の場面画像（YouTube の hq1〜3）から、アニメ／実写／静止画を判定する
# 使い方: python tools/classify_mv.py --sample 100 --out <結果.json> --thumbs <画像の置き場所>
#         python tools/classify_mv.py --out data/mv-kinds.json --thumbs <画像の置き場所>   （音源チャンネル以外の全曲。判定済みは飛ばす）
# 曲データは変えない。結果は { 動画ID: { kind, anime, live, frames, diff } } の JSON
import argparse, json, random, re, subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

ROOT = Path(__file__).resolve().parent.parent
MODEL = 'D:/AI/models/clip-vit-large-patch14'  # curl で取得（この PC は huggingface の自動ダウンロードが SSL で失敗する）
PROMPTS = {
    'anime': ['a screenshot from a Japanese anime', 'a 2D cartoon animation frame', 'an anime illustration of a character'],
    'live': ['a photo of a real person', 'a live action music video with real people', 'a photo of a band performing on stage', 'a photograph of a real place', 'a photo of a Japanese idol group', 'a close-up photo of a real face', 'real children in costumes'],
    'other': ['text on a plain background', 'a black screen', 'a logo on a plain background'],
}
STATIC_DIFF = 2.0  # 3枚の明るさの差（0〜255）がこれより小さければ静止画
THUMB_FRAMES = ['hq1', 'hq2', 'hq3']


def fetch(video_id, name, folder):
    path = folder / f'{video_id}_{name}.jpg'
    if path.exists() and path.stat().st_size > 0:
        return path
    r = subprocess.run(['curl.exe', '-s', '-f', '-o', str(path), f'https://i.ytimg.com/vi/{video_id}/{name}.jpg'])
    return path if r.returncode == 0 and path.exists() else None


def crop_bars(img):
    # hq の画像は 16:9 の動画だと上下に黒帯が入る。真ん中だけ使う
    w, h = img.size
    return img.crop((0, int(h * .125), w, int(h * .875)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sample', type=int, default=0)
    ap.add_argument('--out', required=True)
    ap.add_argument('--thumbs', required=True)
    args = ap.parse_args()
    folder = Path(args.thumbs); folder.mkdir(parents=True, exist_ok=True)
    out = Path(args.out)
    done = json.loads(out.read_text(encoding='utf8')) if out.exists() else {}
    songs = json.loads((ROOT / 'data' / 'songs.json').read_text(encoding='utf8'))
    targets = [s for s in songs if not s.get('retired') and not re.search(r'- Topic$', s.get('channel') or '')]
    if args.sample:
        random.Random(7).shuffle(targets); targets = targets[:args.sample]
    targets = [s for s in targets if s['id'] not in done]
    print(f'判定する動画: {len(targets)} 本', flush=True)

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    model = CLIPModel.from_pretrained(MODEL).to(device).eval()
    proc = CLIPProcessor.from_pretrained(MODEL)
    labels = [(k, p) for k, ps in PROMPTS.items() for p in ps]
    with torch.no_grad():
        t = proc(text=[p for _, p in labels], return_tensors='pt', padding=True).to(device)
        text = model.get_text_features(**t)
        text = getattr(text, 'pooler_output', text)
        text = text / text.norm(dim=-1, keepdim=True)
    idx = {k: [i for i, (x, _) in enumerate(labels) if x == k] for k in PROMPTS}

    for n, s in enumerate(targets, 1):
        with ThreadPoolExecutor(3) as ex:
            paths = [p for p in ex.map(lambda f: fetch(s['id'], f, folder), THUMB_FRAMES) if p]
        if not paths:
            done[s['id']] = {'kind': 'unknown', 'frames': []}
            continue
        imgs = [crop_bars(Image.open(p).convert('RGB')) for p in paths]
        gray = [np.asarray(i.convert('L').resize((64, 36)), dtype=float) for i in imgs]
        diff = float(max(np.abs(a - b).mean() for a in gray for b in gray))
        with torch.no_grad():
            x = proc(images=imgs, return_tensors='pt').to(device)
            f = model.get_image_features(**x)
            f = getattr(f, 'pooler_output', f)
            f = f / f.norm(dim=-1, keepdim=True)
            prob = (100 * f @ text.T).softmax(dim=-1).cpu().numpy()
        frames, ps, ls = [], [], []
        for row in prob:
            sc = {k: float(row[v].sum()) for k, v in idx.items()}
            frames.append(max(sc, key=sc.get)); ps.append(sc['anime']); ls.append(sc['live'])
        anime = frames.count('anime'); live = frames.count('live')
        if diff < STATIC_DIFF: kind = 'static'
        elif anime >= 2 and live == 0: kind = 'anime'  # 実写に見える場面が1枚でもあれば、アニメとしない
        elif live >= 2: kind = 'live'
        else: kind = 'mixed'
        done[s['id']] = {'kind': kind, 'anime': anime, 'live': live, 'frames': frames, 'diff': round(diff, 1), 'pAnime': round(float(np.mean(ps)), 3), 'pLiveMax': round(float(max(ls)), 3)}
        if n % 20 == 0 or n == len(targets):
            out.write_text(json.dumps(done, ensure_ascii=False, indent=1) + '\n', encoding='utf8')
            print(f'{n}/{len(targets)}', flush=True)
    out.write_text(json.dumps(done, ensure_ascii=False, indent=1) + '\n', encoding='utf8')
    c = {}
    for v in done.values(): c[v['kind']] = c.get(v['kind'], 0) + 1
    print('終わり', c, flush=True)


if __name__ == '__main__':
    main()
