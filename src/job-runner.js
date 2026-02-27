import { parseVTT } from './parse-vtt.js';
import { findHighlights } from './find-highlights.js';
import { generateWithRetry } from './generate-animation.js';
import { exportAnimation } from './export-animation.js';
import { findMatch, getAnimationHtml, listAnimations } from './library.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync, cpSync } from 'fs';
import { join, resolve } from 'path';
import archiver from 'archiver';
import { createWriteStream } from 'fs';

/**
 * In-process job runner for the pipeline.
 * Manages session state and runs background tasks.
 *
 * Data model:
 *   session.segments[i] = {
 *     index, highlight, segDir, status,
 *     animations: [{
 *       order, concept, emotion, suggestedType, durationWeight,
 *       decision, libraryMatch, reason,
 *       status, animDir, animationHtml, exportFiles, error
 *     }, ...]
 *   }
 */

// Session states: uploaded → analyzing → plan_ready → generating → exporting → complete → failed
const sessions = new Map();

const INTER_ANIMATION_DELAY_MS = 35000; // 35s between API calls to stay under rate limit

/**
 * Create a new session from an uploaded VTT file.
 */
export function createSession(vttPath, userContext = '') {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const outDir = join('output', `session_${id}`);
  mkdirSync(join(outDir, 'session-data'), { recursive: true });

  const session = {
    id,
    stage: 'uploaded',
    vttPath: resolve(vttPath),
    userContext,
    outDir: resolve(outDir),
    createdAt: new Date().toISOString(),
    error: null,
    progress: { message: 'Uploaded', percent: 0 },
    parsedSession: null,
    highlights: null,
    segments: null,
    estimatedMinutes: null,
  };

  sessions.set(id, session);
  saveState(session);
  return session;
}

/**
 * Get session by ID.
 */
export function getSession(id) {
  return sessions.get(id) || null;
}

/**
 * List all sessions.
 */
export function listSessions() {
  return Array.from(sessions.values()).map(s => ({
    id: s.id,
    stage: s.stage,
    createdAt: s.createdAt,
    error: s.error,
    progress: s.progress,
    segmentCount: s.segments?.length || 0,
  }));
}

/**
 * Save session state to disk.
 */
function saveState(session) {
  const statePath = join(session.outDir, 'state.json');
  const safe = { ...session };
  delete safe.parsedSession; // too large for state file
  writeFileSync(statePath, JSON.stringify(safe, null, 2));
}

/**
 * Run the analysis phase (parse + highlights).
 * Runs in background — updates session state as it progresses.
 */
