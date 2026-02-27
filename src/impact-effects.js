/**
 * Impact Effects Library — Pure CSS/HTML effects for sub-second animation beats.
 * Zero Gemini cost. Used for action punctuation the pixel art can't depict.
 *
 * Each effect is a self-contained HTML page that plays once and holds.
 */

/**
 * Get a complete HTML page for an impact effect.
 *
 * @param {string} effectName - One of: flash_white, flash_red, comic_bam, comic_slash, blood_spray, shatter, custom
 * @param {object} [options]
 * @param {string} [options.customText] - Custom text for the 'custom' effect (e.g., "CRACK!", "BOOM!")
 * @param {number} [options.durationSec] - Total duration in seconds (default: 1)
 * @returns {{ html: string, durationSec: number }}
 */
export function getImpactEffect(effectName, options = {}) {
  const { customText, durationSec = 1 } = options;

  const generator = EFFECTS[effectName] || EFFECTS.flash_white;
  const html = generator({ customText, durationSec });

  return { html, durationSec };
}

/**
 * List all available effect names.
 * @returns {string[]}
 */
export function listEffects() {
  return Object.keys(EFFECTS);
}

// ── Effect Generators ──

function wrapHtml(title, css, bodyContent) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title} — D&D Shorts Impact</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 1080px; height: 1920px; overflow: hidden; background: #000; }
.impact-container {
  width: 1080px;
  height: 1920px;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
${css}
</style>
</head>
<body>
<div class="impact-container">
${bodyContent}
</div>
</body>
</html>`;
}

const EFFECTS = {
  flash_white({ durationSec }) {
    const dur = (durationSec * 0.4).toFixed(2);
    return wrapHtml('Flash White', `
      .flash {
        position: absolute; inset: 0;
        background: #fff;
        animation: flashAnim ${dur}s ease-out forwards;
      }
      @keyframes flashAnim {
        0% { opacity: 1; }
        30% { opacity: 1; }
        100% { opacity: 0; }
      }
    `, '<div class="flash"></div>');
  },

  flash_red({ durationSec }) {
    const dur = (durationSec * 0.5).toFixed(2);
    return wrapHtml('Flash Red', `
      .flash {
        position: absolute; inset: 0;
        background: radial-gradient(circle at center, #ff1a1a, #8b0000, #000);
        animation: flashAnim ${dur}s ease-out forwards;
      }
      @keyframes flashAnim {
        0% { opacity: 1; }
        20% { opacity: 1; }
        100% { opacity: 0; }
      }
    `, '<div class="flash"></div>');
  },

  comic_bam({ customText, durationSec }) {
    const text = customText || 'BAM!';
    const dur = (durationSec * 0.6).toFixed(2);
    return wrapHtml('Comic BAM', `
      .comic-bg {
        position: absolute; inset: 0;
        background: radial-gradient(circle at center, #ffcc00 0%, #ff6600 40%, #cc0000 70%, #000 100%);
        animation: bgPulse ${dur}s ease-out forwards;
      }
      @keyframes bgPulse {
        0% { opacity: 0; transform: scale(0.5); }
        15% { opacity: 1; transform: scale(1.1); }
        30% { transform: scale(1); }
        100% { opacity: 1; transform: scale(1); }
      }
      .comic-text {
        position: relative;
        z-index: 2;
        font-family: 'Impact', 'Arial Black', sans-serif;
        font-size: 180px;
        font-weight: 900;
        color: #fff;
        text-shadow:
          -6px -6px 0 #000,
          6px -6px 0 #000,
          -6px 6px 0 #000,
          6px 6px 0 #000,
          0 0 40px #ff6600,
          0 0 80px #ff3300;
        letter-spacing: 8px;
        animation: textSlam ${dur}s cubic-bezier(0.2, 0, 0.1, 1) forwards;
        transform-origin: center;
      }
      @keyframes textSlam {
        0% { transform: scale(3) rotate(-5deg); opacity: 0; }
        20% { transform: scale(1.1) rotate(2deg); opacity: 1; }
        35% { transform: scale(1) rotate(0deg); }
        100% { transform: scale(1) rotate(0deg); opacity: 1; }
      }
      .burst-lines {
        position: absolute; inset: 0;
        z-index: 1;
      }
      .burst-line {
        position: absolute;
        top: 50%; left: 50%;
        width: 4px; height: 600px;
        background: linear-gradient(to bottom, #fff 0%, transparent 100%);
        transform-origin: top center;
        animation: burstOut 0.3s ease-out forwards;
        opacity: 0;
      }
      @keyframes burstOut {
        0% { opacity: 0; height: 0; }
        50% { opacity: 0.8; }
        100% { opacity: 0.3; height: 600px; }
      }
    `, `
      <div class="comic-bg"></div>
      <div class="burst-lines">
        ${Array.from({ length: 12 }, (_, i) =>
          `<div class="burst-line" style="transform: rotate(${i * 30}deg); animation-delay: ${(i * 0.02).toFixed(2)}s"></div>`
        ).join('\n        ')}
      </div>
      <div class="comic-text">${escapeHtml(text)}</div>
    `);
  },

  comic_slash({ durationSec }) {
    const dur = (durationSec * 0.3).toFixed(2);
    return wrapHtml('Slash', `
      .slash-container { position: absolute; inset: 0; }
      .slash-line {
        position: absolute;
        width: 200%;
        height: 8px;
        background: linear-gradient(90deg, transparent 0%, #fff 20%, #fff 80%, transparent 100%);
        top: 50%;
        left: -50%;
        transform-origin: center;
        animation: slashSwipe ${dur}s ease-out forwards;
        opacity: 0;
        box-shadow: 0 0 30px #fff, 0 0 60px rgba(255,255,255,0.5);
      }
      .slash-line:nth-child(1) {
        transform: rotate(-30deg) translateY(-60px);
        animation-delay: 0s;
      }
      .slash-line:nth-child(2) {
        transform: rotate(-25deg) translateY(0px);
        animation-delay: 0.05s;
      }
      .slash-line:nth-child(3) {
        transform: rotate(-35deg) translateY(60px);
        animation-delay: 0.1s;
      }
      @keyframes slashSwipe {
        0% { opacity: 0; clip-path: inset(0 100% 0 0); }
        30% { opacity: 1; clip-path: inset(0 0 0 0); }
        70% { opacity: 0.8; }
        100% { opacity: 0; }
      }
      .flash-overlay {
        position: absolute; inset: 0;
        background: #fff;
        animation: flashBrief 0.15s ease-out forwards;
        animation-delay: 0.1s;
        opacity: 0;
      }
      @keyframes flashBrief {
        0% { opacity: 0.6; }
        100% { opacity: 0; }
      }
    `, `
      <div class="slash-container">
        <div class="slash-line"></div>
        <div class="slash-line"></div>
        <div class="slash-line"></div>
      </div>
      <div class="flash-overlay"></div>
    `);
  },

  blood_spray({ durationSec }) {
    const dur = (durationSec * 0.5).toFixed(2);
    // Generate random particle positions
    const particles = Array.from({ length: 30 }, (_, i) => {
      const angle = -60 + Math.random() * 120; // spray angle
      const dist = 200 + Math.random() * 800;
      const size = 6 + Math.random() * 24;
      const delay = (Math.random() * 0.15).toFixed(3);
      const x = Math.cos(angle * Math.PI / 180) * dist;
      const y = Math.sin(angle * Math.PI / 180) * dist - 200;
      return { x, y, size, delay, id: i };
    });

    return wrapHtml('Blood Spray', `
      .spray-origin {
        position: absolute;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
      }
      .blood-drop {
        position: absolute;
        border-radius: 50%;
        background: radial-gradient(circle, #cc0000, #8b0000);
        animation: dropFly ${dur}s ease-out forwards;
        opacity: 0;
      }
      @keyframes dropFly {
        0% { opacity: 0; transform: translate(0, 0) scale(0); }
        15% { opacity: 1; transform: translate(var(--tx), var(--ty)) scale(1.2); }
        40% { opacity: 0.9; transform: translate(var(--tx), var(--ty)) scale(1); }
        100% { opacity: 0; transform: translate(var(--tx), calc(var(--ty) + 100px)) scale(0.6); }
      }
      .red-flash {
        position: absolute; inset: 0;
        background: radial-gradient(circle at center, rgba(139,0,0,0.6), transparent 70%);
        animation: redFlash 0.3s ease-out forwards;
      }
      @keyframes redFlash {
        0% { opacity: 1; }
        100% { opacity: 0; }
      }
    `, `
      <div class="red-flash"></div>
      <div class="spray-origin">
        ${particles.map(p =>
          `<div class="blood-drop" style="width:${p.size}px;height:${p.size}px;--tx:${p.x.toFixed(0)}px;--ty:${p.y.toFixed(0)}px;animation-delay:${p.delay}s"></div>`
        ).join('\n        ')}
      </div>
    `);
  },

  shatter({ durationSec }) {
    const dur = (durationSec * 0.4).toFixed(2);
    // Generate crack lines from center
    const cracks = Array.from({ length: 8 }, (_, i) => {
      const angle = i * 45 + (Math.random() * 20 - 10);
      const length = 400 + Math.random() * 600;
      return { angle, length, delay: (i * 0.03).toFixed(3) };
    });

    return wrapHtml('Shatter', `
      .shatter-bg {
        position: absolute; inset: 0;
        background: #000;
      }
      .crack-line {
        position: absolute;
        top: 50%; left: 50%;
        width: 3px;
        background: linear-gradient(to bottom, #fff, rgba(255,255,255,0.3));
        transform-origin: top center;
        animation: crackGrow ${dur}s ease-out forwards;
        opacity: 0;
        box-shadow: 0 0 10px rgba(255,255,255,0.5);
      }
      @keyframes crackGrow {
        0% { opacity: 0; height: 0; }
        20% { opacity: 1; }
        100% { opacity: 0.7; }
      }
      .shatter-flash {
        position: absolute; inset: 0;
        background: #fff;
        animation: shatterFlash 0.2s ease-out forwards;
        opacity: 0;
      }
      @keyframes shatterFlash {
        0% { opacity: 0.8; }
        100% { opacity: 0; }
      }
      .impact-point {
        position: absolute;
        top: 50%; left: 50%;
        width: 40px; height: 40px;
        margin: -20px 0 0 -20px;
        border-radius: 50%;
        background: #fff;
        animation: pointPulse ${dur}s ease-out forwards;
        box-shadow: 0 0 40px #fff, 0 0 80px rgba(255,255,255,0.5);
      }
      @keyframes pointPulse {
        0% { transform: scale(0); opacity: 1; }
        20% { transform: scale(2); opacity: 1; }
        100% { transform: scale(0.5); opacity: 0; }
      }
    `, `
      <div class="shatter-bg"></div>
      <div class="shatter-flash"></div>
      ${cracks.map(c =>
        `<div class="crack-line" style="height:${c.length}px;transform:rotate(${c.angle}deg);animation-delay:${c.delay}s"></div>`
      ).join('\n      ')}
      <div class="impact-point"></div>
    `);
  },

  custom({ customText, durationSec }) {
    const text = customText || '!!!';
    // Use the comic_bam generator with the custom text
    return EFFECTS.comic_bam({ customText: text, durationSec });
  },
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
