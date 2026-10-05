# サビの位置が未設定の曲（「よく再生される部分」のデータもない曲）を、音そのものを解析して推定する。
# 考え方：サビは「曲の中で何度も繰り返され」「音が大きく盛り上がる」部分。その最初の1回の始まりを探す。
#   1. 音声を yt-dlp + ffmpeg で読み込む（ファイルは一時的に作って消す）
#   2. 和音の流れ（クロマ）が似ている区間どうしを比べて、繰り返しの強さを出す
#   3. 音の大きさと合わせて点数にし、上位のうち一番早いものをサビとする
# 推定した曲は chorusSource: 'audio'（チェック画面で「推定（音）」と表示）。手で設定した曲・推定済みの曲は触らない。
# CPU だけで動く（GPU は使わない）。
#
# 使い方: python tools/estimate_chorus_audio.py [--limit 10] [--dry-run]
#         python tools/estimate_chorus_audio.py --test 20   （正解がわかっている曲で当たり具合を確かめる。保存しない）
# 保存: 手元のサーバー（http://localhost:3000）が動いていればその API で、止まっていれば songs.json に直接書く
import json
import os
import random
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import numpy as np
import librosa

ROOT = Path(__file__).resolve().parent.parent
SONGS_PATH = ROOT / 'data' / 'songs.json'
SERVER = 'http://localhost:3000'
YTDLP_OPTS = ['--compat-options', 'no-certifi', '--js-runtimes', 'node']
SR = 22050
HOP = 4096          # 約0.19秒ごとに見る
SEG = 12.0          # 比べる区間の長さ（秒）
MIN_LAG = 8.0       # 繰り返しとみなす最小のずれ（秒）
MAX_SEC = 420       # 長い動画は頭から7分まで
W = [0.25, 0.25, 0.25, 0.25]  # 点数の重み：繰り返し・大きさ・盛り上がりの始まり・長さからの推定に近いか


CACHE = None  # --cache <フォルダ>：読み込んだ音声を取っておく（調整用）


def load_audio(vid):
    """yt-dlp で音声を読み、ffmpeg でモノラル wav にして読み込む"""
    if CACHE and (CACHE / f'{vid}.npy').exists():
        return np.load(CACHE / f'{vid}.npy')
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, 'a.wav')
        yt = subprocess.Popen([sys.executable, '-m', 'yt_dlp', *YTDLP_OPTS, '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
                               '-o', '-', '--no-warnings', '--no-part', '-q', f'https://www.youtube.com/watch?v={vid}'],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        ff = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-t', str(MAX_SEC), '-ac', '1', '-ar', str(SR), '-y', wav],
                            stdin=yt.stdout, capture_output=True)
        yt.stdout.close()
        err = yt.stderr.read().decode('utf8', 'replace').strip()
        yt.wait()
        if ff.returncode != 0 or not os.path.exists(wav) or os.path.getsize(wav) < 10000:
            raise RuntimeError((err or ff.stderr.decode('utf8', 'replace')).splitlines()[-1][:160] if (err or ff.stderr) else '音声を読み込めない')
        y, _ = librosa.load(wav, sr=SR, mono=True)
    if CACHE:
        np.save(CACHE / f'{vid}.npy', y.astype(np.float32))
    return y


def guess(intro, dur):
    """動画の長さからの推定（public/chorus-guess.js と同じ）"""
    if dur <= 110:
        return max(intro + 20, dur * 0.5)
    return max(intro + 30, min(dur * 0.27, 90))


def estimate(y, intro):
    fps = SR / HOP
    dur = len(y) / SR
    chroma = librosa.feature.chroma_stft(y=y, sr=SR, hop_length=HOP)
    chroma = librosa.util.normalize(chroma, axis=0)
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    n = min(chroma.shape[1], len(rms))
    chroma, rms = chroma[:, :n], rms[:n]
    w = int(SEG * fps)
    if n < w * 3:
        return None
    sim = chroma.T @ chroma  # 似ている度合い（0〜1）
    # 区間 t と t+k がどれだけ似ているか（対角線に沿った平均）→ 区間ごとの「繰り返しの強さ」
    rep = np.zeros(n)
    kernel = np.ones(w) / w
    for k in range(int(MIN_LAG * fps), n - w):
        d = np.diagonal(sim, k)
        m = np.convolve(d, kernel, mode='valid')  # m[t] = 区間[t, t+w) と [t+k, t+k+w) の似ている度合い
        np.maximum(rep[:len(m)], m, out=rep[:len(m)])
        np.maximum(rep[k:k + len(m)], m, out=rep[k:k + len(m)])
    loud = np.convolve(rms, kernel, mode='same')
    # 範囲：イントロ＋15秒〜曲の75%。長さからの推定に近いほど加点（near）
    prior = guess(intro, dur)
    lo = int((intro + 15) * fps)
    hi = int(min(dur * 0.75, dur - SEG) * fps)
    if hi <= lo + 2:
        return None
    norm = lambda a: (a - a[lo:hi].min()) / (np.ptp(a[lo:hi]) + 1e-9)
    # 区間の始まり t に対して、t〜t+w の大きさ
    loud_seg = np.convolve(rms, kernel, mode='full')[w - 1:w - 1 + n]
    # 盛り上がりの始まり：t の後2秒と前2秒の大きさの差
    k2 = int(2 * fps)
    after = np.array([rms[i:i + k2].mean() if i + k2 <= n else 0 for i in range(n)])
    before = np.array([rms[max(0, i - k2):i].mean() if i > 0 else 0 for i in range(n)])
    rise = after - before
    t_idx = np.arange(n) / fps
    near = np.exp(-((t_idx - prior) / 20) ** 2)  # 長さからの推定に近いほど少し加点
    score = W[0] * norm(rep) + W[1] * norm(loud_seg) + W[2] * norm(rise) + W[3] * near
    cand = np.arange(lo, hi)
    t = int(cand[np.argmax(score[cand])])
    return round(max(0, t / fps - 0.3), 1)


