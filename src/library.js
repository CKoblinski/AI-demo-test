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
 * Find the best matching library animation for a moment.
 * Returns { decision: 'REUSE'|'ADAPT'|'CREATE', match: animMeta|null, reason: string }
 */
export function findMatch(moment) {
  const library = loadLibrary();
  if (library.animations.length === 0) {
    return { decision: 'CREATE', match: null, reason: 'Library is empty' };
  }

  // Score each animation against the moment
  let bestScore = 0;
  let bestMatch = null;

  for (const anim of library.animations) {
    let score = 0;

    // Moment type match (strongest signal)
    if (anim.momentTypes && anim.momentTypes.includes(moment.type)) {
      score += 50;
    }

    // Tag overlap
    if (anim.tags && moment.tags) {
      const overlap = anim.tags.filter(t => moment.tags.includes(t)).length;
      score += overlap * 10;
    }

    // Theme keyword match
    if (anim.theme && moment.suggestedAnimationType) {
      const themeWords = anim.theme.toLowerCase().split(/[\/\s]+/);
      const momentWords = moment.suggestedAnimationType.toLowerCase().split(/[\s,]+/);
      const themeOverlap = themeWords.filter(w => momentWords.some(mw => mw.includes(w))).length;
      score += themeOverlap * 15;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = anim;
    }
  }

  if (bestScore >= 50) {
    // Strong match — check if it's exact enough to reuse
    if (bestScore >= 60) {
      return { decision: 'REUSE', match: bestMatch, reason: `Strong match: ${bestMatch.name} (score: ${bestScore})` };
    }
    return { decision: 'ADAPT', match: bestMatch, reason: `Partial match: ${bestMatch.name} — adapt for this moment (score: ${bestScore})` };
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
