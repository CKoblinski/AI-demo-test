import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

// Reading speed constants (must match pixel-art-scene-builder.js)
const BASE_MS_PER_CHAR = 55;
const READING_SPEED_MULTIPLIER = 1.6;
const MS_PER_CHAR = Math.round(BASE_MS_PER_CHAR * READING_SPEED_MULTIPLIER); // ~88ms
const LINE_PAUSE_MS = 2000;
const INITIAL_DELAY_MS = 800;
const END_BUFFER_MS = 1000;

/**
 * Build scene context from a wide transcript window around the moment.
 * Extracts setting, conflict, enemies/NPCs, spatial positioning, DM descriptions.
 *
 * @param {object} params
 * @param {object} params.moment - Highlight object
 * @param {object[]} params.cues - Full session cues array
 * @returns {Promise<object>} Scene context brief
 */
export async function buildSceneContext({ moment, cues }) {
  const client = new Anthropic();

  const promptPath = join(__dirname, '..', 'prompts', 'scene-context.md');
  const systemPrompt = readFileSync(promptPath, 'utf-8');

  // Wide window: 5 minutes buffer on each side, capped at 400 cues
  const bufferSec = 300;
  const wideCues = cues.filter(c =>
    c.start >= (moment.startTime - bufferSec) && c.start <= (moment.endTime + bufferSec)
  ).slice(0, 400);

  if (wideCues.length === 0) {
    console.log('  Scene Context: No cues in range, skipping');
    return null;
  }

  // Build transcript text with moment markers
  const lines = [];
  lines.push(`## Selected Moment: "${moment.title}"`);
  lines.push(`**Type:** ${moment.type} | **Time:** ${formatTime(moment.startTime)} → ${formatTime(moment.endTime)}`);
  lines.push(`**Emotional Arc:** ${moment.emotionalArc || 'N/A'}`);
  lines.push(`**Context:** ${moment.contextForViewers || 'N/A'}`);
  lines.push('');
  lines.push('## Transcript');

  let insideMoment = false;
  for (const c of wideCues) {
    const inMoment = c.start >= moment.startTime && c.start <= moment.endTime;
    if (inMoment && !insideMoment) {
      lines.push('── MOMENT START ──');
      insideMoment = true;
    } else if (!inMoment && insideMoment) {
      lines.push('── MOMENT END ──');
      insideMoment = false;
    }
    const ts = formatTime(c.start);
    const speaker = c.speaker ? `${c.speaker}: ` : '';
    lines.push(`[${c.id}] ${ts} ${speaker}${c.text}`);
  }
  if (insideMoment) lines.push('── MOMENT END ──');

  console.log(`  Scene Context: Analyzing ${wideCues.length} cues (${formatTime(wideCues[0].start)} → ${formatTime(wideCues[wideCues.length - 1].start)})...`);
  const startTime = Date.now();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  const durationMs = Date.now() - startTime;
  console.log(`  Scene Context: Done (${durationMs}ms)`);

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const context = parseJSON(text);
  if (!context) {
    console.warn('  Scene Context: Failed to parse response, skipping');
    return null;
  }

  console.log(`  Scene Context: Setting="${(context.setting || '').substring(0, 60)}..."`);
  return context;
}

/**
 * Plan sequences for a selected moment using Claude Sonnet as the Director AI.
 *
 * @param {object} params
 * @param {object} params.moment - Highlight object from find-highlights
 * @param {string} params.direction - User's creative direction text
 * @param {object[]} params.cues - Full session cues array
 * @param {object} [params.sceneContext] - Scene context brief from buildSceneContext
 * @returns {Promise<object>} Sequence plan: { momentTitle, totalDurationSec, estimatedCost, sequences: [...] }
 */
