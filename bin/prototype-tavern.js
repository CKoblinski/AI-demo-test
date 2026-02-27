#!/usr/bin/env node
/**
 * Prototype: Animated Tavern Scene — v2 Character-Focused
 *
 * Three simultaneous actions across 5 frames:
 *   1. Two characters clinking mugs (knight + blue-hat at main table)
 *   2. Bartender cleaning a mug with a rag
 *   3. Fire building and ebbing
 *
 * Bounce pattern: 0→1→2→3→4→3→2→1→ repeat
 * Budget target: ~$0.16 (4 frames × ~$0.04)
 */

import { GoogleGenAI } from '@google/genai';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'output', 'tavern-v2');

// Load .env
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

const STYLE_PREFIX = '16-bit pixel art, RPG game style inspired by Octopath Traveler and Final Fantasy VI, retro gaming aesthetic with modern lighting and detail, ';

const SCENE_ANCHOR = `This is the pixel art tavern scene "The Golden Flagon". It shows a warm stone-walled tavern interior with a large fireplace in the bottom-left, a main center table with adventurers eating and drinking, a bar counter in the background with a barkeeper, torches and candles throughout, wooden floors, and "THE GOLDEN FLAGON" sign at the top.

Keep the EXACT same composition, camera angle, art style, colors, and all background characters who are NOT described below. Every character, table, wall, shelf, and decoration must remain in the same position. The ONLY changes are these three subtle actions happening simultaneously:`;

// Frame definitions — three concurrent actions per frame
const FRAME_DEFS = [
  {
    label: 'mug-lift',
    instruction: `
1) MUG RAISE BEGINS: The silver-armored knight on the left side of the main center table has picked up their mug — their right hand grips the handle and the mug is just lifted off the table surface. The character in the blue pointed hat on the right side of the same table has also picked up their mug in the same way.

2) BARTENDER CLEANING: The barkeeper standing behind the bar counter in the background is holding a mug at chest level. A small cloth rag has appeared in their other hand from below the counter. The rag hand is touching the rim of the mug, beginning to clean it.

3) FIRE GROWS: The fireplace flames in the bottom-left are slightly taller and more intense than the base image. The warm orange glow extends a bit further across the wooden floor.

Everything else in the scene — all other characters, furniture, torches, candles, walls, signs — remains exactly identical to the reference image.`,
  },
  {
    label: 'mugs-rising',
    instruction: `
1) MUGS RISING: The silver-armored knight on the left side of the main center table holds their mug raised to chest height, arm extending toward the center of the table. The character in the blue pointed hat on the right side of the same table mirrors this — their mug also raised to chest height, extending toward the center of the table. The two mugs are approaching each other over the table.

2) BARTENDER CLEANING: The barkeeper behind the bar counter is wiping the inside of the mug with the rag. Their wrist has rotated slightly as they clean the interior of the mug. Hands remain at chest level.

3) FIRE BUILDING: The fireplace flames in the bottom-left are taller and brighter. Warm orange-golden light illuminates more of the stone walls and the nearby characters more brightly.

Everything else in the scene remains exactly identical to the reference image.`,
  },
  {
    label: 'the-clink',
    instruction: `
1) THE CLINK: The silver-armored knight on the left side of the main center table and the character in the blue pointed hat on the right side are clinking their mugs together over the center of the table! Both mugs are extended out and touching/meeting in the middle above the table. This is the celebratory toast moment.

2) BARTENDER CLEANING: The barkeeper behind the bar counter is wiping the opposite side of the mug with the rag. Their hands have shifted slightly in position as they work the rag around the mug.

3) FIRE AT PEAK: The fireplace flames are at their tallest and brightest — blazing with tall flames reaching up. The entire room is bathed in rich warm amber-golden light. This is the warmest, brightest moment.

Everything else in the scene remains exactly identical to the reference image.`,
  },
  {
    label: 'post-clink',
    instruction: `
1) POST-CLINK: The silver-armored knight on the left side of the main center table is pulling their mug back and tilting it slightly as if about to take a drink after the toast. The character in the blue pointed hat on the right side is doing the same — mug pulled back, tilted to drink.

2) BARTENDER INSPECTS: The barkeeper behind the bar counter holds the clean mug up slightly, inspecting it. The rag hand has lowered back toward the counter. Satisfied with the clean mug.

3) FIRE EBBING: The fireplace flames are slightly shorter and less intense. Cooler shadows creep in from the corners and ceiling. The room feels slightly more muted and intimate.

Everything else in the scene remains exactly identical to the reference image.`,
  },
];

