# 生成した PNG を、表示サイズに合わせて縮小・軽量化する（スマホでの読み込みを速くするため）。
# 採用した画像（<名前>.png）だけを書き出す。背景 → JPEG、それ以外 → WebP。
# 使い方:
#   python tools/optimize_assets.py              採用画像を public/assets/glass に書き出す
#   python tools/optimize_assets.py --sheet 保存先.jpg [名前の先頭...]   候補（<名前>_<seed>.png）を見比べる一覧画像を作る

import sys
from pathlib import Path
from PIL import Image, ImageDraw

BASE = Path(__file__).resolve().parent.parent
SRC = BASE / 'data' / 'assets-src' / 'glass'   # 生成した元画像（公開しない）
OUT = BASE / 'public' / 'assets' / 'glass'     # 軽量化した画像（公開する）
SIZES = {'bg': 1920, 'logo': 512, 'podium': 768}  # 横幅。アイコン・アバターは 256

def black_to_alpha(img):
    """明るさ（RGBの最大値）を不透明度にし、色はその分だけ明るく戻す。黒い部分は完全に透明になる"""
    import numpy as np
    a = np.asarray(img).astype(np.float32)
    alpha = a.max(axis=2)
    alpha = np.clip((alpha - 8) * 255 / 247, 0, 255)  # ほぼ黒のノイズは消す
    rgb = np.where(alpha[..., None] > 0, np.clip(a * 255 / np.maximum(alpha[..., None], 1), 0, 255), 0)
    out = np.dstack([rgb, alpha]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')

def optimize():
    OUT.mkdir(parents=True, exist_ok=True)
    for png in sorted(SRC.glob('*.png')):
        if '_' in png.stem:
            continue  # 候補はスキップ（採用したものだけ <名前>.png にコピーしてある）
        img = Image.open(png).convert('RGB')
        if png.stem.startswith('icon-') or png.stem == 'logo':
            img = black_to_alpha(img)  # 黒背景のアイコン・ロゴは黒を透明にする（どの背景の上でも光だけが乗る）
        width = SIZES.get(png.stem, 256)
        if img.width > width:
            img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
        if png.stem == 'bg':
            out = OUT / 'bg.jpg'
            img.save(out, 'JPEG', quality=82, optimize=True, progressive=True)
        else:
            out = OUT / (png.stem + '.webp')
            img.save(out, 'WEBP', quality=84, method=6)
        print(f'{out.name}: {out.stat().st_size // 1024}KB')

def contact_sheet(dest, prefixes):
    cands = sorted(p for p in SRC.glob('*_*.png') if not prefixes or any(p.stem.startswith(x) for x in prefixes))
    names = sorted({p.stem.rsplit('_', 1)[0] for p in cands})
    cell = 240
    seeds = sorted({int(p.stem.rsplit('_', 1)[1]) for p in cands})
    sheet = Image.new('RGB', (cell * len(seeds), (cell + 22) * len(names)), '#222')
    draw = ImageDraw.Draw(sheet)
    for r, name in enumerate(names):
        for c, s in enumerate(seeds):
            p = SRC / f'{name}_{s}.png'
            if not p.exists():
                continue
            img = Image.open(p).convert('RGB')
            img.thumbnail((cell - 8, cell - 8))
            sheet.paste(img, (c * cell + (cell - img.width) // 2, r * (cell + 22) + 20 + (cell - 8 - img.height) // 2))
            draw.text((c * cell + 6, r * (cell + 22) + 4), f'{name}_{s}', fill='#ddd')
    sheet.save(dest, quality=88)
    print('contact sheet:', dest)

if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--sheet':
        contact_sheet(sys.argv[2], sys.argv[3:])
    else:
        optimize()
