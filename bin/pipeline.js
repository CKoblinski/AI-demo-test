#!/usr/bin/env node

import { parseVTT } from '../src/parse-vtt.js';
import { findHighlights } from '../src/find-highlights.js';
import { exportAnimation } from '../src/export-animation.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync, cpSync } from 'fs';
import { join, basename, resolve } from 'path';

// Load .env if present
const envPath = resolve('.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const args = process.argv.slice(2);
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
Usage: node bin/pipeline.js <vtt-file> [options]

  The full pipeline: Parse VTT → Find highlights → Export video

  Options:
    --parse-only       Stop after parsing
    --highlights-only  Stop after finding highlights (skip export)
    --export-only      Skip parsing/highlights, just export existing clips
    --fps=N            Export frames per second (default: 5)
    --keep-frames      Keep individual PNG frames after export

  The pipeline will:
    1. Parse the VTT transcript into structured data
    2. Send to Claude to find 2-3 highlight moments
    3. (You review highlights and place animation.html files in clip folders)
    4. Export all clip animations to video (WebM + MP4)

  Output: output/session_<date>/
`;

if (positional.length === 0) {
  console.error(usage);
  process.exit(1);
}

const vttPath = positional[0];
const parseOnly = !!flags['parse-only'];
const highlightsOnly = !!flags['highlights-only'];
const exportOnly = !!flags['export-only'];
const fps = parseInt(flags.fps) || 5;
const keepFrames = !!flags['keep-frames'];

async function run() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  D&D Shorts Pipeline                          ║');
  console.log('╚═══════════════════════════════════════════════╝\n');

  // ── Determine output directory ──
  let outDir;

  if (exportOnly) {
    // Find existing session folder
    outDir = resolve(vttPath);
    if (!existsSync(outDir)) {
      console.error(`Session folder not found: ${outDir}`);
      process.exit(1);
    }
    console.log(`Export-only mode. Session: ${outDir}\n`);
  } else {
    // ── STAGE 1: Parse ──
    console.log('── Stage 1: Parse VTT ──\n');
    const session = parseVTT(vttPath);

    const sessionDate = session.sessionFile.match(/GMT(\d{8})/)?.[1]
      || session.sessionFile.match(/(\d{4}-\d{2}-\d{2})/)?.[0]?.replace(/-/g, '')
      || 'unknown';
    outDir = join('output', `session_${sessionDate}`);
    mkdirSync(join(outDir, 'session-data'), { recursive: true });

    const sessionPath = join(outDir, 'session-data', 'session.json');
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));

    console.log(`  Duration: ${session.duration}`);
    console.log(`  Cues: ${session.totalCues}`);
    console.log(`  Speakers: ${session.speakers.map(s => s.name + (s.role === 'dm' ? ' [DM]' : '')).join(', ')}`);
    console.log(`  Segments: ${session.segments.map(s => s.type).join(' → ')}`);
    console.log(`  Saved: ${sessionPath}\n`);

    if (parseOnly) {
      console.log('--parse-only flag set. Done.\n');
      process.exit(0);
    }

    // ── STAGE 2: Find Highlights ──
    console.log('── Stage 2: Find Highlights ──\n');

    try {
      const highlights = await findHighlights(session);

      const highlightsPath = join(outDir, 'session-data', 'highlights.json');
      const highlightsData = {
        sessionFile: session.sessionFile,
        analyzedAt: new Date().toISOString(),
        highlights,
      };
      writeFileSync(highlightsPath, JSON.stringify(highlightsData, null, 2));

      console.log(`  Found ${highlights.length} highlights:\n`);
      for (const h of highlights) {
        const startMin = Math.floor(h.startTime / 60);
        const startSec = Math.floor(h.startTime % 60);
        const endMin = Math.floor(h.endTime / 60);
        const endSec = Math.floor(h.endTime % 60);
        console.log(`  #${h.rank} [${h.type}] ${h.title}`);
        console.log(`     ${String(startMin).padStart(2, '0')}:${String(startSec).padStart(2, '0')} → ${String(endMin).padStart(2, '0')}:${String(endSec).padStart(2, '0')} (~${h.estimatedClipDuration}s clip)`);
        console.log(`     ${h.contextForViewers}`);
        console.log('');
      }

      console.log(`  Saved: ${highlightsPath}\n`);
    } catch (err) {
      console.error(`  Error finding highlights: ${err.message}`);
      if (err.message.includes('ANTHROPIC_API_KEY')) {
        console.error('  Create a .env file with ANTHROPIC_API_KEY=your-key-here');
      }
      process.exit(1);
    }

    if (highlightsOnly) {
      console.log('--highlights-only flag set. Done.');
      console.log(`\nNext steps:`);
      console.log(`  1. Review highlights in: ${join(outDir, 'session-data', 'highlights.json')}`);
      console.log(`  2. Place animation.html files in clip_* folders`);
      console.log(`  3. Run: node bin/export.js ${outDir}\n`);
      process.exit(0);
    }
  }

  // ── STAGE 5: Export ──
  console.log('── Stage 5: Export Videos ──\n');

  // Find clip folders
  const { readdirSync } = await import('fs');
  const entries = readdirSync(outDir, { withFileTypes: true });
  const clipDirs = entries
    .filter(e => e.isDirectory() && e.name.startsWith('clip_'))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (clipDirs.length === 0) {
    console.log('  No clip_* folders found. Skipping export.');
    console.log(`  To export, create clip folders with animation.html files in: ${outDir}`);
    console.log(`  Then run: node bin/export.js ${outDir}\n`);
  } else {
    for (const dir of clipDirs) {
      const clipPath = join(outDir, dir.name);
      const htmlPath = join(clipPath, 'animation.html');

      if (!existsSync(htmlPath)) {
        console.log(`  Skipping ${dir.name} — no animation.html`);
        continue;
      }

      console.log(`  Exporting: ${dir.name}`);
      try {
        await exportAnimation(htmlPath, clipPath, {
          fps, keepFrames, webm: true, mp4: true, mov: false,
        });
      } catch (err) {
        console.error(`  ✗ Failed: ${err.message}`);
      }
    }
  }

  // ── Summary ──
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  Pipeline Complete                             ║');
  console.log('╚═══════════════════════════════════════════════╝\n');
  console.log(`  Output: ${resolve(outDir)}\n`);

  // List what's in each clip folder
  for (const dir of clipDirs) {
    const clipPath = join(outDir, dir.name);
    const files = readdirSync(clipPath).filter(f => !f.startsWith('.'));
    console.log(`  ${dir.name}/`);
    for (const f of files) {
      console.log(`    ${f}`);
    }
    console.log('');
  }
}

run().catch(err => {
  console.error(`Fatal: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
