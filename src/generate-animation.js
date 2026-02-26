import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getAnimationHtml } from './library.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MAIN_REPO = join(ROOT, '..', '..', '..'); // up to ascii-animation-skill root

// Skill docs paths (try worktree first, then main repo)
function readSkillDoc(filename) {
  const paths = [
    join(ROOT, filename),
    join(MAIN_REPO, filename),
  ];
  for (const p of paths) {
    if (existsSync(p)) return readFileSync(p, 'utf-8');
  }
  return null;
}

/**
 * Load all skill documentation for the system prompt.
 * Returns a combined string of SKILL.md + references + player template.
 */
function loadSkillContext() {
  const parts = [];

  const skill = readSkillDoc('SKILL.md');
  if (skill) parts.push('# ANIMATION SKILL GUIDE\n\n' + skill);

  const colorSystem = readSkillDoc('references/color-system.md');
  if (colorSystem) parts.push('\n\n# COLOR SYSTEM REFERENCE\n\n' + colorSystem);

  const motionPatterns = readSkillDoc('references/motion-patterns.md');
  if (motionPatterns) parts.push('\n\n# MOTION PATTERNS REFERENCE\n\n' + motionPatterns);

  const unicodeRef = readSkillDoc('references/unicode-reference.md');
  if (unicodeRef) parts.push('\n\n# UNICODE CHARACTER REFERENCE\n\n' + unicodeRef);

  const playerTemplate = readSkillDoc('assets/player-template.html');
  if (playerTemplate) parts.push('\n\n# PLAYER TEMPLATE HTML\n\nUse this as the base HTML shell for the animation. Replace the ANIMATION CODE section with your implementation.\n\n```html\n' + playerTemplate + '\n```');

  return parts.join('');
}

// Cache the skill context since it doesn't change
let skillContextCache = null;

function getSkillContext() {
  if (!skillContextCache) {
    skillContextCache = loadSkillContext();
  }
  return skillContextCache;
}

/**
 * Load the animation generator prompt.
 */
function loadGeneratorPrompt() {
  const promptPath = join(ROOT, 'prompts', 'animation-generator.md');
  if (existsSync(promptPath)) return readFileSync(promptPath, 'utf-8');
  return '';
}

/**
 * Generate an animation HTML file using Claude Sonnet.
 *
 * @param {object} params
 * @param {object} params.moment - The highlight moment data
 * @param {string} params.decision - 'CREATE' | 'ADAPT'
 * @param {string} params.concept - Animation concept description
 * @param {string} [params.adaptFromId] - Library animation ID to adapt from (for ADAPT)
 * @param {string} [params.rejectionFeedback] - Previous rejection rationale (for regeneration)
 * @param {string} [params.exampleId] - Library animation ID to use as few-shot example
 * @param {object} [params.options] - { apiKey, model }
 * @returns {Promise<{ html: string, valid: boolean, errors: string[] }>}
 */