export async function planSequences({ moment, direction, cues, sceneContext }) {
  const client = new Anthropic();

  // Load the director prompt
  const promptPath = join(__dirname, '..', 'prompts', 'sequence-director.md');
  const systemPrompt = readFileSync(promptPath, 'utf-8');

  // Load character cards if available
  const charactersPath = join(__dirname, '..', 'data', 'characters.json');
  let characters = [];
  if (existsSync(charactersPath)) {
    try {
      characters = JSON.parse(readFileSync(charactersPath, 'utf-8')).characters || [];
    } catch (e) {
      console.warn('  Warning: Failed to load character cards:', e.message);
    }
  }

  // Build the context message with all the info the Director needs
  const contextParts = [];

  // Moment data
  contextParts.push(`## Selected Moment\n`);
  contextParts.push(`**Title:** ${moment.title}`);
  contextParts.push(`**Type:** ${moment.type}`);
  contextParts.push(`**Rank:** ${moment.rank}`);
  contextParts.push(`**Time Range:** ${formatTime(moment.startTime)} → ${formatTime(moment.endTime)} (${Math.round((moment.endTime - moment.startTime))}s)`);
  contextParts.push(`**Emotional Arc:** ${moment.emotionalArc || 'N/A'}`);
  contextParts.push(`**Why It's Good:** ${moment.whyItsGood || 'N/A'}`);
  contextParts.push(`**Context for Viewers:** ${moment.contextForViewers || 'N/A'}`);
  contextParts.push(`**Suggested Background Mood:** ${moment.suggestedBackgroundMood || 'neutral'}`);
  contextParts.push(`**Visual Concept (rough sketch):** ${moment.visualConcept || 'N/A'}`);
  contextParts.push(`**Original Cue Range:** startCue=${moment.startCue}, endCue=${moment.endCue}`);

  // Dialogue excerpt
  if (moment.dialogueExcerpt && moment.dialogueExcerpt.length > 0) {
    contextParts.push(`\n## Dialogue Excerpt (strongest lines — but curate from the FULL transcript below)`);
    for (const line of moment.dialogueExcerpt) {
      contextParts.push(`- **${line.speaker || 'Unknown'}:** "${line.text}"`);
    }
  }

  // Scene context brief (from buildSceneContext — broad transcript analysis)
  if (sceneContext) {
    contextParts.push(`\n## Scene Brief (broader transcript context)`);
    if (sceneContext.setting) contextParts.push(`**Setting:** ${sceneContext.setting}`);
    if (sceneContext.conflict) contextParts.push(`**Conflict:** ${sceneContext.conflict}`);
    if (sceneContext.enemiesAndNPCs && sceneContext.enemiesAndNPCs.length > 0) {
      contextParts.push(`**Enemies/NPCs:**`);
      for (const npc of sceneContext.enemiesAndNPCs) {
        contextParts.push(`- **${npc.name}**${npc.count ? ` (×${npc.count})` : ''}: ${npc.description}`);
      }
    }
    if (sceneContext.spatialPositioning) contextParts.push(`**Positioning:** ${sceneContext.spatialPositioning}`);
    if (sceneContext.keyParticipants) contextParts.push(`**Key Participants:** ${Array.isArray(sceneContext.keyParticipants) ? sceneContext.keyParticipants.join(', ') : sceneContext.keyParticipants}`);
    if (sceneContext.dmDescriptions && sceneContext.dmDescriptions.length > 0) {
      contextParts.push(`**DM Descriptions (use these for visual reference):**`);
      for (const desc of sceneContext.dmDescriptions) {
        contextParts.push(`- "${desc.text}"${desc.approxCueId ? ` [~cue ${desc.approxCueId}]` : ''}`);
      }
    }
    if (sceneContext.leadUp) contextParts.push(`**Lead-up:** ${sceneContext.leadUp}`);
    if (sceneContext.emotionalTemperature) contextParts.push(`**Emotional Temperature:** ${sceneContext.emotionalTemperature}`);
  }

  // Character cards — inject visual descriptions for known characters
  if (characters.length > 0) {
    // Find which speakers appear in this moment's dialogue
    const momentSpeakers = new Set();
    if (moment.dialogueExcerpt) {
      for (const line of moment.dialogueExcerpt) {
        if (line.speaker) momentSpeakers.add(line.speaker);
      }
    }
    // Also check full cue range
    if (cues && cues.length > 0 && moment.startTime !== undefined) {
      const momentCues = cues.filter(c => c.start >= moment.startTime && c.start <= moment.endTime);
      for (const c of momentCues) {
        if (c.speaker) momentSpeakers.add(c.speaker);
      }
    }

    // Filter to characters that appear in the moment (or include all if few)
    const relevantChars = characters.filter(ch =>
      momentSpeakers.has(ch.name) || characters.length <= 6
    );

    if (relevantChars.length > 0) {
      contextParts.push(`\n## Character Reference`);
      contextParts.push(`Use these descriptions for portrait prompts. Match colors for dialogue box borders.`);
      for (const ch of relevantChars) {
        let charLine = `- **${ch.name}** (${ch.race}, ${ch.class}) [border color: ${ch.color}]: ${ch.visualDescription}`;
        if (ch.conditionalFeatures) {
          const features = Object.entries(ch.conditionalFeatures)
            .map(([feature, condition]) => `${feature}: ${condition}`)
            .join('; ');
          charLine += ` | CONDITIONAL: ${features}`;
        }
        contextParts.push(charLine);
      }
    }
  }

  // Rough animation sequence hint from highlight finder
  if (moment.animationSequence && moment.animationSequence.length > 0) {
    contextParts.push(`\n## Rough Animation Hints (from highlight analysis)`);
    for (const seq of moment.animationSequence) {
      contextParts.push(`- Beat ${seq.order}: ${seq.concept} (${Math.round((seq.durationWeight || 0) * 100)}% of clip)`);
    }
  }

  // User's creative direction
  if (direction && direction.trim()) {
    contextParts.push(`\n## User's Creative Direction`);
    contextParts.push(direction.trim());
  }

  // Full transcript context: moment range + 30s buffer on each side
  if (cues && cues.length > 0 && moment.startTime !== undefined) {
    const bufferSec = 30;
    const allNearbyCues = cues.filter(c =>
      c.start >= (moment.startTime - bufferSec) && c.start <= (moment.endTime + bufferSec)
    ).slice(0, 120); // Safety cap to avoid overwhelming context

    if (allNearbyCues.length > 0) {
      contextParts.push(`\n## Full Transcript Context`);
      contextParts.push(`Cues between ── markers are IN the moment range. Select and curate dialogue from these.`);

      let insideMoment = false;
      for (const c of allNearbyCues) {
        const inMoment = c.start >= moment.startTime && c.start <= moment.endTime;
        if (inMoment && !insideMoment) {
          contextParts.push(`── MOMENT START ──`);
          insideMoment = true;
        } else if (!inMoment && insideMoment) {
          contextParts.push(`── MOMENT END ──`);
          insideMoment = false;
        }
        const ts = formatTime(c.start);
        const speaker = c.speaker ? `${c.speaker}: ` : '';
        contextParts.push(`[${c.id}] ${ts} ${speaker}${c.text}`);
      }
      if (insideMoment) contextParts.push(`── MOMENT END ──`);
    }
  }

  // Speakers needing description
  if (moment.speakerDescriptionNeeded && moment.speakerDescriptionNeeded.length > 0) {
    contextParts.push(`\n## Characters Needing Portrait Description`);
    contextParts.push(moment.speakerDescriptionNeeded.join(', '));
  }

  const userMessage = contextParts.join('\n');

  console.log(`  Director AI: Planning sequences for "${moment.title}"...`);
  const startTime = Date.now();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const durationMs = Date.now() - startTime;
  console.log(`  Director AI: Done (${durationMs}ms)`);

  // Parse JSON from response
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const plan = parseJSON(text);

  if (!plan || !plan.sequences || !Array.isArray(plan.sequences)) {
    throw new Error(`Director AI returned invalid plan: ${text.substring(0, 200)}`);
  }

  console.log(`  Director AI: ${plan.sequences.length} sequences, ~${plan.totalDurationSec}s total, ~$${plan.estimatedCost?.toFixed(2) || '?'}`);

  return plan;
}

