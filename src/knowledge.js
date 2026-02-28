/**
 * Knowledge Manager — persistent world knowledge for D&D Shorts pipeline.
 *
 * Manages characters (PCs), NPCs, locations, and a portrait index.
 * Stores everything in data/knowledge.json.
 * Provides migration from legacy data/characters.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_PATH = join(__dirname, '..', 'data', 'knowledge.json');
const CHARACTERS_PATH = join(__dirname, '..', 'data', 'characters.json');
const PORTRAITS_DIR = join(__dirname, '..', 'data', 'portraits');

/**
 * Load the knowledge base from disk.
 * Creates a fresh one if the file doesn't exist.
 *
 * @returns {object} The knowledge base { version, characters, npcs, locations, portraits }
 */
export function loadKnowledge() {
  if (!existsSync(KNOWLEDGE_PATH)) {
    const fresh = { version: 1, characters: [], npcs: [], locations: [], portraits: [], backgrounds: [] };
    saveKnowledge(fresh);
    return fresh;
  }

  try {
    const raw = readFileSync(KNOWLEDGE_PATH, 'utf-8');
    const kb = JSON.parse(raw);

    // Ensure all required arrays exist (forward compatibility)
    kb.characters = kb.characters || [];
    kb.npcs = kb.npcs || [];
    kb.locations = kb.locations || [];
    kb.portraits = kb.portraits || [];
    kb.backgrounds = kb.backgrounds || [];

    return kb;
  } catch (err) {
    console.error(`Knowledge base read error: ${err.message}, creating fresh`);
    const fresh = { version: 1, characters: [], npcs: [], locations: [], portraits: [], backgrounds: [] };
    saveKnowledge(fresh);
    return fresh;
  }
}

/**
 * Save the knowledge base to disk.
 *
 * @param {object} kb - The knowledge base object
 */
