import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'templates');

/**
 * Assemble a dialogue scene from template + generated images.
 *
 * @param {object} params
 * @param {string} params.portraitBase64 - Base64-encoded portrait image
 * @param {string} params.portraitMimeType - MIME type (e.g., 'image/png')
 * @param {string} params.backgroundBase64 - Base64-encoded background image
 * @param {string} params.backgroundMimeType - MIME type
 * @param {string} params.characterName - Character name to display
 * @param {string} params.characterColor - Hex color for the character (e.g., '#e8a033')
 * @param {string} params.dialogueText - The dialogue text to typewrite
 * @param {string} [params.sceneTitle] - HTML page title
 * @param {number} [params.textSpeed=50] - Ms per character for typewriter
 * @returns {string} Complete self-contained HTML
 */
export function assembleDialogueScene(params) {
  const {
    portraitBase64,
    portraitMimeType = 'image/png',
    backgroundBase64,
    backgroundMimeType = 'image/png',
    characterName,
    characterColor = '#e8a033',
    dialogueText,
    sceneTitle = `${characterName} — D&D Shorts`,
    textSpeed = 50,
  } = params;

  const template = readFileSync(join(TEMPLATES_DIR, 'dialogue-scene.html'), 'utf-8');

  // Build data URIs
  const portraitSrc = `data:${portraitMimeType};base64,${portraitBase64}`;
  const backgroundSrc = `data:${backgroundMimeType};base64,${backgroundBase64}`;

  // Escape dialogue text for JS string embedding
  const escapedDialogue = dialogueText
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  // Replace template tokens
  let html = template;
  html = html.replace(/\{\{SCENE_TITLE\}\}/g, escapeHtml(sceneTitle));
  html = html.replace(/\{\{PORTRAIT_SRC\}\}/g, portraitSrc);
  html = html.replace(/\{\{BACKGROUND_SRC\}\}/g, backgroundSrc);
  html = html.replace(/\{\{CHAR_NAME\}\}/g, escapeHtml(characterName));
  html = html.replace(/\{\{CHAR_COLOR\}\}/g, characterColor);
  html = html.replace(/\{\{DIALOGUE_TEXT\}\}/g, escapedDialogue);
  html = html.replace(/\{\{TEXT_SPEED\}\}/g, String(textSpeed));

  return html;
}

/**
 * Assemble an animated dialogue scene with multi-frame portrait + multi-line dialogue.
 *
 * @param {object} params
 * @param {Array<{ base64: string, mimeType?: string }>} params.portraitFrames - Portrait frames (index 0 = closed mouth)
 * @param {string} params.backgroundBase64
 * @param {string} [params.backgroundMimeType]
 * @param {string} params.characterName
 * @param {string} [params.characterColor='#e8a033']
 * @param {Array<{ text: string, speed?: number }>} params.dialogueLines
 * @param {number} [params.mouthCycleMs=150]
 * @param {number} [params.linePauseMs=1200]
 * @param {string} [params.sceneTitle]
 * @returns {string} Complete self-contained HTML
 */
export function assembleAnimatedDialogueScene(params) {
  const {
    portraitFrames,
    backgroundBase64,
    backgroundMimeType = 'image/png',
    characterName,
    characterColor = '#e8a033',
    dialogueLines,
    mouthCycleMs = 150,
    linePauseMs = 1200,
    sceneTitle = `${characterName} — D&D Shorts`,
  } = params;

  const template = readFileSync(join(TEMPLATES_DIR, 'animated-dialogue.html'), 'utf-8');

  // Build background data URI
  const backgroundSrc = `data:${backgroundMimeType};base64,${backgroundBase64}`;

  // Build portrait <img> tags
  const portraitImgs = portraitFrames.map((frame, i) => {
    const mime = frame.mimeType || 'image/png';
    const src = `data:${mime};base64,${frame.base64}`;
    const activeClass = i === 0 ? ' active' : '';
    return `<img class="portrait-variant${activeClass}" src="${src}" data-frame="${i}" alt="frame ${i}">`;
  }).join('\n      ');

  // Escape dialogue lines for JSON embedding
  const linesJson = JSON.stringify(dialogueLines.map(l => ({
    text: l.text,
    speed: l.speed || 55,
  })));

  // Replace template tokens
  let html = template;
  html = html.replace(/\{\{SCENE_TITLE\}\}/g, escapeHtml(sceneTitle));
  html = html.replace(/\{\{BACKGROUND_SRC\}\}/g, backgroundSrc);
  html = html.replace(/\{\{PORTRAIT_IMGS\}\}/g, portraitImgs);
  html = html.replace(/\{\{CHAR_NAME\}\}/g, escapeHtml(characterName));
  html = html.replace(/\{\{CHAR_COLOR\}\}/g, characterColor);
  html = html.replace(/\{\{DIALOGUE_LINES_JSON\}\}/g, linesJson);
  html = html.replace(/\{\{MOUTH_CYCLE_MS\}\}/g, String(mouthCycleMs));
  html = html.replace(/\{\{LINE_PAUSE_MS\}\}/g, String(linePauseMs));
  html = html.replace(/\{\{PORTRAIT_COUNT\}\}/g, String(portraitFrames.length));

  return html;
}

/**
 * Assemble and save a dialogue scene to disk.
 */
export function assembleAndSave(params, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const html = assembleDialogueScene(params);
  writeFileSync(outputPath, html);
  console.log(`  Scene saved: ${outputPath}`);
  return outputPath;
}

/**
 * Assemble and save an animated dialogue scene to disk.
 */
export function assembleAnimatedAndSave(params, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const html = assembleAnimatedDialogueScene(params);
  writeFileSync(outputPath, html);
  console.log(`  Scene saved: ${outputPath}`);
  return outputPath;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
