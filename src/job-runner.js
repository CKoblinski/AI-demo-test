import { parseVTT } from './parse-vtt.js';
import { findHighlights } from './find-highlights.js';
import { generateWithRetry } from './generate-animation.js';
import { exportAnimation } from './export-animation.js';
import { findMatch, getAnimationHtml, listAnimations } from './library.js';
import { buildPixelScene, buildMomentSequences, regenerateSingleSequence, reconstructPlayerData, readBackgroundFromDisk } from './pixel-art-scene-builder.js';
import { runDirectorPipeline, rewriteSingleSequence } from './sequence-director.js';
import { assembleSequencePlayerScene } from './assemble-scene.js';
import { migrateFromCharactersJson, extractEntities, addBackground } from './knowledge.js';
import { generateSessionSummary } from './session-summary.js';
import { sanitizeStoryboardDescriptions } from './prompt-sanitizer.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync, cpSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import { createWriteStream } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Session states: uploaded → analyzing → plan_ready → planning → storyboard_ready → generating → exporting → complete → failed
const sessions = new Map();

const INTER_ANIMATION_DELAY_MS = 10000; // 10s between API calls (Tier 2 rate limits)

/**
 * Create a new session from an uploaded VTT file.
 */
export function createSession(vttPath, userContext = '', analysisModel = '') {
  const now = new Date();
  const dateStr = now.toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\..+/, '');
  // e.g. "2026-02-27_14-30-05"
  const shortRand = Math.random().toString(36).slice(2, 6);
  const id = `${dateStr}_${shortRand}`;
  const outDir = join('output', `session_${id}`);
  mkdirSync(join(outDir, 'session-data'), { recursive: true });

  const session = {
    id,
    stage: 'uploaded',
    vttPath: resolve(vttPath),
    userContext,
    analysisModel: analysisModel || 'claude-opus-4-6',
    outDir: resolve(outDir),
    createdAt: new Date().toISOString(),
    error: null,
    progress: { message: 'Uploaded', percent: 0 },
    parsedSession: null,
    highlights: null,
    sessionSummary: null,
    segments: null,
    campaignIds: null,  // null = load all campaigns, [] = none, ['id'] = specific
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
    hasSessionSummary: !!s.sessionSummary,
    analysisModel: s.analysisModel || '',
    momentTitle: s.highlights?.[s.selectedMoment]?.title || null,
    totalCost: s.generation?.totalCost || null,
  }));
}

/**
 * Delete session from in-memory map.
 * Files on disk are preserved for manual recovery.
 */
