# スマホの「ホーム画面に追加」用のアイコンを、今のロゴ（data/assets-src/glass/logo.png）から作る。
# 書き出し: public/icons/ に iPhone 用 180、Android 用 192・512、マスカブル（丸や角丸に切り抜かれても欠けない）512、ファビコン 32・48
# 使い方: python tools/make_icons.py
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'icons'
OUT.mkdir(parents=True, exist_ok=True)

logo = Image.open(ROOT / 'data' / 'assets-src' / 'glass' / 'logo.png').convert('RGB')
# 黒い背景を透明にして、ロゴの部分だけ切り出す（明るさをそのまま透明度にする）
gray = logo.convert('L')
alpha = gray.point(lambda v: 0 if v < 10 else min(255, int((v - 10) * 2.2)))
logo = logo.convert('RGBA'); logo.putalpha(alpha)
logo = logo.crop(alpha.point(lambda v: 255 if v > 20 else 0).getbbox())


def background(size):
    """紺〜紫のグラデーションに、ふんわり光をのせた背景"""
    bg = Image.new('RGB', (size, size), (8, 8, 26))
    glow = Image.new('RGB', (size, size), (0, 0, 0))
    d = ImageDraw.Draw(glow)
    d.ellipse([size * -0.1, size * 0.35, size * 0.8, size * 1.25], fill=(70, 40, 120))   # 左下に紫
    d.ellipse([size * 0.35, size * -0.25, size * 1.2, size * 0.6], fill=(20, 70, 110))   # 右上に青
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.18))
    return Image.blend(bg, glow, 0.85).convert('RGBA')


def icon(size, scale):
    """scale：アイコンの一辺に対するロゴの大きさ"""
    im = background(size)
    lg = logo.copy()
    lg.thumbnail((int(size * scale), int(size * scale)), Image.LANCZOS)
    im.alpha_composite(lg, ((size - lg.width) // 2, (size - lg.height) // 2))
    return im.convert('RGB')


icon(180, 0.74).save(OUT / 'apple-touch-icon.png', optimize=True)
icon(192, 0.74).save(OUT / 'icon-192.png', optimize=True)
icon(512, 0.74).save(OUT / 'icon-512.png', optimize=True)
icon(512, 0.58).save(OUT / 'icon-maskable-512.png', optimize=True)   # 中心の80%に収まるよう小さめ
icon(48, 0.86).save(OUT / 'favicon-48.png', optimize=True)
icon(32, 0.9).save(OUT / 'favicon-32.png', optimize=True)
for p in sorted(OUT.iterdir()):
    print(p.name, Image.open(p).size, p.stat().st_size // 1024, 'KB')
