# ローカルの ComfyUI（FLUX.2 klein 4B）で、文章から画像を作る（RUSH専用画面の背景など）。
# 使い方: .venv-embed\Scripts\python.exe tools\flux_t2i.py <ジョブJSON> <出力フォルダ>
#   ジョブ: [{"name": 出力名, "text": プロンプト, "seed": 数, "w": 幅, "h": 高さ}]
# 事前に ComfyUI が http://127.0.0.1:8188 で動いていること（comfy-mcp の launch_comfyui など）。
import json, sys, time, urllib.request, pathlib

URL = "http://127.0.0.1:8188"
BASE = json.load(open(r"E:\flux2\workflows\flux2_klein4b_fp8_api.json", encoding="utf-8"))
OUT = pathlib.Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)


def run(job):
    wf = json.loads(json.dumps(BASE))
    wf["4"]["inputs"]["text"] = job["text"]
    wf["9"]["inputs"]["noise_seed"] = job.get("seed", 11)
    w, h = job.get("w", 1536), job.get("h", 864)
    for n in ("8", "10"):
        wf[n]["inputs"].update(width=w, height=h)
    wf["13"]["inputs"]["filename_prefix"] = "rush_" + job["name"]
    req = urllib.request.Request(URL + "/prompt", json.dumps({"prompt": wf}).encode(), {"Content-Type": "application/json"})
    pid = json.load(urllib.request.urlopen(req))["prompt_id"]
    while True:
        time.sleep(1)
        hist = json.load(urllib.request.urlopen(f"{URL}/history/{pid}"))
        if pid in hist:
            break
    for node in hist[pid]["outputs"].values():
        for im in node.get("images", []):
            q = f"filename={im['filename']}&subfolder={im['subfolder']}&type={im['type']}"
            (OUT / f"{job['name']}.png").write_bytes(urllib.request.urlopen(f"{URL}/view?{q}").read())
            print(job["name"], "ok", flush=True)


for job in json.load(open(sys.argv[1], encoding="utf-8")):
    run(job)