export function deleteSession(id) {
  sessions.delete(id);
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

    session.progress = { message: `Finding highlights + summarizing session (${parsed.cues.length} cues)...`, percent: 30 };
    saveState(session);

    // Run highlight finding AND session summary in parallel
    // Session summary analyzes the DM's recap (~50 cues) — fast and cheap
    // This adds zero wall-clock time since both run concurrently
    const [highlights, sessionSummary] = await Promise.all([
      findHighlights(parsed, { userContext: session.userContext, model: session.analysisModel }),
      generateSessionSummary(parsed, { campaignIds: session.campaignIds }).catch(err => {
        // Non-fatal — log and continue without summary
        console.warn(`Session summary failed (non-fatal): ${err.message}`);
        return null;
      }),
    ]);

    const highlightsPath = join(session.outDir, 'session-data', 'highlights.json');
    writeFileSync(highlightsPath, JSON.stringify({
      sessionFile: parsed.sessionFile,
      analyzedAt: new Date().toISOString(),
      userContext: session.userContext,
      highlights,
    }, null, 2));

    // Save session summary if generated
    if (sessionSummary) {
      const summaryPath = join(session.outDir, 'session-data', 'session-summary.json');
      writeFileSync(summaryPath, JSON.stringify(sessionSummary, null, 2));
      console.log(`Session summary saved (${Object.keys(sessionSummary.properNounTranslations || {}).length} proper nouns translated)`);
    }

    session.highlights = highlights;
    session.sessionSummary = sessionSummary;

    // ── Auto-entity extraction (Knowledge System) ──
    try {
      // Ensure characters.json is migrated to knowledge base on first run
      migrateFromCharactersJson();

      // Extract new NPCs/locations/creatures from DM lines
      session.progress = { message: 'Extracting entities from transcript...', percent: 40 };
      saveState(session);

      const newEntities = await extractEntities(parsed.cues, { sessionId: session.id, speakers: parsed.speakers });
      if (newEntities.length > 0) {
        session.extractedEntities = newEntities;
        console.log(`Extracted ${newEntities.length} new entities from transcript`);
      }
    } catch (entityErr) {
      // Non-fatal — log and continue
      console.warn(`Entity extraction failed (non-fatal): ${entityErr.message}`);
    }

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
 * Cancel an in-progress pixel art generation.
 * Sets a flag that runPixelGeneration checks between steps.
 */
export function cancelGeneration(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  session.cancelled = true;

  // Return to the appropriate stage so user can re-submit
  if (session.stage === 'generating') {
    // If we had a storyboard, return to storyboard_ready so they can re-approve
    // Otherwise return to plan_ready (moment selector)
    if (session.storyboard) {
      session.stage = 'storyboard_ready';
      session.progress = { message: 'Generation cancelled — review storyboard to try again', percent: 55 };
    } else {
      session.stage = 'plan_ready';
      session.progress = { message: 'Generation cancelled — pick a moment to try again', percent: 50 };
    }
    session.generation = null;
    saveState(session);
  }

  return session;
}

/**
 * Run the Director AI to plan sequences for a selected moment.
 * Creates a storyboard that the user reviews before generation.
 */
export async function runDirector(sessionId, momentIndex, direction = '') {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!session.highlights) throw new Error('No highlights available');

  const moment = session.highlights[momentIndex];
  if (!moment) throw new Error(`Invalid moment index: ${momentIndex}`);

  session.selectedMoment = momentIndex;
  session.direction = direction;
  session.stage = 'planning';
  session.progress = { message: 'Building scene context...', percent: 51 };
  saveState(session);

  try {
    const { plan, qcResult, creativeResult, sceneContext } = await runDirectorPipeline({
      moment,
      direction,
      cues: session.parsedSession?.cues || [],
      sceneContext: session.sceneContext || null,  // Reuse cached scene context if same moment
      sessionSummary: session.sessionSummary || null,
      onProgress: (step, message) => {
        const percentMap = {
          scene_context: 52,
          planning: 53,
          technical_qc: 54,
          creative_qc: 54.5,
          retry: 53,
        };
        session.progress = { message, percent: percentMap[step] || 53 };
        saveState(session);
      },
    });

    // Cache scene context for potential re-plans
    session.sceneContext = sceneContext;

    session.storyboard = {
      plan,
      qcResult,
      creativeResult,
      sceneContext,
      approved: false,
      createdAt: new Date().toISOString(),
    };
    session.stage = 'storyboard_ready';
    session.progress = { message: 'Storyboard ready for review', percent: 55 };
    saveState(session);

    return session.storyboard;
  } catch (err) {
    session.stage = 'plan_ready'; // Return to moment selector on failure
    session.error = err.message;
    session.progress = { message: `Director AI failed: ${err.message}`, percent: 50 };
    saveState(session);
    throw err;
  }
}

/**
 * Run pixel art generation for a selected moment.
 * Uses multi-sequence pipeline if a storyboard exists (Director AI flow),
 * otherwise falls back to the legacy single-scene pipeline.
 */