export async function runAnalysis(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  session.stage = 'analyzing';
  session.progress = { message: 'Parsing transcript...', percent: 10 };
  saveState(session);

  try {
    // Parse VTT
    const parsed = parseVTT(session.vttPath);
    session.parsedSession = parsed;

    // Validate we got actual content
    if (!parsed.cues || parsed.cues.length === 0) {
      throw new Error(
        'VTT file parsed but contained 0 dialogue cues. ' +
        'Make sure this is a Zoom transcript VTT file (not a caption-only or empty file).'
      );
    }

    if (parsed.cues.length < 10) {
      console.warn(`Warning: Only ${parsed.cues.length} cues found — transcript may be too short for meaningful highlights.`);
    }

    console.log(`Parsed ${parsed.cues.length} cues, ${parsed.speakers.length} speakers, duration ${parsed.duration}`);

    const sessionDataPath = join(session.outDir, 'session-data', 'session.json');
    writeFileSync(sessionDataPath, JSON.stringify(parsed, null, 2));

    session.progress = { message: `Finding highlight moments (${parsed.cues.length} cues)...`, percent: 30 };
    saveState(session);

    // Find highlights
    const highlights = await findHighlights(parsed, { userContext: session.userContext });

    const highlightsPath = join(session.outDir, 'session-data', 'highlights.json');
    writeFileSync(highlightsPath, JSON.stringify({
      sessionFile: parsed.sessionFile,
      analyzedAt: new Date().toISOString(),
      userContext: session.userContext,
      highlights,
    }, null, 2));

    session.highlights = highlights;

    // Build segments with nested animations
    const segments = highlights.map((h, i) => {
      // Get animation sequence from highlight (new format)
      // Fallback to single-item array from old fields
      const animSequence = h.animationSequence || [
        {
          order: 1,
          concept: h.animationNotes || h.suggestedAnimationType || `${h.type} animation`,
          emotion: h.emotionalArc || 'unknown',
          suggestedType: h.suggestedAnimationType || h.type,
          durationWeight: 1.0,
        }
      ];

      const animations = animSequence.map((seqItem, ai) => {
        const match = findMatch(seqItem, h.type);
        return {
          order: seqItem.order || ai + 1,
          concept: seqItem.concept,
          emotion: seqItem.emotion || '',
          suggestedType: seqItem.suggestedType || h.type,
          durationWeight: seqItem.durationWeight || (1 / animSequence.length),
          decision: match.decision,
          libraryMatch: match.match,
          reason: match.reason,
          status: 'pending',
          animDir: null,
          animationHtml: null,
          exportFiles: null,
          error: null,
        };
      });

      return {
        index: i,
        highlight: h,
        animations,
        segDir: null,
        status: 'pending',
      };
    });

    session.segments = segments;
    session.stage = 'plan_ready';
    session.progress = { message: 'Plan ready for review', percent: 50 };

    // Estimate time — count animations, not segments
    const totalAnims = segments.reduce((sum, s) => sum + s.animations.length, 0);
    const createCount = segments.flatMap(s => s.animations).filter(a => a.decision === 'CREATE').length;
    const adaptCount = segments.flatMap(s => s.animations).filter(a => a.decision === 'ADAPT').length;
    const reuseCount = segments.flatMap(s => s.animations).filter(a => a.decision === 'REUSE').length;
    // ~1.5min per CREATE/ADAPT (generation + delay), ~1min per export, reuse is fast
    const genMinutes = (createCount + adaptCount) * 1.5;
    const exportMinutes = totalAnims * 1;
    session.estimatedMinutes = Math.ceil(genMinutes + exportMinutes + 1);

    console.log(`Plan ready: ${segments.length} clips, ${totalAnims} animations (${createCount} create, ${adaptCount} adapt, ${reuseCount} reuse)`);
    console.log(`Estimated time: ~${session.estimatedMinutes} minutes`);

    saveState(session);
  } catch (err) {
    session.stage = 'failed';
    session.error = err.message;
    session.progress = { message: `Analysis failed: ${err.message}`, percent: 0 };
    saveState(session);
    throw err;
  }
}

/**
 * Run generation + export for all approved segments.
 * Processes animations SEQUENTIALLY to respect rate limits.
 */
