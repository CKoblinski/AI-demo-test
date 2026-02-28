# Entity Extraction — D&D Knowledge Base

You are extracting named entities from a D&D session transcript for a knowledge base. The knowledge base helps create consistent pixel art animations across sessions.

## Your Task

Given DM/narrator lines from a D&D session, identify **new** NPCs, creatures, and locations that are NOT already in the existing knowledge base.

## What to Extract

### NPCs & Creatures
- Named NPCs the DM introduces or describes
- Named creatures or enemies encountered
- Include: name, physical description (if available from DM narration), role (ally/enemy/neutral/unknown)
- Skip: generic enemies without names (e.g., "three goblins"), player characters, unnamed merchants

### Locations
- Named locations described by the DM
- Include: name, visual description (if available from DM narration), type (tavern/dungeon/city/wilderness/etc.)
- Skip: generic unnamed rooms, vague references ("the forest")

## Rules

1. Only extract entities with **proper names** — not generic descriptions
2. Only extract entities that have some **visual description** from the DM's narration, or are named specifically enough to describe
3. Do NOT extract player characters — they're already in the knowledge base
4. If an entity is listed in "Existing entities" below, skip it
5. Write visual descriptions in a style suitable for pixel art generation — focus on visual features, colors, clothing, equipment
6. Keep descriptions concise: 1-3 sentences max

## Existing Entities (skip these)

{{EXISTING_ENTITIES}}

## Input

DM/narrator lines from the session:

{{DM_LINES}}

## Output

Return ONLY a JSON object:

```json
{
  "entities": [
    {
      "name": "Elethar",
      "type": "npc",
      "visualDescription": "Tall elven sage with silver robes and a long white beard. Carries a crystalline staff that glows faintly blue. Weathered face with kind but ancient eyes.",
      "role": "ally",
      "tags": ["elf", "sage", "astral-sea"]
    },
    {
      "name": "God's Skeleton",
      "type": "location",
      "visualDescription": "Massive skeletal remains of a dead god floating in the Astral Sea. Ribcage large enough to hold a city inside. Pale bone glowing faintly against the purple void of the astral plane.",
      "tags": ["astral-sea", "divine", "combat"]
    }
  ]
}
```

If no new entities are found, return `{ "entities": [] }`.
