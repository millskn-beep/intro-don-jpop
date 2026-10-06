// マスコット（双子の女の子）の表情違いを、ローカルの ComfyUI（FLUX.2 klein・参照画像つき）で作る。
// 元の絵（data/assets-src/mascot/base.png：2人並んだデザイン）を参照させて、同じ見た目のまま表情・ポーズだけ変える。
// 1つにつき複数の seed で候補を作り（data/assets-src/mascot/<名前>_<seed>.png）、見比べて良いものを選ぶ。
// 背景の切り抜きと軽量化は tools/cut_mascot.py
// 使い方: node tools/gen-mascot.js [名前...] [--seeds 3] [--from 1] [--char rabbit|cat]（--char を付けると、うさぎ・ねこの8場面）

const fs = require('fs');
const path = require('path');

const COMFY = 'http://127.0.0.1:8188';
const WORKFLOW = 'E:\\flux2\\workflows\\flux2_klein4b_fp8_api.json';
const DIR = path.join(__dirname, '..', 'data', 'assets-src', 'mascot');

const SAME = 'same character design, same face, same hair, same headphones and same outfit as in the reference image, cute chibi anime style, super deformed proportions, clean cel shading, full body, centered, simple flat pure white background, no text, no letters, no logo';
const BLUE = 'the girl with long blue hair and cyan headphones from the reference image, alone';
const RED = 'the girl with red twin tails and magenta headphones from the reference image, alone';
const BOTH = 'the two twin girls from the reference image together side by side';

// 場面：イントロ＝青の子、サビ＝赤の子、「もう一回！」・正解・不正解＝2人
// うさぎ・ねこ（1匹）の場面ごとのポーズ。元の絵は data/assets-src/mascot/<キャラ>/base.png。--char rabbit などで選ぶ
const ANIMAL_SAME = 'same character design, same face, same fur colors and markings, same headphones and accessories as in the reference image, cute chibi kawaii mascot style, super deformed proportions, clean cel shading, centered, simple flat pure white background, no text, no letters, no logo';
const ANIMAL_POSES = {
  idle: 'standing and waving hello cheerfully at the viewer, relaxed happy smile, full body',
  listen: 'holding its headphones with both paws, eyes closed, listening happily to music, small floating music notes, full body',
  chorus: 'jumping excitedly with both arms raised high, sparkling eyes, big open smile, small sparkles around, full body',
  again: 'raising one paw and pointing up, winking and encouraging, cheerful, full body',
  ok: 'jumping with joy and making a victory pose, big happy smile, small sparkles, full body',
  ng: 'sad with teary eyes and drooping ears, cute disappointed pouting expression, full body',
  celebrate: 'jumping with joy holding up a shiny golden trophy, confetti and sparkles around, overjoyed, full body',
  cutin: 'dynamic close-up bust shot, leaning toward the viewer and pointing forward energetically with a wink, excited determined expression, dramatic action pose',
};
const ANIMAL_JOBS = char => Object.entries(ANIMAL_POSES).map(([pose, act]) => ({
  name: `${char}-${pose}`, w: pose === 'cutin' ? 1024 : 768, h: pose === 'cutin' ? 768 : 1024,
  text: `the ${char === 'rabbit' ? 'bunny' : 'cat'} mascot from the reference image, alone, ${act}, ${ANIMAL_SAME}`,
}));
const JOBS = [
  { name: 'blue-listen', w: 768, h: 1024, text: `${BLUE}, holding her headphones with both hands, eyes closed, listening happily to music, small floating music notes, ${SAME}` },
  { name: 'red-chorus', w: 768, h: 1024, text: `${RED}, jumping with both arms raised up high, very excited, sparkling eyes, big open smile, small sparkles around her, ${SAME}` },
  { name: 'both-again', w: 1024, h: 768, text: `${BOTH}, both raising one index finger up, winking and encouraging, cheerful, ${SAME}` },
  { name: 'both-ok', w: 1024, h: 768, text: `${BOTH}, giving each other a high five, jumping with joy, big happy smiles, ${SAME}` },
  // 出題中に左右に分けて立たせる用（1人ずつ）。青＝左、赤＝右
  { name: 'blue-chorus', w: 768, h: 1024, text: `${BLUE}, excited with sparkling eyes, both fists raised, singing along happily, small music notes around her, ${SAME}` },
  { name: 'blue-ok', w: 768, h: 1024, text: `${BLUE}, jumping with joy and making a victory peace sign, big happy smile, small sparkles, ${SAME}` },
  { name: 'blue-ng', w: 768, h: 1024, text: `${BLUE}, pouting sadly with teary eyes, hands clasped, cute disappointed expression, ${SAME}` },
  { name: 'red-listen', w: 768, h: 1024, text: `${RED}, holding her headphones with both hands, eyes closed, listening happily to music, small floating music notes, ${SAME}` },
  { name: 'red-ok', w: 768, h: 1024, text: `${RED}, jumping with joy and making a victory peace sign with a wink, big happy smile, small sparkles, ${SAME}` },
  { name: 'red-ng', w: 768, h: 1024, text: `${RED}, pouting sadly with teary eyes and drooping shoulders, cute disappointed expression, ${SAME}` },
  { name: 'both-idle', w: 1024, h: 768, text: `${BOTH}, both waving hello cheerfully at the viewer, relaxed happy smiles, standing, ${SAME}` },
  { name: 'both-celebrate', w: 1024, h: 768, text: `${BOTH}, jumping with joy and holding up a shiny golden trophy together, confetti and sparkles around them, overjoyed big smiles, ${SAME}` },
  { name: 'both-cutin', w: 1024, h: 768, text: `${BOTH}, dynamic close-up bust shot, leaning toward the viewer and pointing forward energetically, one winking, excited determined expressions, dramatic action pose, ${SAME.replace('full body, ', '')}` },
  { name: 'both-ng', w: 1024, h: 768, text: `${BOTH}, both pouting sadly with teary eyes and drooping shoulders, cute disappointed expression, ${SAME}` },
];

