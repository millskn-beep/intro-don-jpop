# 登録している動画が「原曲そのまま」でない曲（セリフ・効果音が入るPV、予告、カバー、ライブなど）を洗い出す。
# 1曲ずつ音声を読み込み（tools/estimate_chorus_audio.py と同じ方法）、動画のタイトルと合わせて次を調べる：
#   ・タイトルに 予告／PV／CM／cover／歌ってみた／ピアノ／live などが入っている
#   ・サビの位置が「曲の中で大きい部分」になっていない（セリフや静かな場面になっている）
#   ・サビ・イントロのあたりで音が途切れがち（会話・効果音の合間）
#   ・音から推定したサビの位置と、登録しているサビの位置が大きく違う
# 結果は data/scan-videos.json に書く（曲データは変えない）。途中で止めても、次は続きから。
# 使い方: python tools/scan_videos.py [--limit 20] [--ids id1,id2] [--workers 2]
#         python tools/scan_videos.py --report   （結果から怪しい曲の一覧を出す）
import json
import re
import subprocess
import sys
import tempfile
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import librosa

sys.path.insert(0, str(Path(__file__).resolve().parent))
import estimate_chorus_audio as ec  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SONGS_PATH = ROOT / 'data' / 'songs.json'
OUT_PATH = ROOT / 'data' / 'scan-videos.json'
HOP = 2048
SR = ec.SR
WORDS = re.compile(r'予告|特報|PV|ＰＶ|CM|ＣＭ|トレーラー|trailer|teaser|cover|カバー|歌ってみた|弾いてみた|叩いてみた|演奏してみた|piano|ピアノ|オルゴール|music ?box|'
                   r'off ?vocal|instrumental|カラオケ|karaoke|remix|リミックス|live|ライブ|LIVE|acoustic|アコースティック|arrange|アレンジ|8 ?bit|nightcore|'
                   r'踊ってみた|AMV|MAD|メドレー|medley|reformare|re-?recording|新録|セルフカバー|self ?cover|movie edit|劇場版ver', re.I)
lock = threading.Lock()


def load(vid):
    """音声と動画のタイトル・チャンネルを読み込む"""
    with tempfile.TemporaryDirectory() as tmp:
        wav, meta = os.path.join(tmp, 'a.wav'), os.path.join(tmp, 'meta.txt')
        yt = subprocess.Popen([sys.executable, '-m', 'yt_dlp', *ec.YTDLP_OPTS, '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
                               '--print-to-file', '%(title)s\t%(channel)s\t%(duration)s', meta,
                               '-o', '-', '--no-warnings', '--no-part', '-q', f'https://www.youtube.com/watch?v={vid}'],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        ff = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-t', str(ec.MAX_SEC), '-ac', '1', '-ar', str(SR), '-y', wav],
                            stdin=yt.stdout, capture_output=True)
        yt.stdout.close()
        err = yt.stderr.read().decode('utf8', 'replace').strip()
        yt.wait()
        if ff.returncode != 0 or not os.path.exists(wav) or os.path.getsize(wav) < 10000:
            raise RuntimeError((err.splitlines() or ['音声を読み込めない'])[-1][:160])
        y, _ = librosa.load(wav, sr=SR, mono=True)
        title, channel, dur = (Path(meta).read_text(encoding='utf8').strip().split('\t') + ['', '', ''])[:3] if os.path.exists(meta) else ('', '', '')
    return y, title, channel


def analyze(y, intro, chorus):
    fps = SR / HOP
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    n = len(rms)
    w = int(12 * fps)
    peak = np.percentile(rms, 95) + 1e-9
    win = np.convolve(rms, np.ones(w) / w, mode='valid')  # 12秒ごとの大きさ
    def rank_at(t):  # その位置から12秒の大きさが、曲の中で上から何割か（1に近いほど大きい）
        i = min(max(0, int(t * fps)), len(win) - 1)
        return float((win < win[i]).mean())
    def gaps_at(t, sec):  # その位置から sec 秒のうち、音がほとんどない（会話の合間など）割合
        a, b = int(t * fps), min(n, int((t + sec) * fps))
        seg = rms[a:b]
        return float((seg < peak * 0.12).mean()) if len(seg) else 1.0
    est = ec.estimate(y, intro)
    return {
        'dur': round(len(y) / SR, 1),
        'chorusRank': round(rank_at(chorus), 2),
        'chorusGaps': round(gaps_at(chorus, 12), 2),
        'introGaps': round(gaps_at(intro, 8), 2),
        'earlyGaps': round(gaps_at(intro, 30), 2),  # はじめの30秒（セリフが入る PV は途切れがち）
        'est': est,
    }