/**
 * Validate a sequence plan using Claude Haiku as a quality checker.
 *
 * @param {object} plan - The sequence plan from planSequences()
 * @returns {Promise<object>} QC result: { approved: boolean, fixes: [...] }
 */
export async function validateSequences(plan) {
  const client = new Anthropic();

  const promptPath = join(__dirname, '..', 'prompts', 'sequence-quality-check.md');
  const systemPrompt = readFileSync(promptPath, 'utf-8');

  console.log(`  QC Check: Validating ${plan.sequences.length} sequences...`);
  const startTime = Date.now();

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: JSON.stringify(plan, null, 2) }],
  });

  const durationMs = Date.now() - startTime;
  console.log(`  QC Check: Done (${durationMs}ms)`);

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const result = parseJSON(text);

  if (!result) {
    console.warn(`  QC Check: Failed to parse response, auto-approving`);
    return { approved: true, fixes: [] };
  }

  if (result.fixes && result.fixes.length > 0) {
    console.log(`  QC Check: ${result.fixes.length} issues found`);
    for (const fix of result.fixes) {
      console.log(`    - Seq ${fix.sequenceOrder}: ${fix.issue}`);
    }
  } else {
    console.log(`  QC Check: Approved`);
  }

  return result;
}

/**
 * Apply QC fixes to a sequence plan.
 * Modifies the plan in-place and returns it.
 */
