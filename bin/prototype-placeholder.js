#!/usr/bin/env node

/**
 * Placeholder prototype — shows the dialogue scene template
 * using generated placeholder pixel art (solid color rectangles).
 * Run this to preview the layout without needing API credits.
 *
 * Usage: node bin/prototype-placeholder.js
 */

import { assembleAndSave } from '../src/assemble-scene.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'output', 'prototype');

mkdirSync(OUTPUT_DIR, { recursive: true });

// Create simple placeholder images as base64 PNGs
// Since we can't use canvas without extra deps, we'll create tiny valid PNGs

// A minimal 1x1 PNG generator (yes, really — we'll use CSS to style them)
function createPlaceholderPng(r, g, b) {
  // Minimal valid PNG: 1x1 pixel
  // PNG signature + IHDR + IDAT + IEND
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk: 1x1, 8-bit RGB
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);   // width
  ihdrData.writeUInt32BE(1, 4);   // height
  ihdrData[8] = 8;                // bit depth
  ihdrData[9] = 2;                // color type (RGB)
  const ihdr = makeChunk('IHDR', ihdrData);

  // IDAT chunk: deflate-compressed row (filter byte + RGB)
  // Raw data: [0x00 (no filter), R, G, B]
  // Wrap in zlib: 0x78, 0x01 (deflate), then raw block
  const rawRow = Buffer.from([0, r, g, b]);
  const deflated = deflateRawBlock(rawRow);
  const idat = makeChunk('IDAT', deflated);

  // IEND chunk
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function deflateRawBlock(data) {
  // Minimal zlib wrapper: header + raw deflate block + adler32
  const header = Buffer.from([0x78, 0x01]); // zlib header (deflate, no dict)
  // BFINAL=1, BTYPE=00 (no compression)
  const blockHeader = Buffer.from([0x01]);
  const len = Buffer.alloc(2);
  len.writeUInt16LE(data.length, 0);
  const nlen = Buffer.alloc(2);
  nlen.writeUInt16LE(data.length ^ 0xFFFF, 0);
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(data), 0);
  return Buffer.concat([header, blockHeader, len, nlen, data, adler]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Create placeholder images
const portraitPng = createPlaceholderPng(180, 120, 60);   // warm brown
const bgPng = createPlaceholderPng(40, 30, 50);           // dark purple

const portraitBase64 = portraitPng.toString('base64');
const bgBase64 = bgPng.toString('base64');

// Save PNGs for reference
writeFileSync(join(OUTPUT_DIR, 'portrait-placeholder.png'), portraitPng);
writeFileSync(join(OUTPUT_DIR, 'background-placeholder.png'), bgPng);

console.log('');
console.log('=== Placeholder Prototype ===');
console.log('');
console.log('Using solid color placeholders (1x1 px, will stretch via CSS)');
console.log('This shows the LAYOUT and ANIMATION — swap real pixel art later.');
console.log('');

// Assemble the scene
const outputPath = assembleAndSave({
  portraitBase64,
  portraitMimeType: 'image/png',
  backgroundBase64: bgBase64,
  backgroundMimeType: 'image/png',
  characterName: 'Bixie',
  characterColor: '#e8a033',
  dialogueText: "I rolled a natural twenty!\nTime to clean out this treasury...",
  textSpeed: 55,
}, join(OUTPUT_DIR, 'dialogue-scene-placeholder.html'));

console.log('');
console.log('Done! Opening in browser...');

try {
  execSync(`open "${outputPath}"`);
} catch {
  console.log(`Open manually: ${outputPath}`);
}
