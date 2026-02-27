#!/usr/bin/env node
/**
 * Prototype: Animated Tavern Scene via PixelLab API
 *
 * Same concept as prototype-tavern.js but using PixelLab's pixel art API.
 * Generates a tavern scene + 4 lighting variants using init_image approach,
 * then assembles into a bounce-loop animation.
 *
 * PixelLab produces TRUE pixel art (grid-snapped) at smaller resolutions
 * that upscale crisply with image-rendering: pixelated.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'output', 'tavern-pixellab');

// Load .env
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

const API_KEY = process.env.PIXELLAB_API_KEY;
if (!API_KEY) {
  console.error('ERROR: PIXELLAB_API_KEY not found in .env');
  process.exit(1);
}

const BASE_URL = 'https://api.pixellab.ai/v1';

// PixelLab true pixel art dimensions — will be upscaled in the viewer
// 200x356 ≈ 9:16 aspect ratio, well within 400x400 limit
const IMG_WIDTH = 200;
const IMG_HEIGHT = 356;

async function pixelLabRequest(endpoint, body) {
  const url = `${BASE_URL}${endpoint}`;
  const startTime = Date.now();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const durationMs = Date.now() - startTime;

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`PixelLab ${endpoint} failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return { data, durationMs };
}

async function checkBalance() {
  const response = await fetch(`${BASE_URL}/balance`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  if (!response.ok) throw new Error(`Balance check failed: ${response.status}`);
  return response.json();
}

/**
 * Convert a data URI (data:image/png;base64,...) to just the base64 portion,
 * or if it's already raw base64, add the data URI prefix.
 */
function toDataUri(base64OrUri, mime = 'image/png') {
  if (base64OrUri.startsWith('data:')) return base64OrUri;
  return `data:${mime};base64,${base64OrUri}`;
}

function fromDataUri(dataUri) {
  const match = dataUri.match(/^data:[^;]+;base64,(.+)$/);
  return match ? match[1] : dataUri;
}

function saveImage(dataUri, path) {
  const raw = fromDataUri(dataUri);
  const buffer = Buffer.from(raw, 'base64');
  writeFileSync(path, buffer);
  return buffer;
}

// Scene description — matching the Gemini tavern concept
const BASE_DESCRIPTION = 'A warm fantasy tavern interior called The Golden Flagon, stone walls, large fireplace with blazing fire on the left, wooden tables with adventurers eating and drinking, candles and torches on walls, a bar counter in the background with barkeeper, wooden plank floor, cozy warm atmosphere, multiple fantasy RPG characters seated around tables, mugs of ale, detailed pixel art environment';

// Variant descriptions — same fire-focused changes as Gemini test
const FRAME_DEFS = [
  {
    label: 'fire-building',
    description: BASE_DESCRIPTION + ', the fireplace flames are slightly taller and more intense, warm orange-golden light extends further across the wooden floor, bright warm atmosphere',
    strength: 200,  // moderate influence from init image
  },
  {
    label: 'fire-peak',
    description: BASE_DESCRIPTION + ', the fireplace is blazing at full intensity with tall bright flames, entire room bathed in rich warm amber-golden light, strongest warm highlights on all surfaces, dramatic warm fire shadows on stone walls',
    strength: 250,
  },
  {
    label: 'fire-shifting',
    description: BASE_DESCRIPTION + ', the fireplace flames shifted slightly to the right as if caught by a draft, dynamic lighting with shifted shadows, visible embers and sparks near the hearth, fire still bright but light pattern shifted',
    strength: 200,
  },
  {
    label: 'fire-ebbing',
    description: BASE_DESCRIPTION + ', the fireplace has dimmed with shorter less intense flames, cooler shadows in corners and ceiling, more intimate muted atmosphere, candles and torches relatively brighter, increased contrast between warm firelit areas and cool shadows',
    strength: 200,
  },
];