export async function runGeneration(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!session.segments) throw new Error('No segments to generate');

  session.stage = 'generating';
  session.progress = { message: 'Generating animations...', percent: 55 };
  saveState(session);

  const library = listAnimations();
  const exampleId = library.length > 0 ? library[0].id : null;

  try {
    let animIndex = 0;
    const totalAnims = session.segments.reduce((sum, s) => sum + s.animations.length, 0);

    // Process segments sequentially
    for (const seg of session.segments) {
      const segDir = join(session.outDir, `segment_${String(seg.index + 1).padStart(2, '0')}_${slugify(seg.highlight.title)}`);
      mkdirSync(segDir, { recursive: true });
      seg.segDir = segDir;

      // Process each animation sequentially (rate limit compliance)
      for (const anim of seg.animations) {
        animIndex++;
        const animDir = join(segDir, `anim_${String(anim.order).padStart(2, '0')}_${slugify(anim.concept)}`);
        mkdirSync(animDir, { recursive: true });
        anim.animDir = animDir;

        // REUSE: copy from library
        if (anim.decision === 'REUSE' && anim.libraryMatch) {
          anim.status = 'generating';
          updateAnimProgress(session, animIndex, totalAnims);

          const html = getAnimationHtml(anim.libraryMatch.id);
          if (html) {
            writeFileSync(join(animDir, 'animation.html'), html);
            anim.animationHtml = html;
            anim.status = 'generated';
            console.log(`  Reused: ${anim.libraryMatch.name} → ${anim.concept}`);
            updateAnimProgress(session, animIndex, totalAnims);
            continue;
          }
          // Fallback to CREATE if library file missing
          anim.decision = 'CREATE';
        }

        // ADAPT or CREATE: call Sonnet API
        anim.status = 'generating';
        updateAnimProgress(session, animIndex, totalAnims);
        saveState(session);

        // Wait between API calls to respect rate limits
        if (animIndex > 1) {
          console.log(`  Waiting ${INTER_ANIMATION_DELAY_MS / 1000}s for rate limit...`);
          await sleep(INTER_ANIMATION_DELAY_MS);
        }

        try {
          const result = await generateWithRetry({
            moment: seg.highlight,
            decision: anim.decision,
            concept: anim.concept,
            adaptFromId: anim.decision === 'ADAPT' && anim.libraryMatch ? anim.libraryMatch.id : undefined,
            exampleId,
          });

          if (result.valid) {
            writeFileSync(join(animDir, 'animation.html'), result.html);
            anim.animationHtml = result.html;
            anim.status = 'generated';
            console.log(`  Generated: ${anim.concept.substring(0, 50)}... (valid)`);
          } else {
            // Still save for manual inspection
            writeFileSync(join(animDir, 'animation.html'), result.html);
            anim.animationHtml = result.html;
            anim.status = 'generated'; // allow export attempt even with validation warnings
            console.warn(`  Generated with warnings: ${result.errors.join(', ')}`);
          }
        } catch (err) {
          anim.status = 'failed';
          anim.error = err.message;
          console.error(`  Failed: ${anim.concept.substring(0, 50)}... — ${err.message}`);
        }

        updateAnimProgress(session, animIndex, totalAnims);
        saveState(session);
      }

      // Update segment-level status
      seg.status = seg.animations.every(a => a.status === 'generated' || a.status === 'complete')
        ? 'generated' : 'partial';
    }

    // Export phase
    session.stage = 'exporting';
    session.progress = { message: 'Exporting videos...', percent: 75 };
    saveState(session);

    let exportIndex = 0;
    for (const seg of session.segments) {
      for (const anim of seg.animations) {
        exportIndex++;
        if (anim.status !== 'generated') continue;
        if (!anim.animDir || !existsSync(join(anim.animDir, 'animation.html'))) continue;

        anim.status = 'exporting';
        updateAnimProgress(session, exportIndex, totalAnims, 'Exporting');
        saveState(session);

        try {
          const htmlPath = join(anim.animDir, 'animation.html');
          await exportAnimation(htmlPath, anim.animDir, {
            fps: 5, webm: true, mp4: true, mov: false,
          });
          anim.status = 'complete';
          anim.exportFiles = {
            html: 'animation.html',
            webm: 'animation.webm',
            mp4: 'animation.mp4',
            peakFrame: 'peak-frame.png',
            thumbnail: 'thumbnail.png',
          };
          console.log(`  Exported: anim ${exportIndex}/${totalAnims}`);
        } catch (err) {
          anim.status = 'export_failed';
          anim.error = `Export failed: ${err.message}`;
          console.error(`  Export failed: ${err.message}`);
        }

        updateAnimProgress(session, exportIndex, totalAnims, 'Exporting');
        saveState(session);
      }

      // Write director's notes per segment (clip)
      const notes = generateDirectorsNotes(seg);
      writeFileSync(join(seg.segDir, 'directors-notes.md'), notes);

      // Update segment-level status
      seg.status = seg.animations.every(a => a.status === 'complete') ? 'complete'
        : seg.animations.some(a => a.status === 'complete') ? 'partial'
        : 'failed';
    }

    session.stage = 'complete';
    session.progress = { message: 'All done!', percent: 100 };
    saveState(session);

  } catch (err) {
    session.stage = 'failed';
    session.error = err.message;
    session.progress = { message: `Generation failed: ${err.message}`, percent: 0 };
    saveState(session);
    throw err;
  }
}

/**
 * Regenerate a single animation within a clip.
 */
