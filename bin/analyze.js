#!/usr/bin/env node

import { parseVTT } from '../src/parse-vtt.js';
import { findHighlights } from '../src/find-highlights.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
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
const vttPath = args.find(a => !a.startsWith('--'));

if (!vttPath) {
  console.error('Usage: node bin/analyze.js <path-to-vtt-file>');
  console.error('  Options:');
  console.error('    --parse-only    Stop after parsing (skip highlight analysis)');
  process.exit(1);
}

const parseOnly = args.includes('--parse-only');

// Parse VTT
console.log(`\nParsing: ${basename(vttPath)}`);
const session = parseVTT(vttPath);

// Create output directory
const sessionDate = session.sessionFile.match(/GMT(\d{8})/)?.[1] || 'unknown';
const outDir = join('output', `session_${sessionDate}`);
mkdirSync(join(outDir, 'session-data'), { recursive: true });

// Write parsed session
const sessionPath = join(outDir, 'session-data', 'session.json');
writeFileSync(sessionPath, JSON.stringify(session, null, 2));

// Print summary
console.log(`\n--- Session Summary ---`);
console.log(`Duration: ${session.duration}`);
console.log(`Total cues: ${session.totalCues}`);
console.log(`\nSpeakers:`);
for (const s of session.speakers) {
  const role = s.role === 'dm' ? ' [DM]' : '';
  console.log(`  ${s.name}${role}`);
  console.log(`    Cues: ${s.cueCount} | Speaking time: ${Math.round(s.totalSpeakingTime)}s | Avg text length: ${s.avgTextLength} chars`);
}

console.log(`\nSegments:`);
for (const seg of session.segments) {
  const startMin = Math.floor(seg.startTime / 60);
  const endMin = Math.floor(seg.endTime / 60);
  const durMin = Math.round((seg.endTime - seg.startTime) / 60);
  console.log(`  ${seg.type}: ${startMin}m → ${endMin}m (${durMin} min)`);
}

console.log(`\nParsed session saved to: ${sessionPath}`);

if (parseOnly) {
  console.log('\n--parse-only flag set. Stopping after parse.');
  process.exit(0);
}

// Stage 2: Find highlights via Claude
console.log('\n--- Finding Highlights ---');

try {
  const highlights = await findHighlights(session);

  // Save highlights
  const highlightsPath = join(outDir, 'session-data', 'highlights.json');
  const highlightsData = {
    sessionFile: session.sessionFile,
    analyzedAt: new Date().toISOString(),
    highlights,
  };
  writeFileSync(highlightsPath, JSON.stringify(highlightsData, null, 2));

  // Print highlights
  console.log(`\nFound ${highlights.length} highlights:\n`);
  for (const h of highlights) {
    const startMin = Math.floor(h.startTime / 60);
    const startSec = Math.floor(h.startTime % 60);
    const endMin = Math.floor(h.endTime / 60);
    const endSec = Math.floor(h.endTime % 60);
    console.log(`  #${h.rank} [${h.type}] ${h.title}`);
    console.log(`     ${String(startMin).padStart(2, '0')}:${String(startSec).padStart(2, '0')} → ${String(endMin).padStart(2, '0')}:${String(endSec).padStart(2, '0')} (~${h.estimatedClipDuration}s clip)`);
    console.log(`     ${h.whyItsGood}`);
    console.log(`     Animation: ${h.suggestedAnimationType} — ${h.animationNotes}`);
    console.log('');
  }

  console.log(`Highlights saved to: ${highlightsPath}`);
} catch (err) {
  console.error(`\nError finding highlights: ${err.message}`);
  if (err.message.includes('ANTHROPIC_API_KEY')) {
    console.error('Create a .env file with ANTHROPIC_API_KEY=your-key-here');
  }
  process.exit(1);
}
