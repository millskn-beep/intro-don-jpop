# 自動の解析と修正（時間を決めて裏で動かす）。送ってもらった修正（data/fix-history.json）を正解にして、判定を合わせ直しながら進める。
#
#   1. サビ：「音から推定」した曲（chorusSource: 'audio'）を、修正で合わせた重みで推定し直す（tools/estimate_chorus_audio.py の W）
#   2. イントロ：頭の「音楽以外」（セリフ・歓声・効果音・環境音）を飛ばした位置（tools/intro_cheer.py の music_start）を出し、
#      いまのイントロより 1.5 秒以上遅ければ直す。40 秒より大きく動くものは直さず一覧（data/auto-fixes.json の pending）にだけ出す
#   3. 1 時間ごとに公開サイトから修正を取り込み（tools/pull-fixes.js）、増えた正解で判定の基準（何秒中何秒が音楽以外なら飛ばすか）を合わせ直す
#
# 4. Songle（産総研の音楽解析サービス。解析済みの曲だけ）と照合する：
#    サビは Songle の解析があればそれを使う（chorusSource: 'songle'）。イントロは Songle の最初の拍が「いまの位置で音楽が始まっている」
#    と言っている曲は自動で直さず一覧に。基準の合わせ直しでは、Songle で「すぐ音楽が始まる」と分かる曲も「遅らせすぎ」の確認に使う
# 直した曲には印（introSource: 'auto' ／ chorusSource: 'audio2'・'songle'）と直す前の値（introBefore ／ chorusBefore）を残す。収録曲一覧に「自動で直した」と出る。
# 手で直した曲（修正の記録がある曲・introMeasured が false の曲）は触らない。途中で止めても、次は続きから。
#
# 使い方（専用の環境）: .venv-embed/Scripts/python tools/auto_fix.py --hours 10 [--limit N] [--dry-run]
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import estimate_chorus_audio as ec  # noqa: E402
from intro_cheer import load_model, emb, SCAN_LABELS, load_head, music_start, SCAN_PATH, VIDEO_WORDS  # noqa: E402
from embed_scan import to16k, labeled  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SONGS_PATH = ROOT / 'data' / 'songs.json'
HISTORY_PATH = ROOT / 'data' / 'fix-history.json'
LABELS_PATH = ROOT / 'data' / 'auto-labels.json'   # 1 秒ごとの判定（頭から 120 秒）。調べ直さなくて済むように残す
LOG_PATH = ROOT / 'data' / 'auto-fixes.json'       # 直した曲・直さず一覧に出した曲・基準の合わせ直し
CACHE = ROOT / 'data' / 'audio-cache'
HEAD = 120
MAX_SHIFT = 40       # これより大きく動くものは自動で直さない
MIN_SHIFT = 1.5
PULL_EVERY = 3600    # 公開サイトから修正を取り込む間隔（秒）

args = sys.argv[1:]
opt = lambda k, d: type(d)(args[args.index(k) + 1]) if k in args else d
HOURS, LIMIT, DRY = opt('--hours', 10.0), opt('--limit', 10 ** 6), '--dry-run' in args
NO_CHORUS = '--no-chorus' in args  # 試すとき用：サビの推定し直しを飛ばす
DEADLINE = time.time() + HOURS * 3600


def now():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def say(*a):
    print(now(), *a, flush=True)


def read(p, d):
    try:
        return json.loads(p.read_text(encoding='utf8'))
    except Exception:
        return d


def write(p, v, indent=1):
    tmp = p.with_suffix(p.suffix + '.tmp')
    tmp.write_text(json.dumps(v, ensure_ascii=False, indent=indent) + '\n', encoding='utf8')
    tmp.replace(p)


