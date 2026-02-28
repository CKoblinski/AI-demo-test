import { GoogleGenAI } from '@google/genai';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

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

// Closing reinforcement — appended AFTER the description to sandwich the style instruction
const STYLE_SUFFIX = ' CRITICAL STYLE REMINDER: This MUST be 16-bit SNES-era pixel art with visible chunky pixels, dithered shading, limited palette (max 24 colors). NOT anime, NOT smooth digital art, NOT realistic. Think Octopath Traveler / Final Fantasy VI sprite work. Visible pixel grid is mandatory.';

// Pixel Snapper — post-processor that enforces pixel grid alignment + palette quantization
const PIXEL_SNAPPER_BIN = join(__dirname, '..', 'tools', 'pixel-snapper', 'target', 'release', 'spritefusion-pixel-snapper');
// Portraits get fewer colors → chunkier, more retro, less anime smooth shading
const PORTRAIT_SNAP_COLORS = 16;
const DEFAULT_SNAP_COLORS = 24;
let _pixelSnapperAvailable = null;

/**
 * Check if Pixel Snapper binary is available (cached after first check).
 */
function isPixelSnapperAvailable() {
  if (_pixelSnapperAvailable !== null) return _pixelSnapperAvailable;
  _pixelSnapperAvailable = existsSync(PIXEL_SNAPPER_BIN);
  if (!_pixelSnapperAvailable) {
    console.warn('  Pixel Snapper: Not installed (expected at tools/pixel-snapper/). Skipping post-processing.');
    console.warn('  To install: cd tools/pixel-snapper && cargo build --release');
  } else {
    console.log('  Pixel Snapper: Available ✓');
  }
  return _pixelSnapperAvailable;
}

/**
 * Post-process a generated image through Pixel Snapper.
 * Enforces pixel grid alignment and quantizes to a strict palette.
 * Non-fatal: if snapper fails, returns the original buffer.
 *
 * @param {Buffer} imageBuffer - Source PNG buffer
 * @param {number} [colors=24] - Max colors for palette quantization
 * @returns {Buffer} Processed PNG buffer (or original on failure)
 */
function snapToPixelArt(imageBuffer, colors = 24) {
  if (!isPixelSnapperAvailable()) return imageBuffer;

  // Write to temp file, process, read back
  const tmpInput = join(__dirname, '..', `.tmp_snap_in_${Date.now()}.png`);
  const tmpOutput = join(__dirname, '..', `.tmp_snap_out_${Date.now()}.png`);

  try {
    writeFileSync(tmpInput, imageBuffer);

    execFileSync(PIXEL_SNAPPER_BIN, [tmpInput, tmpOutput, String(colors)], {
      timeout: 15000,
      stdio: 'pipe',
    });

    if (existsSync(tmpOutput)) {
      const snapped = readFileSync(tmpOutput);
      const origKB = Math.round(imageBuffer.length / 1024);
      const snapKB = Math.round(snapped.length / 1024);
      console.log(`  Pixel Snapper: ${origKB}KB → ${snapKB}KB (${colors} colors)`);
      return snapped;
    } else {
      console.warn('  Pixel Snapper: No output file produced, using original');
      return imageBuffer;
    }
  } catch (err) {
    console.warn(`  Pixel Snapper: Error (${err.message?.substring(0, 100)}), using original`);
    return imageBuffer;
  } finally {
    // Cleanup temp files
    try { if (existsSync(tmpInput)) unlinkSync(tmpInput); } catch (_) {}
    try { if (existsSync(tmpOutput)) unlinkSync(tmpOutput); } catch (_) {}
  }
}

/**
 * Truncate a description to maxLen at the last sentence boundary.
 * Prevents prompt bloat from diluting style instructions.
 */