async function upload(file) {
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(file)]), 'mascot-base.png');
  form.append('overwrite', 'true');
  const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`画像のアップロード失敗 ${res.status}`);
  return (await res.json()).name;
}

async function generate(job, seed, image) {
  const wf = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
  wf['4'].inputs.text = job.text;
  wf['8'].inputs.width = wf['10'].inputs.width = job.w;
  wf['8'].inputs.height = wf['10'].inputs.height = job.h;
  wf['9'].inputs.noise_seed = seed;
  wf['13'].inputs.filename_prefix = `anison/mascot_${job.name}`;
  // 参照画像：読み込み → 約1メガピクセルに縮小 → 潜在表現にして、プロンプト（と空のプロンプト）に添える
  wf['20'] = { class_type: 'LoadImage', inputs: { image } };
  wf['21'] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['20', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 } };
  wf['22'] = { class_type: 'VAEEncode', inputs: { pixels: ['21', 0], vae: ['3', 0] } };
  wf['23'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['4', 0], latent: ['22', 0] } };
  wf['24'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['5', 0], latent: ['22', 0] } };
  wf['6'].inputs.positive = ['23', 0];
  wf['6'].inputs.negative = ['24', 0];

  const res = await fetch(`${COMFY}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf }) });
  if (!res.ok) throw new Error(`投入失敗 ${res.status}: ${await res.text()}`);
  const { prompt_id } = await res.json();
  for (let i = 0; i < 720; i++) {
    await new Promise(r => setTimeout(r, 500));
    const entry = (await fetch(`${COMFY}/history/${prompt_id}`).then(r => r.json()))[prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new Error('生成エラー: ' + JSON.stringify(entry.status.messages).slice(0, 400));
    const img = entry.outputs?.['13']?.images?.[0];
    if (!img) continue;
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
    return Buffer.from(await fetch(`${COMFY}/view?${q}`).then(r => r.arrayBuffer()));
  }
  throw new Error('タイムアウト');
}

(async () => {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
  const seeds = opt('--seeds', 3), from = opt('--from', 1);
  const names = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
  const char = args.includes('--char') ? args[args.indexOf('--char') + 1] : 'twins';
  const image = await upload(char === 'twins' ? path.join(DIR, 'base.png') : path.join(DIR, char, 'base.png'));
  const jobs = char === 'twins' ? JOBS : ANIMAL_JOBS(char);
  for (const job of jobs.filter(j => !names.length || names.includes(j.name))) {
    for (let s = from; s < from + seeds; s++) {
      const file = path.join(DIR, `${job.name}_${s}.png`);
      if (fs.existsSync(file)) continue;
      const t0 = Date.now();
      fs.writeFileSync(file, await generate(job, 3000 + s * 11, image));
      console.log(`ok ${job.name}_${s}.png ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
