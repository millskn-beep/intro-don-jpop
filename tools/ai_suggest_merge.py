# ai-suggest.json に、構造解析AI（data/struct-ai/*.json）のサビの案を足す（tools/struct_ai.py の結果）
import json
from pathlib import Path
R = Path(__file__).resolve().parent.parent / 'data'
d = json.loads((R / 'ai-suggest.json').read_text(encoding='utf8'))
songs = {s['id']: s for s in json.loads((R / 'songs.json').read_text(encoding='utf8'))}
n = 0
for it in d['items']:
    p = R / 'struct-ai' / f"{it['id']}.json"
    it['cands'] = [c for c in it['cands'] if c['key'] != 'allin1']
    if not p.exists():
        continue
    intro = songs[it['id']].get('intro', 0) or 0
    ch = [s for s, l in json.loads(p.read_text(encoding='utf8')) if l == 'chorus' and s > intro + 5]
    if ch:
        it['cands'].insert(2, {'key': 'allin1', 'label': '構造解析AI', 't': round(ch[0], 1), 'short': 'AI', 'note': '曲の構造（イントロ・Aメロ・サビ…）を解析するAIが最初に「サビ」とした所'})
        n += 1
d['methods']['allin1'] = 'all-in-one（構造解析AI）'
(R / 'ai-suggest.json').write_text(json.dumps(d, ensure_ascii=False, indent=1) + '\n', encoding='utf8')
print(n, '曲に構造解析AIの案を足しました')
