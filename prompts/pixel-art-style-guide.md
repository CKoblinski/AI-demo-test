# Pixel Art Style Guide — D&D Shorts Factory

This document defines the visual aesthetic for all Gemini-generated pixel art. It is referenced by `src/pixel-art-generator.js` and should be consulted when crafting any image generation prompt.

## Core Aesthetic

**Style**: 16-bit pixel art, RPG game style
**Inspirations**: Octopath Traveler, Final Fantasy VI, Chrono Trigger
**Feel**: Retro gaming aesthetic with modern lighting and detail

### Style Prefix (prepended to all Gemini prompts)
```
16-bit SNES-era pixel art with visible pixel grid, limited color palette (max 24 colors),
no anti-aliasing, no smooth gradients, crisp hard-edged pixels.
Style of Octopath Traveler, Final Fantasy VI, Chrono Trigger.
Hand-pixeled aesthetic, NOT AI-generated looking, NOT anime, NOT smooth digital art.
Chunky defined pixels, dithering for shading, retro RPG game sprite style,
```

**Key enforcement**: The prefix explicitly rejects AI-art hallmarks (smooth gradients, anime style, anti-aliasing) and demands visible pixel structure. This is critical for maintaining the retro aesthetic.

## Format & Resolution

- **Aspect ratio**: 9:16 vertical (YouTube Shorts, Instagram Reels, TikTok)
- **Export resolution**: 1080 × 1920 pixels
- **CSS rendering**: `image-rendering: pixelated` for crisp upscaling
- **Gemini output**: ~1024px on long edge, upscaled in the viewer

## Color Palette

### UI Elements
- Background: `#0a0a0f` (near-black with subtle blue)
- Gold accent: `#c8a030` (borders, highlights, badges)
- Text: white on dark, with subtle glow

### Per-Character Colors
Each character gets a signature color used for:
- Portrait frame border
- Name text
- Dialogue box border
- Glow effects

Examples:
- Bixie: `#d4a853` (warm gold — rogue)
- Generic default: `#e8a033` (orange-gold)

## Portrait Style

- **Composition**: Close-up face, shoulders visible
- **Lighting**: Dramatic, directional (candlelight, firelight, moonlight)
- **Background**: Dark, minimal — the face is the focus
- **Expression**: Should match the emotional tone of the dialogue
- **Size in UI**: 280×280px with colored border, rounded corners, glow + inset shadow

### Portrait Prompt Pattern
```
close-up face portrait of [CHARACTER DESCRIPTION],
expressive eyes, dramatic lighting, dark background,
square composition, character portrait for RPG dialogue box
```

## Background Style

- **Composition**: Full-scene environment, 9:16 vertical
- **Depth**: Foreground detail → mid-ground subject → background atmosphere
- **Lighting**: Mood-driven (see modifiers below)
- **Detail level**: Highly detailed environment pixel art
- **Vignette**: Dark edges framing the scene (added via CSS)

### Background Prompt Pattern
```
[SCENE DESCRIPTION], [MOOD MODIFIER],
9:16 vertical composition, vignette darkening at edges
```

### Mood Modifiers
| Mood | Prompt addition | Use when |
|------|----------------|----------|
| `triumphant` | "golden warm light, celebratory atmosphere, rays of light" | Victory, discovery, nat 20 |
| `tense` | "cold blue shadows, dramatic contrast, sense of danger" | Combat, confrontation |
| `mysterious` | "purple mist, ethereal glow, magical atmosphere" | Exploration, arcane moments |
| `dark` | "deep shadows, ominous atmosphere, minimal light sources with red accents" | Stealth, danger, horror |
| `neutral` | "balanced warm and cool lighting, comfortable atmosphere" | General dialogue, conversation |
| `comedic` | "bright warm colors, exaggerated details, lighthearted atmosphere" | Funny moments, banter |

## D&D Fantasy Conventions

- Medieval fantasy setting (stone, wood, leather, metal, cloth)
- Magic manifests as glowing runes, ethereal light, colored energy
- Weapons: swords, crossbows, staffs, daggers — era-appropriate
- Architecture: taverns, castles, dungeons, camps, forests, caves
- Lighting sources: torches, candles, campfires, magical glow, moonlight

## Dialogue Box Style

Defined in `templates/animated-dialogue.html`:
- Semi-transparent dark background: `rgba(10, 8, 20, 0.92)`
- 4px colored border (character's signature color)
- Decorative corner brackets in matching color
- Character name: 36px, uppercase, colored, with text-shadow glow
- Dialogue text: 32px, white, monospace-like font
- Typewriter reveal with blinking cursor

## Animation Conventions

### Code-Driven Effects (zero API cost)
These effects are built into the HTML templates:
- Fire/torch flicker (CSS brightness animation)
- Torch glow pulses (staggered CSS animations)
- Ambient floating particles (JS-generated with unique keyframes)
- Portrait bob (subtle vertical movement)
- Stage glow (CSS box-shadow pulse)

### Mouth Animation
- 3 frames: closed (base portrait), slightly-open, open
- Triangle wave cycle: 0→1→2→1→0 at 150ms per frame
- Active only during typewriter speech
- Returns to closed (frame 0) when not talking

### Bounce Loops (for action scenes)
- 5-10 frames, played as: 0→1→2→3→4→3→2→1→repeat
- Only generate the forward frames; bounce reversal is automatic
- Each frame describes complete state of ALL animated elements

---

## Future: Human Art Integration

This section documents our plans for incorporating human-created pixel art into the pipeline. These are not yet implemented but inform design decisions.

### Sprite Sheets
- Commission pixel artist to create character sprite sheets (idle, talking, action poses)
- Sprite sheets uploaded to the asset library
- Sent as reference images alongside Gemini API calls for style consistency
- Gemini generates new poses/expressions that match the artist's style

### Reference Library
- The existing library system (`src/library.js`, `library/`) will evolve from ASCII animations to pixel art references
- Library matching (REUSE/ADAPT/CREATE) will score against pixel art templates instead of ASCII animations
- New library entries will include: character sprites, background templates, effect overlays

### Style Consistency
- As human art accumulates, this style guide will be updated with specific examples
- The `STYLE_PREFIX` may reference uploaded art: "in the style of the provided reference images"
- Goal: AI-generated assets that are indistinguishable from human-created ones in the final product