export function applyFixes(plan, fixes) {
  if (!fixes || fixes.length === 0) return plan;

  for (const fix of fixes) {
    const seq = plan.sequences.find(s => s.order === fix.sequenceOrder);
    if (!seq) continue;

    // Only apply if field exists AND suggestedValue is a real value (not null/undefined)
    if (fix.field && fix.suggestedValue != null) {
      seq[fix.field] = fix.suggestedValue;
      console.log(`  Applied fix: seq ${fix.sequenceOrder} ${fix.field} → ${fix.suggestedValue}`);
    }
  }

  // Recalculate totalDurationSec and startOffsets
  let offset = 0;
  for (const seq of plan.sequences) {
    seq.startOffsetSec = offset;
    offset += seq.durationSec || 0;
  }
  plan.totalDurationSec = offset;

  // Recalculate cost
  plan.estimatedCost = plan.sequences.reduce((sum, seq) => {
    const hasReusedBg = !!seq.reuseBackgroundFrom;
    if (seq.type === 'dialogue' || seq.type === 'dm_description') return sum + (hasReusedBg ? 0.12 : 0.16);
    if (seq.type === 'close_up' || seq.type === 'action_closeup') return sum + 0.04 * (seq.frameCount || 3);
    if (seq.type === 'establishing_shot') return sum + 0.04;
    if (seq.type === 'impact') return sum; // $0.00
    return sum;
  }, 0);

  return plan;
}

/**
 * Creative QC: 3-dimension quality check using Claude Sonnet.
 * Checks cinematic pacing, character fidelity, and scene coherence.
 *
 * @param {object} plan - Sequence plan
 * @param {object} sceneContext - Scene context brief
 * @param {object[]} characterCards - Character card definitions
 * @returns {Promise<object>} { dimensions: {...}, passCount: number, overallFeedback: string }
 */
export async function creativeQC(plan, sceneContext, characterCards) {
  const client = new Anthropic();

  const promptPath = join(__dirname, '..', 'prompts', 'creative-quality-check.md');
  const systemPrompt = readFileSync(promptPath, 'utf-8');

  // Build the input message
  const parts = [];
  parts.push('## Sequence Plan');
  parts.push('```json');
  parts.push(JSON.stringify(plan, null, 2));
  parts.push('```');

  if (sceneContext) {
    parts.push('\n## Scene Context');
    parts.push('```json');
    parts.push(JSON.stringify(sceneContext, null, 2));
    parts.push('```');
  }

  if (characterCards && characterCards.length > 0) {
    parts.push('\n## Character Cards');
    for (const ch of characterCards) {
      let line = `- **${ch.name}** (${ch.race}, ${ch.class}): ${ch.visualDescription}`;
      if (ch.conditionalFeatures) {
        const features = Object.entries(ch.conditionalFeatures)
          .map(([f, c]) => `${f}: ${c}`)
          .join('; ');
        line += ` | CONDITIONAL: ${features}`;
      }
      parts.push(line);
    }
  }

  console.log('  Creative QC: Checking 3 dimensions...');
  const startTime = Date.now();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: parts.join('\n') }],
  });

  const durationMs = Date.now() - startTime;
  console.log(`  Creative QC: Done (${durationMs}ms)`);

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const result = parseJSON(text);

  if (!result || !result.dimensions) {
    console.warn('  Creative QC: Failed to parse — auto-approving');
    return {
      dimensions: {
        cinematicPacing: { pass: true, feedback: '' },
        characterFidelity: { pass: true, feedback: '' },
        sceneCoherence: { pass: true, feedback: '' },
      },
      passCount: 3,
      overallFeedback: '',
    };
  }

  // Calculate passCount if not provided
  if (result.passCount === undefined) {
    result.passCount = Object.values(result.dimensions).filter(d => d.pass).length;
  }

  // Log results
  for (const [name, dim] of Object.entries(result.dimensions)) {
    const icon = dim.pass ? '✓' : '✗';
    console.log(`    ${icon} ${name}${dim.feedback ? ': ' + dim.feedback.substring(0, 100) + (dim.feedback.length > 100 ? '...' : '') : ''}`);
  }

  return result;
}