def save_song(song_id, fields):
    """曲データの1曲だけ書き換える（毎回読み直して、ほかの変更を消さないように）"""
    songs = read(SONGS_PATH, [])
    for s in songs:
        if s['id'] == song_id:
            s.update(fields)
            break
    else:
        return False
    if not DRY:
        tmp = SONGS_PATH.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(songs, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
        tmp.replace(SONGS_PATH)
    return True


def log_event(bucket, **kw):
    log = read(LOG_PATH, {'fixed': [], 'pending': [], 'tuning': []})
    log.setdefault(bucket, []).append({'at': now(), **kw})
    if not DRY:
        write(LOG_PATH, log)


# ── Songle（https://songle.jp）の解析：サビ（くり返しの始まり）と最初の拍。1 秒に 1 回まで、結果は data/songle.json に残す ──
SONGLE_PATH = ROOT / 'data' / 'songle.json'
SONGLE = read(SONGLE_PATH, {})


def songle(vid):
    if vid in SONGLE:
        return SONGLE[vid]
    import urllib.request
    import urllib.error
    out = {}
    try:
        for kind in ('chorus', 'beat'):
            url = f'https://widget.songle.jp/api/v1/song/{kind}.json?url=www.youtube.com/watch?v={vid}'
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'anison-intro-vs'}), timeout=15) as r:
                d = json.loads(r.read().decode('utf8') or '{}')
            if kind == 'chorus' and d.get('chorusSegments'):
                out['chorus'] = sorted(x['start'] / 1000 for x in d['chorusSegments'][0]['repeats'])
            if kind == 'beat' and d.get('beats'):
                out['beat'] = d['beats'][0]['start'] / 1000
            time.sleep(1)
            if kind == 'chorus' and not out:
                break  # 解析がない曲は拍もない
    except urllib.error.HTTPError as e:
        if e.code != 404:
            return None  # 混んでいるなど：記録しない（次にまた聞く）
        # 404 は「Songle にまだ解析がない曲」。取れたところまでを記録する
    except Exception:
        return None  # つながらないときは記録しない（次にまた聞く）
    SONGLE[vid] = out
    write(SONGLE_PATH, SONGLE, indent=0)
    return out


# ── 1 秒ごとの判定 ──
model = load_model()
T = np.stack([np.asarray(model.encode(v, prompt_name='SearchQuery', normalize_embeddings=True), dtype=np.float32).reshape(-1)
              for v in SCAN_LABELS.values()])
LABELS = read(LABELS_PATH, {})
# 前の候補探し（同じきまり・120 秒）で調べた曲は、そのまま使う
for vid, v in read(SCAN_PATH, {}).items():
    if v.get('rule') == 2 and v.get('labels') and vid not in LABELS:
        LABELS[vid] = v['labels']


def labels_of(y16):
    st = np.arange(0, max(0, len(y16) / 16000 - 1), 1.0)
    S = emb(model, [y16[int(t * 16000):int((t + 1) * 16000)] for t in st]) @ T.T
    return ''.join('IVSCE'[i] for i in np.argmax(S, 1))


def get_labels(vid):
    if vid in LABELS:
        return LABELS[vid]
    p = CACHE / f'{vid}.npy'
    y16 = to16k(np.load(p))[:16000 * HEAD] if p.exists() else load_head(vid, HEAD)
    LABELS[vid] = labels_of(y16)
    write(LABELS_PATH, LABELS, indent=0)  # 判定の結果は曲データではないので、試しでも残す（次から速く）
    return LABELS[vid]


def lab_arr(s):
    return np.array(['IVSCE'.index(c) for c in s])

# ── 基準の合わせ直し：直してもらったイントロ（正解）で、いちばん当たって、ふつうの曲を遅らせすぎない基準を選ぶ ──
RULE = {'win': 20, 'k': 8}


