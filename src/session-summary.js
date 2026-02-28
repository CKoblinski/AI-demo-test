import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_PATH = join(__dirname, '..', 'prompts', 'session-summary.md');
const CAMPAIGN_DIR = join(__dirname, '..', 'data', 'campaign');

/**
 * Load campaign context cards from the data/campaign/ directory.
 * Returns an array of campaign card objects, or empty array if none found.
 *
 * @param {string|string[]} [campaignIds] - Specific campaign IDs to load.
 *   If null/undefined, loads ALL campaign files.
 *   If empty array [], loads NONE (explicitly opt out).
 * @returns {object[]} Campaign context cards
 */
export function loadCampaignContext(campaignIds = null) {
  if (Array.isArray(campaignIds) && campaignIds.length === 0) {
    // Explicit opt-out: empty array means no campaign context
    return [];
  }

  if (!existsSync(CAMPAIGN_DIR)) {
    return [];
  }

  const files = readdirSync(CAMPAIGN_DIR).filter(f => f.endsWith('.json'));
  const campaigns = [];

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(CAMPAIGN_DIR, file), 'utf-8'));

      // Filter by ID if specific campaigns requested
      if (campaignIds && !campaignIds.includes(data.campaignId)) {
        continue;
      }

      campaigns.push(data);
    } catch (e) {
      console.warn(`  Warning: Failed to load campaign file ${file}: ${e.message}`);
    }
  }

  return campaigns;
}

/**
 * Format campaign context cards into a text block for the AI prompt.
 *
 * @param {object[]} campaigns - Campaign card objects from loadCampaignContext
 * @returns {string} Formatted text block, or empty string if no campaigns
 */
function formatCampaignContext(campaigns) {
  if (!campaigns || campaigns.length === 0) return '';

  const parts = [];
  parts.push('\n## Campaign Context (reference cards)');

  for (const campaign of campaigns) {
    parts.push(`\n### ${campaign.title}`);
    parts.push(`Setting: ${campaign.setting}`);
    parts.push(`Description: ${campaign.description}`);

    if (campaign.worldConcepts && campaign.worldConcepts.length > 0) {
      parts.push('\n**Key Concepts:**');
      for (const concept of campaign.worldConcepts) {
        parts.push(`- **${concept.name}** (${concept.type}): ${concept.visualDescription}`);
      }
    }

    if (campaign.locations && campaign.locations.length > 0) {
      parts.push('\n**Known Locations:**');
      for (const loc of campaign.locations) {
        parts.push(`- **${loc.name}** (${loc.region}): ${loc.visualDescription}`);
      }
    }

    if (campaign.factions && campaign.factions.length > 0) {
      parts.push('\n**Factions:**');
      for (const faction of campaign.factions) {
        parts.push(`- **${faction.name}**: ${faction.visualDescription}`);
      }
    }
  }

  return parts.join('\n');
}

/**
 * Find the DM's recap window within the transcript.
 *
 * Real sessions often start with 5-15 minutes of pre-session banter before
 * the DM does the recap. This function searches the first ~300 cues using
 * two signals:
 *   1. DM cue containing recap keywords ("last session", "welcome back", etc.)
 *   2. First DM monologue (3+ consecutive DM cues) — the recap pattern
 *
 * Returns ~100 cues starting from the detected recap point.
 *
 * @param {object[]} cues - Full cue array from parse-vtt.js
 * @param {object[]} speakers - Speaker array from parse-vtt.js (with role: 'dm')
 * @param {number} [maxSearch=300] - How many cues to search for the recap
 * @returns {object[]} The recap window (~100 cues)
 */
export function findRecapWindow(cues, speakers, maxSearch = 300) {
  const searchCues = cues.slice(0, maxSearch);

  // The DM is identified by parse-vtt.js (role: 'dm') — speaker name is the
  // raw Zoom display name (e.g. "Connor Koblinski (DM)"), NOT a generic "DM"
  const dmSpeaker = speakers.find(s => s.role === 'dm');
  const dmName = dmSpeaker?.name || null;

  const isDM = (speakerName) => {
    if (!dmName || !speakerName) return false;
    return speakerName === dmName;
  };

  // Signal 1: DM cue containing recap keywords
  const recapKeywords = /last session|last time|previously|recap|where we left off|when we left off|welcome back/i;
  const recapCueIdx = searchCues.findIndex(c =>
    isDM(c.speaker) && recapKeywords.test(c.text)
  );

  // Signal 2: First DM monologue (3+ consecutive DM cues)
  let monologueStart = -1;
  if (recapCueIdx === -1) {
    let dmRun = 0;
    for (let i = 0; i < searchCues.length; i++) {
      if (isDM(searchCues[i].speaker)) {
        dmRun++;
        if (dmRun >= 3 && monologueStart === -1) {
          monologueStart = i - (dmRun - 1);
          break;
        }
      } else {
        dmRun = 0;
      }
    }
  }

  // Pick the best start point
  const recapStart = recapCueIdx >= 0 ? Math.max(0, recapCueIdx - 5)
                   : monologueStart >= 0 ? Math.max(0, monologueStart - 3)
                   : 0; // fallback: start of transcript

  const recapEnd = Math.min(cues.length, recapStart + 100);
  const window = cues.slice(recapStart, recapEnd);

  // Log what we found
  const method = recapCueIdx >= 0 ? `keyword match at cue ${recapCueIdx}`
               : monologueStart >= 0 ? `DM monologue at cue ${monologueStart}`
               : 'fallback (start of transcript)';
  console.log(`  Session Summary: Recap window → cues ${recapStart}-${recapEnd - 1} (${method})`);

  return window;
}

