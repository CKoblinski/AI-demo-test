import { GoogleGenAI } from '@google/genai';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env if not already loaded
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

const STYLE_PREFIX = '16-bit pixel art, RPG game style inspired by Octopath Traveler and Final Fantasy VI, retro gaming aesthetic with modern lighting and detail, ';

let aiClient = null;

function getClient() {
  if (!aiClient) {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_AI_API_KEY is required. Set it in .env');
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

/**
 * Generate a pixel art image using Nano Banana 2 (Gemini 3.1 Flash Image).
 *
 * @param {string} prompt - Image description
 * @param {object} [options]
 * @param {string} [options.savePath] - Path to save the PNG
 * @returns {Promise<{ buffer: Buffer, base64: string, path?: string }>}
 */
export async function generatePixelArt(prompt, options = {}) {
  const ai = getClient();
  const fullPrompt = STYLE_PREFIX + prompt;

  console.log(`  Generating image: ${prompt.substring(0, 80)}...`);
  const startTime = Date.now();

  let response;
  const maxRetries = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-image-preview',
        contents: fullPrompt,
        config: {
          responseModalities: ['image', 'text'],
        },
      });
      break; // success
    } catch (err) {
      const details = err.message || String(err);
      const status = err.status || err.code || 'unknown';
      console.error(`  API error (${status}): ${details.substring(0, 200)}`);

      if (attempt < maxRetries) {
        const waitSec = 10 * attempt;
        console.log(`  Retrying in ${waitSec}s (attempt ${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw err;
    }
  }

  const durationMs = Date.now() - startTime;

  // Extract image from response
  const parts = response.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData);

  if (!imagePart) {
    // Check if there's a text response explaining why
    const textPart = parts.find(p => p.text);
    const reason = textPart?.text || 'No image returned';
    throw new Error(`Image generation failed: ${reason}`);
  }

  const base64 = imagePart.inlineData.data;
  const mimeType = imagePart.inlineData.mimeType || 'image/png';
  const buffer = Buffer.from(base64, 'base64');

  console.log(`  Generated (${durationMs}ms, ${(buffer.length / 1024).toFixed(0)}KB, ${mimeType})`);

  let savedPath = null;
  if (options.savePath) {
    mkdirSync(dirname(options.savePath), { recursive: true });
    writeFileSync(options.savePath, buffer);
    savedPath = options.savePath;
    console.log(`  Saved: ${options.savePath}`);
  }

  return { buffer, base64, mimeType, path: savedPath, durationMs };
}

/**
 * Generate a character portrait (close-up face for dialogue scenes).
 */
export async function generateCharacterPortrait(name, description, options = {}) {
  const prompt = `close-up face portrait of ${description}, expressive eyes, dramatic lighting, dark background, square composition, character portrait for RPG dialogue box`;
  return generatePixelArt(prompt, options);
}

/**
 * Generate a full-body character sprite.
 */
export async function generateCharacterSprite(name, description, pose = 'standing', options = {}) {
  const prompt = `full body ${pose} sprite of ${description}, facing forward, transparent background style (solid dark background), RPG character sprite sheet style`;
  return generatePixelArt(prompt, options);
}

/**
 * Generate mouth-position variants of an existing portrait using reference-based generation.
 * Keeps face/hair/clothing/background consistent — only the mouth changes.
 *
 * @param {Buffer} basePortraitBuffer - The original portrait PNG buffer
 * @param {string} baseMimeType - MIME type of the base portrait
 * @param {object} [options]
 * @param {string} [options.saveDir] - Directory to save variant PNGs
 * @returns {Promise<Array<{ buffer, base64, mimeType, label }>>}
 */
export async function generateMouthVariants(basePortraitBuffer, baseMimeType = 'image/png', options = {}) {
  const ai = getClient();
  const baseBase64 = basePortraitBuffer.toString('base64');

  const expressions = [
    { label: 'mouth-slightly-open', instruction: 'mouth slightly open as if speaking mid-sentence, lips parted. Everything else identical.' },
    { label: 'mouth-open', instruction: 'mouth open wider, talking expression as if saying a vowel sound. Everything else identical.' },
  ];

  const variants = [];

  for (let i = 0; i < expressions.length; i++) {
    const expr = expressions[i];
    console.log(`  Generating mouth variant: ${expr.label}...`);

    // Wait between API calls
    if (i > 0 || variants.length > 0) {
      console.log('  Pausing 15s between API calls...');
      await new Promise(r => setTimeout(r, 15000));
    }

    const startTime = Date.now();
    let response;
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await ai.models.generateContent({
          model: 'gemini-3.1-flash-image-preview',
          contents: [
            {
              parts: [
                { inlineData: { data: baseBase64, mimeType: baseMimeType } },
                { text: STYLE_PREFIX + `This is a character portrait. Create the EXACT same character portrait with the EXACT same art style, clothing, hair, eyes, lighting, and background. The ONLY change: ${expr.instruction}` },
              ],
            },
          ],
          config: {
            responseModalities: ['image', 'text'],
          },
        });
        break;
      } catch (err) {
        const details = err.message || String(err);
        console.error(`  API error: ${details.substring(0, 200)}`);
        if (attempt < maxRetries) {
          const waitSec = 15 * attempt;
          console.log(`  Retrying in ${waitSec}s (attempt ${attempt}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }
        throw err;
      }
    }

    const durationMs = Date.now() - startTime;
    const parts = response.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData);

    if (!imagePart) {
      const textPart = parts.find(p => p.text);
      console.warn(`  Variant ${expr.label} failed: ${textPart?.text || 'No image returned'}. Skipping.`);
      continue;
    }

    const varBase64 = imagePart.inlineData.data;
    const varMime = imagePart.inlineData.mimeType || 'image/png';
    const varBuffer = Buffer.from(varBase64, 'base64');

    console.log(`  Generated variant: ${expr.label} (${durationMs}ms, ${(varBuffer.length / 1024).toFixed(0)}KB)`);

    if (options.saveDir) {
      const savePath = join(options.saveDir, `portrait-${expr.label}.png`);
      mkdirSync(options.saveDir, { recursive: true });
      writeFileSync(savePath, varBuffer);
      console.log(`  Saved: ${savePath}`);
    }

    variants.push({ buffer: varBuffer, base64: varBase64, mimeType: varMime, label: expr.label });
  }

  return variants;
}

/**
 * Generate a scene background (9:16 vertical for Shorts).
 */
export async function generateSceneBackground(description, mood = 'neutral', options = {}) {
  const moodModifiers = {
    triumphant: 'golden warm light, celebratory atmosphere',
    tense: 'cold blue shadows, dramatic contrast',
    mysterious: 'purple mist, ethereal glow',
    dark: 'deep shadows, ominous red accents',
    neutral: 'balanced warm and cool tones',
    comedic: 'bright colors, exaggerated details',
  };
  const moodStr = moodModifiers[mood] || moodModifiers.neutral;
  const prompt = `${description}, vertical composition (portrait orientation 9:16 aspect ratio), ${moodStr}, detailed environment, RPG game background`;
  return generatePixelArt(prompt, options);
}
