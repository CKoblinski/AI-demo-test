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
 */

// Session states: uploaded → analyzing → plan_ready → generating → exporting → complete → failed
const sessions = new Map();

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
    segments: null, // the plan with animation decisions
    generationResults: null,
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

    const sessionDataPath = join(session.outDir, 'session-data', 'session.json');
    writeFileSync(sessionDataPath, JSON.stringify(parsed, null, 2));

    session.progress = { message: 'Finding highlight moments...', percent: 30 };
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

    // Build segments with animation decisions
    const segments = highlights.map((h, i) => {
      const match = findMatch(h);
      return {
        index: i,
        highlight: h,
        decision: match.decision,
        libraryMatch: match.match,
        reason: match.reason,
        concept: h.animationNotes || h.suggestedAnimationType || `${h.type} animation`,
        status: 'pending', // pending → generating → exporting → complete → failed
        animationHtml: null,
        exportFiles: null,
        error: null,
      };
    });

    session.segments = segments;
    session.stage = 'plan_ready';
    session.progress = { message: 'Plan ready for review', percent: 50 };

    // Estimate time
    const createCount = segments.filter(s => s.decision === 'CREATE').length;
    const adaptCount = segments.filter(s => s.decision === 'ADAPT').length;
    const reuseCount = segments.filter(s => s.decision === 'REUSE').length;
    // ~1min per generate, ~1min per export, reuse is instant
    session.estimatedMinutes = Math.ceil((createCount + adaptCount) * 1.5 + segments.length * 1 + 1);

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
    // Generate all animations in parallel
    const generatePromises = session.segments.map(async (seg, i) => {
      const segDir = join(session.outDir, `segment_${String(i + 1).padStart(2, '0')}_${slugify(seg.highlight.title)}`);
      mkdirSync(segDir, { recursive: true });
      seg.segDir = segDir;

      if (seg.decision === 'REUSE' && seg.libraryMatch) {
        // Copy from library
        seg.status = 'generating';
        const html = getAnimationHtml(seg.libraryMatch.id);
        if (html) {
          writeFileSync(join(segDir, 'animation.html'), html);
          seg.animationHtml = html;
          seg.status = 'generated';
          updateSegmentProgress(session);
          return;
        }
        // Fallback to CREATE if library file missing
        seg.decision = 'CREATE';
      }

      seg.status = 'generating';
      updateSegmentProgress(session);

      const result = await generateWithRetry({
        moment: seg.highlight,
        decision: seg.decision,
        concept: seg.concept,
        adaptFromId: seg.decision === 'ADAPT' && seg.libraryMatch ? seg.libraryMatch.id : undefined,
        exampleId,
      });

      if (result.valid) {
        writeFileSync(join(segDir, 'animation.html'), result.html);
        seg.animationHtml = result.html;
        seg.status = 'generated';
      } else {
        seg.status = 'failed';
        seg.error = `Validation failed: ${result.errors.join(', ')}`;
        // Still save the HTML for manual inspection
        writeFileSync(join(segDir, 'animation.html'), result.html);
        seg.animationHtml = result.html;
      }
      updateSegmentProgress(session);
    });

    await Promise.all(generatePromises);

    // Export phase
    session.stage = 'exporting';
    session.progress = { message: 'Exporting videos...', percent: 75 };
    saveState(session);

    for (const seg of session.segments) {
      if (seg.status !== 'generated' && seg.status !== 'failed') continue;
      if (!seg.segDir || !existsSync(join(seg.segDir, 'animation.html'))) continue;

      seg.status = 'exporting';
      updateSegmentProgress(session);

      try {
        const htmlPath = join(seg.segDir, 'animation.html');
        await exportAnimation(htmlPath, seg.segDir, {
          fps: 5, webm: true, mp4: true, mov: false,
        });
        seg.status = 'complete';
        seg.exportFiles = {
          html: 'animation.html',
          webm: 'animation.webm',
          mp4: 'animation.mp4',
          peakFrame: 'peak-frame.png',
          thumbnail: 'thumbnail.png',
        };
      } catch (err) {
        seg.status = 'export_failed';
        seg.error = `Export failed: ${err.message}`;
      }

      updateSegmentProgress(session);
    }

    // Write director's notes for each segment
    for (const seg of session.segments) {
      if (!seg.segDir) continue;
      const notes = generateDirectorsNotes(seg);
      writeFileSync(join(seg.segDir, 'directors-notes.md'), notes);
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
 * Regenerate a single rejected segment.
 */
export async function regenerateSegment(sessionId, segmentIndex, rationale) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const seg = session.segments[segmentIndex];
  if (!seg) throw new Error(`Segment ${segmentIndex} not found`);

  seg.status = 'generating';
  seg.error = null;
  updateSegmentProgress(session);
  saveState(session);

  const library = listAnimations();
  const exampleId = library.length > 0 ? library[0].id : null;

  try {
    const result = await generateWithRetry({
      moment: seg.highlight,
      decision: 'CREATE', // Always create fresh on regeneration
      concept: seg.concept,
      rejectionFeedback: rationale,
      exampleId,
    });

    if (result.valid || result.html) {
      writeFileSync(join(seg.segDir, 'animation.html'), result.html);
      seg.animationHtml = result.html;
      seg.status = 'generated';
    }

    // Re-export
    seg.status = 'exporting';
    updateSegmentProgress(session);

    try {
      await exportAnimation(join(seg.segDir, 'animation.html'), seg.segDir, {
        fps: 5, webm: true, mp4: true, mov: false,
      });
      seg.status = 'complete';
      seg.exportFiles = {
        html: 'animation.html',
        webm: 'animation.webm',
        mp4: 'animation.mp4',
        peakFrame: 'peak-frame.png',
        thumbnail: 'thumbnail.png',
      };
    } catch (err) {
      seg.status = 'export_failed';
      seg.error = `Export failed: ${err.message}`;
    }

    // Rewrite director's notes
    const notes = generateDirectorsNotes(seg);
    writeFileSync(join(seg.segDir, 'directors-notes.md'), notes);

    updateSegmentProgress(session);
    saveState(session);

  } catch (err) {
    seg.status = 'failed';
    seg.error = err.message;
    updateSegmentProgress(session);
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

function updateSegmentProgress(session) {
  const total = session.segments.length;
  const done = session.segments.filter(s => s.status === 'complete' || s.status === 'export_failed').length;
  const generating = session.segments.filter(s => s.status === 'generating').length;
  const exporting = session.segments.filter(s => s.status === 'exporting').length;

  let message = '';
  if (generating > 0) message = `Generating animations (${done}/${total} done)...`;
  else if (exporting > 0) message = `Exporting videos (${done}/${total} done)...`;
  else message = `${done}/${total} segments complete`;

  const percent = 55 + Math.floor((done / total) * 45);
  session.progress = { message, percent };
}

function generateDirectorsNotes(seg) {
  const h = seg.highlight;
  const startMin = Math.floor((h.startTime || 0) / 60);
  const startSec = Math.floor((h.startTime || 0) % 60);
  const endMin = Math.floor((h.endTime || 0) / 60);
  const endSec = Math.floor((h.endTime || 0) % 60);

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

## Animation
**Decision:** ${seg.decision}
**Concept:** ${seg.concept}
${seg.libraryMatch ? `**Based on:** ${seg.libraryMatch.name}` : ''}

## Premiere Pro Import
- **WebM overlay:** Import \`animation.webm\` above your footage — alpha channel makes background transparent
- **MP4 blend mode:** Import \`animation.mp4\`, set blend mode to "Screen" or "Add" — black disappears
- **Still frame:** Use \`peak-frame.png\` for thumbnails or title cards
`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
