// マスコット（双子）の絵を、ローカルの ComfyUI（Wan 2.2 5B・画像から動画）で動かす。
// 元の絵は tools/gen-mascot.js で作って選んだもの（data/assets-src/mascot/<名前>_<番号>.png、白い背景）。
// 1つにつき複数の seed で候補を作り（data/assets-src/mascot-anim/<名前>_<seed>.mp4）、見比べて良いものを選ぶ。
// 背景の切り抜きと透過アニメ（webp）への書き出しは tools/cut_mascot.py
// 使い方: node tools/gen-mascot-anim.js [名前...] [--seeds 2] [--from 1]

const fs = require('fs');
const path = require('path');
const { workflow } = require('./gen-effects');

const COMFY = 'http://127.0.0.1:8188';
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'assets-src', 'mascot');
const OUT = path.join(ROOT, 'data', 'assets-src', 'mascot-anim');

const SAME = 'same characters, same face and same outfit, cute chibi anime style, clean cel shading, static camera, no camera movement, no zoom, the plain pure white background stays plain white, smooth gentle motion';

// pick: 採用した静止画の番号。縦長（1人）は 576x768、横長（2人）は 768x576（元の絵と同じ縦横比、32の倍数）
const JOBS = [
  { name: 'blue-listen', pick: 1, w: 576, h: 768, text: `The chibi girl sways gently side to side to the music with her eyes closed, holding her headphones with both hands, smiling happily, her long hair swaying softly, small music notes float up, ${SAME}` },
  { name: 'red-chorus', pick: 3, w: 576, h: 768, text: `The chibi girl bounces up and down excitedly with both arms raised high, cheering, her red twin tails bouncing, sparkles twinkle around her, ${SAME}` },
  { name: 'both-again', pick: 1, w: 768, h: 576, text: `The two chibi girls cheerfully wag their raised index fingers and wink, bobbing up and down slightly in rhythm, ${SAME}` },
  { name: 'both-ok', pick: 2, w: 768, h: 576, text: `The two chibi girls happily jump up and down together with their hands touching in a high five, big joyful smiles, ${SAME}` },
  { name: 'both-ng', pick: 2, w: 768, h: 576, text: `The two chibi girls droop sadly, sniffling with teary eyes, their shoulders shaking slightly, ${SAME}` },
];

async function upload(file, name) {
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(file)]), name);
  form.append('overwrite', 'true');
  const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`画像のアップロード失敗 ${res.status}`);
  return (await res.json()).name;
}

async function generate(job, seed) {
  const image = await upload(path.join(SRC, `${job.name}_${job.pick}.png`), `mascot-${job.name}.png`);
  const wf = workflow({ image, text: job.text, seed, prefix: `anison/mascot_${job.name}`, width: job.w, height: job.h });
  const res = await fetch(`${COMFY}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf }) });
  if (!res.ok) throw new Error(`投入失敗 ${res.status}: ${await res.text()}`);
  const { prompt_id } = await res.json();
  for (let i = 0; i < 1800; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const entry = (await fetch(`${COMFY}/history/${prompt_id}`).then(r => r.json()))[prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new Error('生成エラー: ' + JSON.stringify(entry.status.messages).slice(0, 400));
    const out = Object.values(entry.outputs?.['58'] || {}).find(v => Array.isArray(v) && v[0]?.filename)?.[0];
    if (!out) continue;
    const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder, type: out.type });
    return Buffer.from(await fetch(`${COMFY}/view?${q}`).then(r => r.arrayBuffer()));
  }
  throw new Error('タイムアウト');
}

(async () => {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
  const seeds = opt('--seeds', 2), from = opt('--from', 1);
  const names = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
  fs.mkdirSync(OUT, { recursive: true });
  for (const job of JOBS.filter(j => !names.length || names.includes(j.name))) {
    for (let s = from; s < from + seeds; s++) {
      const file = path.join(OUT, `${job.name}_${s}.mp4`);
      if (fs.existsSync(file)) continue;
      const t0 = Date.now();
      fs.writeFileSync(file, await generate(job, 5000 + s * 19));
      console.log(`ok ${job.name}_${s}.mp4 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