function buildAnimatedHTML(frames, frameMs = 200) {
  // Bounce sequence: 0,1,2,3,4,3,2,1, repeat
  const bounceSeq = [];
  for (let i = 0; i < frames.length; i++) bounceSeq.push(i);
  for (let i = frames.length - 2; i > 0; i--) bounceSeq.push(i);

  const cycleDuration = bounceSeq.length * frameMs;

  const frameImgs = frames.map((f, i) =>
    `<img class="tavern-frame" id="frame-${i}" src="${f.dataUri}" alt="Frame ${i}: ${f.label}" />`
  ).join('\n      ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>The Golden Flagon — PixelLab Animated</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #0a0806; overflow: hidden; }

    .scene {
      position: relative;
      width: 100vw;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .frame-stack {
      position: relative;
      height: 100vh;
      aspect-ratio: 9/16;
      max-width: 100vw;
    }

    .tavern-frame {
      position: absolute;
      top: 0; left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      /* TRUE pixel art — crisp upscaling */
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      opacity: 0;
      transition: none;
    }

    .tavern-frame.active { opacity: 1; }

    /* Minimal vignette — no extra glow overlay per user feedback */
    .vignette {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      background: radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.3) 100%);
      pointer-events: none;
    }

    .info {
      position: fixed;
      bottom: 10px; left: 10px;
      color: rgba(255,200,100,0.7);
      font: 12px monospace;
      pointer-events: none;
    }

    .badge {
      position: fixed;
      top: 10px; left: 10px;
      color: rgba(255,200,100,0.5);
      font: bold 14px monospace;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div class="scene">
    <div class="frame-stack">
      ${frameImgs}
      <div class="vignette"></div>
    </div>
  </div>
  <div class="badge">PixelLab</div>
  <div class="info">
    <span id="frame-label">Frame 0</span> |
    ${(1000 / frameMs).toFixed(0)} fps |
    Bounce cycle: ${(cycleDuration / 1000).toFixed(1)}s |
    ${IMG_WIDTH}x${IMG_HEIGHT} upscaled
  </div>

  <script>
    const BOUNCE_SEQ = ${JSON.stringify(bounceSeq)};
    const FRAME_COUNT = ${frames.length};
    const FRAME_MS = ${frameMs};

    const frameEls = [];
    for (let i = 0; i < FRAME_COUNT; i++) frameEls.push(document.getElementById('frame-' + i));
    const frameLabel = document.getElementById('frame-label');

    let seqIdx = 0;
    frameEls[0].classList.add('active');

    setInterval(() => {
      seqIdx = (seqIdx + 1) % BOUNCE_SEQ.length;
      const idx = BOUNCE_SEQ[seqIdx];
      for (let i = 0; i < FRAME_COUNT; i++) frameEls[i].classList.toggle('active', i === idx);
      frameLabel.textContent = 'Frame ' + idx;
    }, FRAME_MS);
  </script>
</body>
</html>`;
}

// ─── Main ───

async function main() {
  console.log('=== Animated Tavern: PixelLab Edition ===\n');

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Check balance
  const balance = await checkBalance();
  console.log(`  PixelLab balance: $${balance.usd.toFixed(4)}\n`);

  const startTotal = Date.now();
  let totalCost = 0;

  // Step 1: Generate base tavern scene
  console.log(`  [1/${FRAME_DEFS.length + 1}] Generating base tavern scene (${IMG_WIDTH}x${IMG_HEIGHT})...`);

  const baseResult = await pixelLabRequest('/generate-image-pixflux', {
    description: BASE_DESCRIPTION,
    image_size: { width: IMG_WIDTH, height: IMG_HEIGHT },
    text_guidance_scale: 10,
    shading: 'detailed shading',
    detail: 'highly detailed',
    outline: 'selective outline',
  });

  const baseDataUri = baseResult.data.image.base64;
  const baseCost = baseResult.data.usage.usd;
  totalCost += baseCost;
  saveImage(baseDataUri, join(OUTPUT_DIR, 'frame-0-base.png'));
  console.log(`    Done (${baseResult.durationMs}ms, $${baseCost.toFixed(4)})`);

  const allFrames = [{ dataUri: baseDataUri, label: 'base' }];

  // Step 2: Generate variants using init_image
  for (let i = 0; i < FRAME_DEFS.length; i++) {
    const def = FRAME_DEFS[i];
    console.log(`  [${i + 2}/${FRAME_DEFS.length + 1}] ${def.label}...`);

    // Brief pause between calls
    if (i > 0) {
      await new Promise(r => setTimeout(r, 2000));
    }

    const result = await pixelLabRequest('/generate-image-pixflux', {
      description: def.description,
      image_size: { width: IMG_WIDTH, height: IMG_HEIGHT },
      text_guidance_scale: 8,
      shading: 'detailed shading',
      detail: 'highly detailed',
      outline: 'selective outline',
      init_image: { type: 'base64', base64: baseDataUri },
      init_image_strength: def.strength,
    });

    const cost = result.data.usage.usd;
    totalCost += cost;
    const dataUri = result.data.image.base64;
    saveImage(dataUri, join(OUTPUT_DIR, `frame-${i + 1}-${def.label}.png`));
    console.log(`    Done (${result.durationMs}ms, $${cost.toFixed(4)})`);

    allFrames.push({ dataUri, label: def.label });
  }

  const totalDuration = ((Date.now() - startTotal) / 1000).toFixed(1);

  console.log(`\n  All frames generated!`);
  console.log(`  Total: ${allFrames.length} frames, ${totalDuration}s, $${totalCost.toFixed(4)}`);

  // Build animated HTML
  console.log('\n  Assembling bounce-loop animation...');
  const html = buildAnimatedHTML(allFrames, 200);
  const htmlPath = join(OUTPUT_DIR, 'tavern-pixellab.html');
  writeFileSync(htmlPath, html);
  console.log(`  Saved: ${htmlPath}`);

  // Check remaining balance
  const finalBalance = await checkBalance();

  console.log(`\n=== Done! ===`);
  console.log(`  Frames: ${allFrames.length} (1 base + ${FRAME_DEFS.length} variants)`);
  console.log(`  Resolution: ${IMG_WIDTH}x${IMG_HEIGHT} (true pixel art, upscaled in viewer)`);
  console.log(`  Time: ${totalDuration}s`);
  console.log(`  Cost: $${totalCost.toFixed(4)}`);
  console.log(`  Remaining balance: $${finalBalance.usd.toFixed(4)}`);
  console.log(`  Output: ${htmlPath}\n`);

  // Open in browser
  try {
    execSync(`open "${htmlPath}"`);
    console.log('  Opened in browser.');
  } catch {
    console.log(`  Open manually: ${htmlPath}`);
  }
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
