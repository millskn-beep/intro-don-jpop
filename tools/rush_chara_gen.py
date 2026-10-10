# RUSH専用キャラ（4人）の絵を、FLUX.2 klein 9B（画風見本つき）で描く。賭け盟約・ナースの一歩と同じ方法。
# 使い方: .venv-embed\Scripts\python.exe tools\rush_chara_gen.py <ジョブJSON> <出力フォルダ>
#   ジョブ: [{"name": 出力名, "text": プロンプト, "seed": 数, "w": 幅, "h": 高さ, "ref": 参照画像パス(省略時は画風見本)}]
import json, sys, time, uuid, urllib.request, pathlib

URL = "http://127.0.0.1:8188"
BASE = json.load(open(r"E:\flux2\workflows\nurse_ippo_9b_ref_api.json", encoding="utf-8"))
STYLE_REF = r"E:\flux2\ComfyUI\input\gptstyle_day_b.png"
OUT = pathlib.Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)


def upload(path):
    data = open(path, "rb").read(); bnd = uuid.uuid4().hex
    name = "rush_" + pathlib.Path(path).name
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: image/png\r\n\r\n").encode() + data + \
           (f"\r\n--{bnd}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{bnd}--\r\n").encode()
    req = urllib.request.Request(URL + "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={bnd}"})
    return json.load(urllib.request.urlopen(req))["name"]


def run(job):
    wf = json.loads(json.dumps(BASE))
    wf["30"]["inputs"]["image"] = upload(job.get("ref", STYLE_REF))
    wf["4"]["inputs"]["text"] = job["text"]
    wf["9"]["inputs"]["noise_seed"] = job.get("seed", 11)
    w, h = job.get("w", 832), job.get("h", 1216)
    for n in ("8", "10"):
        wf[n]["inputs"].update(width=w, height=h)
    wf["13"]["inputs"]["filename_prefix"] = "rush_chara_" + job["name"]
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