export async function generateAnimation(params) {
  const {
    moment,
    decision,
    concept,
    adaptFromId,
    rejectionFeedback,
    exampleId,
    options = {},
  } = params;

  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');

  const model = options.model || 'claude-sonnet-4-20250514';
  const client = new Anthropic({ apiKey });

  // Build system prompt
  const skillContext = getSkillContext();
  const generatorPrompt = loadGeneratorPrompt();
  const systemPrompt = generatorPrompt + '\n\n' + skillContext;

  // Build user prompt
  let userPrompt = `## Animation Request

**Decision:** ${decision}
**Concept:** ${concept}

### Moment Details
- **Type:** ${moment.type}
- **Title:** ${moment.title}
- **Emotional Arc:** ${moment.emotionalArc || 'unknown'}
- **Key Dialogue:** ${moment.keyDialogue || 'none provided'}
- **Duration:** ~${moment.estimatedClipDuration || 20} seconds

### Canvas Constraints
- **Width:** 54 characters
- **Height:** 40 rows
- **Format:** 9:16 vertical (YouTube Shorts / Instagram Reels)
- **Frame Count:** 16-24 frames
- **Mode:** ${concept.toLowerCase().includes('bounce') ? 'Bounce (only author forward half)' : 'Loop'}

### Design Philosophy
These animations are TONE POEMS — they set the mood, the audio tells the story. Don't try to literally animate complex scenes. Use simple iconic imagery that captures the FEELING of the moment. The viewer's phone screen should feel alive with atmosphere while they listen to the audio.

### Vertical Composition
The canvas is 54 wide × 40 tall (portrait). Use the full height:
- Top zone (rows 0-11): atmosphere, particles, ambient effects
- Center (rows 12-28): main subject
- Bottom zone (rows 29-39): ground, base, supporting detail
`;

  // Add adaptation context
  if (decision === 'ADAPT' && adaptFromId) {
    const sourceHtml = getAnimationHtml(adaptFromId);
    if (sourceHtml) {
      userPrompt += `\n### Source Animation to Adapt\nAdapt the following animation. Keep the overall structure but modify it to match the new concept:\n\n\`\`\`html\n${sourceHtml}\n\`\`\`\n`;
    }
  }

  // Add example for few-shot learning
  if (exampleId) {
    const exampleHtml = getAnimationHtml(exampleId);
    if (exampleHtml) {
      userPrompt += `\n### Example Animation (for reference)\nHere is an example of a working animation that follows the correct patterns:\n\n\`\`\`html\n${exampleHtml}\n\`\`\`\n`;
    }
  }

  // Add rejection feedback for regeneration
  if (rejectionFeedback) {
    userPrompt += `\n### Previous Attempt Rejected\nThe previous version was rejected. User feedback: "${rejectionFeedback}"\nPlease create a DIFFERENT approach that addresses this feedback.\n`;
  }

  userPrompt += `\n### Output\nReturn ONLY the complete HTML file. No explanations, no markdown code fences. Just the raw HTML starting with \`<!DOCTYPE html>\` and ending with \`</html>\`.`;

  console.log(`  Generating animation: ${concept.substring(0, 60)}...`);
  console.log(`  Model: ${model}`);

  // Rate-limit-aware API call with retry + backoff
  let response;
  const maxApiRetries = 3;
  for (let attempt = 1; attempt <= maxApiRetries; attempt++) {
    try {
      response = await client.messages.create({
        model,
        max_tokens: 16000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      break; // success
    } catch (err) {
      const isRateLimit = err.status === 429 ||
        err.message?.includes('rate_limit') ||
        err.message?.includes('429');

      if (isRateLimit && attempt < maxApiRetries) {
        const waitSec = Math.min(60 * attempt, 180);
        console.log(`  Rate limited (attempt ${attempt}/${maxApiRetries}). Waiting ${waitSec}s...`);
        await sleep(waitSec * 1000);
        continue;
      }
      throw err;
    }
  }

  let html = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  // Strip markdown code fences if Sonnet wrapped the output
  const htmlMatch = html.match(/```(?:html)?\s*(<!DOCTYPE[\s\S]*?<\/html>)\s*```/i);
  if (htmlMatch) {
    html = htmlMatch[1];
  } else {
    // Try to extract just the HTML portion
    const docMatch = html.match(/(<!DOCTYPE[\s\S]*<\/html>)/i);
    if (docMatch) {
      html = docMatch[1];
    }
  }

  // Validate the generated HTML
  const errors = validateAnimationHtml(html);

  return {
    html,
    valid: errors.length === 0,
    errors,
    tokensUsed: response.usage?.output_tokens || 0,
  };
}

/**
 * Basic validation of generated animation HTML.
 */
function validateAnimationHtml(html) {
  const errors = [];

  if (!html.includes('<!DOCTYPE html>') && !html.includes('<!doctype html>')) {
    errors.push('Missing DOCTYPE declaration');
  }
  if (!html.includes('buildFrame')) {
    errors.push('Missing buildFrame function');
  }
  if (!html.includes('colorizeFrame')) {
    errors.push('Missing colorizeFrame function');
  }
  if (!/const\s+FC\s*=|let\s+FC\s*=|var\s+FC\s*=/.test(html)) {
    errors.push('Missing FC (frame config) array');
  }
  if (!html.includes('frameData')) {
    errors.push('Missing frameData variable');
  }
  if (!html.includes('white-space:pre') && !html.includes('white-space: pre')) {
    errors.push('Missing white-space:pre (will cause rendering issues)');
  }
  if (!html.includes('<div id="stage">') && !html.includes("id=\"stage\"")) {
    errors.push('Missing #stage element');
  }

  return errors;
}

/**
 * Generate with retry on validation failure.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function generateWithRetry(params, maxRetries = 1) {
  let result = await generateAnimation(params);

  if (!result.valid && maxRetries > 0) {
    console.log(`  Validation failed (${result.errors.join(', ')}). Retrying...`);
    const retryParams = {
      ...params,
      rejectionFeedback: (params.rejectionFeedback || '') +
        `\nTechnical issues with previous output: ${result.errors.join(', ')}. Please ensure the output is a valid, complete HTML file following the two-pass renderer pattern.`,
    };
    result = await generateAnimation(retryParams);
  }

  return result;
}
