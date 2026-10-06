# マスコットの絵の背景を切り抜いて、軽量版（透過 webp）を public/assets/mascot/ に書き出す。
# 静止画: data/assets-src/mascot/<名前>_<seed>.png（tools/gen-mascot.js）
# アニメ: data/assets-src/mascot-anim/<名前>_<seed>.mp4（tools/gen-mascot-anim.js）→ 1コマずつ切り抜いて、透過アニメ webp にする
# 使い方: python tools/cut_mascot.py both-idle=2@twins/idle ...        （静止画。@の後は書き出し先 キャラ/場面）
#         python tools/cut_mascot.py --anim blue-listen=1 red-chorus=2 ...  （アニメ）
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image
from rembg import remove, new_session

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'data' / 'assets-src' / 'mascot'
ANIM = ROOT / 'data' / 'assets-src' / 'mascot-anim'
OUT = ROOT / 'public' / 'assets' / 'mascot'
HEIGHT = 420      # 画面での最大の高さの2倍くらい（高精細な画面向け）
ANIM_HEIGHT = 280 # アニメはコマ数ぶん重くなるので小さめに
STEP = 3          # 動画（24fps）から何コマおきに使うか（3 → 8fps。軽さ優先）

session = new_session('isnet-anime')  # アニメ絵向けの切り抜きモデル
OUT.mkdir(parents=True, exist_ok=True)


def cut(im):
    return remove(im.convert('RGB'), session=session)


def bbox(im):
    return im.getchannel('A').point(lambda a: 255 if a > 16 else 0).getbbox()


def still(name, n, dest=None):
    im = cut(Image.open(SRC / f'{name}_{n}.png'))
    im = im.crop(bbox(im))  # まわりの余白を詰める
    im.thumbnail((HEIGHT * 2, HEIGHT), Image.LANCZOS)
    dst = OUT / f'{dest or name}.webp'
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, 'WEBP', quality=88, method=6)
    print(f'書き出し {dst.relative_to(ROOT)} {im.size[0]}x{im.size[1]} {dst.stat().st_size // 1024}KB')


def anim(name, n, dest=None):
    # 切り抜いたコマは取っておく（切り抜きに時間がかかるので、書き出し直しのときに使い回す）
    cache = ANIM / f'{name}_{n}_cut{STEP}'
    if not cache.exists():
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', str(ANIM / f'{name}_{n}.mp4'),
                            '-vf', f'fps={24 // STEP}', f'{tmp}/f%03d.png'], check=True)
            cache.mkdir()
            for p in sorted(Path(tmp).glob('f*.png')):
                cut(Image.open(p)).save(cache / p.name)
    frames = [Image.open(p).convert('RGBA') for p in sorted(cache.glob('f*.png'))]
    # 全コマに共通の枠で切り詰める（コマごとに詰めると位置がぶれる）
    boxes = [bbox(f) for f in frames if bbox(f)]
    box = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
    frames = [f.crop(box) for f in frames]
    for f in frames:
        f.thumbnail((ANIM_HEIGHT * 2, ANIM_HEIGHT), Image.LANCZOS)
    frames = frames + frames[-2:0:-1]  # 順再生→逆再生でつなぎ目のないループに
    dst = OUT / f'{dest or name}.webp'
    dst.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(dst, 'WEBP', save_all=True, append_images=frames[1:], duration=round(1000 * STEP / 24), loop=0,
                   quality=70, alpha_quality=60, method=6, minimize_size=True)
    print(f'書き出し {dst.relative_to(ROOT)} {frames[0].size[0]}x{frames[0].size[1]} {len(frames)}コマ {dst.stat().st_size // 1024}KB')


args = sys.argv[1:]
is_anim = '--anim' in args
for arg in (a for a in args if a != '--anim'):
    name, n = arg.split('=')
    n, _, dest = n.partition('@')  # 書き出し先： 名前=番号@キャラ/場面（例 both-idle=2@twins/idle）
    (anim if is_anim else still)(name, n, dest or None)
