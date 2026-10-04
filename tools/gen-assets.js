// デザイン用の画像を、ローカルの ComfyUI（FLUX.2 klein）で生成して data/assets-src/glass/ に保存する。
// 既存キャラクターやロゴは描かせない。文字は崩れるので画像には入れず、画面側で重ねる。
// 1つの画像につき複数の seed で候補を作り（<名前>_<seed>.png）、見比べて良いものを <名前>.png として採用する。
// 使い方: node tools/gen-assets.js [名前...] [--seeds 4] [--from 1]
//   名前を省くと全部。--seeds は候補の数、--from は seed の開始番号（作り直すときにずらす）

const fs = require('fs');
const path = require('path');

const COMFY = 'http://127.0.0.1:8188';
const WORKFLOW = 'E:\\flux2\\workflows\\flux2_klein4b_fp8_api.json';
const OUT = path.join(__dirname, '..', 'data', 'assets-src', 'glass'); // 元画像（公開しない）。optimize_assets.py で public/assets/glass に軽量版を書き出す

const NO_TEXT = 'no text, no letters, no words, no logo, no watermark';
const STYLE = 'sleek, stylish, premium, futuristic, iridescent glass and chrome, soft cyan magenta violet light, high quality';
// アイコンは黒背景で作り、画面では mix-blend-mode: screen で黒を消して光だけ重ねる
const ICON = subject => `Glowing white line icon of ${subject}, thin elegant strokes, soft iridescent cyan and magenta glow, centered, minimal, flat, on a pure black background`;
// アバターは実在の人物ではなく、動物などのマスコット
const AVATAR = animal => `Stylish minimal mascot avatar of a cute ${animal} head, made of glossy iridescent glass, simple geometric shapes, soft rim light, centered, front view, on a dark navy gradient background, 3D render`;

const ANIMALS = ['fox', 'cat with big cute eyes, small nose and whiskers', 'rabbit', 'owl', 'penguin', 'bear', 'panda', 'hamster with round cheeks', 'baby dragon with two small horns and big eyes', 'round robot', 'shiba inu dog', 'frog'];

const JOBS = [
  { name: 'logo', w: 1024, h: 1024, text: `Minimal logo mark: an abstract stylized music note fused with a play button and circular sound waves, made of glowing iridescent glass and chrome, symmetrical, centered on a pure black background, ${STYLE}` },
  { name: 'bg', w: 1920, h: 1088, text: `Abstract dark background of flowing soft light ribbons and blurred bokeh, iridescent cyan magenta violet gradients, glass refraction, deep navy and black, calm, cinematic, wide, ${STYLE}` },
  { name: 'podium', w: 1024, h: 768, text: `Three-step winner podium made of frosted glass with softly glowing edges, a polished chrome trophy cup on the top step, dark background with soft iridescent light, centered, front view, ${STYLE}` },
  { name: 'icon-crown', w: 512, h: 512, text: ICON('a royal crown') },
  { name: 'icon-note', w: 512, h: 512, text: ICON('a music note') },
  { name: 'icon-ok', w: 512, h: 512, text: ICON('a perfect circle ring') },
  { name: 'icon-ng', w: 512, h: 512, text: ICON('a bold X cross mark') },
  { name: 'icon-skip', w: 512, h: 512, text: ICON('a fast forward symbol, two right-pointing triangles') },
  ...ANIMALS.map((a, i) => ({ name: `avatar-${i + 1}`, w: 512, h: 512, text: AVATAR(a) })),
].map(j => ({ ...j, text: `${j.text}, ${NO_TEXT}` }));

async function generate(job, seed) {
  const wf = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
  wf['4'].inputs.text = job.text;
  wf['8'].inputs.width = wf['10'].inputs.width = job.w;
  wf['8'].inputs.height = wf['10'].inputs.height = job.h;
  wf['9'].inputs.noise_seed = seed;
  wf['13'].inputs.filename_prefix = `anison/glass_${job.name}`;

  const res = await fetch(`${COMFY}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf }) });
  if (!res.ok) throw new Error(`投入失敗 ${res.status}: ${await res.text()}`);
  const { prompt_id } = await res.json();

  for (let i = 0; i < 720; i++) {
    await new Promise(r => setTimeout(r, 500));
    const h = await fetch(`${COMFY}/history/${prompt_id}`).then(r => r.json());
    const entry = h[prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new Error('生成エラー: ' + JSON.stringify(entry.status.messages).slice(0, 300));
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
  const seeds = opt('--seeds', 4), from = opt('--from', 1);
  const names = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
  fs.mkdirSync(OUT, { recursive: true });
  for (const job of JOBS.filter(j => !names.length || names.includes(j.name))) {
    for (let s = from; s < from + seeds; s++) {
      const file = path.join(OUT, `${job.name}_${s}.png`);
      if (fs.existsSync(file)) continue;
      const t0 = Date.now();
      fs.writeFileSync(file, await generate(job, 7000 + s * 13));
      console.log(`ok ${job.name}_${s}.png ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
