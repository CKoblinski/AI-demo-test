# Pixel Art Animation Skill

Generate animated pixel art dialogue scenes and action sequences for D&D YouTube Shorts using Google Gemini image generation + code-driven animation assembly.

## Quick Reference

| Task | Where to look |
|------|---------------|
| Style guide for all Gemini prompts | `prompts/pixel-art-style-guide.md` |
| Image generation functions | `src/pixel-art-generator.js` |
| Director AI (sequence planning) | `src/sequence-director.js` |
| Multi-sequence scene builder | `src/pixel-art-scene-builder.js` |
| Scene assembly (templates) | `src/assemble-scene.js` |
| Job runner (session management) | `src/job-runner.js` |
| Dialogue template | `templates/animated-dialogue.html` |
| Action bounce template | `templates/action-bounce.html` |
| Sequence player template | `templates/sequence-player.html` |
| Video capture/export | `bin/capture-scene.js` |
| Character cards | `data/characters.json` |
| CTO brief & roadmap | `CTO-BRIEF.md` |
| ASCII animation skill (preserved) | `SKILL.md` |

## The Multi-Sequence Pipeline

Every pixel art moment follows this flow:

1. **VTT Parse** — `src/parse-vtt.js` extracts speakers, timestamps, segments
2. **Highlight Discovery** — Claude Haiku ranks top 7 moments from transcript
3. **Scene Context** — Claude Sonnet analyzes 10-min window for setting, enemies, positioning
4. **Director AI** — Claude Sonnet plans 4-8 sequences (establishing, dialogue, DM narration, close-up, impact)
5. **Technical QC** — Claude Haiku validates timing and fields, auto-fixes
6. **Creative QC** — Claude Sonnet checks pacing, character fidelity, scene coherence (2/3 pass, max 3 retries)
7. **Human Review** — Interactive storyboard editor (reorder, edit, add/delete)
8. **Generation** — Gemini generates portraits, backgrounds, action frames per sequence
9. **Assembly** — HTML templates populated with base64 images + code-driven animation
10. **Export** — Puppeteer captures frames, ffmpeg encodes MP4 (1080x1920)

## Sequence Types

| Type | What it generates | Cost |
|------|------------------|------|
| `establishing_shot` | Full background image + CSS zoom/drift | ~$0.04 |
| `dialogue` | Character portrait + 2 mouth variants + background | ~$0.12-0.16 |
| `dm_description` | Narrator portrait + text overlay on background | ~$0.12-0.16 |
| `close_up` | 3-5 action frames in bounce animation | ~$0.12-0.20 |
| `impact` | Pure CSS effect (flash, shake, blood spray) | $0.00 |

## Gemini API Patterns

### Model & SDK
- Model: `gemini-3.1-flash-image-preview`
- SDK: `@google/genai` v1.43.0
- Cost: ~$0.04 per image
- Rate limiting: 15s pause between calls (enforced in code)
- All prompts include "no text/UI/labels" directive

### Style Prefix
Prepended to all generation prompts:
```
"PORTRAIT ORIENTATION (9:16 vertical), 16-bit SNES-era pixel art with visible pixel grid,
limited color palette (max 24 colors), no anti-aliasing, crisp hard-edged pixels.
Style of Octopath Traveler, Final Fantasy VI, Chrono Trigger.
Do NOT include any text, words, letters, numbers, labels, titles, UI elements,
health bars, or watermarks — pure artwork only."
```

### Reference-Based Generation
Pass an existing image alongside a text instruction to generate variants. Used for:
- **Mouth variants**: "Keep everything identical, only change the mouth"
- **Expression variants**: "Same character, change facial expression to match: [description]"
- **Action frame variants**: "Same composition, progress the action to frame N of N"

## Character System

### Character Cards (`data/characters.json`)
Each character has: name, border color, race, class, visual description, optional conditional features.

**Conditional features** (e.g., Hodim's wings) only appear in portrait descriptions when the moment warrants it. The Director AI decides when to activate them.

### Portrait Caching
- Same character across sequences: reuse cached portrait ($0.00)
- Same character with different emotion: generate expression variant from base ($0.04 + $0.08 mouth variants)
- DM/Narrator: normalized to one hooded-sage portrait across all DM sequences

## Template System

### `templates/animated-dialogue.html`
Dialogue scenes with typewriter text and 3-frame mouth animation cycling.

Built-in effects (code-driven, zero API cost):
- **Typewriter** — character-by-character text reveal with blinking cursor
- **Mouth cycling** — triangle wave (0-1-2-1-0) during speech only
- **Ambient brightness** — smooth +/-1.5% brightness drift (ease-in-out)
- **Torch glow** — pulsing glow overlays at staggered intervals
- **Ambient particles** — 15 floating orbs with unique drift keyframes
- **Portrait bob** — subtle +/-6px vertical bob (3s cycle)
- **Mood-based color grading** — tense, dark, mysterious, heroic, calm, sad

### `templates/action-bounce.html`
Close-up action scenes with 3-5 frames in a bounce loop (1-2-3-2-1).

Built-in effects: screen shake on peak frame, impact flash, ambient particles, mood glow.

### `templates/sequence-player.html`
Master player that plays all sequences in order with transition effects between them.

### Reading Speed Convention
All typewriter dialogue uses a **1.6x multiplier** (88ms/char from 55ms base). Duration:
```
chars x speed_ms_per_char + (lineCount x 2000ms pause) + 800ms initial + 1000ms buffer
```

## Quality Control

### Technical QC (Claude Haiku)
- Validates timing math, required fields per type
- Auto-fixes issues (adjusts durations, fills missing fields)

### Creative QC (Claude Sonnet)
Three dimensions, each pass/fail:
1. **Cinematic Pacing** — action interleaved with dialogue, tension builds
2. **Character Fidelity** — portraits match character cards, emotions match moment
3. **Scene Coherence** — backgrounds match actual setting from transcript

Needs 2/3 to pass. Retries up to 3 times with feedback.

### Visual Coherence (Gemini Vision)
- Checks portrait + mouth variants are the same character
- Checks action frames maintain consistent style

## Cost Reference

| Asset | Cost | Time |
|-------|------|------|
| Portrait | ~$0.04 | ~25s |
| Mouth variants (x2) | ~$0.08 | ~45s |
| Expression variant | ~$0.04 | ~25s |
| Background | ~$0.04 | ~25s |
| Action frame | ~$0.04 | ~25s |
| **Total per moment (4-6 sequences)** | **~$0.50-0.70** | **~8-12 min** |
| **AI planning per moment** | **~$0.11** | **~30s** |
