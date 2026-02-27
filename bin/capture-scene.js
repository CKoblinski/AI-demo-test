#!/usr/bin/env node
/**
 * Capture an animated dialogue scene as video/GIF using Puppeteer + ffmpeg.
 *
 * Usage: node bin/capture-scene.js <html-file> [--duration=10] [--fps=15] [--width=1080] [--height=1920] [--no-gif]
 *
 * Outputs:
 *   <basename>.mp4  — H.264 video
 *   <basename>.gif  — Animated GIF (unless --no-gif)
 */

import puppeteer from 'puppeteer';
import { execSync } from 'child_process';
import { mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse args
const args = process.argv.slice(2);
const htmlFile = args.find(a => !a.startsWith('--'));
if (!htmlFile) {
  console.error('Usage: node bin/capture-scene.js <html-file> [--duration=10] [--fps=15] [--width=1080] [--height=1920] [--no-gif]');
  process.exit(1);
}

function getArg(name, defaultVal) {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : defaultVal;
}

const DURATION = parseInt(getArg('duration', '10'));
const FPS = parseInt(getArg('fps', '15'));
const WIDTH = parseInt(getArg('width', '1080'));
const HEIGHT = parseInt(getArg('height', '1920'));
const SKIP_GIF = args.includes('--no-gif');
const TOTAL_FRAMES = DURATION * FPS;

const outputDir = dirname(htmlFile);
const baseName = basename(htmlFile, '.html');
const framesDir = join(outputDir, '_capture_frames');
const mp4Path = join(outputDir, `${baseName}.mp4`);
const gifPath = join(outputDir, `${baseName}.gif`);

async function main() {
  console.log(`=== Scene Capture ===`);
  console.log(`  Source: ${htmlFile}`);
  console.log(`  Resolution: ${WIDTH}x${HEIGHT}`);
  console.log(`  Duration: ${DURATION}s @ ${FPS}fps = ${TOTAL_FRAMES} frames`);
  if (SKIP_GIF) console.log(`  GIF: skipped (--no-gif)`);
  console.log();

  // Clean up frames dir
  mkdirSync(framesDir, { recursive: true });
  for (const f of readdirSync(framesDir)) {
    unlinkSync(join(framesDir, f));
  }

  // Launch puppeteer
  console.log('  Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: [`--window-size=${WIDTH},${HEIGHT}`],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });

  // Navigate to the HTML file
  const fileUrl = `file://${htmlFile}`;
  console.log(`  Loading: ${fileUrl}`);
  await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30000 });

  // Wait for any known content selector to appear
  await Promise.race([
    page.waitForSelector('.portrait-variant', { timeout: 5000 }),
    page.waitForSelector('.action-frame', { timeout: 5000 }),
    page.waitForSelector('.seq-bg', { timeout: 5000 }),
    page.waitForSelector('#scene', { timeout: 5000 }),
  ]).catch(() => {});
  await new Promise(r => setTimeout(r, 500));

  // Capture frames
  console.log(`  Capturing ${TOTAL_FRAMES} frames...`);
  const frameInterval = 1000 / FPS;
  const startTime = Date.now();

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const framePath = join(framesDir, `frame_${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: framePath, type: 'png' });

    if (i % FPS === 0) {
      process.stdout.write(`    ${Math.floor(i / FPS)}s / ${DURATION}s\r`);
    }

    // Wait for next frame timing
    const elapsed = Date.now() - startTime;
    const targetTime = (i + 1) * frameInterval;
    const waitTime = targetTime - elapsed;
    if (waitTime > 0) {
      await new Promise(r => setTimeout(r, waitTime));
    }
  }

  const captureTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`    Captured ${TOTAL_FRAMES} frames in ${captureTime}s`);

  await browser.close();

  // Encode MP4
  console.log('\n  Encoding MP4...');
  const mp4Cmd = `ffmpeg -y -framerate ${FPS} -i "${framesDir}/frame_%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 18 -preset medium "${mp4Path}" 2>&1 | tail -3`;
  execSync(mp4Cmd, { stdio: 'pipe' });
  console.log(`    Saved: ${mp4Path}`);

  // Encode GIF (unless --no-gif)
  if (!SKIP_GIF) {
    console.log('  Encoding GIF...');
    const palettePath = join(framesDir, 'palette.png');
    const paletteCmd = `ffmpeg -y -framerate ${FPS} -i "${framesDir}/frame_%04d.png" -vf "fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" "${palettePath}" 2>&1 | tail -1`;
    execSync(paletteCmd, { stdio: 'pipe' });

    const gifCmd = `ffmpeg -y -framerate ${FPS} -i "${framesDir}/frame_%04d.png" -i "${palettePath}" -lavfi "fps=${FPS},scale=${Math.min(WIDTH, 540)}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" "${gifPath}" 2>&1 | tail -1`;
    execSync(gifCmd, { stdio: 'pipe' });
    console.log(`    Saved: ${gifPath}`);
  }

  // Clean up frames
  console.log('\n  Cleaning up frames...');
  for (const f of readdirSync(framesDir)) {
    unlinkSync(join(framesDir, f));
  }
  try { execSync(`rmdir "${framesDir}"`); } catch {}

  // File sizes
  const mp4Size = (statSync(mp4Path).size / 1024 / 1024).toFixed(1);
  console.log(`\n=== Done! ===`);
  console.log(`  MP4: ${mp4Path} (${mp4Size}MB)`);

  if (!SKIP_GIF && existsSync(gifPath)) {
    const gifSize = (statSync(gifPath).size / 1024 / 1024).toFixed(1);
    console.log(`  GIF: ${gifPath} (${gifSize}MB)`);
  }
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
