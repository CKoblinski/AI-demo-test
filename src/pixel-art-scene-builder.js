import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

import {
  generateCharacterPortrait,
  generateMouthVariants,
  generateExpressionVariant,
  generateSceneBackground,
  generateActionFrames,
  checkVisualCoherence,
  regenerateActionFrame,
} from './pixel-art-generator.js';
import {
  assembleAnimatedDialogueScene,
  assembleActionBounceScene,
  assembleSequencePlayerScene,
} from './assemble-scene.js';
import { getImpactEffect } from './impact-effects.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Reading speed multiplier — people need more time to read pixel-art typewriter text
const READING_SPEED_MULTIPLIER = 1.6;
// Base ms per character for typewriter (adjusted by multiplier)
const BASE_MS_PER_CHAR = 55;

/**
 * Build a complete pixel art dialogue scene from a highlight moment.
 *
 * @param {object} params
 * @param {object} params.moment - Highlight object from find-highlights.js
 * @param {string} params.direction - User's creative direction (character descriptions, mood, etc.)
 * @param {object[]} params.cues - Session cues array (for pulling full dialogue context)
 * @param {string} params.outDir - Output directory for all assets
 * @param {function} [params.onProgress] - Callback for progress updates: (step, data) => void
 * @param {function} [params.checkCancelled] - Returns true if generation was cancelled
 * @returns {object} Result with file paths and metadata
 */
export async function buildPixelScene({ moment, direction, cues, outDir, onProgress, checkCancelled }) {
  const progress = onProgress || (() => {});
  const isCancelled = checkCancelled || (() => false);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'assets'), { recursive: true });

  const result = {
    portrait: null,
    mouthVariants: [],
    background: null,
    html: null,
    mp4: null,
    gif: null,
    assets: [],
    totalCost: 0,
    totalDurationMs: 0,
  };

  const startTime = Date.now();

  // ─── Parse moment into generation parameters ───

  const {
    characterName,
    characterDescription,
    dialogueLines,
    backgroundDescription,
    backgroundMood,
    characterColor,
  } = parseMomentForGeneration(moment, direction, cues);

  progress('parsed', { characterName, lineCount: dialogueLines.length, backgroundMood });

  // ─── Step 1: Generate portrait ───

  progress('portrait', { status: 'generating' });
  const portraitStart = Date.now();

  const portrait = await generateCharacterPortrait(
    characterName,
    characterDescription,
    { savePath: join(outDir, 'assets', 'portrait.png') }
  );

  const portraitDuration = Date.now() - portraitStart;
  result.portrait = {
    path: join(outDir, 'assets', 'portrait.png'),
    sizeKB: Math.round(portrait.buffer.length / 1024),
    durationMs: portraitDuration,
    base64: portrait.base64,
    mimeType: portrait.mimeType,
  };
  result.totalCost += 0.04;
  result.assets.push(result.portrait.path);

  // Generate a small thumbnail for the UI
  const portraitThumb = portrait.base64.substring(0, 2000); // first ~1.5KB of base64
  progress('portrait', {
    status: 'complete',
    sizeKB: result.portrait.sizeKB,
    durationMs: portraitDuration,
    thumbnailBase64: portraitThumb,
  });

  if (isCancelled()) throw new Error('Generation cancelled');

  // ─── Step 2: Generate mouth variants ───

  progress('mouthVariants', { status: 'generating' });
  const mouthStart = Date.now();

  const variants = await generateMouthVariants(
    portrait.buffer,
    portrait.mimeType,
    { saveDir: join(outDir, 'assets') }
  );

  const mouthDuration = Date.now() - mouthStart;
  result.mouthVariants = variants.map((v, i) => ({
    path: join(outDir, 'assets', `portrait-${v.label}.png`),
    sizeKB: Math.round(v.buffer.length / 1024),
    base64: v.base64,
    mimeType: v.mimeType,
    label: v.label,
  }));
  result.totalCost += variants.length * 0.04;
  for (const v of result.mouthVariants) result.assets.push(v.path);

  progress('mouthVariants', {
    status: 'complete',
    count: variants.length,
    durationMs: mouthDuration,
  });

  if (isCancelled()) throw new Error('Generation cancelled');

  // ─── Step 3: Generate background ───

  progress('background', { status: 'generating' });
  const bgStart = Date.now();

  // Pause before API call
  await sleep(15000);

  const bg = await generateSceneBackground(
    backgroundDescription,
    backgroundMood,
    { savePath: join(outDir, 'assets', 'background.png') }
  );

  const bgDuration = Date.now() - bgStart;
  result.background = {
    path: join(outDir, 'assets', 'background.png'),
    sizeKB: Math.round(bg.buffer.length / 1024),
    durationMs: bgDuration,
    base64: bg.base64,
    mimeType: bg.mimeType,
  };
  result.totalCost += 0.04;
  result.assets.push(result.background.path);

  const bgThumb = bg.base64.substring(0, 2000);
  progress('background', {
    status: 'complete',
    sizeKB: result.background.sizeKB,
    durationMs: bgDuration,
    thumbnailBase64: bgThumb,
  });

  if (isCancelled()) throw new Error('Generation cancelled');

  // ─── Step 4: Assemble scene ───

  progress('assembly', { status: 'assembling' });

  // Build portrait frames array: [closed, slightly-open, open]
  const portraitFrames = [
    { base64: portrait.base64, mimeType: portrait.mimeType },
  ];
  for (const v of variants) {
    portraitFrames.push({ base64: v.base64, mimeType: v.mimeType });
  }
  while (portraitFrames.length < 3) {
    portraitFrames.push(portraitFrames[portraitFrames.length - 1]);
  }

  // Apply reading speed multiplier to dialogue speeds
  const adjustedLines = dialogueLines.map(line => ({
    text: line.text,
    speed: Math.round((line.speed || BASE_MS_PER_CHAR) * READING_SPEED_MULTIPLIER),
  }));

  const sceneTitle = moment.title || `${characterName} — D&D Shorts`;

  const html = assembleAnimatedDialogueScene({
    portraitFrames,
    backgroundBase64: bg.base64,
    backgroundMimeType: bg.mimeType,
    characterName,
    characterColor,
    backgroundMood: backgroundMood || 'dark',
    sceneTitle,
    dialogueLines: adjustedLines,
    mouthCycleMs: 150,
    linePauseMs: 2000,
  });

  const htmlPath = join(outDir, 'scene.html');
  writeFileSync(htmlPath, html);
  result.html = htmlPath;

  progress('assembly', { status: 'complete', sizeKB: Math.round(html.length / 1024) });

  if (isCancelled()) throw new Error('Generation cancelled');

  // ─── Step 5: Export video ───

  progress('export', { status: 'exporting' });
  const exportStart = Date.now();

  // Calculate duration based on dialogue length + reading speed
  let totalTextTime = 0;
  for (const line of adjustedLines) {
    totalTextTime += line.text.length * line.speed; // ms
  }
  totalTextTime += (adjustedLines.length - 1) * 2000; // pauses between lines
  totalTextTime += 4000; // extra buffer at start and end
  const durationSec = Math.ceil(totalTextTime / 1000);

  try {
    const captureBin = join(__dirname, '..', 'bin', 'capture-scene.js');
    await new Promise((resolve, reject) => {
      exec(
        `node "${captureBin}" "${htmlPath}" --duration=${durationSec} --fps=12 --width=1080 --height=1920`,
        { timeout: 300000 },
        (err, stdout, stderr) => {
          if (err) {
            console.error('Export stderr:', stderr);
            reject(err);
          } else {
            if (stdout) console.log('Export stdout:', stdout);
            resolve(stdout);
          }
        }
      );
    });

    const mp4Path = htmlPath.replace('.html', '.mp4');
    const gifPath = htmlPath.replace('.html', '.gif');

    if (existsSync(mp4Path)) {
      result.mp4 = mp4Path;
      result.assets.push(mp4Path);
    }
    if (existsSync(gifPath)) {
      result.gif = gifPath;
      result.assets.push(gifPath);
    }
  } catch (err) {
    console.error('Export failed:', err.message);
    progress('export', { status: 'failed', error: err.message });
  }

  const exportDuration = Date.now() - exportStart;
  progress('export', {
    status: result.mp4 ? 'complete' : 'failed',
    durationMs: exportDuration,
    files: {
      html: result.html,
      mp4: result.mp4,
      gif: result.gif,
      portraitPng: result.portrait?.path,
      backgroundPng: result.background?.path,
      mouthVariantPngs: result.mouthVariants.map(v => v.path),
    },
  });

  // ─── Save metadata ───

  result.totalDurationMs = Date.now() - startTime;
  const metadata = {
    moment: {
      title: moment.title,
      type: moment.type,
      rank: moment.rank,
      emotionalArc: moment.emotionalArc,
      startTime: moment.startTime,
      endTime: moment.endTime,
    },
    characterName,
    characterColor,
    dialogueLines: adjustedLines,
    backgroundMood,
    direction,
    cost: result.totalCost,
    durationMs: result.totalDurationMs,
    generatedAt: new Date().toISOString(),
    files: {
      html: result.html,
      mp4: result.mp4,
      gif: result.gif,
      portrait: result.portrait?.path,
      background: result.background?.path,
      mouthVariants: result.mouthVariants.map(v => v.path),
    },
  };
  writeFileSync(join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  return result;
}


