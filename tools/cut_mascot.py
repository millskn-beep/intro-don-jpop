# マスコットの絵の背景を切り抜いて、軽量版（透過 webp）を public/assets/mascot/ に書き出す。
# 元の絵は tools/gen-mascot.js で作った data/assets-src/mascot/<名前>_<seed>.png
# 使い方: python tools/cut_mascot.py blue-listen=1 red-chorus=3 ...
import sys
from pathlib import Path
from PIL import Image
from rembg import remove, new_session

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'data' / 'assets-src' / 'mascot'
OUT = ROOT / 'public' / 'assets' / 'mascot'
HEIGHT = 420  # 画面での最大の高さの2倍くらい（高精細な画面向け）

session = new_session('isnet-anime')  # アニメ絵向けの切り抜きモデル
OUT.mkdir(parents=True, exist_ok=True)
for arg in sys.argv[1:]:
    name, n = arg.split('=')
    im = remove(Image.open(SRC / f'{name}_{n}.png').convert('RGB'), session=session)
    im = im.crop(im.getchannel('A').point(lambda a: 255 if a > 16 else 0).getbbox())  # まわりの余白を詰める
    im.thumbnail((HEIGHT * 2, HEIGHT), Image.LANCZOS)
    dst = OUT / f'{name}.webp'
    im.save(dst, 'WEBP', quality=88, method=6)
    print(f'書き出し {dst.relative_to(ROOT)} {im.size[0]}x{im.size[1]} {dst.stat().st_size // 1024}KB')
