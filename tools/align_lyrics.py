# 歌詞クイズ用：動画と歌詞（LRC）の時刻のずれを、歌声から求める。
# 動画の音から歌声だけを取り出し（demucs）、歌声の大きさの変化と「LRC で歌っている行がある時間」を重ねて、いちばん重なるずれを探す。
# 結果は data/lyric-offsets.json に { 動画ID: { off: 秒（歌詞の時刻 + off = 動画の時刻）, score, margin, set } } で書く（歌詞そのものは書かない）。
# tools/push-lyrics-live.js が、確かな結果（score・margin が十分）だけを使って時刻をずらし、曲を流す問題に使う。
# 途中で止めても、次は続きから。
# 使い方: python tools/align_lyrics.py --set sync --limit 60   （長さが合っている曲で精度を確かめる。off が 0 近くになるはず）
#         python tools/align_lyrics.py --set shift              （動画のほうが長い曲のずれを求める）
#         python tools/align_lyrics.py --ids id1,id2
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import librosa
import torch
from demucs.pretrained import get_model
from demucs.apply import apply_model

ROOT = Path(__file__).resolve().parent.parent
SONGS_PATH = ROOT / 'data' / 'songs.json'
OUT_PATH = ROOT / 'data' / 'lyric-offsets.json'
LRC_DIR = Path('D:/AI/anison-drive/data/lyrics-id')
APPLE = Path('D:/AI/anison-drive/data/apple-map.json')
SCAN = ROOT / 'data' / 'scan-videos.json'
YTDLP_OPTS = ['--compat-options', 'no-certifi', '--js-runtimes', 'node']
SR = 44100
MAX_SEC = 420
FPS = 10  # 0.1 秒ごと
CREDIT = re.compile(r'作詞|作曲|編曲|作編曲|^\s*(歌|唄|歌唱|vocals?|vo\.?|lyrics?|music|composed?|arrange(d|ment)?|written|composition|lyricist|composer)\s*(by\b|[:：／/])', re.I)


def load_json(p, d):
    try:
        return json.loads(Path(p).read_text(encoding='utf8'))
    except Exception:
        return d


def lrc_times(vid):
    f = LRC_DIR / f'{vid}.lrc'
    if not f.exists():
        return None
    out = []
    for line in f.read_text(encoding='utf8', errors='replace').splitlines():
        tags = re.findall(r'\[(\d+):(\d+(?:\.\d+)?)\]', line)
        text = re.sub(r'\[[^\]]*\]', '', line).strip()
        if not tags:
            continue
        for m, s in tags:
            out.append((int(m) * 60 + float(s), text))
    out.sort()
    return out


def load_audio(vid):
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, 'a.wav')
        yt = subprocess.Popen([sys.executable, '-m', 'yt_dlp', *YTDLP_OPTS, '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
                               '-o', '-', '--no-warnings', '--no-part', '-q', f'https://www.youtube.com/watch?v={vid}'],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        ff = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-t', str(MAX_SEC), '-ac', '2', '-ar', str(SR), '-y', wav],
                            stdin=yt.stdout, capture_output=True)
        yt.stdout.close()
        err = yt.stderr.read().decode('utf8', 'replace').strip()
        yt.wait()
        if ff.returncode != 0 or not os.path.exists(wav) or os.path.getsize(wav) < 10000:
            raise RuntimeError((err or ff.stderr.decode('utf8', 'replace') or '音声を読み込めない').splitlines()[-1][:160])
        y, _ = librosa.load(wav, sr=SR, mono=False)
    return y if y.ndim == 2 else np.stack([y, y])


MODEL = None
CACHE = None  # --cache <フォルダ>：歌声の大きさを取っておく（調整用）


def vocal_env(y):
    """歌声の大きさ（0.1秒ごと、対数・標準化）"""
    global MODEL
    if MODEL is None:
        MODEL = get_model('htdemucs')
        MODEL.to('cuda' if torch.cuda.is_available() else 'cpu').eval()
    dev = next(MODEL.parameters()).device
    wav = torch.from_numpy(y).float()
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        src = apply_model(MODEL, wav[None].to(dev), split=True, overlap=0.1, progress=False)[0]
    voc = src[MODEL.sources.index('vocals')].mean(0).cpu().numpy()
    hop = SR // FPS
    n = len(voc) // hop
    rms = np.sqrt((voc[:n * hop].reshape(n, hop) ** 2).mean(1) + 1e-10)
    e = np.log(rms)
    return (e - np.median(e)) / (e.std() + 1e-8)