export async function regenerateAnimation(sessionId, segmentIndex, animIndex, rationale) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const seg = session.segments[segmentIndex];
  if (!seg) throw new Error(`Segment ${segmentIndex} not found`);

  const anim = seg.animations[animIndex];
  if (!anim) throw new Error(`Animation ${animIndex} not found in segment ${segmentIndex}`);

  anim.status = 'generating';
  anim.error = null;
  session.stage = 'generating';
  updateAnimProgress(session, 1, 1);
  saveState(session);

  const library = listAnimations();
  const exampleId = library.length > 0 ? library[0].id : null;

  try {
    const result = await generateWithRetry({
      moment: seg.highlight,
      decision: 'CREATE', // Always create fresh on regeneration
      concept: anim.concept,
      rejectionFeedback: rationale,
      exampleId,
    });

    if (result.valid || result.html) {
      writeFileSync(join(anim.animDir, 'animation.html'), result.html);
      anim.animationHtml = result.html;
      anim.status = 'generated';
    }

    // Re-export
    anim.status = 'exporting';
    updateAnimProgress(session, 1, 1, 'Exporting');
    saveState(session);

    try {
      await exportAnimation(join(anim.animDir, 'animation.html'), anim.animDir, {
        fps: 5, webm: true, mp4: true, mov: false,
      });
      anim.status = 'complete';
      anim.exportFiles = {
        html: 'animation.html',
        webm: 'animation.webm',
        mp4: 'animation.mp4',
        peakFrame: 'peak-frame.png',
        thumbnail: 'thumbnail.png',
      };
    } catch (err) {
      anim.status = 'export_failed';
      anim.error = `Export failed: ${err.message}`;
    }

    // Update segment and session status
    seg.status = seg.animations.every(a => a.status === 'complete') ? 'complete' : 'partial';
    session.stage = 'complete';
    session.progress = { message: 'Regeneration complete', percent: 100 };
    saveState(session);

  } catch (err) {
    anim.status = 'failed';
    anim.error = err.message;
    session.stage = 'complete'; // Return to results screen
    session.progress = { message: 'Regeneration failed', percent: 100 };
    saveState(session);
    throw err;
  }
}

/**
 * Create a zip of the session output.
 */
export function createSessionZip(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const zipPath = join(session.outDir, 'package.zip');

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);

    archive.pipe(output);

    // Add all segment folders
    for (const seg of session.segments) {
      if (!seg.segDir || !existsSync(seg.segDir)) continue;
      const dirName = seg.segDir.split('/').pop();
      archive.directory(seg.segDir, dirName);
    }

    // Add session data
    const sessionDataDir = join(session.outDir, 'session-data');
    if (existsSync(sessionDataDir)) {
      archive.directory(sessionDataDir, 'session-data');
    }

    archive.finalize();
  });
}

// ── Helpers ──

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 40);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function updateAnimProgress(session, current, total, phase = 'Generating') {
  const percent = 55 + Math.floor((current / total) * 45);
  session.progress = {
    message: `${phase} animations (${current}/${total})...`,
    percent,
  };
}

function generateDirectorsNotes(seg) {
  const h = seg.highlight;
  const startMin = Math.floor((h.startTime || 0) / 60);
  const startSec = Math.floor((h.startTime || 0) % 60);
  const endMin = Math.floor((h.endTime || 0) / 60);
  const endSec = Math.floor((h.endTime || 0) % 60);

  let animSection = '';
  for (const anim of seg.animations) {
    animSection += `### Beat ${anim.order}: ${anim.concept}
**Decision:** ${anim.decision}
**Emotion:** ${anim.emotion || 'N/A'}
**Duration Weight:** ${Math.round((anim.durationWeight || 0) * 100)}%
${anim.libraryMatch ? `**Based on:** ${anim.libraryMatch.name}` : ''}
${anim.status === 'complete' ? '**Status:** Exported' : `**Status:** ${anim.status}`}

`;
  }

  return `# ${h.title}

## The Moment
**Timestamp:** ${pad(startMin)}:${pad(startSec)} → ${pad(endMin)}:${pad(endSec)}
**Type:** ${h.type}
**Emotional Arc:** ${h.emotionalArc || 'N/A'}
**Duration:** ~${h.estimatedClipDuration || 20}s

## Context
${h.contextForViewers || 'N/A'}

## Why This Moment
${h.whyItsGood || 'N/A'}

## Animations (${seg.animations.length} beats)

${animSection}

## Premiere Pro Import
For each animation beat:
- **WebM overlay:** Import \`animation.webm\` above your footage — alpha channel makes background transparent
- **MP4 blend mode:** Import \`animation.mp4\`, set blend mode to "Screen" or "Add" — black disappears
- **Still frame:** Use \`peak-frame.png\` for thumbnails or title cards

Arrange beats sequentially in your timeline. Each beat's duration weight tells you the relative timing.
`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