def tune():
    hist = read(HISTORY_PATH, [])
    songs = {s['id']: s for s in read(SONGS_PATH, [])}
    pos = {h['id']: h['after']['intro'] for h in hist if abs(h['after']['intro'] - h['before']['intro']) > 0.3}
    neg = {h['id']: h['after']['intro'] for h in hist if abs(h['after']['intro'] - h['before']['intro']) <= 0.3}
    for it in labeled():
        if it['kind'] in ('topic', 'swapped-new') and it['id'] in songs:
            neg.setdefault(it['id'], songs[it['id']].get('intro', 0) or 0)
    # Songle の最初の拍が、いまのイントロの位置とほぼ同じ曲（自動の計測と Songle が一致＝頭から音楽）も「遅らせてはいけない曲」に
    n_sg = 0
    for vid, sg in SONGLE.items():
        s = songs.get(vid)
        if s and vid in LABELS and sg.get('beat') is not None and s.get('introMethod') == 'v2' and abs(sg['beat'] - (s.get('intro') or 0)) <= 1.5:
            neg.setdefault(vid, s.get('intro') or 0); n_sg += 1
    labs = {}
    for vid in list(pos) + list(neg):
        try:
            labs[vid] = lab_arr(get_labels(vid))
        except Exception as e:
            say('正解の曲の音を取れない', vid, str(e)[:80])
    best = None
    for win, k in [(10, 4), (10, 5), (15, 5), (15, 7), (20, 8), (20, 10), (30, 12)]:
        hit = sum(1 for v, t in pos.items() if v in labs and (p := music_start(labs[v], win, k)) is not None and abs(p - t) <= 2)
        late = sum(1 for v, t in neg.items() if v in labs and ((p := music_start(labs[v], win, k)) is None or p > t + 2))
        score = (late == 0, hit, -late)
        if best is None or score > best[0]:
            best = (score, win, k, hit, late)
    _, win, k, hit, late = best
    changed = (win, k) != (RULE['win'], RULE['k'])
    RULE.update(win=win, k=k)
    npos = sum(1 for v in pos if v in labs)
    nneg = sum(1 for v in neg if v in labs)
    say(f'基準：{win} 秒のうち {k} 秒以上が音楽以外なら飛ばす（正解 {hit}/{npos}・遅らせすぎ {late}/{nneg}）{"（変更）" if changed else ""}')
    log_event('tuning', win=win, k=k, hit=hit, positives=npos, late=late, negatives=nneg, songleNegatives=n_sg)
    if n_sg:
        say(f'  （うち Songle で頭から音楽と分かる曲 {n_sg} 曲）')


def pull():
    say('公開サイトから修正を取り込みます')
    if DRY:
        return
    r = subprocess.run(['node', str(ROOT / 'tools' / 'pull-fixes.js')], capture_output=True, text=True, encoding='utf8', cwd=ROOT)
    for line in (r.stdout or '').splitlines()[-3:]:
        say('  ', line)


# ── 1. サビ：音から推定した曲を、合わせ直した重みで ──
def redo_chorus():
    songs = read(SONGS_PATH, [])
    hist = {h['id'] for h in read(HISTORY_PATH, [])}
    seen = {e['id'] for e in read(LOG_PATH, {}).get('checked', []) if e.get('kind') == 'chorus-ok'}
    targets = [s for s in songs if s.get('chorusSource') == 'audio' and s.get('embeddable') is not False and s['id'] not in hist and s['id'] not in seen]
    say(f'サビの推定し直し：{len(targets)} 曲')
    for n, s in enumerate(targets, 1):
        if time.time() > DEADLINE:
            return
        sg = songle(s['id']) or {}
        intro = s.get('intro', 0) or 0
        sg_ch = next((c for c in sg.get('chorus', []) if c > intro + 10), None)
        if sg_ch is not None:
            t = round(sg_ch, 1)
            if abs(t - (s.get('chorus') or 0)) >= 1:
                save_song(s['id'], {'chorus': t, 'chorusSource': 'songle', 'chorusBefore': s.get('chorus')})
                log_event('fixed', id=s['id'], title=s['title'], work=s['work'], kind='chorus', before=s.get('chorus'), after=t, by='songle')
                say(f'  [{n}] {s["title"]} → サビ {s.get("chorus")} → {t} 秒（Songle）')
            else:
                log_event('checked', id=s['id'], kind='chorus-ok')
                say(f'  [{n}] {s["title"]} → そのまま（Songle と一致 {t} 秒）')
            continue
        try:
            y = ec.load_audio(s['id'])
            t = ec.estimate(y, s.get('intro', 0) or 0)
        except Exception as e:
            say(f'  [{n}] {s["title"]} → 失敗: {str(e)[:80]}')
            time.sleep(10)
            continue
        if t is None or abs(t - (s.get('chorus') or 0)) < 1:
            log_event('checked', id=s['id'], kind='chorus-ok')
            say(f'  [{n}] {s["title"]} → そのまま（{s.get("chorus")} 秒）')
        else:
            save_song(s['id'], {'chorus': t, 'chorusSource': 'audio2', 'chorusBefore': s.get('chorus')})
            log_event('fixed', id=s['id'], title=s['title'], work=s['work'], kind='chorus', before=s.get('chorus'), after=t)
            say(f'  [{n}] {s["title"]} → サビ {s.get("chorus")} → {t} 秒')
        time.sleep(2)