export async function runPixelGeneration(sessionId, momentIndex, direction = '') {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!session.highlights) throw new Error('No highlights available');

  const moment = session.highlights[momentIndex];
  if (!moment) throw new Error(`Invalid moment index: ${momentIndex}`);

  session.selectedMoment = momentIndex;
  session.direction = direction;
  session.stage = 'generating';
  session.cancelled = false;

  const sceneDir = join(session.outDir, `moment_${String(momentIndex + 1).padStart(2, '0')}_${slugify(moment.title)}`);

  // ── Multi-sequence pipeline (Director AI flow) ──
  if (session.storyboard && session.storyboard.plan && session.storyboard.plan.sequences) {
    const seqCount = session.storyboard.plan.sequences.length;
    session.generation = {
      status: 'generating',
      currentSequence: 0,
      totalSequences: seqCount,
      sequences: session.storyboard.plan.sequences.map((s, i) => ({
        order: i + 1,
        type: s.type,
        speaker: s.speaker,
        status: 'pending',
        assets: {},
        cost: 0,
      })),
      assembly: { status: 'pending' },
      export: { status: 'pending' },
      totalCost: 0,
    };
    session.progress = { message: `Generating ${seqCount} sequences...`, percent: 55 };
    saveState(session);

    // ─── QA-1: Prompt Sanitizer ───
    // Catch raw proper nouns in description fields before they reach Gemini.
    // Zero cost — pure string matching. The Director is instructed to use visual
    // translations, but this validates it actually did.
    const translations = session.sessionSummary?.properNounTranslations || {};
    if (Object.keys(translations).length > 0 && session.storyboard?.plan?.sequences) {
      const sanitizerReport = sanitizeStoryboardDescriptions(session.storyboard, translations);
      if (sanitizerReport.totalReplacements > 0) {
        console.log(`  Prompt Sanitizer: ${sanitizerReport.totalReplacements} substitution(s) made:`);
        for (const sub of sanitizerReport.substitutions) {
          console.log(`    → seq ${sub.order} [${sub.field}]: "${sub.noun}" replaced`);
        }
        // Save the updated storyboard with sanitized descriptions
        saveState(session);
      } else {
        console.log('  Prompt Sanitizer: All descriptions clean — no raw proper nouns detected');
      }
    }

    try {
      const result = await buildMomentSequences({
        storyboard: session.storyboard,
        moment,
        direction,
        cues: session.parsedSession?.cues || [],
        outDir: sceneDir,
        sceneContext: session.sceneContext || session.storyboard?.sceneContext || null,
        checkCancelled: () => session.cancelled === true,
        onProgress: (step, data) => {
          if (step === 'plan') {
            session.progress = { message: `Starting ${data.totalSequences} sequences (~${data.totalDurationSec}s)...`, percent: 55 };
          } else if (step === 'sequence') {
            const seqInfo = session.generation.sequences[data.sequenceIndex];
            if (seqInfo) {
              seqInfo.status = data.status;
              if (data.cost) seqInfo.cost = data.cost;
            }
            session.generation.currentSequence = data.sequenceIndex;
            if (data.status === 'generating') {
              const pct = 55 + Math.floor((data.sequenceIndex / data.totalSequences) * 30);
              session.progress = {
                message: `Sequence ${data.sequenceIndex + 1}/${data.totalSequences}: ${data.type}${data.speaker ? ` (${data.speaker})` : ''}...`,
                percent: pct,
              };
            } else if (data.status === 'complete' || data.status === 'qa_failed') {
              session.generation.totalCost = session.generation.sequences.reduce((s, sq) => s + (sq.cost || 0), 0);
              if (data.qaFailed) {
                seqInfo.status = 'qa_failed';
                seqInfo.qaReason = data.qaReason;
              }
            }
          } else if (step === 'asset') {
            // Per-asset progress within a sequence
            const seqInfo = session.generation.sequences[data.sequenceIndex];
            if (seqInfo) {
              seqInfo.assets[data.asset] = { status: data.status, ...(data.sizeKB ? { sizeKB: data.sizeKB } : {}) };
            }
            if (data.status === 'generating') {
              const pct = 55 + Math.floor((data.sequenceIndex / seqCount) * 30);
              const assetLabel = data.asset === 'portrait' ? `portrait for ${data.speaker || 'character'}`
                : data.asset === 'mouthVariants' ? 'mouth variants'
                : data.asset === 'background' ? 'background'
                : data.asset === 'actionFrames' ? `${data.frameCount || 3} action frames`
                : data.asset;
              session.progress = {
                message: `Seq ${data.sequenceIndex + 1}/${seqCount}: generating ${assetLabel}...`,
                percent: pct,
              };
            }
          } else if (step === 'assembly') {
            session.generation.assembly = { status: data.status };
            if (data.status === 'assembling') {
              session.progress = { message: data.detail || 'Assembling scenes...', percent: 87 };
            } else if (data.status === 'complete') {
              session.progress = { message: 'Exporting video...', percent: 90 };
            }
          } else if (step === 'export') {
            session.generation.export = { status: data.status, ...data };
            if (data.status === 'exporting') {
              const detail = data.detail || 'Exporting video (Puppeteer + ffmpeg)...';
              session.progress = { message: detail, percent: 92 };
            }
          }
          saveState(session);
        },
      });

      // Stash sequence directory paths for rerun support (small strings, safe for state.json)
      session.generation._seqDirs = result.sequences.map(sr => sr.dir || null);

      // Auto-index backgrounds in knowledge base
      try {
        indexGeneratedBackgrounds(session, result);
      } catch (bgErr) {
        console.warn(`  Background indexing failed (non-fatal): ${bgErr.message}`);
      }

      // Final state — track QA failures
      const passedSeqs = result.sequences.filter(s => !s._qaFailed).length;
      const failedSeqs = result.sequences.filter(s => s._qaFailed).length;
      const totalSeqs = result.sequences.length;

      session.generation.status = 'complete';
      session.generation.totalCost = result.totalCost;
      session.generation.qaSummary = {
        passed: passedSeqs,
        failed: failedSeqs,
        total: totalSeqs,
        failedSequences: result.sequences
          .map((s, idx) => s._qaFailed ? { index: idx, reason: s._qaReason } : null)
          .filter(Boolean),
      };

      const hasExports = result.sequenceExports?.some(e => e.mp4);
      session.generation.export = {
        status: hasExports ? 'complete' : 'failed',
        files: {
          playerHtml: result.playerHtml,
        },
        sequenceFiles: result.sequenceExports || [],
      };
      session.stage = 'complete';
      const qaMsg = failedSeqs > 0 ? ` (${passedSeqs}/${totalSeqs} passed QA, ${failedSeqs} skipped)` : '';
      session.progress = { message: `Scene complete!${qaMsg}`, percent: 100 };
      saveState(session);

    } catch (err) {
      if (session.cancelled) {
        console.log(`Generation cancelled for session ${sessionId}`);
        return;
      }
      session.generation.status = 'failed';
      session.stage = 'failed';
      session.error = err.message;
      session.progress = { message: `Generation failed: ${err.message}`, percent: 0 };
      saveState(session);
      throw err;
    }

    return;
  }

  // ── Legacy single-scene pipeline (no storyboard) ──
  session.generation = {
    status: 'generating',
    portrait: { status: 'pending' },
    mouthVariants: { status: 'pending' },
    background: { status: 'pending' },
    assembly: { status: 'pending' },
    export: { status: 'pending' },
    totalCost: 0,
  };
  session.progress = { message: 'Generating pixel art scene...', percent: 55 };
  saveState(session);

  try {
    const result = await buildPixelScene({
      moment,
      direction,
      cues: session.parsedSession?.cues || [],
      outDir: sceneDir,
      checkCancelled: () => session.cancelled === true,
      onProgress: (step, data) => {
        // Update session.generation with per-asset progress
        if (step === 'parsed') {
          session.progress = { message: `Generating portrait for ${data.characterName}...`, percent: 58 };
        } else if (step === 'portrait') {
          session.generation.portrait = { ...session.generation.portrait, ...data };
          if (data.status === 'complete') {
            session.generation.totalCost += 0.04;
            session.progress = { message: 'Generating mouth variants...', percent: 65 };
          }
        } else if (step === 'mouthVariants') {
          session.generation.mouthVariants = { ...session.generation.mouthVariants, ...data };
          if (data.status === 'complete') {
            session.generation.totalCost += data.count * 0.04;
            session.progress = { message: 'Generating background...', percent: 75 };
          }
        } else if (step === 'background') {
          session.generation.background = { ...session.generation.background, ...data };
          if (data.status === 'complete') {
            session.generation.totalCost += 0.04;
            session.progress = { message: 'Assembling scene...', percent: 85 };
          }
        } else if (step === 'assembly') {
          session.generation.assembly = { ...session.generation.assembly, ...data };
          if (data.status === 'complete') {
            session.progress = { message: 'Exporting video...', percent: 90 };
          }
        } else if (step === 'export') {
          session.generation.export = { ...session.generation.export, ...data };
        }
        saveState(session);
      },
    });

    // Final state
    session.generation.status = 'complete';
    session.generation.totalCost = result.totalCost;
    session.generation.export.files = {
      html: result.html,
      mp4: result.mp4,
      gif: result.gif,
      portraitPng: result.portrait?.path,
      backgroundPng: result.background?.path,
      mouthVariantPngs: result.mouthVariants.map(v => v.path),
    };
    session.stage = 'complete';
    session.progress = { message: 'Scene complete!', percent: 100 };
    saveState(session);

  } catch (err) {
    // If cancelled, cancelGeneration() already set the right state
    if (session.cancelled) {
      console.log(`Generation cancelled for session ${sessionId}`);
      return;
    }
    session.generation.status = 'failed';
    session.stage = 'failed';
    session.error = err.message;
    session.progress = { message: `Generation failed: ${err.message}`, percent: 0 };
    saveState(session);
    throw err;
  }
}