function capDescription(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  const cut = text.substring(0, maxLen);
  const lastPeriod = cut.lastIndexOf('.');
  const lastComma = cut.lastIndexOf(',');
  const boundary = Math.max(lastPeriod, lastComma);
  return boundary > maxLen * 0.5 ? cut.substring(0, boundary + 1) : cut;
}

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
  const fullPrompt = STYLE_PREFIX + prompt + STYLE_SUFFIX;

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

  // ── Post-process through Pixel Snapper (grid alignment + palette quantization) ──
  if (!options.skipPixelSnap) {
    const colors = options.portraitSnap ? PORTRAIT_SNAP_COLORS : DEFAULT_SNAP_COLORS;
    const snapped = snapToPixelArt(buffer, colors);
    if (snapped !== buffer) {
      buffer = snapped;
      base64 = buffer.toString('base64');
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
 * Optionally accepts a reference image for cross-session visual consistency.
 *
 * @param {string} name - Character name
 * @param {string} description - Visual description of the character
 * @param {object} [options]
 * @param {string} [options.savePath] - Path to save the PNG
 * @param {object} [options.referenceImage] - Optional reference image { base64, mimeType }
 * @returns {Promise<{ buffer: Buffer, base64: string, mimeType: string, path?: string, durationMs: number }>}
 */
export async function generateCharacterPortrait(name, description, options = {}) {
  if (options.referenceImage) {
    // Reference-based generation: use saved portrait as style anchor
    const ai = getClient();
    const prompt = STYLE_PREFIX + `This is a reference portrait. Create a NEW portrait of the same character in the same chunky pixel art style. The character should look like themselves (same face, hair, clothing) but with the expression and emotion matching this description: ${description}. Square composition, face fills exactly 85-90% of the frame, centered. Dark moody background. Thick visible pixel grid, blocky SNES-era RPG portrait style. NOT anime, NOT smooth — low pixel count aesthetic like a 48x48 pixel portrait scaled up.` + STYLE_SUFFIX;

    console.log(`  Generating portrait (with reference): ${description.substring(0, 80)}...`);
    const startTime = Date.now();

    let response;
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await ai.models.generateContent({
          model: 'gemini-3.1-flash-image-preview',
          contents: [{
            parts: [
              { inlineData: { data: options.referenceImage.base64, mimeType: options.referenceImage.mimeType || 'image/png' } },
              { text: prompt },
            ],
          }],
          config: { responseModalities: ['image', 'text'] },
        });
        break;
      } catch (err) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 15000 * attempt));
          continue;
        }
        throw err;
      }
    }

    const durationMs = Date.now() - startTime;
    const parts = response.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData);

    if (!imagePart) {
      console.warn('  Reference-based portrait failed, falling back to fresh generation');
      // Fall through to normal generation
    } else {
      let base64 = imagePart.inlineData.data;
      const mimeType = imagePart.inlineData.mimeType || 'image/png';
      let buffer = Buffer.from(base64, 'base64');

      console.log(`  Generated portrait (ref-based, ${durationMs}ms, ${Math.round(buffer.length / 1024)}KB)`);

      // Pixel Snapper post-processing — portraits get 16 colors for chunkier look
      const snapped = snapToPixelArt(buffer, PORTRAIT_SNAP_COLORS);
      if (snapped !== buffer) { buffer = snapped; base64 = buffer.toString('base64'); }

      let savedPath = null;
      if (options.savePath) {
        mkdirSync(dirname(options.savePath), { recursive: true });
        writeFileSync(options.savePath, buffer);
        savedPath = options.savePath;
      }

      return { buffer, base64, mimeType, path: savedPath, durationMs };
    }
  }

  // Standard generation (no reference) — cap description to prevent prompt bloat
  const cappedDesc = capDescription(description, 200);
  const prompt = `Character portrait for RPG dialogue box: ${cappedDesc}. Square composition, face fills exactly 85-90% of the frame, centered. Dark moody background. Chunky blocky pixel art style like SNES Final Fantasy VI or Chrono Trigger character select portraits. Thick visible pixel grid, NOT anime, NOT smooth — each pixel should be clearly distinguishable as an individual square. Low pixel count aesthetic (think 48x48 pixel portrait scaled up). Dithered shading, limited palette, hard pixel edges.`;
  return generatePixelArt(prompt, { ...options, skipOrientationCheck: true, portraitSnap: true });
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
  const baseSizeKB = Math.round(basePortraitBuffer.length / 1024);

  const expressions = [
    { label: 'mouth-slightly-open', instruction: 'mouth slightly open, lips parted by 1-2 pixels. ONLY the mouth pixels change.' },
    { label: 'mouth-open', instruction: 'mouth open wider showing teeth, 2-3 pixels of opening. ONLY the mouth pixels change.' },
  ];

  // Generate all variants in parallel — each references the base portrait independently
  console.log(`  Generating ${expressions.length} mouth variants in parallel...`);
  await new Promise(r => setTimeout(r, 2000)); // 2s courtesy pause before burst

  const variantPromises = expressions.map(async (expr) => {
    console.log(`  Generating mouth variant: ${expr.label}...`);
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
                { text: `PIXEL-PERFECT COPY with ONE tiny change. Copy this image EXACTLY — same zoom level, same framing, same face position, same pixel grid, same colors, same lighting, same background, same hair, same eyes, same clothing. The character's face must fill EXACTLY the same percentage of the frame. Do NOT recompose, reframe, zoom in, zoom out, or shift the character's position AT ALL. The ONLY pixels that should differ from the input: ${expr.instruction} Every single pixel outside the mouth area must be IDENTICAL to the input image. This is a 2-frame animation — the frames must be interchangeable without any visible jump in composition.` },
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
          const waitSec = 5 * attempt;
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
      return null;
    }

    let varBase64 = imagePart.inlineData.data;
    const varMime = imagePart.inlineData.mimeType || 'image/png';
    let varBuffer = Buffer.from(varBase64, 'base64');

    // Pixel Snapper post-processing (portrait palette: 16 colors)
    const snappedVar = snapToPixelArt(varBuffer, PORTRAIT_SNAP_COLORS);
    if (snappedVar !== varBuffer) { varBuffer = snappedVar; varBase64 = varBuffer.toString('base64'); }

    console.log(`  Generated variant: ${expr.label} (${durationMs}ms, ${(varBuffer.length / 1024).toFixed(0)}KB)`);

    // ── Framing guard: reject variants where composition drifted drastically ──
    const varSizeKB = Math.round(varBuffer.length / 1024);
    const sizeDriftPct = baseSizeKB > 0 ? Math.abs(varSizeKB - baseSizeKB) / baseSizeKB * 100 : 0;

    if (sizeDriftPct > 60) {
      console.warn(`  ⚠ Framing guard: variant ${expr.label} drifted drastically (${sizeDriftPct.toFixed(0)}% size change). Using base portrait as fallback.`);
      return { buffer: basePortraitBuffer, base64: baseBase64, mimeType: baseMimeType, label: expr.label, framingFallback: true };
    }
    if (sizeDriftPct > 30) {
      console.warn(`  ⚠ Framing guard: variant ${expr.label} has moderate drift (${sizeDriftPct.toFixed(0)}%) — accepting but watch for visual jump`);
    }
    if (options.saveDir) {
      const savePath = join(options.saveDir, `portrait-${expr.label}.png`);
      mkdirSync(options.saveDir, { recursive: true });
      writeFileSync(savePath, varBuffer);
      console.log(`  Saved: ${savePath}`);
    }
    return { buffer: varBuffer, base64: varBase64, mimeType: varMime, label: expr.label };
  });

  const results = await Promise.allSettled(variantPromises);
  const variants = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      variants.push(r.value);
    } else if (r.status === 'rejected') {
      console.warn(`  Mouth variant failed: ${r.reason?.message}`);
    }
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
  console.log('  Pausing 2s between API calls...');
  await new Promise(r => setTimeout(r, 2000));

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
              { text: STYLE_PREFIX + `This is a character portrait. Create the EXACT same character with the EXACT same art style, clothing, hair color, background, zoom level, and framing. The face must fill EXACTLY the same percentage of the frame — do NOT recompose or reframe. Change only the facial expression and emotion to match: ${expressionDesc}. Maintain identical pixel grid, composition, and face position.` + STYLE_SUFFIX },
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

  // Pixel Snapper post-processing — portraits get 16 colors for chunkier look
  const snappedExpr = snapToPixelArt(varBuffer, PORTRAIT_SNAP_COLORS);
  if (snappedExpr !== varBuffer) { varBuffer = snappedExpr; varBase64 = varBuffer.toString('base64'); }

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
  const clampedCount = Math.max(2, Math.min(10, frameCount));

  // ── Frame 1: Generate base frame from prompt ──
  console.log(`  Generating action frame 1/${clampedCount}...`);

  const cappedDesc = capDescription(description, 250);
  const basePrompt = `${cappedDesc}, frame 1 of ${clampedCount} showing the START of the action, vertical composition (portrait orientation 9:16 aspect ratio), ${moodStr}, dramatic close-up, action scene`;
  const baseSavePath = options.saveDir ? join(options.saveDir, 'frame_01.png') : undefined;
  const baseFrame = await generatePixelArt(basePrompt, { savePath: baseSavePath });

  frames.push({
    buffer: baseFrame.buffer,
    base64: baseFrame.base64,
    mimeType: baseFrame.mimeType,
    label: 'frame_01',
  });

  // ── Frames 2-N: Chained dual-image reference (frame 1 = style anchor, frame N-1 = continuity) ──
  for (let i = 2; i <= clampedCount; i++) {
    // Courtesy pause between sequential Gemini calls
    console.log('  Pausing 2s between API calls...');
    await new Promise(r => setTimeout(r, 2000));

    const progressDesc = i === clampedCount ? 'final moment' : `step ${i - 1} of ${clampedCount - 1}`;
    const prevFrame = frames[frames.length - 1]; // chain: reference the PREVIOUS frame for continuity
    console.log(`  Generating action frame ${i}/${clampedCount} (${progressDesc}, chained from frame ${i - 1})...`);

    const startTime = Date.now();
    let response;
    const maxRetries = 2;

    // Build dual-image reference: frame 1 (style) + previous frame (continuity)
    const contentParts = [
      { inlineData: { data: baseFrame.base64, mimeType: baseFrame.mimeType } },
    ];
    // For frame 2, previous IS frame 1, so skip duplicate image
    if (i > 2) {
      contentParts.push({ inlineData: { data: prevFrame.base64, mimeType: prevFrame.mimeType || 'image/png' } });
    }
    const refText = i > 2
      ? `Image 1 is the STARTING frame (style/palette reference). Image 2 is the CURRENT frame (where the action is now). Create the next small step forward in the action sequence. Change only what needs to move — keep the same zoom, composition, color palette, and art style. This is frame ${i} of ${clampedCount} showing "${cappedDesc}". Make a SMALL incremental change from Image 2, not a dramatic leap.`
      : `This is frame 1 of an action sequence showing "${cappedDesc}". Create frame 2 — the next small step in the action. Keep the EXACT same art style, color palette, lighting, composition, and zoom. Make a SMALL incremental change, not a dramatic leap.`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await ai.models.generateContent({
          model: 'gemini-3.1-flash-image-preview',
          contents: [
            {
              parts: [
                ...contentParts,
                { text: STYLE_PREFIX + refText + STYLE_SUFFIX },
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
          const waitSec = 5 * attempt;
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

    let varBase64 = imagePart.inlineData.data;
    const varMime = imagePart.inlineData.mimeType || 'image/png';
    let varBuffer = Buffer.from(varBase64, 'base64');

    // Pixel Snapper post-processing
    const snappedFrame = snapToPixelArt(varBuffer);
    if (snappedFrame !== varBuffer) { varBuffer = snappedFrame; varBase64 = varBuffer.toString('base64'); }

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
    // dialogue / reaction — check portrait consistency with mouth variants + framing
    analysisPrompt = `These ${frames.length} pixel art portraits are mouth variants of the same character for dialogue animation.

Frame 1 is the base (closed mouth). Subsequent frames show the same character with progressively more open mouth.

Analyze these frames:
1. Is this clearly the same character across all frames (same hair, eyes, clothing, background)?
2. Do the mouth positions vary correctly (closed → slightly open → open)?
3. Are there any visual artifacts or major inconsistencies?
4. FRAMING CHECK: What percentage of each frame does the character's face fill? Is the zoom level and composition IDENTICAL across all frames, or did any frame shift, zoom in, or zoom out compared to frame 1? The face should fill the same percentage of the frame in every variant.

Return ONLY a JSON object:
{
  "coherent": true/false,
  "issues": ["list of specific problems, empty if none"],
  "problematicFrames": [frame numbers (1-indexed) that have problems, empty if none],
  "framing": {
    "faceFillPercent": [estimated % face fills for each frame, e.g. 85, 88, 82],
    "compositionConsistent": true/false,
    "framingIssues": ["list of framing-specific problems, empty if none"]
  }
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

        // Parse framing data for dialogue/reaction sequences
        let framingInconsistent = false;
        let framingData = null;
        if (result.framing && sequenceType !== 'action_closeup') {
          framingData = result.framing;
          const fills = result.framing.faceFillPercent;
          if (Array.isArray(fills) && fills.length >= 2) {
            const minFill = Math.min(...fills);
            const maxFill = Math.max(...fills);
            const variance = maxFill - minFill;
            if (variance > 5 || result.framing.compositionConsistent === false) {
              framingInconsistent = true;
              console.log(`  Visual QC: Framing drift detected (fill range: ${minFill}%-${maxFill}%, variance: ${variance}%)`);
            }
          }
        }

        return {
          coherent: result.coherent !== false,
          issues: result.issues || [],
          problematicFrames: result.problematicFrames || [],
          framingInconsistent,
          framingData,
        };
      } catch (e) {
        console.warn(`  Visual QC: Failed to parse response, assuming coherent`);
        return { coherent: true, issues: [], problematicFrames: [], framingInconsistent: false, framingData: null };
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
            text: STYLE_PREFIX + `This is frame 1 of an action sequence showing "${description}". Create frame ${frameNumber} of ${totalFrames} (the ${progressDesc}). Keep the EXACT same art style, color palette, lighting, and composition. Progress the action forward — show the next stage of movement. Previous attempt had issues: ${issueHint}. Ensure visual consistency with frame 1. ${moodStr}` + STYLE_SUFFIX,
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

  let buffer = Buffer.from(imagePart.inlineData.data, 'base64');
  let base64 = imagePart.inlineData.data;
  const durationMs = Date.now() - startTime;
  console.log(`  Regenerated frame ${frameNumber} (${durationMs}ms, ${Math.round(buffer.length / 1024)}KB)`);

  // Pixel Snapper post-processing
  const snappedRegen = snapToPixelArt(buffer);
  if (snappedRegen !== buffer) { buffer = snappedRegen; base64 = buffer.toString('base64'); }

  if (options.savePath) {
    writeFileSync(options.savePath, buffer);
    console.log(`  Saved: ${options.savePath}`);
  }

  return {
    buffer,
    base64,
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
  const cappedDesc = capDescription(description, 300);
  const prompt = `${cappedDesc}, vertical composition (portrait orientation 9:16 aspect ratio), ${moodStr}, detailed environment, RPG game background`;
  return generatePixelArt(prompt, options);
}

/**
 * Check background accuracy using Gemini Flash vision.
 * Compares a generated background against the scene context and description.
 * Catches: wrong setting, baked-in text, wrong mood/lighting, style breaks.
 *
 * @param {Buffer} imageBuffer - The generated background PNG
 * @param {string} imageMimeType - MIME type of the image
 * @param {object|null} sceneContext - Scene context from Director pipeline (setting, conflict, etc.)
 * @param {string} sequenceDesc - The backgroundDescription from the sequence plan
 * @returns {Promise<{ accurate: boolean, issues: string[], shouldRetry: boolean }>}
 */
export async function checkBackgroundAccuracy(imageBuffer, imageMimeType, sceneContext, sequenceDesc) {
  const ai = getClient();
  const imageBase64 = imageBuffer.toString('base64');

  // Build context string from scene context
  let contextStr = '';
  if (sceneContext) {
    if (sceneContext.setting) contextStr += `Setting: ${sceneContext.setting}\n`;
    if (sceneContext.conflict) contextStr += `Conflict: ${sceneContext.conflict}\n`;
    if (sceneContext.enemies) contextStr += `Enemies/NPCs: ${sceneContext.enemies}\n`;
    if (sceneContext.emotionalTemperature) contextStr += `Mood: ${sceneContext.emotionalTemperature}\n`;
  }

  const analysisPrompt = `You are a visual QC checker for pixel art backgrounds used in D&D YouTube Shorts.

This background was generated from this description:
"${sequenceDesc}"

${contextStr ? `Scene context from the D&D session transcript:\n${contextStr}` : ''}

Check this image for these issues:

1. **Text/Labels**: Does the image contain ANY visible text, words, numbers, letters, labels, titles, UI elements, health bars, watermarks, or speech bubbles? This is the most critical check — any text at all is a FAIL.
2. **Setting accuracy**: Does the image match the described setting? (e.g., if the description says "tavern interior" but the image shows a forest, that's wrong)
3. **Style compliance**: Is this actual pixel art (visible pixel grid, limited palette, SNES-era aesthetic)? If it looks photorealistic, smooth digital art, or anime-style, that's wrong.
4. **Mood/lighting**: Does the lighting and mood roughly match what was described?

Return ONLY a JSON object:
{
  "accurate": true/false,
  "issues": ["list of specific problems found, empty if none"],
  "shouldRetry": true/false
}

Set shouldRetry to TRUE only for MAJOR issues:
- Image contains visible text, labels, or UI elements
- Completely wrong setting (forest instead of tavern)
- Not pixel art at all (photorealistic or smooth digital)

Set shouldRetry to FALSE for minor issues:
- Slightly wrong lighting direction
- Missing small details from the description
- Mood is close but not perfect`;

  console.log(`  Background QC: Checking accuracy...`);
  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        parts: [
          { inlineData: { data: imageBase64, mimeType: imageMimeType || 'image/png' } },
          { text: analysisPrompt },
        ],
      }],
    });

    const durationMs = Date.now() - startTime;
    console.log(`  Background QC: Done (${durationMs}ms)`);

    const text = response.candidates?.[0]?.content?.parts
      ?.find(p => p.text)?.text || '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const result = JSON.parse(jsonMatch[0]);
        if (!result.accurate) {
          console.log(`  Background QC: ISSUES — ${(result.issues || []).join('; ')}`);
          console.log(`  Background QC: shouldRetry=${result.shouldRetry}`);
        } else {
          console.log(`  Background QC: Passed ✓`);
        }
        return {
          accurate: result.accurate !== false,
          issues: result.issues || [],
          shouldRetry: result.shouldRetry === true,
        };
      } catch (e) {
        console.warn(`  Background QC: Failed to parse response, assuming accurate`);
        return { accurate: true, issues: [], shouldRetry: false };
      }
    }

    console.warn(`  Background QC: No JSON in response, assuming accurate`);
    return { accurate: true, issues: [], shouldRetry: false };
  } catch (err) {
    console.warn(`  Background QC: Error (${err.message}), skipping`);
    return { accurate: true, issues: [], shouldRetry: false };
  }
}

/**
 * Regenerate a background with additional guidance about what was wrong.
 * Same as generateSceneBackground but appends issue feedback to the prompt.
 *
 * @param {string} description - Background description
 * @param {string} mood - Background mood
 * @param {string} issueHint - What was wrong with the previous attempt
 * @param {object} [options] - { savePath }
 * @returns {Promise<{ buffer: Buffer, base64: string, mimeType: string, path?: string, durationMs: number }>}
 */
export async function regenerateBackground(description, mood = 'neutral', issueHint, options = {}) {
  const moodModifiers = {
    triumphant: 'golden warm light, celebratory atmosphere',
    tense: 'cold blue shadows, dramatic contrast',
    mysterious: 'purple mist, ethereal glow',
    dark: 'deep shadows, ominous red accents',
    neutral: 'balanced warm and cool tones',
    comedic: 'bright colors, exaggerated details',
  };
  const moodStr = moodModifiers[mood] || moodModifiers.neutral;

  console.log(`  Regenerating background with issue feedback: "${issueHint.substring(0, 100)}..."`);

  const cappedDesc = capDescription(description, 300);
  const prompt = `${cappedDesc}, vertical composition (portrait orientation 9:16 aspect ratio), ${moodStr}, detailed environment, RPG game background. CRITICAL: Previous attempt had these issues: ${issueHint}. You MUST avoid these problems. Do NOT include any text, words, numbers, labels, or UI elements.`;
  return generatePixelArt(prompt, options);
}

/**
 * Regenerate a character portrait with additional guidance about what was wrong.
 * Uses the same portrait prompt pattern but appends issue feedback.
 *
 * @param {string} name - Character name
 * @param {string} description - Portrait description
 * @param {string} issueHint - What was wrong with the previous attempt
 * @param {object} [options] - { savePath }
 * @returns {Promise<{ buffer: Buffer, base64: string, mimeType: string, path?: string, durationMs: number }>}
 */
export async function regeneratePortrait(name, description, issueHint, options = {}) {
  console.log(`  Regenerating portrait for ${name} with issue feedback: "${issueHint.substring(0, 100)}..."`);

  const cappedDesc = capDescription(description, 200);
  const prompt = `Character portrait for RPG dialogue box: ${cappedDesc}. Square composition, face fills exactly 85-90% of the frame, centered. Dark moody background. Chunky blocky pixel art style like SNES Final Fantasy VI or Chrono Trigger character select portraits. Thick visible pixel grid, NOT anime, NOT smooth — low pixel count aesthetic (think 48x48 pixel portrait scaled up). Dithered shading, limited palette, hard pixel edges. CRITICAL: Previous attempt had these issues: ${issueHint}. Avoid these problems.`;
  return generatePixelArt(prompt, { ...options, skipOrientationCheck: true, portraitSnap: true });
}
