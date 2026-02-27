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

const STYLE_PREFIX = 'PORTRAIT ORIENTATION (9:16 vertical aspect ratio, taller than wide), mobile phone screen format. 16-bit SNES-era pixel art with visible pixel grid, limited color palette (max 24 colors), no anti-aliasing, no smooth gradients, crisp hard-edged pixels. Style of Octopath Traveler, Final Fantasy VI, Chrono Trigger. Hand-pixeled aesthetic, NOT AI-generated looking, NOT anime, NOT smooth digital art. Chunky defined pixels, dithering for shading, retro RPG game sprite style. IMPORTANT: Do NOT include any text, words, letters, numbers, labels, titles, UI elements, health bars, or watermarks in the image — pure artwork only. ';

/**
 * Read PNG width and height from the IHDR chunk.
 * PNG: 8-byte signature, then IHDR chunk with width (4B BE) at offset 16, height at offset 20.
 */
function readPngDimensions(buffer) {
  if (buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

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

  let base64 = imagePart.inlineData.data;
  const mimeType = imagePart.inlineData.mimeType || 'image/png';
  let buffer = Buffer.from(base64, 'base64');

  console.log(`  Generated (${durationMs}ms, ${(buffer.length / 1024).toFixed(0)}KB, ${mimeType})`);

  // Orientation check — skip for portraits (square composition is intentional)
  if (!options.skipOrientationCheck) {
    const dims = readPngDimensions(buffer);
    if (dims && dims.width > dims.height) {
      console.warn(`  WARNING: Image is landscape (${dims.width}x${dims.height}), expected portrait. Retrying with explicit orientation...`);
      try {
        const retryPrompt = 'CRITICAL: Image MUST be portrait orientation — taller than wide, 9:16 vertical format for mobile phone screen. ' + fullPrompt;
        const retryResponse = await ai.models.generateContent({
          model: 'gemini-3.1-flash-image-preview',
          contents: retryPrompt,
          config: { responseModalities: ['image', 'text'] },
        });
        const retryParts = retryResponse.candidates?.[0]?.content?.parts || [];
        const retryImage = retryParts.find(p => p.inlineData);
        if (retryImage) {
          const retryBuffer = Buffer.from(retryImage.inlineData.data, 'base64');
          const retryDims = readPngDimensions(retryBuffer);
          if (retryDims && retryDims.height >= retryDims.width) {
            console.log(`  Retry succeeded: ${retryDims.width}x${retryDims.height} (portrait)`);
            buffer = retryBuffer;
            base64 = retryImage.inlineData.data;
          } else {
            console.warn(`  Retry still landscape (${retryDims?.width}x${retryDims?.height}), using original`);
          }
        }
      } catch (retryErr) {
        console.warn(`  Orientation retry failed: ${retryErr.message}, using original`);
      }
    }
  }

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
  const prompt = `close-up face portrait of ${description}, expressive eyes, dramatic lighting, dark background, square composition, character portrait for RPG dialogue box, pixel art RPG portrait with visible individual pixels, retro game aesthetic`;
  return generatePixelArt(prompt, { ...options, skipOrientationCheck: true });
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
 * Generate an expression/emotion variant of an existing portrait using reference-based generation.
 * Keeps the same character (face, hair, clothing, background) but changes expression/emotion.
 * Used when the same character reappears with a different portraitDescription (e.g., "horrified" after "determined").
 *
 * @param {Buffer} basePortraitBuffer - The original portrait PNG buffer
 * @param {string} baseMimeType - MIME type of the base portrait
 * @param {string} expressionDesc - Description of the new expression (from Director's portraitDescription)
 * @param {object} [options]
 * @param {string} [options.savePath] - Path to save the variant PNG
 * @returns {Promise<{ buffer, base64, mimeType, path, durationMs }>}
 */
export async function generateExpressionVariant(basePortraitBuffer, baseMimeType = 'image/png', expressionDesc, options = {}) {
  const ai = getClient();
  const baseBase64 = basePortraitBuffer.toString('base64');

  console.log(`  Generating expression variant: "${expressionDesc.substring(0, 80)}..."`);
  console.log('  Pausing 15s between API calls...');
  await new Promise(r => setTimeout(r, 15000));

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
              { text: STYLE_PREFIX + `This is a character portrait. Create the EXACT same character with the EXACT same art style, clothing, hair color, and background. Change the facial expression and emotion to match this description: ${expressionDesc}. Keep everything else about the character identical.` },
            ],
          },
        ],
        config: {
          responseModalities: ['image', 'text'],
        },
      });
      break;
    } catch (err) {
      console.error(`  API error: ${(err.message || String(err)).substring(0, 200)}`);
      if (attempt < maxRetries) {
        const waitSec = 15 * attempt;
        console.log(`  Retrying in ${waitSec}s (attempt ${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
      } else {
        throw new Error(`Expression variant generation failed after ${maxRetries} attempts: ${err.message}`);
      }
    }
  }

  const durationMs = Date.now() - startTime;
  let varBuffer, varBase64, varMime;

  for (const part of (response?.candidates?.[0]?.content?.parts || [])) {
    if (part.inlineData) {
      varBase64 = part.inlineData.data;
      varMime = part.inlineData.mimeType || 'image/png';
      varBuffer = Buffer.from(varBase64, 'base64');
      break;
    }
  }

  if (!varBuffer) {
    console.warn('  Expression variant generation returned no image — falling back to base portrait');
    return { buffer: basePortraitBuffer, base64: baseBase64, mimeType: baseMimeType, path: options.savePath, durationMs };
  }

  const sizeKB = Math.round(varBuffer.length / 1024);
  console.log(`  Expression variant: ${sizeKB}KB (${durationMs}ms)`);

  let savedPath = null;
  if (options.savePath) {
    const dir = dirname(options.savePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(options.savePath, varBuffer);
    savedPath = options.savePath;
    console.log(`  Saved: ${options.savePath}`);
  }

  return { buffer: varBuffer, base64: varBase64, mimeType: varMime, path: savedPath, durationMs };
}

/**
 * Generate action frames for an action closeup sequence.
 * Generates a base frame from prompt, then generates variant frames
 * using the base as a reference for visual consistency.
 *
 * @param {string} description - Action description (e.g., "close-up of a knife being drawn")
 * @param {number} frameCount - Number of unique frames to generate (2-5)
 * @param {string} mood - Background mood for color/lighting
 * @param {object} [options]
 * @param {string} [options.saveDir] - Directory to save frame PNGs
 * @returns {Promise<Array<{ buffer, base64, mimeType, label }>>}
 */
export async function generateActionFrames(description, frameCount = 5, mood = 'neutral', options = {}) {
  const ai = getClient();
  const moodModifiers = {
    triumphant: 'golden warm light, celebratory atmosphere',
    tense: 'cold blue shadows, dramatic contrast',
    mysterious: 'purple mist, ethereal glow',
    dark: 'deep shadows, ominous red accents',
    neutral: 'balanced warm and cool tones',
    comedic: 'bright colors, exaggerated details',
    blood: 'crimson tones, visceral atmosphere',
    epic: 'golden rays, sweeping grandeur',
    magic: 'arcane blue-purple glow, mystical particles',
  };
  const moodStr = moodModifiers[mood] || moodModifiers.neutral;

  const frames = [];
  const clampedCount = Math.max(2, Math.min(7, frameCount));

  // ── Frame 1: Generate base frame from prompt ──
  console.log(`  Generating action frame 1/${clampedCount}...`);

  const basePrompt = `${description}, frame 1 of ${clampedCount} showing the START of the action, vertical composition (portrait orientation 9:16 aspect ratio), ${moodStr}, dramatic close-up, action scene`;
  const baseSavePath = options.saveDir ? join(options.saveDir, 'frame_01.png') : undefined;
  const baseFrame = await generatePixelArt(basePrompt, { savePath: baseSavePath });

  frames.push({
    buffer: baseFrame.buffer,
    base64: baseFrame.base64,
    mimeType: baseFrame.mimeType,
    label: 'frame_01',
  });

  // ── Frames 2-N: Reference-based variants showing action progression ──
  for (let i = 2; i <= clampedCount; i++) {
    // Rate limit pause
    console.log('  Pausing 15s between API calls...');
    await new Promise(r => setTimeout(r, 15000));

    const progressDesc = i === clampedCount ? 'PEAK/CLIMAX' : 'MIDDLE progression';
    console.log(`  Generating action frame ${i}/${clampedCount} (${progressDesc})...`);

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
                { inlineData: { data: baseFrame.base64, mimeType: baseFrame.mimeType } },
                { text: STYLE_PREFIX + `This is frame 1 of an action sequence showing "${description}". Create frame ${i} of ${clampedCount} (the ${progressDesc} of the action). Keep the EXACT same art style, color palette, lighting, and composition. Progress the action forward — show the next stage of movement. The action should feel like a smooth animation sequence.` },
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
          console.log(`  Retrying in ${waitSec}s...`);
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
      console.warn(`  Action frame ${i} failed: ${textPart?.text || 'No image'}. Duplicating previous.`);
      frames.push({ ...frames[frames.length - 1], label: `frame_${String(i).padStart(2, '0')}` });
      continue;
    }

    const varBase64 = imagePart.inlineData.data;
    const varMime = imagePart.inlineData.mimeType || 'image/png';
    const varBuffer = Buffer.from(varBase64, 'base64');

    console.log(`  Generated frame ${i}: (${durationMs}ms, ${(varBuffer.length / 1024).toFixed(0)}KB)`);

    // Orientation sanity check for action frames
    const frameDims = readPngDimensions(varBuffer);
    if (frameDims && frameDims.width > frameDims.height) {
      console.warn(`  WARNING: Action frame ${i} is landscape (${frameDims.width}x${frameDims.height}), expected portrait`);
    }

    if (options.saveDir) {
      const savePath = join(options.saveDir, `frame_${String(i).padStart(2, '0')}.png`);
      mkdirSync(options.saveDir, { recursive: true });
      writeFileSync(savePath, varBuffer);
      console.log(`  Saved: ${savePath}`);
    }

    frames.push({
      buffer: varBuffer,
      base64: varBase64,
      mimeType: varMime,
      label: `frame_${String(i).padStart(2, '0')}`,
    });
  }

  return frames;
}

/**
 * Check visual coherence of generated frames using Gemini Flash vision.
 * Sends all frames to Gemini and asks it to evaluate consistency and progression.
 *
 * @param {Array<{ buffer: Buffer, base64: string, mimeType: string, label: string }>} frames
 * @param {string} sequenceType - 'action_closeup' | 'dialogue' | 'reaction'
 * @param {string} description - What the frames are supposed to show
 * @returns {Promise<{ coherent: boolean, issues: string[], problematicFrames: number[] }>}
 */
export async function checkVisualCoherence(frames, sequenceType, description) {
  const ai = getClient();

  // Build multi-modal content: all frames as images + analysis prompt
  const parts = [];

  for (let i = 0; i < frames.length; i++) {
    parts.push({
      inlineData: {
        data: frames[i].base64,
        mimeType: frames[i].mimeType || 'image/png',
      },
    });
    parts.push({ text: `[Frame ${i + 1}: ${frames[i].label}]` });
  }

  let analysisPrompt;
  if (sequenceType === 'action_closeup') {
    analysisPrompt = `These ${frames.length} pixel art frames are an action sequence meant to show: "${description}".

They will be played in a bounce loop (1→2→3→...→N→...→3→2→repeat).

Analyze these frames:
1. Do they show a coherent visual progression of the described action?
2. Is the pixel art style consistent across all frames (same palette, detail level, lighting)?
3. Are there any visual artifacts, glitches, or obviously broken frames?
4. Would this sequence look good as a smooth bouncing animation?

Return ONLY a JSON object:
{
  "coherent": true/false,
  "issues": ["list of specific problems, empty if none"],
  "problematicFrames": [frame numbers (1-indexed) that have problems, empty if none]
}`;
  } else {
    // dialogue / reaction — check portrait consistency with mouth variants
    analysisPrompt = `These ${frames.length} pixel art portraits are mouth variants of the same character for dialogue animation.

Frame 1 is the base (closed mouth). Subsequent frames show the same character with progressively more open mouth.

Analyze these frames:
1. Is this clearly the same character across all frames (same hair, eyes, clothing, background)?
2. Do the mouth positions vary correctly (closed → slightly open → open)?
3. Are there any visual artifacts or major inconsistencies?

Return ONLY a JSON object:
{
  "coherent": true/false,
  "issues": ["list of specific problems, empty if none"],
  "problematicFrames": [frame numbers (1-indexed) that have problems, empty if none]
}`;
  }

  parts.push({ text: analysisPrompt });

  console.log(`  Visual QC: Checking ${frames.length} frames (${sequenceType})...`);
  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ parts }],
    });

    const durationMs = Date.now() - startTime;
    console.log(`  Visual QC: Done (${durationMs}ms)`);

    const text = response.candidates?.[0]?.content?.parts
      ?.find(p => p.text)?.text || '';

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const result = JSON.parse(jsonMatch[0]);
        if (!result.coherent) {
          console.log(`  Visual QC: FAILED — ${(result.issues || []).join('; ')}`);
        } else {
          console.log(`  Visual QC: Passed`);
        }
        return {
          coherent: result.coherent !== false,
          issues: result.issues || [],
          problematicFrames: result.problematicFrames || [],
        };
      } catch (e) {
        console.warn(`  Visual QC: Failed to parse response, assuming coherent`);
        return { coherent: true, issues: [], problematicFrames: [] };
      }
    }

    console.warn(`  Visual QC: No JSON in response, assuming coherent`);
    return { coherent: true, issues: [], problematicFrames: [] };
  } catch (err) {
    console.warn(`  Visual QC: Error (${err.message}), skipping`);
    return { coherent: true, issues: [], problematicFrames: [] };
  }
}

/**
 * Regenerate a specific action frame with additional guidance about what was wrong.
 * Uses the base frame (frame 1) as reference for consistency.
 *
 * @param {object} baseFrame - The first frame { base64, mimeType }
 * @param {number} frameNumber - Which frame to regenerate (1-indexed)
 * @param {number} totalFrames - Total frame count
 * @param {string} description - Action sequence description
 * @param {string} issueHint - What was wrong with the previous attempt
 * @param {string} [mood='neutral'] - Mood modifier
 * @param {object} [options] - { savePath }
 * @returns {Promise<{ buffer: Buffer, base64: string, mimeType: string }>}
 */
export async function regenerateActionFrame(baseFrame, frameNumber, totalFrames, description, issueHint, mood = 'neutral', options = {}) {
  const ai = getClient();
  const moodModifiers = {
    triumphant: 'golden warm light, celebratory atmosphere',
    tense: 'cold blue shadows, dramatic contrast',
    mysterious: 'purple mist, ethereal glow',
    dark: 'deep shadows, ominous red accents',
    neutral: 'balanced warm and cool tones',
    comedic: 'bright colors, exaggerated details',
    blood: 'crimson tones, visceral atmosphere',
    epic: 'golden rays, sweeping grandeur',
    magic: 'arcane blue-purple glow, mystical particles',
  };
  const moodStr = moodModifiers[mood] || moodModifiers.neutral;

  const progressDesc = frameNumber === totalFrames ? 'PEAK/CLIMAX' : 'MIDDLE progression';

  console.log(`  Regenerating action frame ${frameNumber}/${totalFrames}...`);
  const startTime = Date.now();

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [
      {
        parts: [
          {
            inlineData: {
              data: baseFrame.base64,
              mimeType: baseFrame.mimeType || 'image/png',
            },
          },
          {
            text: STYLE_PREFIX + `This is frame 1 of an action sequence showing "${description}". Create frame ${frameNumber} of ${totalFrames} (the ${progressDesc}). Keep the EXACT same art style, color palette, lighting, and composition. Progress the action forward — show the next stage of movement. Previous attempt had issues: ${issueHint}. Ensure visual consistency with frame 1. ${moodStr}`,
          },
        ],
      },
    ],
    config: { responseModalities: ['image', 'text'] },
  });

  const parts = response.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData);

  if (!imagePart) {
    throw new Error('Regeneration returned no image');
  }

  const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
  const durationMs = Date.now() - startTime;
  console.log(`  Regenerated frame ${frameNumber} (${durationMs}ms, ${Math.round(buffer.length / 1024)}KB)`);

  if (options.savePath) {
    writeFileSync(options.savePath, buffer);
    console.log(`  Saved: ${options.savePath}`);
  }

  return {
    buffer,
    base64: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || 'image/png',
  };
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
