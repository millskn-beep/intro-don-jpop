// 場面の切り替わりエフェクト（短い動画）を、ローカルの ComfyUI（Wan 2.2 5B・画像から動画）で作る。
// 元画像は tools/gen-assets.js の fx-* で作った data/assets-src/glass/fx-*.png（黒背景に光るアイコン）。
// 1つにつき複数の seed で候補を作り（data/assets-src/fx/<名前>_<seed>.mp4）、見比べて良いものを選ぶ。
// 画面では黒い背景を mix-blend-mode: screen で消して、光だけを重ねる。
// 使い方: node tools/gen-effects.js [名前...] [--seeds 2] [--from 1]
//   書き出し（軽量版）: node tools/gen-effects.js --export fx-intro=1 fx-replay=2 ...  → public/assets/fx/<名前>.mp4

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const COMFY = 'http://127.0.0.1:8188';
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'assets-src', 'glass');
const OUT = path.join(ROOT, 'data', 'assets-src', 'fx');
const PUB = path.join(ROOT, 'public', 'assets', 'fx');

const STILL = 'static camera, no camera movement, the pure black background stays completely black, glowing neon light, smooth motion';
const NEG = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，杂乱的背景, text, letters, camera movement, zoom, background change';

// loop: 往復させてつなぎ目のないループにする（ステージの絵用。false は画面中央で1回だけ流す演出）
const JOBS = [
  { name: 'fx-intro', loop: true, text: `The glowing sound wave rings gently breathe, softly expanding and contracting in rhythm around the music note, the music note gently bobs up and down to the beat, the rings shimmer, ${STILL}` },
  { name: 'fx-replay', loop: false, text: `The circular arrow made of light spins smoothly clockwise around its center, leaving a soft glowing trail, ${STILL}` },
  { name: 'fx-chorus', loop: true, text: `The bright star twinkles and pulses with light, the small sparkles around it twinkle on and off and drift slowly, glittering shimmer, ${STILL}` },
  { name: 'fx-burst', loop: false, text: `The ring of light expands quickly outward like a shockwave, the light rays burst outward and then fade away into darkness, ${STILL}` },
];

const FRAMES = 49; // 24fps で約2秒
function workflow({ image, text, seed, prefix, size = 640, width = size, height = size, frames = FRAMES }) {
  return {
    37: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_ti2v_5B_fp16.safetensors', weight_dtype: 'default' } },
    38: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } },
    39: { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } },
    48: { class_type: 'ModelSamplingSD3', inputs: { shift: 8, model: ['37', 0] } },
    6: { class_type: 'CLIPTextEncode', inputs: { text, clip: ['38', 0] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: NEG, clip: ['38', 0] } },
    56: { class_type: 'LoadImage', inputs: { image } },
    55: { class_type: 'Wan22ImageToVideoLatent', inputs: { width, height, length: frames, batch_size: 1, vae: ['39', 0], start_image: ['56', 0] } },
    3: { class_type: 'KSampler', inputs: { seed, steps: 20, cfg: 5, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1, model: ['48', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['55', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['39', 0] } },
    57: { class_type: 'CreateVideo', inputs: { images: ['8', 0], fps: 24 } },
    58: { class_type: 'SaveVideo', inputs: { video: ['57', 0], filename_prefix: prefix, format: 'auto', 'format.codec': 'auto' } },
  };
}

async function upload(file) {
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(file)]), path.basename(file));
  form.append('overwrite', 'true');
  const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`画像のアップロード失敗 ${res.status}`);
  return (await res.json()).name;
}

async function generate(job, seed) {
  const image = await upload(path.join(SRC, `${job.name}.png`));
  const wf = workflow({ image, text: job.text, seed, prefix: `anison/${job.name}` });
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

// 軽量版：320px・H.264。ループするものは「順再生→逆再生」でつなぎ目をなくす
function exportFx(name, n) {
  const job = JOBS.find(j => j.name === name);
  const src = path.join(OUT, `${name}_${n}.mp4`), dst = path.join(PUB, `${name}.mp4`);
  const scale = 'scale=320:320:flags=lanczos,format=yuv420p';
  const filter = job.loop ? `[0:v]split[a][b];[b]reverse,trim=start_frame=1:end_frame=${FRAMES - 1},setpts=PTS-STARTPTS[r];[a][r]concat=n=2:v=1,${scale}` : `[0:v]${scale}`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-filter_complex', filter, '-an', '-c:v', 'libx264', '-crf', '26', '-preset', 'slow', '-movflags', '+faststart', dst]);
  console.log(`書き出し ${path.relative(ROOT, dst)} ${(fs.statSync(dst).size / 1024).toFixed(0)}KB`);
}

module.exports = { workflow, FRAMES }; // tools/gen-mascot-anim.js からも使う
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--dump') { // 確認用：ワークフローを書き出すだけ
    fs.writeFileSync(args[1], JSON.stringify(workflow({ image: 'fx-intro.png', text: JOBS[0].text, seed: 1, prefix: 'anison/test' }), null, 2));
    return;
  }
  if (args[0] === '--export') {
    fs.mkdirSync(PUB, { recursive: true });
    for (const a of args.slice(1)) { const [name, n] = a.split('='); exportFx(name, n); }
    return;
  }
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
  const seeds = opt('--seeds', 2), from = opt('--from', 1);
  const names = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
  fs.mkdirSync(OUT, { recursive: true });
  for (const job of JOBS.filter(j => !names.length || names.includes(j.name))) {
    for (let s = from; s < from + seeds; s++) {
      const file = path.join(OUT, `${job.name}_${s}.mp4`);
      if (fs.existsSync(file)) continue;
      const t0 = Date.now();
      fs.writeFileSync(file, await generate(job, 9000 + s * 17));
      console.log(`ok ${job.name}_${s}.mp4 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
