import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_PATH = join(__dirname, '..', 'prompts', 'highlight-finder.md');

/**
 * Find highlight moments in a parsed D&D session using Claude.
 *
 * @param {object} session - Parsed session data from parse-vtt.js
 * @param {object} options - { apiKey, model }
 * @returns {object[]} Array of highlight objects
 */
export async function findHighlights(session, options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
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

  const speakerSummary = session.speakers.map(s => {
    const role = s.role === 'dm' ? 'DM' : `Player (character: ${s.character || 'unknown'})`;
    return `  - ${s.name}: ${role}, ${s.cueCount} cues, avg ${s.avgTextLength} chars/cue`;
  }).join('\n');

  const cueText = gameplayCues.map(c => {
    const mins = Math.floor(c.start / 60);
    const secs = Math.floor(c.start % 60);
    const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `[${c.id}] ${ts} ${c.speaker}: ${c.text}`;
  }).join('\n');

  const userMessage = `## Session Info
File: ${session.sessionFile}
Duration: ${session.duration}
Total cues: ${session.totalCues}
Gameplay cues (analyzed): ${gameplayCues.length}

## Speakers
${speakerSummary}

## Segments
${session.segments.map(s => `  - ${s.type}: ${Math.floor(s.startTime / 60)}m → ${Math.floor(s.endTime / 60)}m`).join('\n')}

## Transcript (gameplay section only)
Each line: [cueId] MM:SS Speaker: Text

${cueText}`;

  console.log(`\nSending ${gameplayCues.length} cues to Claude (${model})...`);
  console.log(`Estimated tokens: ~${Math.round(userMessage.length / 4)}k`);

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  // Extract JSON from response
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
}