/**
 * Run the full Director pipeline:
 *   scene context → plan → technical QC → creative QC → retry if needed
 *
 * @param {object} params
 * @param {object} params.moment - Highlight object
 * @param {string} params.direction - User's creative direction
 * @param {object[]} params.cues - Full session cues
 * @param {object} [params.sceneContext] - Pre-built scene context (skip building if provided)
 * @param {function} [params.onProgress] - Progress callback
 * @returns {Promise<{ plan: object, qcResult: object, creativeResult: object, sceneContext: object }>}
 */
export async function runDirectorPipeline({ moment, direction, cues, sceneContext, onProgress }) {
  const progress = onProgress || (() => {});

  // Load character cards once for the pipeline
  const charactersPath = join(__dirname, '..', 'data', 'characters.json');
  let characterCards = [];
  if (existsSync(charactersPath)) {
    try {
      characterCards = JSON.parse(readFileSync(charactersPath, 'utf-8')).characters || [];
    } catch (e) { /* ignore */ }
  }

  // Step 1: Build scene context (wide transcript analysis)
  if (!sceneContext) {
    progress('scene_context', 'Building scene context...');
    sceneContext = await buildSceneContext({ moment, cues });
  }

  // Step 2-4: Plan → Technical QC → Creative QC (with retry loop)
  const MAX_ATTEMPTS = 3;
  let plan, qcResult, creativeResult;
  let attempts = 0;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;

    // Build direction with creative QC feedback from previous attempt
    let augmentedDirection = direction || '';
    if (creativeResult && creativeResult.passCount < 2) {
      const failedFeedback = Object.entries(creativeResult.dimensions)
        .filter(([_, dim]) => !dim.pass)
        .map(([name, dim]) => `[QC FEEDBACK - ${name}]: ${dim.feedback}`)
        .join('\n');
      augmentedDirection += '\n\n## Quality Feedback (fix these issues from your previous attempt)\n' + failedFeedback;
      console.log(`  Creative QC: ${creativeResult.passCount}/3 passed, retrying (attempt ${attempts}/${MAX_ATTEMPTS})...`);
      progress('retry', `Retrying Director AI (attempt ${attempts})...`);
    }

    // Plan sequences
    progress('planning', 'Director AI planning sequences...');
    plan = await planSequences({ moment, direction: augmentedDirection, cues, sceneContext });

    // Technical QC (Haiku — timing math, field validation)
    progress('technical_qc', 'Technical quality check...');
    qcResult = await validateSequences(plan);
    if (!qcResult.approved && qcResult.fixes && qcResult.fixes.length > 0) {
      applyFixes(plan, qcResult.fixes);
      console.log(`  Applied ${qcResult.fixes.length} QC fixes`);
    }

    // Creative QC (Sonnet — pacing, character fidelity, scene coherence)
    progress('creative_qc', 'Creative quality check...');
    creativeResult = await creativeQC(plan, sceneContext, characterCards);

    if (creativeResult.passCount >= 2) {
      console.log(`  Creative QC: ${creativeResult.passCount}/3 passed ✓`);
      break;
    }
  }

  // If we exhausted attempts, log warning but proceed
  if (creativeResult && creativeResult.passCount < 2) {
    console.warn(`  Creative QC: Only ${creativeResult.passCount}/3 passed after ${MAX_ATTEMPTS} attempts — proceeding anyway`);
  }

  return { plan, qcResult, creativeResult, sceneContext };
}

// ── Helpers ──

function formatTime(seconds) {
  if (seconds === undefined || seconds === null) return '??:??';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseJSON(text) {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch (e) {
    // Try extracting from ```json blocks
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (e2) { /* fall through */ }
    }
    // Try finding JSON object/array in the text
    const jsonMatch = text.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (e3) { /* fall through */ }
    }
    return null;
  }
}