/**
 * Parse a moment + user direction into concrete generation parameters.
 */
function parseMomentForGeneration(moment, direction, cues) {
  // Default character name from dialogue excerpt
  let characterName = 'Character';
  if (moment.dialogueExcerpt && moment.dialogueExcerpt.length > 0) {
    characterName = moment.dialogueExcerpt[0].speaker || 'Character';
  }

  // Extract character description from direction text
  // Look for patterns like "Bixie is a ..." or "Character: ..."
  let characterDescription = '';
  if (direction) {
    // Try to find a description for this character in the direction
    const descPatterns = [
      new RegExp(`${characterName}\\s+(?:is|looks like|appears as)\\s+(.+?)(?:\\.|$)`, 'i'),
      new RegExp(`${characterName}:\\s*(.+?)(?:\\.|$)`, 'i'),
      // Fallback: if direction has substantial text, use it all as context
    ];
    for (const pattern of descPatterns) {
      const match = direction.match(pattern);
      if (match) {
        characterDescription = match[1].trim();
        break;
      }
    }
    // If no specific pattern matched but direction has content, use it as general description
    if (!characterDescription && direction.length > 20) {
      characterDescription = direction;
    }
  }

  // Build portrait prompt from description
  if (!characterDescription) {
    characterDescription = `a fantasy RPG character named ${characterName}, dramatic lighting, expressive face`;
  }

  // Build dialogue lines from excerpt
  let dialogueLines = [];
  if (moment.dialogueExcerpt && moment.dialogueExcerpt.length > 0) {
    dialogueLines = moment.dialogueExcerpt.map(line => ({
      text: line.text,
      speed: BASE_MS_PER_CHAR,
    }));
  } else if (moment.keyDialogueCueIds && cues) {
    // Fall back to pulling dialogue from cue IDs
    const keyCues = cues.filter(c => moment.keyDialogueCueIds.includes(c.id));
    dialogueLines = keyCues.slice(0, 4).map(c => ({
      text: c.text,
      speed: BASE_MS_PER_CHAR,
    }));
  }

  // Ensure we have at least one line
  if (dialogueLines.length === 0) {
    dialogueLines = [{ text: '...', speed: BASE_MS_PER_CHAR }];
  }

  // Background mood
  const backgroundMood = moment.suggestedBackgroundMood || 'neutral';

  // Build background description from visual concept + mood
  let backgroundDescription = '';
  if (moment.visualConcept) {
    // Extract background-relevant parts from the visual concept
    backgroundDescription = moment.visualConcept;
  } else {
    backgroundDescription = `a fantasy scene, ${backgroundMood} atmosphere, dramatic lighting`;
  }

  // Merge any background-specific direction
  if (direction) {
    const bgPatterns = [
      /background:\s*(.+?)(?:\.|$)/i,
      /setting:\s*(.+?)(?:\.|$)/i,
      /scene:\s*(.+?)(?:\.|$)/i,
    ];
    for (const pattern of bgPatterns) {
      const match = direction.match(pattern);
      if (match) {
        backgroundDescription = match[1].trim();
        break;
      }
    }
  }

  // Character color — warm gold default, could be customized later
  let characterColor = '#e8a033';
  const colorMatch = direction?.match(/color:\s*(#[0-9a-fA-F]{6})/i);
  if (colorMatch) characterColor = colorMatch[1];

  return {
    characterName,
    characterDescription,
    dialogueLines,
    backgroundDescription,
    backgroundMood,
    characterColor,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(text) {
  return (text || 'unknown').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 30);
}

// ═══════════════════════════════════════════════════════════════
// Multi-Sequence Pipeline (Phase 2C)
// ═══════════════════════════════════════════════════════════════

/**
 * Build all sequences for a moment from a Director AI storyboard plan.
 * This is the multi-sequence pipeline that replaces buildPixelScene for
 * sessions that go through the Director AI flow.
 *
 * @param {object} params
 * @param {object} params.storyboard - Storyboard from Director AI { plan, qcResult }
 * @param {object} params.moment - Highlight object
 * @param {string} params.direction - User's creative direction
 * @param {object[]} params.cues - Session cues
 * @param {string} params.outDir - Output directory
 * @param {function} [params.onProgress] - Progress callback: (step, data) => void
 * @param {function} [params.checkCancelled] - Returns true if cancelled
 * @returns {object} Result with all sequence data, player HTML, exports
 */
export async function buildMomentSequences({ storyboard, moment, direction, cues, outDir, onProgress, checkCancelled }) {
  const progress = onProgress || (() => {});
  const isCancelled = checkCancelled || (() => false);

  mkdirSync(outDir, { recursive: true });

  const sequences = storyboard.plan.sequences;
  const sceneTitle = moment.title || 'D&D Shorts';

  // Load character cards for portrait descriptions + colors
  const charactersPath = join(__dirname, '..', 'data', 'characters.json');
  let characterCards = [];
  if (existsSync(charactersPath)) {
    try {
      characterCards = JSON.parse(readFileSync(charactersPath, 'utf-8')).characters || [];
    } catch (e) {
      console.warn('  Warning: Failed to load character cards:', e.message);
    }
  }

  // Character cache: speaker → { portrait: { base64, mimeType, buffer }, mouthVariants: [...] }
  const characterCache = new Map();

  // Style reference from previous sequence's background (for visual consistency)
  let previousBgRef = null;

  const result = {
    sequences: [],
    playerHtml: null,
    mp4: null,
    gif: null,
    assets: [],
    totalCost: 0,
    totalDurationMs: 0,
  };

  const startTime = Date.now();

  progress('plan', {
    status: 'starting',
    totalSequences: sequences.length,
    totalDurationSec: storyboard.plan.totalDurationSec,
  });

  // ─── Generate assets for each sequence ───

  for (let i = 0; i < sequences.length; i++) {
    const seq = sequences[i];
    const seqNum = String(i + 1).padStart(2, '0');
    const seqSlug = slugify(seq.speaker || seq.type);
    const seqDir = join(outDir, `seq_${seqNum}_${seq.type}_${seqSlug}`);
    mkdirSync(join(seqDir, 'assets'), { recursive: true });

    progress('sequence', {
      status: 'generating',
      sequenceIndex: i,
      totalSequences: sequences.length,
      type: seq.type,
      speaker: seq.speaker,
    });

    let seqResult;

    // Resolve reuseBackgroundFrom — look up the referenced sequence's background
    let reusedBg = null;
    if (seq.reuseBackgroundFrom) {
      const refIdx = seq.reuseBackgroundFrom - 1; // Convert order to 0-indexed
      if (refIdx >= 0 && refIdx < result.sequences.length && result.sequences[refIdx].backgroundBase64) {
        reusedBg = {
          base64: result.sequences[refIdx].backgroundBase64,
          mimeType: result.sequences[refIdx].backgroundMimeType || 'image/png',
        };
        console.log(`  Reusing background from sequence ${seq.reuseBackgroundFrom}`);
      }
    }

    switch (seq.type) {
      case 'dialogue':
        seqResult = await generateDialogueSequence(seq, seqDir, characterCache, previousBgRef, direction, {
          progress, isCancelled, seqIndex: i, totalSeqs: sequences.length, reusedBg, characterCards,
        });
        break;

      case 'dm_description':
        seqResult = await generateDMDescriptionSequence(seq, seqDir, characterCache, previousBgRef, direction, {
          progress, isCancelled, seqIndex: i, totalSeqs: sequences.length, reusedBg,
        });
        break;

      case 'close_up':
      case 'action_closeup':
        seqResult = await generateActionSequence(seq, seqDir, previousBgRef, {
          progress, isCancelled, seqIndex: i, totalSeqs: sequences.length,
        });
        break;

      case 'impact':
        seqResult = generateImpactSequence(seq, seqDir);
        break;

      case 'establishing_shot':
        seqResult = await generateEstablishingSequence(seq, seqDir, previousBgRef, {
          progress, isCancelled, seqIndex: i, totalSeqs: sequences.length,
        });
        break;

      case 'reaction':
        // Legacy: treat as short dialogue
        seqResult = await generateDialogueSequence(seq, seqDir, characterCache, previousBgRef, direction, {
          progress, isCancelled, seqIndex: i, totalSeqs: sequences.length, reusedBg, characterCards,
        });
        break;

      default:
        console.warn(`  Unknown sequence type: ${seq.type}, treating as establishing_shot`);
        seqResult = await generateEstablishingSequence(seq, seqDir, previousBgRef, {
          progress, isCancelled, seqIndex: i, totalSeqs: sequences.length,
        });
    }

    // Update style reference for next sequence (visual consistency)
    if (seqResult.backgroundBase64) {
      previousBgRef = { base64: seqResult.backgroundBase64, mimeType: seqResult.backgroundMimeType || 'image/png' };
    }

    result.sequences.push(seqResult);
    result.totalCost += seqResult.cost || 0;
    result.assets.push(...(seqResult.assets || []));

    progress('sequence', {
      status: 'complete',
      sequenceIndex: i,
      totalSequences: sequences.length,
      type: seq.type,
      cost: seqResult.cost,
    });

    if (isCancelled()) throw new Error('Generation cancelled');
  }

  // ─── Assemble individual sequence HTML files ───

  progress('assembly', { status: 'assembling', detail: 'Building individual sequence files' });

  for (let i = 0; i < result.sequences.length; i++) {
    const seqResult = result.sequences[i];
    const seq = sequences[i];

    if ((seq.type === 'dialogue' || seq.type === 'dm_description' || seq.type === 'reaction') && seqResult.assemblyData) {
      const html = assembleAnimatedDialogueScene(seqResult.assemblyData);
      const htmlPath = join(seqResult.dir, 'scene.html');
      writeFileSync(htmlPath, html);
      seqResult.html = htmlPath;
      result.assets.push(htmlPath);
    } else if ((seq.type === 'action_closeup' || seq.type === 'close_up') && seqResult.assemblyData) {
      const html = assembleActionBounceScene(seqResult.assemblyData);
      const htmlPath = join(seqResult.dir, 'scene.html');
      writeFileSync(htmlPath, html);
      seqResult.html = htmlPath;
      result.assets.push(htmlPath);
    } else if (seq.type === 'impact' && seqResult.html) {
      // Impact sequences already have their HTML written
      result.assets.push(seqResult.html);
    } else if (seq.type === 'establishing_shot' && seqResult.playerData) {
      const html = assembleSequencePlayerScene({
        sequences: [seqResult.playerData],
        totalDurationMs: seq.durationSec * 1000,
        sceneTitle: 'Establishing Shot — D&D Shorts',
      });
      const htmlPath = join(seqResult.dir, 'scene.html');
      writeFileSync(htmlPath, html);
      seqResult.html = htmlPath;
      result.assets.push(htmlPath);
    }
  }

  // ─── Assemble master sequence player ───

  progress('assembly', { status: 'assembling', detail: 'Building sequence player' });

  // Build SEQUENCES_JSON for the sequence-player.html template
  const playerSequences = result.sequences.map((seqResult) => seqResult.playerData);

  const totalDurationMs = sequences.reduce((sum, seq) => sum + (seq.durationSec * 1000), 0);

  const playerHtml = assembleSequencePlayerScene({
    sequences: playerSequences,
    totalDurationMs,
    sceneTitle,
  });

  const playerPath = join(outDir, 'sequence-player.html');
  writeFileSync(playerPath, playerHtml);
  result.playerHtml = playerPath;
  result.assets.push(playerPath);

  progress('assembly', { status: 'complete', sizeKB: Math.round(playerHtml.length / 1024) });

  if (isCancelled()) throw new Error('Generation cancelled');

  // ─── Export per-sequence videos ───

  progress('export', { status: 'exporting', detail: 'Exporting per-sequence videos' });
  const exportStart = Date.now();
  const captureBin = join(__dirname, '..', 'bin', 'capture-scene.js');

  result.sequenceExports = [];

  for (let i = 0; i < result.sequences.length; i++) {
    const seqResult = result.sequences[i];
    const seq = sequences[i];

    if (!seqResult.html) {
      console.log(`  Skipping export for sequence ${i + 1} (no HTML)`);
      result.sequenceExports.push({ index: i, type: seq.type, speaker: seq.speaker, mp4: null });
      continue;
    }

    const seqDurationSec = Math.ceil(seq.durationSec) + 1; // +1s buffer

    progress('export', {
      status: 'exporting',
      detail: `Exporting sequence ${i + 1}/${result.sequences.length} (${seq.type})...`,
      sequenceIndex: i,
    });

    try {
      await new Promise((resolve, reject) => {
        exec(
          `node "${captureBin}" "${seqResult.html}" --duration=${seqDurationSec} --fps=12 --width=1080 --height=1920 --no-gif`,
          { timeout: 120000 },
          (err, stdout, stderr) => {
            if (err) {
              console.error(`  Export stderr (seq ${i + 1}):`, stderr);
              reject(err);
            } else {
              resolve(stdout);
            }
          }
        );
      });

      const seqMp4 = seqResult.html.replace('.html', '.mp4');
      if (existsSync(seqMp4)) {
        seqResult.mp4 = seqMp4;
        result.assets.push(seqMp4);
        console.log(`  Exported: ${seqMp4}`);
      }
    } catch (err) {
      console.error(`  Export failed for sequence ${i + 1}: ${err.message}`);
    }

    result.sequenceExports.push({
      index: i,
      type: seq.type,
      speaker: seq.speaker,
      durationSec: seq.durationSec,
      mp4: seqResult.mp4 || null,
      html: seqResult.html || null,
    });

    if (isCancelled()) throw new Error('Generation cancelled');
  }

  const exportDuration = Date.now() - exportStart;
  const exportedCount = result.sequenceExports.filter(e => e.mp4).length;
  progress('export', {
    status: exportedCount > 0 ? 'complete' : 'failed',
    durationMs: exportDuration,
    files: {
      playerHtml: result.playerHtml,
      sequenceExports: result.sequenceExports,
    },
  });

  // ─── Save metadata ───

  result.totalDurationMs = Date.now() - startTime;

  const metadata = {
    moment: {
      title: moment.title,
      type: moment.type,
      rank: moment.rank,
      emotionalArc: moment.emotionalArc,
      startTime: moment.startTime,
      endTime: moment.endTime,
    },
    storyboard: {
      sequenceCount: sequences.length,
      totalDurationSec: storyboard.plan.totalDurationSec,
    },
    originalCueRange: storyboard.plan.originalCueRange || {
      startCue: moment.startCue,
      endCue: moment.endCue,
    },
    sequences: result.sequences.map((sr, i) => ({
      order: i + 1,
      type: sequences[i].type,
      speaker: sequences[i].speaker,
      durationSec: sequences[i].durationSec,
      cost: sr.cost,
      assetCount: sr.assets?.length || 0,
      mp4: sr.mp4 || null,
    })),
    direction,
    cost: result.totalCost,
    durationMs: result.totalDurationMs,
    generatedAt: new Date().toISOString(),
    files: {
      playerHtml: result.playerHtml,
      sequenceExports: result.sequenceExports,
    },
  };
  writeFileSync(join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  return result;
}


// ─── Per-Sequence-Type Generation Helpers ───


/**
 * Generate assets for a dialogue sequence.
 * Produces: portrait, mouth variants (or reuses from cache), background.
 */
async function generateDialogueSequence(seq, seqDir, characterCache, styleRef, direction, opts) {
  const { progress, isCancelled, seqIndex, totalSeqs, reusedBg, characterCards = [] } = opts;
  const assetsDir = join(seqDir, 'assets');

  const result = {
    dir: seqDir,
    type: 'dialogue',
    cost: 0,
    assets: [],
    backgroundBase64: null,
    backgroundMimeType: null,
    assemblyData: null,
    playerData: null,
  };

  const rawSpeaker = seq.speaker || 'Character';
  // Normalize DM speaker to use same cache key as Narrator (hooded sage portrait)
  const isDM = rawSpeaker.toLowerCase() === 'dm' || rawSpeaker.toLowerCase() === 'dungeon master';
  const speaker = isDM ? 'Narrator' : rawSpeaker;
  const cached = characterCache.get(speaker);

  // Look up character card for this speaker (not for DM/Narrator)
  const charCard = isDM ? null : characterCards.find(ch => ch.name.toLowerCase() === rawSpeaker.toLowerCase());

  let portrait, mouthVariants;

  if (cached) {
    // Check if Director gave a different portraitDescription for this appearance (e.g. emotion change)
    const hasNewExpression = !isDM && seq.portraitDescription && cached.portraitDescription
      && seq.portraitDescription !== cached.portraitDescription;

    if (hasNewExpression) {
      // Generate an expression variant using the base portrait as reference
      console.log(`  Generating expression variant for ${rawSpeaker}: "${seq.portraitDescription.substring(0, 60)}..."`);
      progress('asset', { sequenceIndex: seqIndex, asset: 'portrait', status: 'generating', speaker: rawSpeaker });

      const expressionChange = seq.portraitDescription;
      portrait = await generateExpressionVariant(
        cached.portrait.buffer,
        cached.portrait.mimeType,
        expressionChange,
        { savePath: join(assetsDir, 'portrait.png') }
      );
      result.cost += 0.04;
      result.assets.push(join(assetsDir, 'portrait.png'));

      // Generate mouth variants from the new expression
      progress('asset', { sequenceIndex: seqIndex, asset: 'mouthVariants', status: 'generating' });
      mouthVariants = await generateMouthVariants(
        portrait.buffer,
        portrait.mimeType,
        { saveDir: assetsDir }
      );
      result.cost += mouthVariants.length * 0.04;
      for (const v of mouthVariants) {
        result.assets.push(join(assetsDir, `portrait-${v.label}.png`));
      }
      progress('asset', { sequenceIndex: seqIndex, asset: 'mouthVariants', status: 'complete', count: mouthVariants.length });
    } else {
      // Same expression — reuse cached portrait + mouth variants
      console.log(`  Reusing cached portrait for ${rawSpeaker}${isDM ? ' (as Narrator)' : ''}`);
      portrait = cached.portrait;
      mouthVariants = cached.mouthVariants;
    }
  } else {
    // ── Generate portrait ──
    progress('asset', { sequenceIndex: seqIndex, asset: 'portrait', status: 'generating', speaker });

    // Use character card visual description if available, else fall back to Director's desc or direction text
    // DM/Narrator gets the fixed hooded sage description for consistency
    const NARRATOR_DESC = 'Hooded mysterious sage storyteller, face partially obscured by deep hood, warm wise eyes visible in shadow, dark flowing robes, aged hands. Fantasy RPG dungeon master narrator character. Warm candlelight from below illuminating chin and lower face.';
    const portraitDesc = isDM
      ? NARRATOR_DESC
      : charCard
        ? `${charCard.visualDescription} ${seq.portraitDescription || ''}`
        : (seq.portraitDescription || extractCharacterDescription(rawSpeaker, direction));
    portrait = await generateCharacterPortrait(
      speaker,
      portraitDesc,
      { savePath: join(assetsDir, 'portrait.png') }
    );
    result.cost += 0.04;
    result.assets.push(join(assetsDir, 'portrait.png'));

    progress('asset', {
      sequenceIndex: seqIndex, asset: 'portrait', status: 'complete',
      sizeKB: Math.round(portrait.buffer.length / 1024),
      thumbnailBase64: portrait.base64.substring(0, 2000),
    });

    if (isCancelled()) throw new Error('Generation cancelled');

    // ── Generate mouth variants ──
    progress('asset', { sequenceIndex: seqIndex, asset: 'mouthVariants', status: 'generating' });

    mouthVariants = await generateMouthVariants(
      portrait.buffer,
      portrait.mimeType,
      { saveDir: assetsDir }
    );
    result.cost += mouthVariants.length * 0.04;
    for (const v of mouthVariants) {
      result.assets.push(join(assetsDir, `portrait-${v.label}.png`));
    }

    progress('asset', {
      sequenceIndex: seqIndex, asset: 'mouthVariants', status: 'complete',
      count: mouthVariants.length,
    });

    if (isCancelled()) throw new Error('Generation cancelled');

    // Cache for reuse in later sequences (store portraitDescription for expression comparison)
    characterCache.set(speaker, { portrait, mouthVariants, portraitDescription: seq.portraitDescription || '' });

    // ── Portrait Visual QC (log only, no auto-regen) ──
    const allPortraitFrames = [
      { buffer: portrait.buffer, base64: portrait.base64, mimeType: portrait.mimeType, label: 'base' },
      ...mouthVariants.map(v => ({ buffer: v.buffer, base64: v.base64, mimeType: v.mimeType, label: v.label })),
    ];
    const portraitQC = await checkVisualCoherence(
      allPortraitFrames,
      'dialogue',
      `Portrait of ${speaker} with mouth variants`
    );
    if (!portraitQC.coherent) {
      console.log(`  Portrait QC issues (logged for review): ${portraitQC.issues.join('; ')}`);
    }
  }

  // ── Generate or reuse background ──
  let bg;

  if (reusedBg) {
    // Reuse background from an earlier sequence (saves $0.04 + API call)
    console.log(`  Reusing background for ${speaker} (from earlier sequence)`);
    bg = { base64: reusedBg.base64, mimeType: reusedBg.mimeType, buffer: Buffer.from(reusedBg.base64, 'base64') };
    result.backgroundBase64 = bg.base64;
    result.backgroundMimeType = bg.mimeType;
    progress('asset', { sequenceIndex: seqIndex, asset: 'background', status: 'complete', reused: true });
  } else {
    progress('asset', { sequenceIndex: seqIndex, asset: 'background', status: 'generating' });

    // Rate limit pause
    await sleep(15000);

    const bgDesc = seq.backgroundDescription || `fantasy scene, ${seq.backgroundMood || 'neutral'} atmosphere`;
    bg = await generateSceneBackground(
      bgDesc,
      seq.backgroundMood || 'neutral',
      { savePath: join(assetsDir, 'background.png') }
    );
    result.cost += 0.04;
    result.assets.push(join(assetsDir, 'background.png'));
    result.backgroundBase64 = bg.base64;
    result.backgroundMimeType = bg.mimeType;

    progress('asset', {
      sequenceIndex: seqIndex, asset: 'background', status: 'complete',
      sizeKB: Math.round(bg.buffer.length / 1024),
      thumbnailBase64: bg.base64.substring(0, 2000),
    });
  }

  // ── Build data structures ──

  // Portrait frames: [closed, slightly-open, open]
  const portraitFrames = [
    { base64: portrait.base64, mimeType: portrait.mimeType },
  ];
  for (const v of mouthVariants) {
    portraitFrames.push({ base64: v.base64, mimeType: v.mimeType });
  }
  while (portraitFrames.length < 3) {
    portraitFrames.push(portraitFrames[portraitFrames.length - 1]);
  }

  // Dialogue lines with reading speed
  const dialogueLines = (seq.dialogueLines || []).map(line => ({
    text: line.text,
    speed: Math.round(BASE_MS_PER_CHAR * READING_SPEED_MULTIPLIER),
  }));

  if (dialogueLines.length === 0) {
    dialogueLines.push({ text: '...', speed: Math.round(BASE_MS_PER_CHAR * READING_SPEED_MULTIPLIER) });
  }

  // Character color — use character card color if available
  let characterColor = charCard ? charCard.color : '#e8a033';
  const colorMatch = direction?.match(/color:\s*(#[0-9a-fA-F]{6})/i);
  if (colorMatch) characterColor = colorMatch[1]; // Direction override

  // Assembly data for individual standalone HTML
  result.assemblyData = {
    portraitFrames,
    backgroundBase64: bg.base64,
    backgroundMimeType: bg.mimeType,
    characterName: speaker,
    characterColor,
    backgroundMood: seq.backgroundMood || 'dark',
    sceneTitle: `${speaker} — D&D Shorts`,
    dialogueLines,
    mouthCycleMs: 150,
    linePauseMs: 2000,
  };

  // Data for the master sequence player
  result.playerData = {
    type: 'dialogue',
    durationMs: seq.durationSec * 1000,
    transitionIn: seq.transitionIn || 'cut',
    charName: speaker,
    charColor: characterColor,
    portraitImgs: portraitFrames.map(f => `data:${f.mimeType || 'image/png'};base64,${f.base64}`),
    backgroundSrc: `data:${bg.mimeType};base64,${bg.base64}`,
    dialogueLines,
    mouthCycleMs: 150,
    linePauseMs: 2000,
  };

  return result;
}


/**
 * Generate assets for an action closeup sequence.
 * Produces: N action frames that bounce cycle (no portrait, no dialogue).
 */
async function generateActionSequence(seq, seqDir, styleRef, opts) {
  const { progress, isCancelled, seqIndex, totalSeqs } = opts;
  const assetsDir = join(seqDir, 'assets');

  const result = {
    dir: seqDir,
    type: seq.type || 'close_up',
    cost: 0,
    assets: [],
    backgroundBase64: null,
    backgroundMimeType: null,
    assemblyData: null,
    playerData: null,
  };

  const frameCount = Math.max(2, Math.min(5, seq.frameCount || 3));

  progress('asset', {
    sequenceIndex: seqIndex, asset: 'actionFrames', status: 'generating',
    frameCount,
  });

  const frames = await generateActionFrames(
    seq.actionDescription || 'dramatic fantasy action scene close-up',
    frameCount,
    seq.backgroundMood || 'tense',
    { saveDir: assetsDir }
  );

  result.cost += frames.length * 0.04;
  for (const f of frames) {
    result.assets.push(join(assetsDir, `${f.label}.png`));
  }

  // Use the first frame as background reference for subsequent sequences
  if (frames.length > 0) {
    result.backgroundBase64 = frames[0].base64;
    result.backgroundMimeType = frames[0].mimeType;
  }

  progress('asset', {
    sequenceIndex: seqIndex, asset: 'actionFrames', status: 'complete',
    frameCount: frames.length,
  });

  // ── Visual Coherence QC ──
  if (frames.length >= 2) {
    progress('asset', { sequenceIndex: seqIndex, asset: 'visualQC', status: 'generating' });

    const qcResult = await checkVisualCoherence(
      frames,
      'action_closeup',
      seq.actionDescription || 'action sequence'
    );

    if (!qcResult.coherent && qcResult.problematicFrames.length > 0) {
      // Regenerate problematic frames (max 1 retry per frame, skip frame 1)
      let regenCount = 0;
      const issueHint = qcResult.issues.join('. ');

      for (const frameNum of qcResult.problematicFrames) {
        const frameIdx = frameNum - 1; // Convert from 1-indexed
        if (frameIdx <= 0 || frameIdx >= frames.length) continue; // Don't regen frame 1 (base)

        await sleep(15000); // Rate limit pause before Gemini call

        try {
          const savePath = join(assetsDir, `${frames[frameIdx].label}.png`);
          const regen = await regenerateActionFrame(
            frames[0], // Use frame 1 as reference
            frameNum,
            frames.length,
            seq.actionDescription || 'action sequence',
            issueHint,
            seq.backgroundMood || 'tense',
            { savePath }
          );

          frames[frameIdx] = {
            ...regen,
            label: frames[frameIdx].label,
          };
          result.cost += 0.04;
          regenCount++;
        } catch (regenErr) {
          console.warn(`  Failed to regenerate frame ${frameNum}: ${regenErr.message}`);
        }
      }

      progress('asset', { sequenceIndex: seqIndex, asset: 'visualQC', status: 'complete', regenCount });
    } else {
      progress('asset', { sequenceIndex: seqIndex, asset: 'visualQC', status: 'complete', regenCount: 0 });
    }
  }

  // Calculate frame timing for bounce mode
  // Bounce sequence: 0,1,2,1,0,1,2,1,... → period = 2*N-2 frames
  const bounceSteps = Math.max(1, 2 * frameCount - 2);
  // Target 2-3 full bounce cycles within the sequence duration
  const targetCycles = 2.5;
  const frameDurationMs = Math.round((seq.durationSec * 1000) / (bounceSteps * targetCycles));
  const clampedFrameDuration = Math.max(80, Math.min(500, frameDurationMs));

  // Assembly data for individual standalone HTML
  result.assemblyData = {
    frameImages: frames.map(f => ({ base64: f.base64, mimeType: f.mimeType })),
    frameDurationMs: clampedFrameDuration,
    backgroundMood: seq.backgroundMood || 'tense',
    transitionIn: seq.transitionIn || 'cut',
    sceneTitle: 'Action — D&D Shorts',
  };

  // Data for the master sequence player
  result.playerData = {
    type: 'action_closeup',
    durationMs: seq.durationSec * 1000,
    transitionIn: seq.transitionIn || 'flash',
    frameImgs: frames.map(f => `data:${f.mimeType || 'image/png'};base64,${f.base64}`),
    frameDurationMs: clampedFrameDuration,
    bounceMode: seq.bounceMode !== false,
  };

  return result;
}


/**
 * Generate assets for an establishing shot sequence.
 * Produces: just a background (no portrait, no dialogue).
 */
async function generateEstablishingSequence(seq, seqDir, styleRef, opts) {
  const { progress, isCancelled, seqIndex, totalSeqs } = opts;
  const assetsDir = join(seqDir, 'assets');

  const result = {
    dir: seqDir,
    type: 'establishing_shot',
    cost: 0,
    assets: [],
    backgroundBase64: null,
    backgroundMimeType: null,
    playerData: null,
  };

  progress('asset', { sequenceIndex: seqIndex, asset: 'background', status: 'generating' });

  // Rate limit pause
  await sleep(15000);

  const bgDesc = seq.backgroundDescription || `wide establishing shot, fantasy scene, ${seq.backgroundMood || 'neutral'} atmosphere, cinematic composition`;
  const bg = await generateSceneBackground(
    bgDesc,
    seq.backgroundMood || 'neutral',
    { savePath: join(assetsDir, 'background.png') }
  );
  result.cost += 0.04;
  result.assets.push(join(assetsDir, 'background.png'));
  result.backgroundBase64 = bg.base64;
  result.backgroundMimeType = bg.mimeType;

  progress('asset', {
    sequenceIndex: seqIndex, asset: 'background', status: 'complete',
    sizeKB: Math.round(bg.buffer.length / 1024),
    thumbnailBase64: bg.base64.substring(0, 2000),
  });

  // Data for the master sequence player
  result.playerData = {
    type: 'establishing_shot',
    durationMs: seq.durationSec * 1000,
    transitionIn: seq.transitionIn || 'fade',
    backgroundSrc: `data:${bg.mimeType};base64,${bg.base64}`,
  };

  return result;
}


/**
 * Generate assets for a reaction sequence.
 * Produces: portrait (or reuses from cache), background. No dialogue text.
 */
async function generateReactionSequence(seq, seqDir, characterCache, styleRef, direction, opts) {
  const { progress, isCancelled, seqIndex, totalSeqs } = opts;
  const assetsDir = join(seqDir, 'assets');

  const result = {
    dir: seqDir,
    type: 'reaction',
    cost: 0,
    assets: [],
    backgroundBase64: null,
    backgroundMimeType: null,
    playerData: null,
  };

  const speaker = seq.speaker || 'Character';
  const cached = characterCache.get(speaker);

  let portrait;

  if (cached) {
    console.log(`  Reusing cached portrait for ${speaker}`);
    portrait = cached.portrait;
  } else {
    // ── Generate portrait ──
    progress('asset', { sequenceIndex: seqIndex, asset: 'portrait', status: 'generating', speaker });

    const portraitDesc = seq.portraitDescription || extractCharacterDescription(speaker, direction);
    portrait = await generateCharacterPortrait(
      speaker,
      portraitDesc,
      { savePath: join(assetsDir, 'portrait.png') }
    );
    result.cost += 0.04;
    result.assets.push(join(assetsDir, 'portrait.png'));

    // Cache for reuse (no mouth variants needed for reaction)
    characterCache.set(speaker, { portrait, mouthVariants: cached?.mouthVariants || [] });

    progress('asset', {
      sequenceIndex: seqIndex, asset: 'portrait', status: 'complete',
      sizeKB: Math.round(portrait.buffer.length / 1024),
    });

    if (isCancelled()) throw new Error('Generation cancelled');
  }

  // ── Generate background ──
  progress('asset', { sequenceIndex: seqIndex, asset: 'background', status: 'generating' });

  // Rate limit pause
  await sleep(15000);

  const bgDesc = seq.backgroundDescription || `fantasy scene, ${seq.backgroundMood || 'neutral'} atmosphere`;
  const bg = await generateSceneBackground(
    bgDesc,
    seq.backgroundMood || 'neutral',
    { savePath: join(assetsDir, 'background.png') }
  );
  result.cost += 0.04;
  result.assets.push(join(assetsDir, 'background.png'));
  result.backgroundBase64 = bg.base64;
  result.backgroundMimeType = bg.mimeType;

  progress('asset', {
    sequenceIndex: seqIndex, asset: 'background', status: 'complete',
    sizeKB: Math.round(bg.buffer.length / 1024),
  });

  // Character color
  let characterColor = '#e8a033';
  const colorMatch = direction?.match(/color:\s*(#[0-9a-fA-F]{6})/i);
  if (colorMatch) characterColor = colorMatch[1];

  // Data for the master sequence player
  result.playerData = {
    type: 'reaction',
    durationMs: seq.durationSec * 1000,
    transitionIn: seq.transitionIn || 'cut',
    charName: speaker,
    charColor: characterColor,
    portraitImgs: [`data:${portrait.mimeType || 'image/png'};base64,${portrait.base64}`],
    backgroundSrc: `data:${bg.mimeType};base64,${bg.base64}`,
  };

  return result;
}


/**
 * Generate assets for a DM description (narrator) sequence.
 * Uses a hooded sage narrator portrait with mouth variants, cached globally.
 */
async function generateDMDescriptionSequence(seq, seqDir, characterCache, styleRef, direction, opts) {
  const { progress, isCancelled, seqIndex, totalSeqs, reusedBg } = opts;
  const assetsDir = join(seqDir, 'assets');

  const result = {
    dir: seqDir,
    type: 'dm_description',
    cost: 0,
    assets: [],
    backgroundBase64: null,
    backgroundMimeType: null,
    assemblyData: null,
    playerData: null,
  };

  const speaker = 'Narrator';
  const cached = characterCache.get(speaker);

  let portrait, mouthVariants;

  if (cached) {
    console.log(`  Reusing cached narrator portrait`);
    portrait = cached.portrait;
    mouthVariants = cached.mouthVariants;
  } else {
    // ── Generate narrator portrait (hooded sage) ──
    progress('asset', { sequenceIndex: seqIndex, asset: 'portrait', status: 'generating', speaker });

    const narratorDesc = 'Hooded mysterious sage storyteller, face partially obscured by deep hood, warm wise eyes visible in shadow, dark flowing robes, aged hands. Fantasy RPG dungeon master narrator character. Warm candlelight from below illuminating chin and lower face.';
    portrait = await generateCharacterPortrait(
      speaker,
      narratorDesc,
      { savePath: join(assetsDir, 'portrait.png') }
    );
    result.cost += 0.04;
    result.assets.push(join(assetsDir, 'portrait.png'));

    progress('asset', {
      sequenceIndex: seqIndex, asset: 'portrait', status: 'complete',
      sizeKB: Math.round(portrait.buffer.length / 1024),
      thumbnailBase64: portrait.base64.substring(0, 2000),
    });

    if (isCancelled()) throw new Error('Generation cancelled');

    // ── Generate mouth variants ──
    progress('asset', { sequenceIndex: seqIndex, asset: 'mouthVariants', status: 'generating' });

    mouthVariants = await generateMouthVariants(
      portrait.buffer,
      portrait.mimeType,
      { saveDir: assetsDir }
    );
    result.cost += mouthVariants.length * 0.04;
    for (const v of mouthVariants) {
      result.assets.push(join(assetsDir, `portrait-${v.label}.png`));
    }

    progress('asset', {
      sequenceIndex: seqIndex, asset: 'mouthVariants', status: 'complete',
      count: mouthVariants.length,
    });

    if (isCancelled()) throw new Error('Generation cancelled');

    // Cache globally — narrator is reused across all DM sequences
    characterCache.set(speaker, { portrait, mouthVariants, portraitDescription: 'Narrator' });
  }

  // ── Generate or reuse background ──
  let bg;

  if (reusedBg) {
    console.log(`  Reusing background for narrator (from earlier sequence)`);
    bg = { base64: reusedBg.base64, mimeType: reusedBg.mimeType, buffer: Buffer.from(reusedBg.base64, 'base64') };
    result.backgroundBase64 = bg.base64;
    result.backgroundMimeType = bg.mimeType;
    progress('asset', { sequenceIndex: seqIndex, asset: 'background', status: 'complete', reused: true });
  } else {
    progress('asset', { sequenceIndex: seqIndex, asset: 'background', status: 'generating' });
    await sleep(15000);

    const bgDesc = seq.backgroundDescription || `fantasy scene, ${seq.backgroundMood || 'neutral'} atmosphere`;
    bg = await generateSceneBackground(
      bgDesc,
      seq.backgroundMood || 'neutral',
      { savePath: join(assetsDir, 'background.png') }
    );
    result.cost += 0.04;
    result.assets.push(join(assetsDir, 'background.png'));
    result.backgroundBase64 = bg.base64;
    result.backgroundMimeType = bg.mimeType;

    progress('asset', {
      sequenceIndex: seqIndex, asset: 'background', status: 'complete',
      sizeKB: Math.round(bg.buffer.length / 1024),
      thumbnailBase64: bg.base64.substring(0, 2000),
    });
  }

  // ── Build data structures ──
  const portraitFrames = [
    { base64: portrait.base64, mimeType: portrait.mimeType },
  ];
  for (const v of mouthVariants) {
    portraitFrames.push({ base64: v.base64, mimeType: v.mimeType });
  }
  while (portraitFrames.length < 3) {
    portraitFrames.push(portraitFrames[portraitFrames.length - 1]);
  }

  const dialogueLines = (seq.dialogueLines || []).map(line => ({
    text: line.text,
    speed: Math.round(BASE_MS_PER_CHAR * READING_SPEED_MULTIPLIER),
  }));

  if (dialogueLines.length === 0) {
    dialogueLines.push({ text: '...', speed: Math.round(BASE_MS_PER_CHAR * READING_SPEED_MULTIPLIER) });
  }

  // Narrator uses a muted gold color for the dialogue box
  const characterColor = '#8B7355';

  result.assemblyData = {
    portraitFrames,
    backgroundBase64: bg.base64,
    backgroundMimeType: bg.mimeType,
    characterName: 'DM',
    characterColor,
    backgroundMood: seq.backgroundMood || 'mysterious',
    sceneTitle: 'DM Narration — D&D Shorts',
    dialogueLines,
    mouthCycleMs: 150,
    linePauseMs: 2000,
  };

  result.playerData = {
    type: 'dialogue', // Renders identically to dialogue in the player
    durationMs: seq.durationSec * 1000,
    transitionIn: seq.transitionIn || 'cut',
    charName: 'DM',
    charColor: characterColor,
    portraitImgs: portraitFrames.map(f => `data:${f.mimeType || 'image/png'};base64,${f.base64}`),
    backgroundSrc: `data:${bg.mimeType};base64,${bg.base64}`,
    dialogueLines,
    mouthCycleMs: 150,
    linePauseMs: 2000,
  };

  return result;
}


/**
 * Generate an impact sequence — pure CSS/HTML effect, no Gemini calls.
 * Returns immediately (synchronous).
 */
function generateImpactSequence(seq, seqDir) {
  // import is at top of file

  const effectName = seq.effectName || 'flash_white';
  const customText = seq.customText || null;
  const durationSec = seq.durationSec || 1;

  const effect = getImpactEffect(effectName, { customText, durationSec });

  const htmlPath = join(seqDir, 'scene.html');
  writeFileSync(htmlPath, effect.html);

  console.log(`  Impact effect: ${effectName}${customText ? ` "${customText}"` : ''} (${durationSec}s)`);

  return {
    dir: seqDir,
    type: 'impact',
    cost: 0,
    assets: [htmlPath],
    backgroundBase64: null,
    backgroundMimeType: null,
    html: htmlPath,
    playerData: {
      type: 'impact',
      durationMs: durationSec * 1000,
      transitionIn: seq.transitionIn || 'cut',
      effectName,
      customText,
    },
  };
}


/**
 * Extract a character description from user direction text for portrait generation.
 */
function extractCharacterDescription(name, direction) {
  if (!direction) return `a fantasy RPG character named ${name}, dramatic lighting, expressive face`;

  const descPatterns = [
    new RegExp(`${name}\\s+(?:is|looks like|appears as)\\s+(.+?)(?:\\.|$)`, 'i'),
    new RegExp(`${name}:\\s*(.+?)(?:\\.|$)`, 'i'),
  ];

  for (const pattern of descPatterns) {
    const match = direction.match(pattern);
    if (match) return match[1].trim();
  }

  // If direction has substantial text but no name-specific match, use it all
  if (direction.length > 20) return direction;

  return `a fantasy RPG character named ${name}, dramatic lighting, expressive face`;
}