async function generateVariantFrame(ai, baseBuffer, baseMime, frameDef, savePath) {
  const baseB64 = baseBuffer.toString('base64');
  const prompt = STYLE_PREFIX + SCENE_ANCHOR + frameDef.instruction;

  const startTime = Date.now();
  let response;
  const maxRetries = 2;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-image-preview',
        contents: [
          {
            parts: [
              { inlineData: { data: baseB64, mimeType: baseMime } },
              { text: prompt },
            ],
          },
        ],
        config: {
          responseModalities: ['image', 'text'],
        },
      });
      break;
    } catch (err) {
      console.error(`    API error: ${(err.message || '').substring(0, 200)}`);
      if (attempt < maxRetries) {
        const wait = 15 * attempt;
        console.log(`    Retrying in ${wait}s (attempt ${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, wait * 1000));
      } else {
        throw err;
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const parts = response.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData);

  if (!imagePart) {
    const textPart = parts.find(p => p.text);
    throw new Error(`No image returned: ${textPart?.text || 'unknown reason'}`);
  }

  const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
  const mime = imagePart.inlineData.mimeType || 'image/png';

  writeFileSync(savePath, buffer);
  console.log(`    Saved: ${savePath} (${durationMs}ms, ${(buffer.length / 1024).toFixed(0)}KB)`);

  return { buffer, base64: imagePart.inlineData.data, mimeType: mime, durationMs };
}

function buildAnimatedHTML(frames, frameMs = 200) {
  // frames = array of { base64, mimeType } in display order
  // Bounce sequence: 0,1,2,3,4,3,2,1, repeat
  const bounceSeq = [];
  for (let i = 0; i < frames.length; i++) bounceSeq.push(i);
  for (let i = frames.length - 2; i > 0; i--) bounceSeq.push(i);

  const totalFrames = bounceSeq.length;
  const cycleDuration = totalFrames * frameMs;

  const frameImgs = frames.map((f, i) =>
    `<img class="tavern-frame" id="frame-${i}" src="data:${f.mimeType};base64,${f.base64}" alt="Frame ${i}" />`
  ).join('\n      ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>The Golden Flagon — Animated</title>
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
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      image-rendering: pixelated;
      opacity: 0;
      transition: none;
    }

    .tavern-frame.active {
      opacity: 1;
    }

    /* Vignette only — no CSS glow overlay */
    .vignette {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      background: radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.3) 100%);
      pointer-events: none;
    }

    .badge {
      position: fixed;
      top: 10px; left: 10px;
      color: rgba(255,200,100,0.5);
      font: bold 14px monospace;
      pointer-events: none;
    }

    .info {
      position: fixed;
      bottom: 10px;
      left: 10px;
      color: rgba(255,200,100,0.7);
      font: 12px monospace;
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
  <div class="badge">Gemini v2 — Characters</div>
  <div class="info">
    <span id="frame-label">Frame 0</span> |
    ${(1000 / frameMs).toFixed(0)} fps |
    Bounce cycle: ${(cycleDuration / 1000).toFixed(1)}s
  </div>

  <script>
    const FRAME_MS = ${frameMs};
    const FRAME_COUNT = ${frames.length};
    // Bounce sequence: 0,1,2,3,4,3,2,1,...
    const BOUNCE_SEQ = ${JSON.stringify(bounceSeq)};

    const frameEls = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      frameEls.push(document.getElementById('frame-' + i));
    }
    const frameLabel = document.getElementById('frame-label');

    let seqIdx = 0;

    function showFrame(idx) {
      for (let i = 0; i < FRAME_COUNT; i++) {
        frameEls[i].classList.toggle('active', i === idx);
      }
    }

    // Start on frame 0
    showFrame(0);

    setInterval(() => {
      seqIdx = (seqIdx + 1) % BOUNCE_SEQ.length;
      const frameIdx = BOUNCE_SEQ[seqIdx];
      showFrame(frameIdx);
      frameLabel.textContent = 'Frame ' + frameIdx;
    }, FRAME_MS);
  </script>
</body>
</html>`;
}

// ─── Main ───

async function main() {
  console.log('=== Animated Tavern: The Golden Flagon ===\n');

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Load the existing background as our base/reference frame
  const basePath = join(ROOT, 'output', 'prototype', 'background.png');
  if (!existsSync(basePath)) {
    console.error('ERROR: No base background found at', basePath);
    console.error('Run prototype-pixel.js first to generate it.');
    process.exit(1);
  }

  const baseBuffer = readFileSync(basePath);
  const baseMime = 'image/png';
  console.log(`  Base image: ${basePath} (${(baseBuffer.length / 1024).toFixed(0)}KB)\n`);

  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY });
  const startTotal = Date.now();

  // Frame 0 = original
  const allFrames = [{
    base64: baseBuffer.toString('base64'),
    mimeType: baseMime,
    label: 'base',
  }];

  // Generate variant frames
  console.log(`  Generating ${FRAME_DEFS.length} variant frames...\n`);

  for (let i = 0; i < FRAME_DEFS.length; i++) {
    const def = FRAME_DEFS[i];
    console.log(`  [${i + 1}/${FRAME_DEFS.length}] ${def.label}`);

    // Pause between API calls to avoid socket errors
    if (i > 0) {
      console.log('    Pausing 15s between API calls...');
      await new Promise(r => setTimeout(r, 15000));
    }

    const savePath = join(OUTPUT_DIR, `frame-${i + 1}-${def.label}.png`);
    const result = await generateVariantFrame(ai, baseBuffer, baseMime, def, savePath);

    allFrames.push({
      base64: result.base64,
      mimeType: result.mimeType,
      label: def.label,
    });
  }

  const totalDuration = ((Date.now() - startTotal) / 1000).toFixed(1);
  const estCost = allFrames.length * 0.04; // ~$0.04 per generation, frame 0 is free

  console.log(`\n  All frames generated!`);
  console.log(`  Total: ${allFrames.length} frames, ${totalDuration}s, ~$${(estCost - 0.04).toFixed(2)}`);

  // Copy base frame to output dir for reference
  writeFileSync(join(OUTPUT_DIR, 'frame-0-base.png'), baseBuffer);

  // Build animated HTML with bounce loop
  console.log('\n  Assembling bounce-loop animation...');
  const html = buildAnimatedHTML(allFrames, 200); // 200ms per frame = 5fps retro feel
  const htmlPath = join(OUTPUT_DIR, 'tavern-animated.html');
  writeFileSync(htmlPath, html);
  console.log(`  Saved: ${htmlPath} (${(html.length / 1024 / 1024).toFixed(1)}MB)`);

  console.log(`\n=== Done! ===`);
  console.log(`  Frames: ${allFrames.length} (1 base + ${FRAME_DEFS.length} variants)`);
  console.log(`  Bounce sequence: ${allFrames.length + allFrames.length - 2} steps (${(((allFrames.length * 2 - 2) * 200) / 1000).toFixed(1)}s cycle)`);
  console.log(`  Time: ${totalDuration}s`);
  console.log(`  Estimated cost: ~$${(estCost - 0.04).toFixed(2)}`);
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
