# 生成した PNG を、表示サイズに合わせて縮小・軽量化する（スマホでの読み込みを速くするため）。
# 背景 → JPEG、それ以外 → WebP。あわせて確認用の一覧画像（contact sheet）を作る。
# 使い方: python tools/optimize_assets.py [一覧画像の保存先]

import sys
from pathlib import Path
from PIL import Image, ImageDraw

BASE = Path(__file__).resolve().parent.parent
SRC = BASE / 'data' / 'assets-src'   # 生成した元画像（公開しない）
ROOT = BASE / 'public' / 'assets'    # 軽量化した画像（公開する）
SIZES = {'bg': 1920, 'emblem': 512, 'podium': 768}  # 横幅。アイコンは 256
THEMES = ['neon', 'studio', 'pop', 'retro']

def optimize():
    for theme in THEMES:
        for png in sorted((SRC / theme).glob('*.png')):
            img = Image.open(png).convert('RGB')
            width = SIZES.get(png.stem, 256)
            if img.width > width:
                img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
            if png.stem == 'bg':
                out = ROOT / theme / (png.stem + '.jpg')
                img.save(out, 'JPEG', quality=80, optimize=True, progressive=True)
            else:
                out = ROOT / theme / (png.stem + '.webp')
                img.save(out, 'WEBP', quality=82, method=6)
            print(f'{theme}/{out.name}: {out.stat().st_size // 1024}KB')

def contact_sheet(dest):
    cell, cols = 220, 8
    names = ['bg', 'emblem', 'podium', 'icon-fifty', 'icon-audience', 'icon-phone', 'icon-replay', 'icon-pass']
    sheet = Image.new('RGB', (cell * cols, (cell + 24) * len(THEMES)), '#111')
    draw = ImageDraw.Draw(sheet)
    for r, theme in enumerate(THEMES):
        for c, name in enumerate(names):
            img = Image.open(SRC / theme / f'{name}.png').convert('RGB')
            img.thumbnail((cell - 8, cell - 8))
            x, y = c * cell + (cell - img.width) // 2, r * (cell + 24) + 22 + (cell - img.height) // 2
            sheet.paste(img, (x, y))
            draw.text((c * cell + 6, r * (cell + 24) + 4), f'{theme}/{name}', fill='#ccc')
    sheet.save(dest, quality=85)
    print('contact sheet:', dest)

if __name__ == '__main__':
    optimize()
    if len(sys.argv) > 1:
        contact_sheet(sys.argv[1])