/**
 * Rerun a single sequence from a completed moment.
 * Supports two modes:
 *   - 'rewrite': Director AI rewrites the sequence descriptions, then regenerates assets
 *   - 'reattempt': Same descriptions, fresh Gemini generation
 *
 * @param {string} sessionId
 * @param {number} sequenceIndex - 0-based
 * @param {string} mode - 'rewrite' or 'reattempt'
 * @param {string} instructions - User feedback text
 */
export async function rerunSequence(sessionId, sequenceIndex, mode, instructions = '') {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!session.storyboard?.plan?.sequences) throw new Error('No storyboard available');

  const sequences = session.storyboard.plan.sequences;
  if (sequenceIndex < 0 || sequenceIndex >= sequences.length) {
    throw new Error(`Invalid sequence index: ${sequenceIndex} (have ${sequences.length} sequences)`);
  }

  const moment = session.highlights?.[session.selectedMoment];
  if (!moment) throw new Error('No selected moment');

  // Set rerun state
  session.stage = 'rerunning_sequence';
  session.cancelled = false;
  session.rerun = {
    sequenceIndex,
    mode,
    instructions,
    status: 'starting',
    error: null,
  };
  session.progress = { message: `Rerunning sequence ${sequenceIndex + 1}...`, percent: 10 };
  saveState(session);

  // Locate the moment output directory
  const sceneDir = join(session.outDir, `moment_${String((session.selectedMoment || 0) + 1).padStart(2, '0')}_${slugify(moment.title)}`);

  // Locate sequence directories — prefer _seqDirs from state, fall back to scanning
  let seqDirs = session.generation?._seqDirs;
  if (!seqDirs || seqDirs.length === 0) {
    // Scan for seq_NN_* directories
    const entries = readdirSync(sceneDir, { withFileTypes: true });
    const seqEntries = entries.filter(e => e.isDirectory() && /^seq_\d+_/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    seqDirs = seqEntries.map(e => join(sceneDir, e.name));
    session.generation._seqDirs = seqDirs;
  }

  const seqDir = seqDirs[sequenceIndex];
  if (!seqDir || !existsSync(seqDir)) {
    throw new Error(`Sequence directory not found for index ${sequenceIndex}`);
  }

  try {
    // ── Step 1: Rewrite sequence if requested ──
    if (mode === 'rewrite' && instructions) {
      session.rerun.status = 'rewriting';
      session.progress = { message: `Rewriting sequence ${sequenceIndex + 1} descriptions...`, percent: 20 };
      saveState(session);

      const rewritten = await rewriteSingleSequence({
        storyboard: session.storyboard.plan,
        sequenceIndex,
        instructions,
        moment,
        cues: session.parsedSession?.cues || [],
        sceneContext: session.sceneContext || session.storyboard?.sceneContext || null,
        sessionSummary: session.sessionSummary || null,
      });

      // Update storyboard with rewritten sequence
      session.storyboard.plan.sequences[sequenceIndex] = rewritten;

      // Recalculate startOffsetSec for all sequences after the rewritten one
      let offset = 0;
      for (const seq of session.storyboard.plan.sequences) {
        seq.startOffsetSec = offset;
        offset += seq.durationSec || 0;
      }
      session.storyboard.plan.totalDurationSec = offset;

      saveState(session);
      console.log(`  Sequence ${sequenceIndex + 1} rewritten by Director AI`);
    } else if (mode === 'reattempt' && instructions) {
      // Append instructions as visualNotes addendum
      const seq = sequences[sequenceIndex];
      const note = `\n[USER FEEDBACK]: ${instructions}`;
      seq.visualNotes = (seq.visualNotes || '') + note;
      saveState(session);
    }

    // ── Step 2: Resolve background references from disk ──
    session.rerun.status = 'generating';
    session.progress = { message: `Regenerating sequence ${sequenceIndex + 1} assets...`, percent: 35 };
    saveState(session);

    const seq = sequences[sequenceIndex];

    // Resolve reuseBackgroundFrom from disk
    let reusedBg = null;
    if (seq.reuseBackgroundFrom) {
      const refIdx = seq.reuseBackgroundFrom - 1;
      if (refIdx >= 0 && refIdx < seqDirs.length && seqDirs[refIdx]) {
        const bgData = readBackgroundFromDisk(seqDirs[refIdx]);
        if (bgData) {
          reusedBg = { base64: bgData.base64, mimeType: bgData.mimeType };
          console.log(`  Reusing background from sequence ${seq.reuseBackgroundFrom} (disk)`);
        }
      }
    }

    // Resolve styleRef from previous sequence's background
    let styleRef = null;
    if (sequenceIndex > 0 && seqDirs[sequenceIndex - 1]) {
      const prevBg = readBackgroundFromDisk(seqDirs[sequenceIndex - 1]);
      if (prevBg) {
        styleRef = { base64: prevBg.base64, mimeType: prevBg.mimeType };
      }
    }

    // ── Step 3: Regenerate assets ──
    const seqResult = await regenerateSingleSequence({
      seq,
      sequenceIndex,
      seqDir,
      direction: session.direction || '',
      sceneContext: session.sceneContext || session.storyboard?.sceneContext || null,
      reusedBg,
      styleRef,
      checkCancelled: () => session.cancelled === true,
      onProgress: (step, data) => {
        if (step === 'sequence' && data.status === 'generating') {
          session.progress = { message: `Generating ${seq.type} assets...`, percent: 45 };
        } else if (step === 'asset') {
          session.progress = { message: `Generating ${data.asset}...`, percent: 50 };
        }
        saveState(session);
      },
    });

    if (session.cancelled) throw new Error('Rerun cancelled');

    // Update session generation data for this sequence
    if (session.generation?.sequences?.[sequenceIndex]) {
      session.generation.sequences[sequenceIndex].status = seqResult._qaFailed ? 'qa_failed' : 'complete';
      session.generation.sequences[sequenceIndex].cost = seqResult.cost || 0;
    }

    // ── Step 4: Reassemble master HTML ──
    session.rerun.status = 'assembling';
    session.progress = { message: 'Rebuilding sequence player...', percent: 70 };
    saveState(session);

    // Reconstruct playerData for ALL sequences from disk
    const playerSequences = [];
    for (let i = 0; i < sequences.length; i++) {
      if (i === sequenceIndex) {
        // Use the fresh seqResult's playerData
        if (seqResult.playerData && !seqResult._qaFailed) {
          playerSequences.push(seqResult.playerData);
        }
      } else {
        // Reconstruct from disk
        const dir = seqDirs[i];
        if (dir && existsSync(dir)) {
          const pd = reconstructPlayerData(dir, sequences[i]);
          if (pd) playerSequences.push(pd);
        }
      }
    }

    if (playerSequences.length > 0) {
      const totalDurationMs = sequences.reduce((sum, s) => sum + (s.durationSec * 1000), 0);
      const sceneTitle = moment.title || 'D&D Shorts';

      const playerHtml = assembleSequencePlayerScene({
        sequences: playerSequences,
        totalDurationMs,
        sceneTitle,
      });

      const playerPath = join(sceneDir, 'sequence-player.html');
      writeFileSync(playerPath, playerHtml);

      if (session.generation?.export?.files) {
        session.generation.export.files.playerHtml = playerPath;
      }

      console.log(`  Master sequence-player.html rebuilt (${Math.round(playerHtml.length / 1024)}KB)`);
    }

    // ── Step 5: Re-export sequence MP4 ──
    session.rerun.status = 'exporting';
    session.progress = { message: 'Exporting video...', percent: 80 };
    saveState(session);

    if (seqResult.html && !seqResult._qaFailed) {
      const captureBin = join(__dirname, '..', 'bin', 'capture-scene.js');
      const seqDurationSec = Math.ceil(seq.durationSec) + 1;

      try {
        await new Promise((resolve, reject) => {
          exec(
            `node "${captureBin}" "${seqResult.html}" --duration=${seqDurationSec} --fps=12 --width=1080 --height=1920 --no-gif`,
            { timeout: 120000 },
            (err, stdout, stderr) => {
              if (err) {
                console.error(`  Export stderr (rerun seq ${sequenceIndex + 1}):`, stderr);
                reject(err);
              } else {
                resolve(stdout);
              }
            }
          );
        });

        const seqMp4 = seqResult.html.replace('.html', '.mp4');
        if (existsSync(seqMp4)) {
          console.log(`  Re-exported: ${seqMp4}`);

          // Update sequenceFiles in session
          if (session.generation?.export?.sequenceFiles?.[sequenceIndex]) {
            session.generation.export.sequenceFiles[sequenceIndex].mp4 = seqMp4;
            session.generation.export.sequenceFiles[sequenceIndex].html = seqResult.html;
          }
        }
      } catch (err) {
        console.error(`  Re-export failed: ${err.message}`);
      }
    }

    // ── Step 6: Re-concatenate master MP4 ──
    session.progress = { message: 'Concatenating master video...', percent: 90 };
    saveState(session);

    const allMp4s = [];
    for (let i = 0; i < sequences.length; i++) {
      const dir = seqDirs[i];
      if (dir) {
        const mp4Path = join(dir, 'scene.mp4');
        if (existsSync(mp4Path)) allMp4s.push(mp4Path);
      }
    }

    if (allMp4s.length >= 2) {
      const concatListPath = join(sceneDir, 'concat-list.txt');
      const concatContent = allMp4s.map(f => `file '${f}'`).join('\n');
      writeFileSync(concatListPath, concatContent);

      const masterMp4Path = join(sceneDir, 'scene.mp4');
      try {
        await new Promise((resolve, reject) => {
          exec(
            `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${masterMp4Path}"`,
            { timeout: 60000 },
            (err, stdout, stderr) => {
              if (err) reject(err);
              else resolve(stdout);
            }
          );
        });
        console.log(`  Master MP4 re-concatenated: ${masterMp4Path}`);
      } catch (err) {
        console.error(`  Master MP4 concat error: ${err.message}`);
      }
    } else if (allMp4s.length === 1) {
      console.log(`  Single sequence — no concat needed`);
    }

    // ── Step 7: Finalize ──
    session.stage = 'complete';
    session.rerun.status = 'complete';
    session.progress = { message: 'Sequence rerun complete!', percent: 100 };
    // Recalculate total cost
    if (session.generation?.sequences) {
      session.generation.totalCost = session.generation.sequences.reduce((s, sq) => s + (sq.cost || 0), 0);
    }
    saveState(session);

    console.log(`  Rerun complete for session ${sessionId}, sequence ${sequenceIndex + 1}`);

  } catch (err) {
    if (session.cancelled) {
      session.stage = 'complete'; // Return to complete state so user can try again
      session.rerun.status = 'cancelled';
      session.progress = { message: 'Rerun cancelled', percent: 0 };
      saveState(session);
      return;
    }
    console.error(`  Rerun failed: ${err.message}`);
    session.stage = 'complete'; // Return to complete state so user can retry
    session.rerun = { ...session.rerun, status: 'failed', error: err.message };
    session.progress = { message: `Rerun failed: ${err.message}`, percent: 0 };
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

    // Add all legacy segment folders (ASCII pipeline)
    if (session.segments) {
      for (const seg of session.segments) {
        if (!seg.segDir || !existsSync(seg.segDir)) continue;
        const dirName = seg.segDir.split('/').pop();
        archive.directory(seg.segDir, dirName);
      }
    }

    // Add pixel art moment_* directories (new pipeline)
    try {
      const outEntries = readdirSync(session.outDir, { withFileTypes: true });
      for (const entry of outEntries) {
        if (entry.isDirectory() && entry.name.startsWith('moment_')) {
          const momentDir = join(session.outDir, entry.name);
          archive.directory(momentDir, entry.name);
          console.log(`  ZIP: Adding ${entry.name}/`);
        }
      }
    } catch (e) {
      console.warn(`  ZIP: Error scanning for moment_* dirs: ${e.message}`);
    }

    // Add top-level MP4/GIF/HTML files in outDir
    try {
      const outEntries = readdirSync(session.outDir, { withFileTypes: true });
      for (const entry of outEntries) {
        if (entry.isFile() && /\.(mp4|gif|html)$/i.test(entry.name) && entry.name !== 'package.zip') {
          archive.file(join(session.outDir, entry.name), { name: entry.name });
        }
      }
    } catch (e) { /* non-fatal */ }

    // Add session data
    const sessionDataDir = join(session.outDir, 'session-data');
    if (existsSync(sessionDataDir)) {
      archive.directory(sessionDataDir, 'session-data');
    }

    archive.finalize();
  });
}

