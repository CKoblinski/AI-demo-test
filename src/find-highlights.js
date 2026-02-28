import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_PATH_HAIKU = join(__dirname, '..', 'prompts', 'highlight-finder.md');
const PROMPT_PATH_OPUS = join(__dirname, '..', 'prompts', 'highlight-finder-opus.md');
const KNOWLEDGE_PATH = join(__dirname, '..', 'data', 'knowledge.json');

// ~4 chars per token is a rough estimate for English text
const CHARS_PER_TOKEN = 4;
// Haiku chunking limits — stay well under rate limit
const MAX_INPUT_TOKENS = 20000;
const MAX_TRANSCRIPT_TOKENS = MAX_INPUT_TOKENS - 4000;
const MAX_TRANSCRIPT_CHARS = MAX_TRANSCRIPT_TOKENS * CHARS_PER_TOKEN;

/**
 * Find highlight moments in a parsed D&D session using Claude.
 *
 * Two code paths:
 * - Opus (default): sends the full transcript in a single request. Better quality, ~$1.20/session.
 * - Haiku: splits into overlapping chunks. Cheaper (~$0.25/session), less global context.
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

  const model = options.model || 'claude-opus-4-6';
  const isOpus = model.includes('opus');

  const promptPath = isOpus ? PROMPT_PATH_OPUS : PROMPT_PATH_HAIKU;
  const systemPrompt = readFileSync(promptPath, 'utf-8');

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

  if (isOpus) {
    return findHighlightsOpus(apiKey, model, systemPrompt, session, gameplayCues, speakerSummary, userContext);
  } else {
    return findHighlightsChunked(apiKey, model, systemPrompt, session, gameplayCues, speakerSummary, userContext);
  }
}

// ═══════════════════════════════════════
// Opus path — single request, full transcript
// ═══════════════════════════════════════

async function findHighlightsOpus(apiKey, model, systemPrompt, session, gameplayCues, speakerSummary, userContext) {
  const sessionHeader = buildSessionHeader(session, gameplayCues, speakerSummary, userContext);

  // Load character knowledge for Opus context
  const knowledgeSection = buildKnowledgeSection();

  // Format full transcript (no chunking)
  const cueLines = gameplayCues.map(c => formatCueLine(c));
  const fullTranscript = cueLines.join('\n');

  const totalChars = sessionHeader.length + knowledgeSection.length + fullTranscript.length;
  const estTokens = Math.round(totalChars / CHARS_PER_TOKEN / 1000);

  console.log(`\nSending FULL transcript to Opus (${gameplayCues.length} cues, ~${estTokens}k tokens)...`);
  console.log(`  Model: ${model}`);
  console.log(`  Estimated cost: ~$${(estTokens * 15 / 1000 + 4 * 75 / 1000).toFixed(2)}`);

  const userMessage = sessionHeader +
    knowledgeSection +
    `\n## Transcript (gameplay section only)\nEach line: [cueId] MM:SS Speaker: Text\n\n` +
    fullTranscript;

  const highlights = await callClaudeWithRetry(apiKey, model, systemPrompt, userMessage, 3, 16384);

  // Validate editedDialogue cueIds if present
  for (const h of highlights) {
    if (h.editedDialogue) {
      for (const line of h.editedDialogue) {
        if (typeof line.cueId !== 'number') {
          console.warn(`  Warning: editedDialogue line missing cueId in highlight "${h.title}"`);
        }
      }
    }
  }

  console.log(`\nFound ${highlights.length} highlights (globally ranked).`);
  return highlights;
}

/**
 * Build a knowledge section with character cards for Opus context.
 * Gives the model information about characters, abilities, and signature items.
 */
function buildKnowledgeSection() {
  if (!existsSync(KNOWLEDGE_PATH)) return '';

  try {
    const kb = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf-8'));
    const chars = [...(kb.characters || []), ...(kb.npcs || [])];
    if (chars.length === 0) return '';

    let section = '\n## Character Knowledge\nThese are the known characters in this campaign. Use this to identify moments involving named items, abilities, and character dynamics.\n\n';

    for (const c of chars) {
      section += `### ${c.name}`;
      if (c.race) section += ` (${c.race}`;
      if (c.class) section += ` ${c.class}`;
      if (c.race) section += ')';
      section += '\n';

      if (c.visualDescription) {
        section += `Visual: ${c.visualDescription}\n`;
      }
      if (c.signatureItems?.length) {
        section += `Signature Items: ${c.signatureItems.map(i => `${i.name} — ${i.visualDescription}`).join('; ')}\n`;
      }
      if (c.keyAbilities?.length) {
        section += `Key Abilities: ${c.keyAbilities.join('; ')}\n`;
      }
      section += '\n';
    }

    // Include locations if any
    if (kb.locations?.length) {
      section += '### Known Locations\n';
      for (const loc of kb.locations) {
        section += `- **${loc.name}**: ${loc.visualDescription}\n`;
      }
      section += '\n';
    }

    return section;
  } catch (err) {
    console.warn(`Failed to load knowledge for Opus context: ${err.message}`);
    return '';
  }
}

// ═══════════════════════════════════════
// Haiku path — chunked requests (original logic)
// ═══════════════════════════════════════