def indicator(lines, n):
    """LRC で歌っている時間を 1（行の頭から次の行まで、長くても7秒）"""
    ind = np.zeros(n)
    for i, (t, text) in enumerate(lines):
        if not text or CREDIT.search(text):
            continue
        end = min(lines[i + 1][0] if i + 1 < len(lines) else t + 5, t + 7)
        a, b = int(t * FPS), int((end - 0.2) * FPS)
        if a < n:
            ind[max(0, a):max(0, min(n, b))] = 1
    return ind


def best_offset(env, lines, lo, hi):
    n = int((max(t for t, _ in lines) + 10) * FPS)
    ind = indicator(lines, n)
    offs = np.arange(int(lo * FPS), int(hi * FPS) + 1)
    sc = np.full(len(offs), -1.0)
    for k, o in enumerate(offs):
        # 歌詞の時刻 t → 動画の t + off
        a0, b0 = max(0, -o), min(n, len(env) - o)
        if b0 - a0 < 30 * FPS:
            continue
        x, z = ind[a0:b0], env[a0 + o:b0 + o]
        if x.std() == 0:
            continue
        sc[k] = np.corrcoef(x, z)[0, 1]
    k = int(np.argmax(sc))
    far = np.abs(offs - offs[k]) > 1.5 * FPS
    second = sc[far].max() if far.any() else -1
    return offs[k] / FPS, float(sc[k]), float(sc[k] - second)


def main():
    global CACHE, OUT_PATH
    args = sys.argv[1:]
    arg = lambda k, d=None: args[args.index(k) + 1] if k in args else d
    if arg('--out'):
        OUT_PATH = Path(arg('--out'))  # 精度を確かめるときは別のファイルへ
    songs = [s for s in load_json(SONGS_PATH, []) if s.get('id') and not s.get('retired')]
    scan, apple = load_json(SCAN, {}), load_json(APPLE, {})
    done = load_json(OUT_PATH, {})
    which = arg('--set', 'shift')
    if arg('--cache'):
        CACHE = Path(arg('--cache')); CACHE.mkdir(parents=True, exist_ok=True)
    if '--redo' in args:
        done = {}
    ids = set(arg('--ids').split(',')) if arg('--ids') else None
    todo = []
    for s in songs:
        vid = s['id']
        if vid in done or (ids and vid not in ids) or not (LRC_DIR / f'{vid}.lrc').exists():
            continue
        yd, ad = (scan.get(vid) or {}).get('dur'), (apple.get(vid) or {}).get('dur')
        if not ids:
            if not yd or not ad:
                continue
            d = yd - ad
            if which == 'sync' and abs(d) > 2:
                continue
            if which == 'shift' and d <= 2:
                continue
        todo.append((s, yd, ad))
    limit = int(arg('--limit', '0')) or len(todo)
    todo = todo[:limit]
    print(f'これから {len(todo)} 曲（{which}）', flush=True)
    lock = threading.Lock()

    # YouTube に止められにくいよう、1曲ずつ少し間をあけて読む。止められたら15分待って同じ曲からやり直す（12回まで）
    blocked = 0
    for i, (s, yd, ad) in enumerate(todo):
        vid = s['id']
        y = None
        if not (CACHE and (CACHE / f'{vid}.npy').exists()):
            while True:
                try:
                    y = load_audio(vid)
                    blocked = 0
                    break
                except Exception as e:
                    err = str(e)
                    if not re.search(r'Sign in to confirm|429|not a bot', err):
                        print(f'× {s["title"]}：{err}', flush=True)
                        break
                    blocked += 1
                    if blocked > 12:
                        print('YouTube に止められ続けたので終わります（あとで続きから）', flush=True)
                        return
                    print(f'（YouTube に止められたので 15 分待ちます：{blocked} 回目）', flush=True)
                    time.sleep(15 * 60)
            if y is None:
                continue
            time.sleep(3)
        if True:
            lines = lrc_times(vid)
            if not lines or len(lines) < 6:
                continue
            cf = CACHE / f'{vid}.npy' if CACHE else None
            if cf and cf.exists():
                env = np.load(cf)
            else:
                env = vocal_env(y)
                if cf:
                    np.save(cf, env.astype(np.float32))
            d = (yd or 0) - (ad or 0)
            lo, hi = (-5, 40) if which == 'sync' else (-5, max(d, 0) + 5)
            off, score, margin = best_offset(env, lines, lo, hi)
            with lock:
                done[vid] = {'off': round(off, 1), 'score': round(score, 3), 'margin': round(margin, 3), 'set': which if not ids else 'ids', 'd': round(d, 1)}
                OUT_PATH.write_text(json.dumps(done, ensure_ascii=False, indent=0), encoding='utf8')
            print(f'{i + 1}/{len(todo)} off {off:+.1f}  score {score:.2f}  margin {margin:.2f}  （長さの差 {d:+.1f}）{s["title"]}', flush=True)


if __name__ == '__main__':
    main()