/**
 * Update the storyboard plan with user edits from the interactive editor.
 * Replaces the plan's sequences with the edited version.
 *
 * @param {string} sessionId
 * @param {object} editedPlan - The full edited plan object (sequences, totalDurationSec, etc.)
 * @returns {object} Updated session
 */
export function updateStoryboard(sessionId, editedPlan) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!session.storyboard) throw new Error('No storyboard to update');

  // Merge user edits into the existing storyboard plan
  session.storyboard.plan.sequences = editedPlan.sequences;
  session.storyboard.plan.totalDurationSec = editedPlan.totalDurationSec ||
    editedPlan.sequences.reduce((sum, s) => sum + (s.durationSec || 0), 0);
  session.storyboard.plan.estimatedCost = editedPlan.estimatedCost ||
    session.storyboard.plan.estimatedCost;
  session.storyboard.editedAt = new Date().toISOString();

  // Recalculate startOffsets and order
  let offset = 0;
  session.storyboard.plan.sequences.forEach((seq, i) => {
    seq.order = i + 1;
    seq.startOffsetSec = offset;
    offset += seq.durationSec || 0;
  });
  session.storyboard.plan.totalDurationSec = offset;

  // Recalculate cost
  session.storyboard.plan.estimatedCost = session.storyboard.plan.sequences.reduce((sum, seq) => {
    if (seq.reuseBackgroundFrom) {
      // Reused BG saves $0.04
      if (seq.type === 'dialogue' || seq.type === 'dm_description') return sum + 0.12;
    }
    if (seq.type === 'dialogue' || seq.type === 'dm_description') return sum + 0.16;
    if (seq.type === 'close_up') return sum + 0.04 * (seq.frameCount || 3);
    if (seq.type === 'establishing_shot') return sum + 0.04;
    if (seq.type === 'impact') return sum; // $0.00
    return sum;
  }, 0);

  saveState(session);
  return session;
}