async function findHighlightsChunked(apiKey, model, systemPrompt, session, gameplayCues, speakerSummary, userContext) {
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

    // Wait between chunks to respect rate limits (Haiku has higher limits)
    if (ci > 0) {
      const waitSec = model.includes('haiku') ? 1 : 15;
      console.log(`  Waiting ${waitSec}s between chunks...`);
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

// ═══════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════

/**
 * Call Claude with retry + exponential backoff for rate limits.
 */
async function callClaudeWithRetry(apiKey, model, systemPrompt, userMessage, maxRetries = 3, maxTokens = 8192) {
  const isOpus = model.includes('opus');
  const client = new Anthropic({ apiKey, timeout: isOpus ? 300000 : 120000 });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const responseText = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      // Log usage for cost tracking
      if (response.usage) {
        const inputCost = response.usage.input_tokens * (isOpus ? 15 : 0.8) / 1_000_000;
        const outputCost = response.usage.output_tokens * (isOpus ? 75 : 4) / 1_000_000;
        console.log(`  API usage: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out — $${(inputCost + outputCost).toFixed(3)}`);
      }

      // Try to parse JSON — Claude might wrap it in ```json``` blocks
      let jsonStr = responseText;

      // Try closed code blocks first
      const closedMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (closedMatch) {
        jsonStr = closedMatch[1];
      } else {
        // Handle unclosed code blocks (response truncated before closing ```)
        const openMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*)/);
        if (openMatch) {
          jsonStr = openMatch[1];
        }
      }

      // Try parsing as-is first
      try {
        const highlights = JSON.parse(jsonStr.trim());
        return Array.isArray(highlights) ? highlights : [highlights];
      } catch (e) {
        // If JSON was truncated, try to salvage complete objects from the array
        const salvaged = salvageTruncatedJSON(jsonStr.trim());
        if (salvaged && salvaged.length > 0) {
          console.log(`  Salvaged ${salvaged.length} highlights from truncated response`);
          return salvaged;
        }
        // Graceful fallback: if Claude returned prose instead of JSON (e.g. for
        // very small chunks or wrap-up sections), log and return empty instead of crashing
        console.warn(`  Claude returned non-JSON response: ${e.message}`);
        console.warn(`  Response preview: ${responseText.substring(0, 200)}`);
        return [];
      }
    } catch (err) {
      // Check for rate limit error (429)
      const isRateLimit = err.status === 429 ||
        err.message?.includes('rate_limit') ||
        err.message?.includes('429');

      // Check for transient connection/server errors
      const isTransient = isRateLimit ||
        err.status === 500 || err.status === 502 || err.status === 503 || err.status === 529 ||
        err.message?.includes('Connection error') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('ETIMEDOUT') ||
        err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';

      if (isTransient && attempt < maxRetries) {
        const waitSec = isRateLimit ? Math.min(60 * attempt, 180) : 10 * attempt;
        console.log(`  ${isRateLimit ? 'Rate limited' : 'Transient error'} (attempt ${attempt}/${maxRetries}): ${err.message}. Waiting ${waitSec}s...`);
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
    const nextStart = endIdx - overlap;

    // Anti-regression: ensure we always advance past the previous chunk's start
    if (nextStart <= startIdx) {
      startIdx = endIdx; // No overlap possible, just advance
    } else {
      startIdx = nextStart;
    }
  }

  // Merge tiny final chunks (< 20 cues) into the previous chunk.
  // Very small chunks (wrap-up, goodbyes) cause Claude to return prose instead of JSON.
  // Only merge if the combined size doesn't exceed maxChars (avoid API token limit errors).
  const MIN_CHUNK_CUES = 20;
  if (chunks.length > 1) {
    const lastChunk = chunks[chunks.length - 1];
    const lastCueCount = lastChunk.text.split('\n').filter(l => l.match(/^\[\d+\]/)).length;
    if (lastCueCount < MIN_CHUNK_CUES) {
      const prev = chunks[chunks.length - 2];
      const mergedSize = prev.text.length + 1 + lastChunk.text.length;
      if (mergedSize <= maxChars * 1.15) {
        // Safe to merge — within ~15% of the limit (small overrun is OK)
        prev.text = prev.text + '\n' + lastChunk.text;
        prev.endId = lastChunk.endId;
        chunks.pop();
        console.log(`  Merged tiny final chunk (${lastCueCount} cues) into chunk ${chunks.length}`);
      } else {
        console.log(`  Tiny final chunk (${lastCueCount} cues) too large to merge safely (${mergedSize} chars > ${maxChars}), keeping separate`);
      }
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

/**
 * Try to salvage complete JSON objects from a truncated JSON array.
 * E.g., if the response is `[{...}, {... (cut off)`, extract the complete objects.
 */
function salvageTruncatedJSON(str) {
  // Must start with [
  if (!str.startsWith('[')) return null;

  const results = [];
  let depth = 0;
  let objStart = -1;

  for (let i = 1; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') {
      // Skip string contents
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\') i++; // skip escaped chars
        i++;
      }
      continue;
    }
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          const obj = JSON.parse(str.substring(objStart, i + 1));
          results.push(obj);
        } catch (e) {
          // skip malformed object
        }
        objStart = -1;
      }
    }
  }

  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
