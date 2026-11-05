# サビの位置が決まっていない曲（chorus が 0）を、音から推定して保存する（tools/estimate_chorus_audio.py の関数を使う）
# 使い方: python tools/chorus_ids.py            … chorus が 0 の曲を全部
#         python tools/chorus_ids.py <id> ...    … 指定した曲だけ
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import estimate_chorus_audio as ec

songs = json.loads(ec.SONGS_PATH.read_text(encoding='utf8'))
ids = set(sys.argv[1:]) or {s['id'] for s in songs if not s.get('retired') and not (s.get('chorus', 0) > 0)}
print(f'サビを音から推定する曲: {len(ids)} 曲', flush=True)
for s in [x for x in songs if x['id'] in ids]:
    try:
        t = ec.estimate(ec.load_audio(s['id']), s.get('intro', 0) or 0)
        if t is None:
            print(f"{s['title']} → 推定できず", flush=True); continue
        fresh = next((x for x in json.loads(ec.SONGS_PATH.read_text(encoding='utf8')) if x['id'] == s['id']), None)
        if fresh and not (fresh.get('chorus', 0) > 0):
            print(f"{s['title']} → {t} {ec.save({**fresh, 'chorus': t, 'chorusSource': 'audio'})}", flush=True)
    except Exception as e:
        print(f"{s['title']} → 失敗: {e}", flush=True)