# ── 2. イントロ ──
def intro_targets():
    import re
    songs = read(SONGS_PATH, [])
    videos = read(ROOT / 'data' / 'scan-videos.json', {})
    hist = {h['id'] for h in read(HISTORY_PATH, [])}
    done = {e['id'] for k in ('fixed', 'pending', 'checked') for e in read(LOG_PATH, {}).get(k, []) if e.get('kind', 'intro') in ('intro', 'intro-big', 'ok')}
    words = re.compile(VIDEO_WORDS, re.I)
    ok = [s for s in songs if s.get('embeddable') is not False and not s.get('retired') and s['id'] not in hist and s['id'] not in done
          and s.get('introMeasured') is not False and s.get('introSource') != 'auto']
    topic = lambda s: (videos.get(s['id'], {}).get('channel') or '').endswith('- Topic')
    mv = lambda s: bool(words.search(videos.get(s['id'], {}).get('title', '')))
    # MV・映画の映像 → ほかの動画 → 公式音源（Topic）の順
    return sorted(ok, key=lambda s: (topic(s), not mv(s)))


def check_intro(s):
    lab = lab_arr(get_labels(s['id']))
    start = music_start(lab, RULE['win'], RULE['k'])
    intro = s.get('intro', 0) or 0
    if start is None or start <= intro + MIN_SHIFT:
        log_event('checked', id=s['id'], kind='ok')
        return f'そのまま（いま {intro} 秒・音楽の始まり {start} 秒）'
    sg = songle(s['id']) or {}
    beat = sg.get('beat')
    if beat is not None and abs(beat - intro) <= 1.5 and abs(beat - start) > 3:
        log_event('pending', id=s['id'], title=s['title'], work=s['work'], kind='intro-big', before=intro, after=start, rule=dict(RULE), songleBeat=beat, why='songle')
        return f'★ Songle は「いまの位置で音楽が始まる」と言うので一覧だけ（{intro} → {start} 秒・Songle の最初の拍 {beat:.1f} 秒）'
    if start - intro > MAX_SHIFT:
        log_event('pending', id=s['id'], title=s['title'], work=s['work'], kind='intro-big', before=intro, after=start, rule=dict(RULE))
        return f'★ 大きく動くので一覧だけ（{intro} → {start} 秒）'
    save_song(s['id'], {'intro': start, 'introSource': 'auto', 'introBefore': intro})
    log_event('fixed', id=s['id'], title=s['title'], work=s['work'], kind='intro', before=intro, after=start, rule=dict(RULE), songleBeat=beat)
    return f'◎ イントロを直した（{intro} → {start} 秒）' + (f'（Songle の最初の拍 {beat:.1f} 秒）' if beat is not None else '')


def main():
    ec.CACHE = None  # サビの推定し直しでは音を残さない（容量のため）
    say(f'開始：{HOURS} 時間で止まります{"（試し・保存しない）" if DRY else ""}')
    pull()
    tune()
    last_pull = time.time()
    if not NO_CHORUS:
        redo_chorus()
    targets = intro_targets()[:LIMIT]
    say(f'イントロ：{len(targets)} 曲')
    fails = 0
    for n, s in enumerate(targets, 1):
        if time.time() > DEADLINE:
            say('時間になったので止めます（次は続きから）')
            break
        if time.time() - last_pull > PULL_EVERY:
            pull(); tune(); last_pull = time.time()
        fresh = next((x for x in read(SONGS_PATH, []) if x['id'] == s['id']), None)
        if not fresh or fresh.get('introMeasured') is False or fresh.get('introSource') == 'auto':
            continue  # 取り込んだ修正で手で直された曲は触らない
        try:
            had = s['id'] in LABELS
            msg = check_intro(fresh)
            fails = 0
            say(f'[{n}/{len(targets)}] {s["title"]}（{s["work"]}） → {msg}')
            if not had:
                time.sleep(2)
        except Exception as e:
            fails += 1
            say(f'[{n}/{len(targets)}] {s["title"]} → 失敗: {str(e)[:100]}')
            if fails >= 5:
                say('5 回続けて失敗したので 10 分休みます（YouTube に止められている可能性）')
                time.sleep(600)
                fails = 0
            else:
                time.sleep(10)
    log = read(LOG_PATH, {})
    say(f'終わり：直した {len(log.get("fixed", []))} 件・一覧だけ {len(log.get("pending", []))} 件（{LOG_PATH}）')


if __name__ == '__main__':
    main()
