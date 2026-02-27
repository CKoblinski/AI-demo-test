#!/usr/bin/env node

/**
 * Animated Pixel Art Prototype
 *
 * Generates mouth variants from the existing portrait, then assembles
 * an animated RPG dialogue scene with:
 *   - 3 portrait frames (mouth cycling)
 *   - 2 dialogue lines (sequential typewriter)
 *   - Background fire flicker + torch glow
 *
 * Usage: node bin/prototype-animated.js
 */

import { generateMouthVariants } from '../src/pixel-art-generator.js';
import { assembleAnimatedAndSave } from '../src/assemble-scene.js';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'output', 'prototype');

mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Load existing assets ──

const portraitPath = join(OUTPUT_DIR, 'portrait.png');
const backgroundPath = join(OUTPUT_DIR, 'background.png');

if (!existsSync(portraitPath) || !existsSync(backgroundPath)) {
  console.error('Missing assets! Run `node bin/prototype-pixel.js` first to generate portrait + background.');
  process.exit(1);
}

const portraitBuffer = readFileSync(portraitPath);
const portraitBase64 = portraitBuffer.toString('base64');
const backgroundBase64 = readFileSync(backgroundPath).toString('base64');

console.log('');
console.log('=== Animated Pixel Art Prototype ===');
console.log('');
console.log(`  Base portrait: ${portraitPath} (${(portraitBuffer.length / 1024).toFixed(0)}KB)`);
console.log(`  Background: ${backgroundPath}`);
console.log('');

async function main() {
  const startTime = Date.now();

  // ── Step 1: Generate mouth variants ──
  console.log('[1/2] Generating mouth variants from base portrait...');
  console.log('  (Using reference-based generation — same character, different mouth)');
  console.log('');

  const variants = await generateMouthVariants(portraitBuffer, 'image/png', {
    saveDir: OUTPUT_DIR,
  });

  console.log('');
  console.log(`  Got ${variants.length} mouth variants`);

  // Build portrait frames array: [base (closed), slightly open, open]
  const portraitFrames = [
    { base64: portraitBase64, mimeType: 'image/png' },
    ...variants.map(v => ({ base64: v.base64, mimeType: v.mimeType })),
  ];

  // If we got fewer than 2 variants, duplicate the base for missing frames
  while (portraitFrames.length < 3) {
    console.log(`  Warning: Only got ${portraitFrames.length} frames, duplicating base for missing slot`);
    portraitFrames.push({ base64: portraitBase64, mimeType: 'image/png' });
  }

  console.log(`  Total portrait frames: ${portraitFrames.length}`);
  console.log('');

  // ── Step 2: Assemble animated scene ──
  console.log('[2/2] Assembling animated dialogue scene...');

  const outputPath = assembleAnimatedAndSave({
    portraitFrames,
    backgroundBase64,
    backgroundMimeType: 'image/png',
    characterName: 'Bixie',
    characterColor: '#e8a033',
    dialogueLines: [
      { text: "I rolled a natural twenty!", speed: 55 },
      { text: "Time to clean out this treasury...", speed: 60 },
    ],
    mouthCycleMs: 150,
    linePauseMs: 1500,
  }, join(OUTPUT_DIR, 'animated-dialogue.html'));

  // ── Summary ──
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const imageCost = variants.length * 0.039;

  console.log('');
  console.log('=== Done! ===');
  console.log(`  Mouth variants generated: ${variants.length}`);
  console.log(`  Portrait frames: ${portraitFrames.length}`);
  console.log(`  Dialogue lines: 2`);
  console.log(`  Time: ${totalTime}s`);
  console.log(`  Estimated cost: ~$${imageCost.toFixed(3)}`);
  console.log(`  Output: ${outputPath}`);
  console.log('');

  // Open in browser
  try {
    execSync(`open "${outputPath}"`);
    console.log('  Opened in browser.');
  } catch {
    console.log(`  Open manually: ${outputPath}`);
  }
}

main().catch(err => {
  console.error('');
  console.error('Prototype failed:', err.message);
  if (err.message?.includes('quota') || err.message?.includes('billing')) {
    console.error('Image generation requires the paid tier. Check: https://aistudio.google.com/plan');
  }
  process.exit(1);
});
