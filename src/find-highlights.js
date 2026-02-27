import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_PATH = join(__dirname, '..', 'prompts', 'highlight-finder.md');

// ~4 chars per token is a rough estimate for English text
const CHARS_PER_TOKEN = 4;
// Stay well under the rate limit — target ~20K input tokens per request
const MAX_INPUT_TOKENS = 20000;
// System prompt is ~3K tokens, leave room for it
const MAX_TRANSCRIPT_TOKENS = MAX_INPUT_TOKENS - 4000;
const MAX_TRANSCRIPT_CHARS = MAX_TRANSCRIPT_TOKENS * CHARS_PER_TOKEN;

/**
 * Find highlight moments in a parsed D&D session using Claude.
 *
 * For large transcripts (>20K tokens), splits into overlapping chunks
 * and sends each chunk separately, then merges and deduplicates results.
 *
 * @param {object} session - Parsed session data from parse-vtt.js
 * @param {object} options - { apiKey, model, userContext }
 * @returns {object[]} Array of highlight objects
 */
export async function findHighlights(session, options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  const userContext = options.userContext || '';
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required. Set it in .env or pass via options.');
  }

  const model = options.model || 'claude-sonnet-4-20250514';
  const systemPrompt = readFileSync(PROMPT_PATH, 'utf-8');

  // Build the transcript payload for Claude
  // Include session metadata + gameplay cues only (skip pre-session banter)
  const gameplaySegment = session.segments.find(s => s.type === 'gameplay');
  const gameplayCues = gameplaySegment
    ? session.cues.filter(c => c.id >= gameplaySegment.startCue && c.id <= gameplaySegment.endCue)
    : session.cues;

  const speakerSummary = session.speakers.length > 0
    ? session.speakers.map(s => {
        const role = s.role === 'dm' ? 'DM' : `Player (character: ${s.character || 'unknown'})`;
        return `  - ${s.name}: ${role}, ${s.cueCount} cues, avg ${s.avgTextLength} chars/cue`;
      }).join('\n')
    : '  (No speaker identification available — this is an auto-caption transcript)';

  const sessionHeader = buildSessionHeader(session, gameplayCues, speakerSummary, userContext);

  // Format all cue lines
  const cueLines = gameplayCues.map(c => formatCueLine(c));
  const fullTranscript = cueLines.join('\n');

  const headerChars = sessionHeader.length;
  const availableChars = MAX_TRANSCRIPT_CHARS - headerChars;

  if (fullTranscript.length <= availableChars) {
    // Small enough to send in one request
    console.log(`\nSending ${gameplayCues.length} cues to Claude (${model})...`);
    console.log(`Estimated tokens: ~${Math.round((sessionHeader.length + fullTranscript.length) / CHARS_PER_TOKEN / 1000)}k`);

    const userMessage = sessionHeader + `\n## Transcript (gameplay section only)\nEach line: [cueId] MM:SS Speaker: Text\n\n${fullTranscript}`;
    const highlights = await callClaudeWithRetry(apiKey, model, systemPrompt, userMessage);
    return highlights;
  }

  // Large transcript — split into chunks with overlap
  console.log(`\nTranscript too large for single request (${fullTranscript.length} chars, limit ${availableChars}).`);
  console.log(`Splitting into chunks...`);

  const chunks = chunkCueLines(cueLines, availableChars);
  console.log(`Split into ${chunks.length} chunks.`);

  const allHighlights = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const chunkHeader = sessionHeader +
      `\n## Transcript — Chunk ${ci + 1} of ${chunks.length}\n` +
      `This is part ${ci + 1} of a longer transcript. Find the best moments in THIS section.\n` +
      `Each line: [cueId] MM:SS Speaker/Text\n\n`;
    const userMessage = chunkHeader + chunk.text;

    console.log(`\n  Chunk ${ci + 1}/${chunks.length}: cues ${chunk.startId}-${chunk.endId} (~${Math.round(userMessage.length / CHARS_PER_TOKEN / 1000)}k tokens)`);

    // Wait between chunks to respect rate limits
    if (ci > 0) {
      const waitSec = 65; // wait just over a minute between chunks
      console.log(`  Waiting ${waitSec}s for rate limit reset...`);
      await sleep(waitSec * 1000);
    }

    try {
      const highlights = await callClaudeWithRetry(apiKey, model, systemPrompt, userMessage);
      allHighlights.push(...highlights);
      console.log(`  Found ${highlights.length} highlights in chunk ${ci + 1}`);
    } catch (err) {
      console.error(`  Chunk ${ci + 1} failed: ${err.message}`);
      // Continue with other chunks
    }
  }

  if (allHighlights.length === 0) {
    throw new Error('No highlights found in any chunk. The transcript may not contain recognizable D&D moments.');
  }

  // Deduplicate and pick top 7
  const deduped = deduplicateHighlights(allHighlights);
  const topN = deduped.slice(0, 7).map((h, i) => ({ ...h, rank: i + 1 }));

  console.log(`\nFinal: ${topN.length} highlights selected from ${allHighlights.length} candidates.`);
  return topN;
}

/**
 * Call Claude with retry + exponential backoff for rate limits.
 */