// ── Background Indexing ──

/**
 * Index generated backgrounds in the knowledge base after generation.
 * Scans sequence directories for background.png files and indexes them
 * with location/mood tags from the storyboard.
 */
function indexGeneratedBackgrounds(session, result) {
  const storyboard = session.storyboard?.plan;
  if (!storyboard?.sequences) return;

  const seqDirs = result.sequences.map(sr => sr.dir || null);
  let indexed = 0;

  for (let i = 0; i < storyboard.sequences.length; i++) {
    const seq = storyboard.sequences[i];
    const seqDir = seqDirs[i];
    if (!seqDir) continue;

    // Skip sequences that reuse backgrounds from another sequence
    if (seq.reuseBackgroundFrom != null) continue;

    // Only index types that have backgrounds
    const bgTypes = ['dialogue', 'dm_description', 'establishing_shot', 'reaction'];
    if (!bgTypes.includes(seq.type)) continue;

    const bgPath = join(seqDir, 'assets', 'background.png');
    if (!existsSync(bgPath)) continue;

    // Derive location tag from background description or mood
    const desc = seq.backgroundDescription || '';
    const locationTag = deriveLocationTag(desc);

    addBackground({
      imagePath: bgPath,
      mood: seq.backgroundMood || 'neutral',
      description: desc,
      sessionId: session.id,
      locationTag,
    });
    indexed++;
  }

  if (indexed > 0) {
    console.log(`  Knowledge: Indexed ${indexed} backgrounds`);
  }
}

/**
 * Derive a simple location tag from a background description.
 * Uses keyword matching for common D&D locations.
 */
function deriveLocationTag(description) {
  const desc = description.toLowerCase();
  const tags = [
    ['tavern', /tavern|inn|bar|pub|ale/],
    ['dungeon', /dungeon|underground|cavern|cave|tunnel/],
    ['forest', /forest|woods|trees|grove|glade/],
    ['camp', /camp|campfire|tent|bonfire/],
    ['castle', /castle|fortress|keep|throne/],
    ['temple', /temple|shrine|altar|chapel|church/],
    ['battlefield', /battlefield|arena|combat|fighting/],
    ['astral', /astral|void|cosmos|ethereal|plane/],
    ['ocean', /ocean|sea|ship|dock|port|harbor/],
    ['mountain', /mountain|cliff|peak|summit/],
    ['city', /city|town|street|market|village/],
    ['library', /library|study|books|archive/],
  ];

  for (const [tag, regex] of tags) {
    if (regex.test(desc)) return tag;
  }
  return 'unknown';
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
