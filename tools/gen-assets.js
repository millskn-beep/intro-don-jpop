// デザイン用の画像を、ローカルの ComfyUI（FLUX.2 klein）でまとめて生成して public/assets/<テーマ>/ に保存する。
// 既存キャラクターやロゴは描かせない。文字は崩れるので画像には入れず、画面側で重ねる。
// 使い方: node tools/gen-assets.js [テーマ名...]   （省略で全テーマ。既にある画像は作り直さない。--force で作り直す）

const fs = require('fs');
const path = require('path');

const COMFY = 'http://127.0.0.1:8188';
const WORKFLOW = 'E:\\flux2\\workflows\\flux2_klein4b_fp8_api.json';
const OUT = path.join(__dirname, '..', 'data', 'assets-src'); // 元画像（公開しない）。optimize_assets.py で public/assets に軽量版を書き出す

const NO_TEXT = 'no text, no letters, no words, no logo, no watermark';

// テーマごとの画風と、各画像の中身
const THEMES = {
  neon: {
    style: 'glowing neon tubes, magenta and cyan, dark navy background, high contrast',
    bg: 'Wide panoramic view of an empty concert stage at night, vivid magenta and cyan neon light beams and lasers, light haze, glowing speaker towers, bokeh of crowd penlights in the dark, no people in focus, cinematic digital illustration',
    emblem: 'Neon sign emblem of a vintage stage microphone crossed with a music note inside a glowing circle, mounted on a dark brick wall, symmetrical, centered',
    podium: 'Three-step winner podium on a dark concert stage, edges glowing with magenta and cyan neon, a golden trophy cup on the top step, falling confetti, centered, front view',
    icon: subject => `Neon light icon of ${subject}, glowing cyan and magenta lines on a solid black circle, simple, minimal, centered, flat`,
  },
  studio: {
    style: 'deep royal blue and gold, dramatic spotlights, glossy, TV game show',
    bg: 'Grand TV quiz show studio set, deep royal blue and gold color scheme, dramatic spotlights shining down, circular stage floor with glowing concentric rings, dark empty audience seats, glossy reflections, no people, cinematic wide shot',
    emblem: 'Ornate golden medallion emblem with a music note in the center, deep blue enamel inlay, rays of light behind it, luxury game show style, symmetrical, centered',
    podium: 'Golden three-step winner podium under spotlights in a deep blue TV studio, a shining golden trophy cup on top, sparkles, centered, front view',
    icon: subject => `Glossy round game show button icon of ${subject}, gold rim, deep blue center, soft highlight, centered, simple`,
  },
  pop: {
    style: 'bright pastel candy colors, flat vector illustration, kawaii, cheerful',
    bg: 'Bright cheerful pastel background with floating music notes, stars, hearts and bubbles, candy colors pink mint lemon lavender, soft gradient, flat vector illustration, kawaii pattern, no characters',
    emblem: 'Cute pastel round sticker badge with a big music note and little stars, thick white outline, flat vector illustration, centered on plain light background',
    podium: 'Cute pastel three-step podium with a shiny golden trophy cup, confetti and stars, flat vector illustration, plain white background, centered',
    icon: subject => `Cute flat pastel sticker icon of ${subject}, thick white outline, rounded shapes, centered on a plain soft pink circle`,
  },
  retro: {
    style: '16-bit pixel art, limited palette purple orange teal, CRT scanlines',
    bg: 'Pixel art landscape of a retro arcade game, starry night sky with a big pixel moon, synthwave neon grid floor stretching to the horizon, CRT scanlines, limited palette purple orange teal, 16-bit style, no characters',
    emblem: 'Pixel art emblem of a cassette tape with a music note, 16-bit sprite style, bold dark outline, centered on a dark purple background',
    podium: 'Pixel art three-step podium with a golden trophy cup on top, 16-bit game style, sparkles, centered on a dark purple background',
    icon: subject => `16-bit pixel art icon of ${subject}, bold black outline, limited palette, centered on a dark purple square`,
  },
};

const ICONS = {
  fifty: 'a circle split exactly in half, the left half bright and the right half faded',
  audience: 'three simple person silhouettes raising their hands',
  phone: 'a classic telephone handset',
  replay: 'a circular rewind arrow around a music note',
  pass: 'a big question mark',
};

function jobsFor(theme) {
  const t = THEMES[theme];
  const jobs = [
    { name: 'bg', w: 1920, h: 1088, text: `${t.bg}, ${t.style}, ${NO_TEXT}` },
    { name: 'emblem', w: 1024, h: 1024, text: `${t.emblem}, ${t.style}, ${NO_TEXT}` },
    { name: 'podium', w: 1024, h: 768, text: `${t.podium}, ${t.style}, ${NO_TEXT}` },
  ];
  for (const [name, subject] of Object.entries(ICONS)) {
    jobs.push({ name: `icon-${name}`, w: 512, h: 512, text: `${t.icon(subject)}, ${t.style}, ${NO_TEXT}` });
  }
  return jobs;
}

async function generate(theme, job, seed) {
  const wf = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
  wf['4'].inputs.text = job.text;
  wf['8'].inputs.width = wf['10'].inputs.width = job.w;
  wf['8'].inputs.height = wf['10'].inputs.height = job.h;
  wf['9'].inputs.noise_seed = seed;
  wf['13'].inputs.filename_prefix = `anison/${theme}_${job.name}`;

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
    const buf = Buffer.from(await fetch(`${COMFY}/view?${q}`).then(r => r.arrayBuffer()));
    return buf;
  }
  throw new Error('タイムアウト');
}

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const themes = args.filter(a => !a.startsWith('--'));
  for (const theme of themes.length ? themes : Object.keys(THEMES)) {
    fs.mkdirSync(path.join(OUT, theme), { recursive: true });
    for (const [i, job] of jobsFor(theme).entries()) {
      const file = path.join(OUT, theme, `${job.name}.png`);
      if (fs.existsSync(file) && !force) { console.log(`skip ${theme}/${job.name}`); continue; }
      const t0 = Date.now();
      const buf = await generate(theme, job, 1000 + i * 7 + theme.length * 101);
      fs.writeFileSync(file, buf);
      console.log(`ok   ${theme}/${job.name}.png  ${(buf.length / 1024).toFixed(0)}KB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
