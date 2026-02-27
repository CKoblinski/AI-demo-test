#!/usr/bin/env node
/**
 * Prototype: Bixie Dialogue Scene — "Death is Easy"
 *
 * Generates:
 *   1. Bixie portrait (close-up face)
 *   2. Two mouth variants from the portrait
 *   3. Dark moody background (campfire/tent at night)
 *   4. Assembled animated dialogue scene with real Session 114 dialogue
 *
 * Dialogue: "Death is an easy way out. Embarrassment is a little more interesting."
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'output', 'bixie-scene');

// Load .env
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

// Import our generators
import {
  generateCharacterPortrait,
  generateMouthVariants,
  generateSceneBackground,
} from '../src/pixel-art-generator.js';
import { assembleAnimatedDialogueScene } from '../src/assemble-scene.js';

async function main() {
  console.log('=== Bixie Dialogue Scene: "Death is Easy" ===\n');
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const startTotal = Date.now();

  // ─── Step 1: Generate Bixie's portrait ───
  console.log('[1/3] Generating Bixie portrait...');
  const portrait = await generateCharacterPortrait(
    'Bixie',
    'a short blonde wood elf rogue woman with fair white skin, pointed elf ears, sharp clever eyes with a knowing smirk, short blonde hair, wearing a fantasy military outfit similar to Attack on Titan Survey Corps with leather straps and buckles, a brown wool cloak draped over one shoulder, a small crossbow visible on her back, dramatic candlelight from below casting shadows on her face, confident and dangerous expression',
    { savePath: join(OUTPUT_DIR, 'portrait.png') }
  );
  console.log(`  Portrait: ${(portrait.buffer.length / 1024).toFixed(0)}KB\n`);

  // ─── Step 2: Generate mouth variants ───
  console.log('[2/3] Generating mouth variants...');
  const variants = await generateMouthVariants(
    portrait.buffer,
    portrait.mimeType,
    { saveDir: OUTPUT_DIR }
  );
  console.log(`  Got ${variants.length} mouth variants\n`);

  // Build portrait frames array: [closed, slightly-open, open]
  const portraitFrames = [
    { base64: portrait.base64, mimeType: portrait.mimeType },
  ];
  for (const v of variants) {
    portraitFrames.push({ base64: v.base64, mimeType: v.mimeType });
  }
  // If we got fewer than 2 variants, duplicate the last one
  while (portraitFrames.length < 3) {
    portraitFrames.push(portraitFrames[portraitFrames.length - 1]);
  }
  console.log(`  Total portrait frames: ${portraitFrames.length}\n`);

  // ─── Step 3: Generate background ───
  console.log('[3/3] Generating background...');
  // Pause before next API call
  console.log('  Pausing 15s between API calls...');
  await new Promise(r => setTimeout(r, 15000));

  const bg = await generateSceneBackground(
    'a dark military camp at night, canvas tents in the background, a small campfire casting warm flickering light, scattered weapons and supply crates, night sky with stars visible, moody and tense atmosphere, a rogue is about to do something dangerous',
    'dark',
    { savePath: join(OUTPUT_DIR, 'background.png') }
  );
  console.log(`  Background: ${(bg.buffer.length / 1024).toFixed(0)}KB\n`);

  // ─── Assemble the scene ───
  console.log('Assembling animated dialogue scene...');

  const html = assembleAnimatedDialogueScene({
    portraitFrames,
    backgroundBase64: bg.base64,
    backgroundMimeType: bg.mimeType,
    characterName: 'Bixie',
    characterColor: '#d4a853',  // warm gold for a rogue
    sceneTitle: 'Session 114 — Death is Easy',
    dialogueLines: [
      { text: 'Death is an easy way out.', speed: 60 },
      { text: 'Embarrassment is a little more interesting.', speed: 55 },
    ],
    mouthCycleMs: 150,
    linePauseMs: 1500,
  });

  const htmlPath = join(OUTPUT_DIR, 'bixie-dialogue.html');
  writeFileSync(htmlPath, html);
  console.log(`  Saved: ${htmlPath} (${(html.length / 1024 / 1024).toFixed(1)}MB)`);

  const totalDuration = ((Date.now() - startTotal) / 1000).toFixed(1);
  // 1 portrait + 2 variants + 1 background = 4 API calls
  const estCost = 4 * 0.04;

  console.log(`\n=== Done! ===`);
  console.log(`  Portrait frames: ${portraitFrames.length}`);
  console.log(`  Dialogue lines: 2`);
  console.log(`  Time: ${totalDuration}s`);
  console.log(`  Estimated cost: ~$${estCost.toFixed(2)}`);
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
