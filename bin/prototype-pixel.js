#!/usr/bin/env node

/**
 * Pixel Art Prototype — RPG Dialogue Scene
 *
 * Generates pixel art sprites using Nano Banana 2 (Gemini 3.1 Flash Image)
 * and assembles them into an RPG-style dialogue scene.
 *
 * Usage: node bin/prototype-pixel.js
 */

import { generateCharacterPortrait, generateSceneBackground } from '../src/pixel-art-generator.js';
import { assembleAndSave } from '../src/assemble-scene.js';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'output', 'prototype');

mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Sample Scene Data ──
const scene = {
  characterName: 'Bixie',
  characterColor: '#e8a033',
  characterDescription: 'a cunning halfling rogue with messy auburn hair, a sly grin, bright mischievous eyes, and a leather hood',
  backgroundDescription: 'dimly lit medieval tavern interior with wooden tables, mugs of ale, warm torchlight on stone walls, and a fireplace',
  backgroundMood: 'triumphant',
  dialogueText: "I rolled a natural twenty!\nTime to clean out this treasury...",
  textSpeed: 55,
};

async function main() {
  console.log('');
  console.log('=== Pixel Art Prototype ===');
  console.log('');
  console.log(`Character: ${scene.characterName}`);
  console.log(`Scene: ${scene.backgroundDescription.substring(0, 60)}...`);
  console.log('');

  const startTime = Date.now();
  let totalImages = 0;

  // ── Step 1: Generate Character Portrait ──
  console.log('[1/3] Generating character portrait...');
  const portrait = await generateCharacterPortrait(
    scene.characterName,
    scene.characterDescription,
    { savePath: join(OUTPUT_DIR, 'portrait.png') }
  );
  totalImages++;

  // Pause between API calls — new Nano Banana 2 model may rate limit aggressively
  console.log('  Pausing 15s between API calls...');
  await new Promise(r => setTimeout(r, 15000));

  // ── Step 2: Generate Background ──
  console.log('[2/3] Generating scene background...');
  const background = await generateSceneBackground(
    scene.backgroundDescription,
    scene.backgroundMood,
    { savePath: join(OUTPUT_DIR, 'background.png') }
  );
  totalImages++;

  // ── Step 3: Assemble Scene ──
  console.log('[3/3] Assembling dialogue scene...');
  const outputPath = assembleAndSave({
    portraitBase64: portrait.base64,
    portraitMimeType: portrait.mimeType,
    backgroundBase64: background.base64,
    backgroundMimeType: background.mimeType,
    characterName: scene.characterName,
    characterColor: scene.characterColor,
    dialogueText: scene.dialogueText,
    textSpeed: scene.textSpeed,
  }, join(OUTPUT_DIR, 'dialogue-scene.html'));

  // ── Summary ──
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const estimatedCost = totalImages * 0.039; // Gemini Flash Image pricing

  console.log('');
  console.log('=== Done! ===');
  console.log(`  Images generated: ${totalImages}`);
  console.log(`  Time: ${totalTime}s`);
  console.log(`  Estimated cost: ~$${estimatedCost.toFixed(3)}`);
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

  if (err.message?.includes('API key') || err.message?.includes('apiKey')) {
    console.error('');
    console.error('Set GOOGLE_AI_API_KEY in your .env file.');
    console.error('Get a key at: https://aistudio.google.com/apikey');
  }

  if (err.message?.includes('billing') || err.message?.includes('quota')) {
    console.error('');
    console.error('Image generation requires the paid tier.');
    console.error('Check billing at: https://aistudio.google.com/plan');
  }

  process.exit(1);
});