async function callClaudeWithRetry(apiKey, model, systemPrompt, userMessage, maxRetries = 3) {
  const client = new Anthropic({ apiKey });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const responseText = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      // Try to parse JSON — Claude might wrap it in ```json``` blocks
      let jsonStr = responseText;
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      try {
        const highlights = JSON.parse(jsonStr.trim());
        return Array.isArray(highlights) ? highlights : [highlights];
      } catch (e) {
        console.error('Failed to parse Claude response as JSON:');
        console.error(responseText.substring(0, 500));
        throw new Error(`Claude returned non-JSON response: ${e.message}`);
      }
    } catch (err) {
      // Check for rate limit error (429)
      const isRateLimit = err.status === 429 ||
        err.message?.includes('rate_limit') ||
        err.message?.includes('429');

      if (isRateLimit && attempt < maxRetries) {
        // Parse retry-after header or use exponential backoff
        const waitSec = Math.min(60 * attempt, 180); // 60s, 120s, 180s
        console.log(`  Rate limited (attempt ${attempt}/${maxRetries}). Waiting ${waitSec}s...`);
        await sleep(waitSec * 1000);
        continue;
      }

      throw err;
    }
  }
}

/**
 * Build the session header (everything before the transcript).
 */
function buildSessionHeader(session, gameplayCues, speakerSummary, userContext) {
  let header = `## Session Info
File: ${session.sessionFile}
Duration: ${session.duration}
Total cues: ${session.totalCues}
Gameplay cues (analyzed): ${gameplayCues.length}

## Speakers
${speakerSummary}

## Segments
${session.segments.map(s => `  - ${s.type}: ${Math.floor(s.startTime / 60)}m → ${Math.floor(s.endTime / 60)}m`).join('\n')}
`;

  if (userContext) {
    header += `
## DM Notes (what the DM thinks was important)
${userContext}

Pay special attention to these notes — the DM knows what mattered. Prioritize moments they mention.
`;
  }

  return header;
}

/**
 * Format a cue line for the transcript.
 * Handles both speaker-identified and speaker-less formats.
 */
function formatCueLine(cue) {
  const mins = Math.floor(cue.start / 60);
  const secs = Math.floor(cue.start % 60);
  const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  if (cue.speaker) {
    return `[${cue.id}] ${ts} ${cue.speaker}: ${cue.text}`;
  } else {
    return `[${cue.id}] ${ts} ${cue.text}`;
  }
}

/**
 * Split cue lines into chunks that fit within the character limit.
 * Uses ~10% overlap between chunks so Claude doesn't miss moments at boundaries.
 */
function chunkCueLines(cueLines, maxChars) {
  const chunks = [];
  let startIdx = 0;

  while (startIdx < cueLines.length) {
    // Build chunk from startIdx
    let endIdx = startIdx;
    let charCount = 0;

    while (endIdx < cueLines.length) {
      const lineLen = cueLines[endIdx].length + 1; // +1 for newline
      if (charCount + lineLen > maxChars && endIdx > startIdx) break;
      charCount += lineLen;
      endIdx++;
    }

    const chunkLines = cueLines.slice(startIdx, endIdx);
    const text = chunkLines.join('\n');

    // Extract start/end cue IDs from the bracket notation
    const firstMatch = chunkLines[0]?.match(/^\[(\d+)\]/);
    const lastMatch = chunkLines[chunkLines.length - 1]?.match(/^\[(\d+)\]/);

    chunks.push({
      text,
      startId: firstMatch ? parseInt(firstMatch[1]) : startIdx,
      endId: lastMatch ? parseInt(lastMatch[1]) : endIdx,
    });

    // Overlap: go back ~10% of the chunk so moments at boundaries aren't missed
    const overlap = Math.floor((endIdx - startIdx) * 0.1);
    startIdx = endIdx - overlap;

    // But don't go backwards
    if (startIdx <= chunks[chunks.length - 1]?.startId) {
      startIdx = endIdx;
    }
  }

  return chunks;
}

/**
 * Deduplicate highlights by checking for overlapping time ranges.
 * Keep the highest-scored version of overlapping moments.
 */
function deduplicateHighlights(highlights) {
  // Sort by rank (lower = better)
  const sorted = [...highlights].sort((a, b) => (a.rank || 99) - (b.rank || 99));

  const kept = [];
  for (const h of sorted) {
    const overlaps = kept.some(k => {
      const hStart = h.startTime || h.startCue || 0;
      const hEnd = h.endTime || h.endCue || 0;
      const kStart = k.startTime || k.startCue || 0;
      const kEnd = k.endTime || k.endCue || 0;

      // Check if they overlap significantly (>50% of the shorter one)
      const overlapStart = Math.max(hStart, kStart);
      const overlapEnd = Math.min(hEnd, kEnd);
      if (overlapEnd <= overlapStart) return false;

      const overlapLen = overlapEnd - overlapStart;
      const shortestLen = Math.min(hEnd - hStart, kEnd - kStart);
      return shortestLen > 0 && (overlapLen / shortestLen) > 0.5;
    });

    if (!overlaps) {
      kept.push(h);
    }
  }

  return kept;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
