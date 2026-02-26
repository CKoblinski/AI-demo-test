#!/usr/bin/env node

import { exportAnimation } from '../src/export-animation.js';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve, basename, dirname } from 'path';

const args = process.argv.slice(2);

// ── Parse flags ──
const flags = {};
const positional = [];
for (const a of args) {
  if (a.startsWith('--')) {
    const [key, val] = a.slice(2).split('=');
    flags[key] = val === undefined ? true : val;
  } else {
    positional.push(a);
  }
}

const usage = `
Usage: node bin/export.js <target> [options]

  <target> can be:
    - Path to an animation.html file
    - Path to a clip folder (containing animation.html)
    - Path to a session folder (exports all clip_* folders)

  Options:
    --fps=N          Frames per second (default: 5)
    --width=N        Viewport width (default: 1080)
    --height=N       Viewport height (default: 1920)
    --keep-frames    Keep individual PNG frames
    --webm           Export WebM with alpha (default: on)
    --no-webm        Skip WebM export
    --mp4            Export MP4 on black (default: on)
    --no-mp4         Skip MP4 export
    --mov            Export ProRes 4444 MOV (slower, huge files)
    --no-mov         Skip MOV export (default)

  Examples:
    node bin/export.js output/session_unknown/clip_01_lex_nat20_insight/
    node bin/export.js output/session_unknown/   (exports all clips)
    node bin/export.js my-animation.html --fps=8 --keep-frames
`;

if (positional.length === 0) {
  console.error(usage);
  process.exit(1);
}

const target = resolve(positional[0]);

const opts = {
  fps: parseInt(flags.fps) || 5,
  width: parseInt(flags.width) || 1080,
  height: parseInt(flags.height) || 1920,
  keepFrames: !!flags['keep-frames'],
  webm: flags['no-webm'] ? false : true,
  mp4: flags['no-mp4'] ? false : true,
  mov: !!flags.mov && !flags['no-mov'],
};

// ── Discover what to export ──
async function run() {
  const jobs = [];

  if (target.endsWith('.html') && existsSync(target)) {
    // Single HTML file
    const outDir = dirname(target);
    jobs.push({ html: target, outDir });
  } else if (existsSync(join(target, 'animation.html'))) {
    // Clip folder
    jobs.push({ html: join(target, 'animation.html'), outDir: target });
  } else if (existsSync(target)) {
    // Session folder — find all clip_* subdirectories
    const entries = readdirSync(target, { withFileTypes: true });
    const clipDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith('clip_'))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (clipDirs.length === 0) {
      console.error(`No clip_* folders found in: ${target}`);
      process.exit(1);
    }

    for (const dir of clipDirs) {
      const clipPath = join(target, dir.name);
      const htmlPath = join(clipPath, 'animation.html');
      if (existsSync(htmlPath)) {
        jobs.push({ html: htmlPath, outDir: clipPath });
      } else {
        console.warn(`  Skipping ${dir.name} — no animation.html`);
      }
    }
  } else {
    console.error(`Target not found: ${target}`);
    process.exit(1);
  }

  console.log(`\n═══ Exporting ${jobs.length} animation(s) ═══`);
  console.log(`  Format: ${opts.width}x${opts.height} @ ${opts.fps}fps`);
  console.log(`  Outputs: ${[opts.webm && 'WebM', opts.mp4 && 'MP4', opts.mov && 'MOV'].filter(Boolean).join(', ')}`);
  console.log('');

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    console.log(`[${i + 1}/${jobs.length}] ${basename(dirname(job.html)) || basename(job.html)}`);
    try {
      const result = await exportAnimation(job.html, job.outDir, opts);
      console.log(`  ✓ ${result.totalFrames} frames exported`);
    } catch (err) {
      console.error(`  ✗ Export failed: ${err.message}`);
      if (err.stack) console.error(err.stack);
    }
  }

  console.log(`\n═══ Export complete ═══\n`);
}

run().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