def suspect_reasons(song, r):
    why = []
    if r.get('title') and WORDS.search(r['title']):
        why.append(f"動画タイトル「{r['title'][:40]}」")
    if r['chorusRank'] < 0.35:
        why.append(f"サビの位置が静か（大きさ {int(r['chorusRank'] * 100)}%）")
    if r['chorusGaps'] > 0.25:
        why.append(f"サビで音が途切れる（{int(r['chorusGaps'] * 100)}%）")
    if r['introGaps'] > 0.35:
        why.append(f"イントロで音が途切れる（{int(r['introGaps'] * 100)}%）")
    elif r.get('earlyGaps', 0) > 0.2:
        why.append(f"はじめの30秒で音が途切れる（{int(r['earlyGaps'] * 100)}%）")
    if r.get('est') is not None and abs(r['est'] - song.get('chorus', 0)) > 25 and r['chorusRank'] < 0.6:
        why.append(f"音から推定したサビ {r['est']}秒と大きく違う")
    return why


def save(done):
    # Windows ではほかのプログラムが読んでいると置き換えに失敗することがあるので、少し待ってやり直す
    tmp = OUT_PATH.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(done, ensure_ascii=False, indent=1), encoding='utf8')
    for i in range(10):
        try:
            tmp.replace(OUT_PATH)
            return
        except PermissionError:
            time.sleep(0.5 * (i + 1))
    print('  （結果の保存に失敗。次の曲で保存し直します）', flush=True)


def main():
    args = sys.argv[1:]
    songs = json.loads(SONGS_PATH.read_text(encoding='utf8'))
    done = json.loads(OUT_PATH.read_text(encoding='utf8')) if OUT_PATH.exists() else {}
    if '--report' in args:
        byid = {s['id']: s for s in songs}
        rows = []
        for vid, r in done.items():
            s = byid.get(vid)
            if not s or 'error' in r:
                continue
            why = suspect_reasons(s, r)
            if why:
                rows.append((len(why), s, r, why))
        rows.sort(key=lambda x: -x[0])
        for k, s, r, why in rows:
            print(f"{s['title']} ／ {s['work']}（{vid_of(s)}）サビ{s.get('chorus')}秒 … " + '、'.join(why))
        print(f'怪しい曲 {len(rows)} / 調べた {len(done)} 曲、読み込めなかった {sum(1 for r in done.values() if "error" in r)} 曲')
        return
    opt = lambda k, d: args[args.index(k) + 1] if k in args else d
    ids = opt('--ids', '')
    targets = [s for s in songs if s.get('embeddable') is not False and not s.get('error')]
    if ids:
        targets = [s for s in targets if s['id'] in ids.split(',')]
    else:
        targets = [s for s in targets if s['id'] not in done or 'error' in done[s['id']]]
    targets = targets[:int(opt('--limit', 10**6))]
    print(f'調べる曲: {len(targets)} 曲', flush=True)
    count = [0]

    def work(s):
        try:
            y, title, channel = load(s['id'])
            r = analyze(y, s.get('intro', 0) or 0, s.get('chorus', 0) or ec.guess(s.get('intro', 0) or 0, len(y) / SR))
            r.update(title=title, channel=channel)
            why = suspect_reasons(s, r)
            msg = '怪しい：' + '、'.join(why) if why else 'OK'
        except Exception as e:
            r, msg = {'error': str(e)[:160]}, f'失敗: {e}'
        with lock:
            done[s['id']] = r
            count[0] += 1
            save(done)
            print(f"[{count[0]}/{len(targets)}] {s['title']}（{s['work']}） → {msg}", flush=True)
        time.sleep(0.5)

    with ThreadPoolExecutor(max_workers=int(opt('--workers', 2))) as ex:
        list(ex.map(work, targets))
    print('終わり', flush=True)


def vid_of(s):
    return s['id']


if __name__ == '__main__':
    main()