/**
 * Generate a session summary card from the DM's recap section of a transcript.
 * Analyzes the DM's recap to extract macro-level session context.
 *
 * Designed to run in parallel with findHighlights() — uses a smart recap
 * detector to find the actual recap within the first ~300 cues, then
 * sends ~100 cues to the AI. Fast and cheap (~$0.002).
 *
 * @param {object} session - Parsed session data from parse-vtt.js
 * @param {object} [options] - Configuration options
 * @param {string} [options.apiKey] - Anthropic API key
 * @param {string} [options.model] - Model to use (default: claude-haiku-4-5)
 * @param {string[]} [options.campaignIds] - Campaign IDs to load for context.
 *   null = load all campaigns, [] = load none
 * @returns {Promise<object>} Session summary card
 */
export async function generateSessionSummary(session, options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for session summary.');
  }

  const model = options.model || 'claude-haiku-4-5-20251001';
  const systemPrompt = readFileSync(PROMPT_PATH, 'utf-8');

  // Smart recap detection — searches first ~300 cues for the DM recap,
  // skipping pre-session banter. Returns ~100 cues from the recap start.
  const recapCues = findRecapWindow(session.cues, session.speakers || []);

  if (recapCues.length === 0) {
    console.log('  Session Summary: No cues available, skipping');
    return null;
  }

  // Build the user message
  const parts = [];

  // Speaker info
  const speakerSummary = session.speakers.length > 0
    ? session.speakers.map(s => {
        const role = s.role === 'dm' ? 'DM' : `Player (character: ${s.character || 'unknown'})`;
        return `  - ${s.name}: ${role}`;
      }).join('\n')
    : '  (Auto-caption transcript — no speaker identification)';

  parts.push(`## Session Info`);
  parts.push(`File: ${session.sessionFile}`);
  parts.push(`Duration: ${session.duration}`);
  parts.push(`Total cues: ${session.totalCues}`);
  parts.push('');
  parts.push(`## Speakers`);
  parts.push(speakerSummary);
  parts.push('');

  // Campaign context (if available)
  const campaignContext = loadCampaignContext(options.campaignIds);
  const campaignText = formatCampaignContext(campaignContext);
  if (campaignText) {
    parts.push(campaignText);
    parts.push('');
  }

  // Transcript (recap window)
  parts.push(`## Recap Transcript (${recapCues.length} cues)`);
  parts.push('Each line: [cueId] MM:SS Speaker: Text');
  parts.push('');

  for (const c of recapCues) {
    const mins = Math.floor(c.start / 60);
    const secs = Math.floor(c.start % 60);
    const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    const speaker = c.speaker ? `${c.speaker}: ` : '';
    parts.push(`[${c.id}] ${ts} ${speaker}${c.text}`);
  }

  const userMessage = parts.join('\n');

  console.log(`  Session Summary: Analyzing first ${recapCues.length} cues (${model})...`);
  const startTime = Date.now();

  const client = new Anthropic({ apiKey, timeout: 60000 });

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const durationMs = Date.now() - startTime;
    console.log(`  Session Summary: Done (${durationMs}ms)`);

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Parse JSON from response
    const summary = parseJSON(text);
    if (!summary) {
      console.warn('  Session Summary: Failed to parse response');
      return null;
    }

    // Attach metadata
    summary._meta = {
      model,
      durationMs,
      cuesAnalyzed: recapCues.length,
      campaignContextUsed: campaignContext.map(c => c.campaignId),
      generatedAt: new Date().toISOString(),
    };

    console.log(`  Session Summary: Setting="${(summary.sessionSetting || '').substring(0, 60)}..."`);
    console.log(`  Session Summary: ${summary.recentEvents?.length || 0} events, ${Object.keys(summary.properNounTranslations || {}).length} proper nouns translated`);

    return summary;
  } catch (err) {
    console.error(`  Session Summary: Failed — ${err.message}`);
    // Non-fatal — return null so the pipeline continues without it
    return null;
  }
}

/**
 * Try to parse JSON from Claude's response text.
 */
function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (e2) { /* fall through */ }
    }
    const jsonMatch = text.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (e3) { /* fall through */ }
    }
    return null;
  }
}
