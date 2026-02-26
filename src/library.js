import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIBRARY_DIR = join(__dirname, '..', 'library');
const INDEX_PATH = join(LIBRARY_DIR, 'index.json');

let libraryCache = null;

/**
 * Load the animation library index.
 * @returns {{ version: number, animations: object[] }}
 */
export function loadLibrary() {
  if (libraryCache) return libraryCache;
  if (!existsSync(INDEX_PATH)) {
    libraryCache = { version: 1, lastUpdated: new Date().toISOString(), animations: [] };
    return libraryCache;
  }
  libraryCache = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
  return libraryCache;
}

/**
 * Get all animations in the library.
 */
export function listAnimations() {
  return loadLibrary().animations;
}

/**
 * Get full metadata for a specific animation.
 */
export function getAnimationMeta(id) {
  const metaPath = join(LIBRARY_DIR, id, 'meta.json');
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, 'utf-8'));
}

/**
 * Get the animation HTML source for a library entry.
 */
export function getAnimationHtml(id) {
  const htmlPath = join(LIBRARY_DIR, id, 'animation.html');
  if (!existsSync(htmlPath)) return null;
  return readFileSync(htmlPath, 'utf-8');
}

/**
 * Find the best matching library animation for an animation concept.
 *
 * Works with both:
 * - Full highlight objects (legacy): { type, tags, suggestedAnimationType }
 * - Animation sequence items (new): { suggestedType, concept, emotion }
 *
 * @param {object} item - Either a highlight or animation sequence item
 * @param {string} [parentType] - The parent highlight's moment type (for sequence items)
 * @returns {{ decision: string, match: object|null, reason: string }}
 */
export function findMatch(item, parentType = null) {
  const library = loadLibrary();
  if (library.animations.length === 0) {
    return { decision: 'CREATE', match: null, reason: 'Library is empty' };
  }

  // Determine the moment type to match against
  const momentType = item.type || item.suggestedType || parentType;
  // Determine theme keywords to match against
  const themeSource = item.suggestedAnimationType || item.suggestedType || item.concept || '';

  // Score each animation against the item
  let bestScore = 0;
  let bestMatch = null;

  for (const anim of library.animations) {
    let score = 0;

    // Moment type match (strongest signal)
    if (momentType && anim.momentTypes && anim.momentTypes.includes(momentType)) {
      score += 50;
    }

    // Tag overlap (works when item has tags — mainly for full highlights)
    if (anim.tags && item.tags) {
      const overlap = anim.tags.filter(t => item.tags.includes(t)).length;
      score += overlap * 10;
    }

    // Theme keyword match — check against concept/suggestedType
    if (anim.theme && themeSource) {
      const themeWords = anim.theme.toLowerCase().split(/[\/\s]+/);
      const sourceWords = themeSource.toLowerCase().split(/[\s,_]+/);
      const themeOverlap = themeWords.filter(w => sourceWords.some(sw => sw.includes(w) || w.includes(sw))).length;
      score += themeOverlap * 15;
    }

    // Concept keyword match — check animation name/tags against concept text
    if (anim.tags && item.concept) {
      const conceptWords = item.concept.toLowerCase().split(/[\s,]+/);
      const tagOverlap = anim.tags.filter(t => conceptWords.some(cw => cw.includes(t) || t.includes(cw))).length;
      score += tagOverlap * 8;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = anim;
    }
  }

  if (bestScore >= 50) {
    if (bestScore >= 60) {
      return { decision: 'REUSE', match: bestMatch, reason: `Strong match: ${bestMatch.name} (score: ${bestScore})` };
    }
    return { decision: 'ADAPT', match: bestMatch, reason: `Partial match: ${bestMatch.name} — adapt for this concept (score: ${bestScore})` };
  }

  return { decision: 'CREATE', match: null, reason: `No good library match (best score: ${bestScore})` };
}

/**
 * Add a new animation to the library.
 */
export function addToLibrary(id, animationHtml, metadata) {
  const animDir = join(LIBRARY_DIR, id);
  mkdirSync(animDir, { recursive: true });

  writeFileSync(join(animDir, 'animation.html'), animationHtml);
  writeFileSync(join(animDir, 'meta.json'), JSON.stringify(metadata, null, 2));

  // Update the index
  const library = loadLibrary();
  const existing = library.animations.findIndex(a => a.id === id);
  const indexEntry = {
    id,
    name: metadata.name,
    theme: metadata.theme,
    emotion: metadata.emotion,
    momentTypes: metadata.momentTypes,
    tags: metadata.tags,
  };

  if (existing >= 0) {
    library.animations[existing] = indexEntry;
  } else {
    library.animations.push(indexEntry);
  }

  library.lastUpdated = new Date().toISOString();
  writeFileSync(INDEX_PATH, JSON.stringify(library, null, 2));
  libraryCache = library;

  return indexEntry;
}

/**
 * Clear the cache (for testing or after manual edits).
 */
export function clearCache() {
  libraryCache = null;
}
