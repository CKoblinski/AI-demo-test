import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import {
  generateCharacterPortrait,
  generateMouthVariants,
  generateSceneBackground,
} from './pixel-art-generator.js';
import { assembleAnimatedDialogueScene } from './assemble-scene.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Reading speed multiplier — people need more time to read pixel-art typewriter text
const READING_SPEED_MULTIPLIER = 1.25;
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
 * @returns {object} Result with file paths and metadata
 */
export async function buildPixelScene({ moment, direction, cues, outDir, onProgress }) {
  const progress = onProgress || (() => {});
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
    sceneTitle,
    dialogueLines: adjustedLines,
    mouthCycleMs: 150,
    linePauseMs: 1500,
  });

  const htmlPath = join(outDir, 'scene.html');
  writeFileSync(htmlPath, html);
  result.html = htmlPath;

  progress('assembly', { status: 'complete', sizeKB: Math.round(html.length / 1024) });

  // ─── Step 5: Export video ───

  progress('export', { status: 'exporting' });
  const exportStart = Date.now();

  // Calculate duration based on dialogue length + reading speed
  let totalTextTime = 0;
  for (const line of adjustedLines) {
    totalTextTime += line.text.length * line.speed; // ms
  }
  totalTextTime += (adjustedLines.length - 1) * 1500; // pauses between lines
  totalTextTime += 3000; // extra buffer at start and end
  const durationSec = Math.ceil(totalTextTime / 1000);

  try {
    const captureBin = join(__dirname, '..', 'bin', 'capture-scene.js');
    execSync(
      `node "${captureBin}" "${htmlPath}" --duration=${durationSec} --fps=12 --width=1080 --height=1920`,
      { stdio: 'pipe', timeout: 300000 }
    );

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