export function saveKnowledge(kb) {
  const dir = dirname(KNOWLEDGE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(KNOWLEDGE_PATH, JSON.stringify(kb, null, 2));
}

/**
 * One-time migration from data/characters.json → knowledge.json characters.
 * Only migrates characters that don't already exist in the KB.
 * Safe to call multiple times — skips already-migrated characters.
 *
 * @returns {number} Number of characters migrated
 */
export function migrateFromCharactersJson() {
  if (!existsSync(CHARACTERS_PATH)) {
    console.log('  Knowledge: No characters.json to migrate');
    return 0;
  }

  const kb = loadKnowledge();

  let legacyChars;
  try {
    const raw = readFileSync(CHARACTERS_PATH, 'utf-8');
    legacyChars = JSON.parse(raw).characters || [];
  } catch (err) {
    console.warn(`  Knowledge: Failed to parse characters.json: ${err.message}`);
    return 0;
  }

  let migrated = 0;

  for (const ch of legacyChars) {
    const id = slugifyId(ch.name);

    // Skip if already exists
    if (kb.characters.find(c => c.id === id)) continue;

    kb.characters.push({
      id,
      name: ch.name,
      type: 'pc',
      color: ch.color || '#e8a033',
      race: ch.race || 'Unknown',
      class: ch.class || 'Unknown',
      visualDescription: ch.visualDescription || '',
      conditionalFeatures: ch.conditionalFeatures || {},
      tokenImagePath: ch.tokenImagePath || null,
      referenceImages: [],
      firstSeen: null,
      tags: ['player'],
    });

    migrated++;
  }

  if (migrated > 0) {
    saveKnowledge(kb);
    console.log(`  Knowledge: Migrated ${migrated} characters from characters.json`);
  }

  return migrated;
}

/**
 * Find an entity by name across all entity types.
 * Case-insensitive fuzzy match.
 *
 * @param {string} name - Entity name to search for
 * @param {string} [type] - Optional type filter: 'pc', 'npc', 'location'
 * @returns {object|null} The entity object, or null if not found
 */
export function findEntity(name, type) {
  const kb = loadKnowledge();
  const lower = name.toLowerCase().trim();

  // Search characters (PCs)
  if (!type || type === 'pc') {
    const match = kb.characters.find(c =>
      c.name.toLowerCase() === lower ||
      c.id === lower
    );
    if (match) return { ...match, _entityType: 'character' };
  }

  // Search NPCs
  if (!type || type === 'npc') {
    const match = kb.npcs.find(n =>
      n.name.toLowerCase() === lower ||
      n.id === lower
    );
    if (match) return { ...match, _entityType: 'npc' };
  }

  // Search locations
  if (!type || type === 'location') {
    const match = kb.locations.find(l =>
      l.name.toLowerCase() === lower ||
      l.id === lower
    );
    if (match) return { ...match, _entityType: 'location' };
  }

  return null;
}

/**
 * Add a new entity to the knowledge base.
 *
 * @param {object} entity - Entity object with at minimum: name, type ('npc' | 'location' | 'creature')
 * @returns {object} The added entity (with generated ID)
 */
export function addEntity(entity) {
  const kb = loadKnowledge();
  const id = entity.id || slugifyId(entity.name);

  const enriched = {
    id,
    name: entity.name,
    type: entity.type,
    visualDescription: entity.visualDescription || '',
    referenceImages: entity.referenceImages || [],
    firstSeen: entity.firstSeen || null,
    lastSeen: entity.lastSeen || null,
    tags: entity.tags || [],
    autoGenerated: entity.autoGenerated !== false,
  };

  // Add optional fields based on type
  if (entity.color) enriched.color = entity.color;
  if (entity.race) enriched.race = entity.race;
  if (entity.class) enriched.class = entity.class;

  // Route to the right array
  if (entity.type === 'npc' || entity.type === 'creature') {
    // Check for duplicates
    if (kb.npcs.find(n => n.id === id)) {
      console.log(`  Knowledge: NPC "${entity.name}" already exists, skipping`);
      return kb.npcs.find(n => n.id === id);
    }
    kb.npcs.push(enriched);
  } else if (entity.type === 'location') {
    if (kb.locations.find(l => l.id === id)) {
      console.log(`  Knowledge: Location "${entity.name}" already exists, skipping`);
      return kb.locations.find(l => l.id === id);
    }
    kb.locations.push(enriched);
  } else {
    console.warn(`  Knowledge: Unknown entity type "${entity.type}" for "${entity.name}"`);
    return enriched;
  }

  saveKnowledge(kb);
  console.log(`  Knowledge: Added ${entity.type} "${entity.name}"`);
  return enriched;
}

/**
 * Save a generated portrait to the persistent portrait database.
 *
 * @param {string} entityId - Entity ID (e.g. 'hodim')
 * @param {object} portraitData
 * @param {Buffer} portraitData.buffer - Portrait PNG buffer
 * @param {string} portraitData.mimeType - MIME type
 * @param {string} [portraitData.mood] - Mood/expression (e.g. 'tense', 'calm', 'angry')
 * @param {string} [portraitData.description] - Description of what this portrait shows
 * @param {string} [portraitData.sessionId] - Session ID where this was generated
 * @param {number} [portraitData.quality=1] - Quality: 0=gold (commissioned), 1=good AI, 2=uncertain
 * @returns {object} The portrait record
 */
export function addPortrait(entityId, portraitData) {
  const kb = loadKnowledge();

  // Ensure portraits directory exists
  if (!existsSync(PORTRAITS_DIR)) mkdirSync(PORTRAITS_DIR, { recursive: true });

  const mood = portraitData.mood || 'neutral';
  const timestamp = Date.now().toString(36);
  const filename = `${entityId}_${mood}_${timestamp}.png`;
  const imagePath = join(PORTRAITS_DIR, filename);

  // Save the image file
  writeFileSync(imagePath, portraitData.buffer);

  const record = {
    id: `${entityId}_${mood}_${timestamp}`,
    entityId,
    mood,
    description: portraitData.description || '',
    imagePath: `data/portraits/${filename}`,
    sessionId: portraitData.sessionId || null,
    quality: portraitData.quality !== undefined ? portraitData.quality : 1,
    createdAt: new Date().toISOString(),
  };

  kb.portraits.push(record);
  saveKnowledge(kb);

  console.log(`  Knowledge: Saved portrait for ${entityId} (${mood}) → ${filename}`);
  return record;
}

/**
 * Find the best portrait for an entity, optionally filtered by mood.
 * Returns the highest-quality (lowest quality number) most recent portrait.
 *
 * @param {string} entityId - Entity ID
 * @param {string} [mood] - Optional mood filter
 * @returns {object|null} Portrait record with { imagePath, buffer, mimeType, ... } or null
 */
export function findBestPortrait(entityId, mood) {
  const kb = loadKnowledge();

  // Filter out portraits rated "bad" by the user
  let candidates = kb.portraits.filter(p => p.entityId === entityId && p.rating !== 'bad');

  if (mood) {
    // Prefer exact mood match, but fall back to any portrait
    const moodMatch = candidates.filter(p => p.mood === mood);
    if (moodMatch.length > 0) {
      candidates = moodMatch;
    }
  }

  if (candidates.length === 0) return null;

  // Sort by quality (lower is better), then by recency (newer first)
  candidates.sort((a, b) => {
    if (a.quality !== b.quality) return a.quality - b.quality;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const best = candidates[0];

  // Load the image buffer if the file exists
  const fullPath = join(__dirname, '..', best.imagePath);
  if (existsSync(fullPath)) {
    const buffer = readFileSync(fullPath);
    return {
      ...best,
      buffer,
      base64: buffer.toString('base64'),
      mimeType: 'image/png',
    };
  }

  console.warn(`  Knowledge: Portrait file missing: ${best.imagePath}`);
  return null;
}

/**
 * Index a generated background in the knowledge base.
 * Stores metadata only — the actual PNG stays in the session output directory.
 *
 * @param {object} bgData - { imagePath, mood, description, sessionId, locationTag? }
 * @returns {object} The background record
 */
export function addBackground(bgData) {
  const kb = loadKnowledge();

  const timestamp = Date.now().toString(36);
  const mood = bgData.mood || 'neutral';
  const tag = bgData.locationTag || 'unknown';

  const record = {
    id: `bg_${tag}_${mood}_${timestamp}`,
    locationTag: tag,
    mood,
    description: bgData.description || '',
    imagePath: bgData.imagePath,
    sessionId: bgData.sessionId || null,
    quality: 1,
    createdAt: new Date().toISOString(),
  };

  kb.backgrounds.push(record);
  saveKnowledge(kb);

  return record;
}

/**
 * Find backgrounds matching a location tag and/or mood.
 *
 * @param {string} [locationTag] - Location tag to match
 * @param {string} [mood] - Mood to match
 * @returns {object[]} Matching background records (newest first)
 */
export function findBackgrounds(locationTag, mood) {
  const kb = loadKnowledge();

  let candidates = kb.backgrounds.filter(b => b.rating !== 'bad');

  if (locationTag) {
    const tagMatch = candidates.filter(b => b.locationTag === locationTag);
    if (tagMatch.length > 0) candidates = tagMatch;
  }

  if (mood) {
    const moodMatch = candidates.filter(b => b.mood === mood);
    if (moodMatch.length > 0) candidates = moodMatch;
  }

  // Newest first
  candidates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return candidates;
}

/**
 * Get all relevant knowledge for a moment — PCs by speaker names,
 * NPCs/locations by scene context matching.
 *
 * @param {string[]} speakerNames - Character names speaking in this moment
 * @param {object|null} sceneContext - Scene context (setting, conflict, enemies, etc.)
 * @returns {object} { characters: [], npcs: [], locations: [] }
 */
export function getRelevantKnowledge(speakerNames = [], sceneContext = null) {
  const kb = loadKnowledge();

  // Find PCs by speaker name
  const characters = [];
  for (const name of speakerNames) {
    const lower = name.toLowerCase().trim();
    // Skip generic labels
    if (lower === 'dm' || lower === 'dungeon master' || lower === 'narrator' || lower === 'player') continue;

    const match = kb.characters.find(c => c.name.toLowerCase() === lower);
    if (match) characters.push(match);
  }

  // Find relevant NPCs and locations by scene context keywords
  const npcs = [];
  const locations = [];

  if (sceneContext) {
    const contextStr = [
      sceneContext.setting,
      sceneContext.conflict,
      sceneContext.enemies,
      sceneContext.positioning,
      sceneContext.leadUp,
    ].filter(Boolean).join(' ').toLowerCase();

    for (const npc of kb.npcs) {
      if (contextStr.includes(npc.name.toLowerCase())) {
        npcs.push(npc);
      }
    }

    for (const loc of kb.locations) {
      if (contextStr.includes(loc.name.toLowerCase())) {
        locations.push(loc);
      }
    }
  }

  return { characters, npcs, locations };
}

/**
 * Extract new entities (NPCs, creatures, locations) from DM lines in a transcript.
 * Uses Claude Haiku to identify named entities not already in the knowledge base.
 * Designed to run ONCE after VTT analysis.
 *
 * @param {object[]} cues - Session cues array (from parse-vtt.js)
 * @param {object} [options]
 * @param {string} [options.sessionId] - Session identifier for firstSeen tracking
 * @returns {Promise<object[]>} Array of newly added entities
 */
export async function extractEntities(cues, options = {}) {
  const kb = loadKnowledge();
  const speakers = options.speakers || [];

  // Find the DM by parsed role (set by parse-vtt.js speaker detection),
  // not by literal name matching. The DM name is the raw Zoom display name
  // (e.g. "Connor Koblinski"), not a generic "DM" label.
  const dmSpeaker = speakers.find(s => s.role === 'dm');
  const dmName = dmSpeaker?.name || null;

  // Collect DM/narrator lines (cap at ~2000 chars for token efficiency)
  const dmLines = cues
    .filter(c => {
      const spk = (c.speaker || '').toLowerCase();
      // Match by actual DM speaker name OR generic labels OR auto-caption (no speaker)
      const isDMByName = dmName && c.speaker === dmName;
      const isDMByLabel = spk === 'dm' || spk === 'dungeon master' || spk === 'narrator';
      return isDMByName || isDMByLabel || spk === '';
    })
    .map(c => c.text)
    .filter(t => t && t.length > 20) // Skip very short lines
    .slice(0, 100); // Cap to avoid huge payloads

  if (dmLines.length === 0) {
    console.log('  Entity extraction: No DM lines found, skipping');
    return [];
  }

  const dmText = dmLines.join('\n').substring(0, 8000); // ~2K tokens

  // Build existing entities list for the prompt
  const existingNames = [
    ...kb.characters.map(c => c.name),
    ...kb.npcs.map(n => n.name),
    ...kb.locations.map(l => l.name),
  ];
  const existingStr = existingNames.length > 0
    ? existingNames.join(', ')
    : '(none yet)';

  // Load prompt template
  const promptPath = join(__dirname, '..', 'prompts', 'entity-extraction.md');
  let systemPrompt;
  try {
    systemPrompt = readFileSync(promptPath, 'utf-8');
  } catch (err) {
    console.warn(`  Entity extraction: Prompt file not found, skipping: ${err.message}`);
    return [];
  }

  // Fill template
  systemPrompt = systemPrompt
    .replace('{{EXISTING_ENTITIES}}', existingStr)
    .replace('{{DM_LINES}}', dmText);

  console.log(`  Entity extraction: Analyzing ${dmLines.length} DM lines...`);

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: systemPrompt }],
    });

    const text = response.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.log('  Entity extraction: No JSON in response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const entities = parsed.entities || [];

    if (entities.length === 0) {
      console.log('  Entity extraction: No new entities found');
      return [];
    }

    // Add each new entity to the knowledge base
    const added = [];
    for (const entity of entities) {
      if (!entity.name || !entity.type) continue;

      // Double-check it's not already in KB
      if (findEntity(entity.name)) {
        console.log(`  Entity extraction: "${entity.name}" already exists, skipping`);
        continue;
      }

      const result = addEntity({
        name: entity.name,
        type: entity.type,
        visualDescription: entity.visualDescription || '',
        tags: entity.tags || [],
        firstSeen: options.sessionId || null,
        lastSeen: options.sessionId || null,
        autoGenerated: true,
      });

      added.push(result);
    }

    if (added.length > 0) {
      console.log(`  Entity extraction: Added ${added.length} new entities: ${added.map(e => `${e.name} (${e.type})`).join(', ')}`);
    }

    return added;
  } catch (err) {
    console.warn(`  Entity extraction: Error (${err.message}), skipping`);
    return [];
  }
}

// ── Internal helpers ──

function slugifyId(text) {
  return (text || 'unknown').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
}