def save(song):
    data = json.dumps({'songs': [song]}).encode('utf8')
    try:
        req = urllib.request.Request(f'{SERVER}/api/songs', data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status == 200:
                return 'api'
    except Exception:
        pass
    all_songs = json.loads(SONGS_PATH.read_text(encoding='utf8'))
    cur = next((s for s in all_songs if s['id'] == song['id']), None)
    if not cur:
        return 'skip'
    for k in ['chorus', 'chorusSource', 'chorusChecked']:
        if k in song:
            cur[k] = song[k]
    tmp = SONGS_PATH.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(all_songs, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    tmp.replace(SONGS_PATH)
    return 'file'


def main():
    args = sys.argv[1:]
    opt = lambda k, d: int(args[args.index(k) + 1]) if k in args else d
    dry = '--dry-run' in args
    songs = json.loads(SONGS_PATH.read_text(encoding='utf8'))
    test = opt('--test', 0)
    global CACHE, W
    if '--cache' in args:
        CACHE = Path(args[args.index('--cache') + 1]); CACHE.mkdir(parents=True, exist_ok=True)
    if '--w' in args:
        W = [float(x) for x in args[args.index('--w') + 1].split(',')]
    if test:
        # 正解（手で設定・よく再生される部分）がわかっている曲で当たり具合を見る
        pool = [s for s in songs if s.get('chorus', 0) > 0 and s.get('chorusSource') in ('manual', 'heatmap') and s.get('embeddable') is not False]
        random.seed(1)
        targets = random.sample(pool, min(test, len(pool)))
    else:
        targets = [s for s in songs if s.get('embeddable') is not False and not s.get('error')
                   and not (s.get('chorus', 0) > 0) and s.get('chorusSource') not in ('manual', 'audio')][:opt('--limit', 10**6)]
    print(f'{"確かめる" if test else "推定する"}曲: {len(targets)} 曲{"（保存しない）" if dry or test else ""}', flush=True)
    hits = ghits = done = failed = 0
    by = {}
    for i, s in enumerate(targets, 1):
        label = f"[{i}/{len(targets)}] {s['title']}（{s['work']}）"
        try:
            t = estimate(load_audio(s['id']), s.get('intro', 0) or 0)
            if t is None:
                print(f'{label} → 推定できず', flush=True)
                continue
            done += 1
            if test:
                # ゲームではサビの位置から流すので、少し早いのは問題ないが遅いとサビの頭を逃す → -8〜+3秒を当たりとする
                good = lambda x: -8 <= x - s['chorus'] <= 3
                ok = good(t)
                g = guess(s.get('intro', 0) or 0, len(load_audio(s['id'])) / SR)
                gok = good(g)
                hits += ok; ghits += gok
                src = s.get('chorusSource'); by.setdefault(src, [0, 0, 0]); by[src][0] += ok; by[src][1] += gok; by[src][2] += 1
                print(f"{label} → 推定 {t} 秒 / 長さから {round(g)} 秒 / 正解 {s['chorus']} 秒 {'○' if ok else '×'}{'○' if gok else '×'}", flush=True)
                continue
            print(f'{label} → {t} 秒', flush=True)
            if not dry:
                fresh = next((x for x in json.loads(SONGS_PATH.read_text(encoding='utf8')) if x['id'] == s['id']), None)
                if fresh and not (fresh.get('chorus', 0) > 0):
                    save({**fresh, 'chorus': t, 'chorusSource': 'audio', 'chorusChecked': True})
        except Exception as e:
            failed += 1
            print(f'{label} → 失敗: {e}', flush=True)
        if not (CACHE and (CACHE / f"{s['id']}.npy").exists()):
            time.sleep(1)
    if test:
        print(f'当たり（-8〜+3秒）: 音の解析 {hits} / 長さから {ghits} / {done} 曲、失敗 {failed} 曲 ' + ' '.join(f'[{k}: 音{v[0]} 長{v[1]} / {v[2]}]' for k, v in by.items()))
    else:
        print(f'終わり：推定 {done} 曲、失敗 {failed} 曲')


if __name__ == '__main__':
    main()
