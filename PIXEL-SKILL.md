# Pixel Art Animation Skill

Generate animated pixel art dialogue scenes and action sequences for D&D YouTube Shorts using Google Gemini image generation + code-driven animation assembly.

## Quick Reference

| Task | Where to look |
|------|---------------|
| Style guide for all Gemini prompts | `prompts/pixel-art-style-guide.md` |
| Image generation functions | `src/pixel-art-generator.js` |
| Scene assembly (templates) | `src/assemble-scene.js` |
| Animated dialogue template | `templates/animated-dialogue.html` |
| Video capture/export | `bin/capture-scene.js`, `src/export-animation.js` |
| ASCII animation skill (preserved) | `SKILL.md` |

## The Pipeline

Every pixel art scene follows this flow:

1. **Portrait** — close-up face of the speaking character via `generateCharacterPortrait()`
2. **Mouth variants** — 2 variants (slightly-open, open) from the portrait via `generateMouthVariants()`
3. **Background** — 9:16 vertical scene via `generateSceneBackground()`
4. **Assembly** — template population via `assembleAnimatedDialogueScene()`
5. **Export** — Puppeteer frame capture + ffmpeg encoding → MP4, GIF, individual PNGs

## Gemini API Patterns

### Model & SDK
- Model: `gemini-3.1-flash-image-preview`
- SDK: `@google/genai` v1.43.0
- Cost: ~$0.04 per image (~$0.16 per dialogue scene)
- Rate limiting: 15s pause between calls (enforced in code)

### Style Prefix
Prepended to all generation prompts:
```
"16-bit pixel art, RPG game style inspired by Octopath Traveler and Final Fantasy VI,
retro gaming aesthetic with modern lighting and detail, "
```

### Reference-Based Generation
Pass an existing image alongside a text instruction to generate variants while maintaining consistency. Used for:
- **Mouth variants**: "Keep face/hair/clothing identical, only change the mouth to [position]"
- **Scene variants**: SCENE_ANCHOR pattern — describe full scene + "the ONLY changes are..."

### The SCENE_ANCHOR Pattern (for multi-frame scenes)
When generating variant frames from a base image:
1. Describe the full scene composition in an anchor text
2. State "Keep the EXACT same composition, camera angle, art style..."
3. Describe ONLY the specific changes
4. Every frame must describe ALL animated elements (complete state, not deltas)
5. End with "Everything else remains exactly identical to the reference image"

### Retry Logic
- 2 attempts per API call
- 10s wait after first failure, 20s after second
- Mouth variants: 15s pause between sequential calls

## Template System

### `templates/animated-dialogue.html`

Template tokens:
```
{{SCENE_TITLE}}          → page title
{{PORTRAIT_IMGS}}        → <img> elements for portrait frames
{{BACKGROUND_SRC}}       → data: URL for background
{{CHAR_NAME}}            → character name (HTML-escaped)
{{CHAR_COLOR}}           → hex color (e.g. #d4a853)
{{DIALOGUE_LINES_JSON}}  → JSON array of { text, speed }
{{MOUTH_CYCLE_MS}}       → ms per mouth frame (default 150)
{{LINE_PAUSE_MS}}        → ms pause between lines (default 1200)
{{PORTRAIT_COUNT}}       → number of portrait frames
```

Built-in features (code-driven, zero API cost):
- **Typewriter** — character-by-character text reveal with blinking cursor
- **Mouth cycling** — triangle wave (0→1→2→1→0) during speech only
- **Fire flicker** — CSS brightness animation on background (4-step, 2s cycle)
- **Torch glow** — pulsing glow overlays at staggered intervals
- **Ambient particles** — 15 floating orbs with unique drift keyframes
- **Portrait bob** — subtle ±6px vertical bob (3s cycle)

### Reading Speed Convention
All typewriter dialogue uses a **1.25x multiplier** on estimated reading time. People need more time than you'd think to read animated pixel-art text. When calculating duration:
```
chars × speed_ms_per_char × 1.25
```

## Scene Assembly API

```javascript
import { assembleAnimatedDialogueScene } from './src/assemble-scene.js';

const html = assembleAnimatedDialogueScene({
  portraitFrames: [
    { base64: '...', mimeType: 'image/png' },  // closed mouth
    { base64: '...', mimeType: 'image/png' },  // slightly open
    { base64: '...', mimeType: 'image/png' },  // open
  ],
  backgroundBase64: '...',
  backgroundMimeType: 'image/png',
  characterName: 'Bixie',
  characterColor: '#d4a853',
  sceneTitle: 'Session 114 — Death is Easy',
  dialogueLines: [
    { text: 'Death is an easy way out.', speed: 60 },
    { text: 'Embarrassment is a little more interesting.', speed: 55 },
  ],
  mouthCycleMs: 150,
  linePauseMs: 1500,
});
```

## Background Mood Modifiers

| Mood | Effect | When to use |
|------|--------|------------|
| `triumphant` | Golden warm light, celebratory | Victories, discoveries |
| `tense` | Cold blue shadows, dramatic contrast | Combat, confrontation |
| `mysterious` | Purple mist, ethereal glow | Exploration, magic |
| `dark` | Deep shadows, ominous red accents | Danger, stealth |
| `neutral` | Balanced warm and cool | General dialogue |
| `comedic` | Bright colors, exaggerated details | Funny moments |

## Video Export

```bash
# Capture HTML animation → MP4 + GIF
node bin/capture-scene.js path/to/scene.html --duration=12 --fps=12 --width=1080 --height=1920
```

Outputs: `scene.mp4` (H.264, ~2-3MB) and `scene.gif` (palette-optimized, ~20-30MB)

Professional export via `src/export-animation.js` also supports WebM (VP9 + alpha) and MOV (ProRes 4444).

## Future: Human Art Integration

The pipeline is designed to incorporate human-created art:

- **Sprite sheets**: Pixel artist creates character sprites → uploaded as reference images alongside Gemini API calls for style consistency
- **Library system** (`src/library.js`): Currently holds ASCII animations. Will evolve to hold pixel art sprite references and style templates. The matching/scoring system (REUSE/ADAPT/CREATE) will work the same way.
- **Style guide**: `prompts/pixel-art-style-guide.md` will incorporate examples from human art to maintain consistency across AI-generated and human-created assets.

Do NOT delete the ASCII animation system (`SKILL.md`, `src/generate-animation.js`, `prompts/animation-generator.md`, `library/`). It will be preserved alongside the pixel art pipeline and may be repurposed.

## Cost Reference

| Asset | Cost | Time |
|-------|------|------|
| Portrait | ~$0.04 | ~25s |
| Mouth variant (×2) | ~$0.08 | ~45s (with 15s pause) |
| Background | ~$0.04 | ~25s |
| **Total per dialogue scene** | **~$0.16** | **~2 min** |
| Scene variant frame (tavern-style) | ~$0.04 | ~25s |
| 5-frame bounce animation | ~$0.16 | ~2 min |
