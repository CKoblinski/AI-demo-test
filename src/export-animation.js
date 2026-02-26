import puppeteer from 'puppeteer';
import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

/**
 * Export an ASCII animation HTML to video files for Premiere Pro.
 *
 * Captures each frame as a transparent PNG via Puppeteer,
 * then stitches into WebM (VP9 + alpha) and MOV (ProRes 4444).
 *
 * @param {string} htmlPath - Path to the animation HTML file
 * @param {string} outDir   - Output directory for exported files
 * @param {object} opts     - Options
 * @param {number} opts.fps        - Frames per second (default: 5)
 * @param {number} opts.width      - Viewport width (default: 1080 for vertical Shorts)
 * @param {number} opts.height     - Viewport height (default: 1920 for vertical Shorts)
 * @param {number} opts.peakFrame  - Frame index to use as thumbnail still (default: auto-detect)
 * @param {boolean} opts.keepFrames - Keep individual PNG frames (default: false)
 * @param {boolean} opts.webm      - Export WebM with alpha (default: true)
 * @param {boolean} opts.mov       - Export ProRes 4444 MOV (default: false, slower)
 * @param {boolean} opts.mp4       - Export MP4 on black background (default: true)
 * @param {boolean} opts.bounce    - Capture bounce (forward + reverse) (default: auto-detect)
 */
export async function exportAnimation(htmlPath, outDir, opts = {}) {
  const fps = opts.fps || 5;
  const width = opts.width || 1080;
  const height = opts.height || 1920;
  const keepFrames = opts.keepFrames ?? false;
  const exportWebm = opts.webm ?? true;
  const exportMov = opts.mov ?? false;
  const exportMp4 = opts.mp4 ?? true;

  const absHtml = resolve(htmlPath);
  const framesDir = join(outDir, 'frames');

  mkdirSync(framesDir, { recursive: true });

  console.log(`\nExporting: ${htmlPath}`);
  console.log(`  Output: ${outDir}`);
  console.log(`  Size: ${width}x${height} @ ${fps}fps`);

  // ── Launch browser ──
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      `--window-size=${width},${height}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  // Make the background transparent for alpha capture
  await page.evaluateOnNewDocument(() => {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.style.background = 'transparent';
      document.documentElement.style.background = 'transparent';
    });
  });

  await page.goto(`file://${absHtml}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#stage');

  // Wait for first render
  await new Promise(r => setTimeout(r, 500));

  // ── Get frame count and detect bounce mode ──
  const animInfo = await page.evaluate(() => {
    const total = typeof frameData !== 'undefined' ? frameData.length
                : typeof frames !== 'undefined' ? frames.length : 0;
    const isBounce = typeof bouncing !== 'undefined' ? bouncing : false;

    // Find peak frame (highest mood)
    let peakIdx = 0;
    let peakMood = 0;
    if (typeof frameData !== 'undefined') {
      frameData.forEach((f, i) => {
        if (f.mood > peakMood) { peakMood = f.mood; peakIdx = i; }
      });
    }

    return { total, isBounce, peakIdx };
  });

  const totalFrames = animInfo.total;
  const isBounce = opts.bounce ?? animInfo.isBounce;
  const peakFrame = opts.peakFrame ?? animInfo.peakIdx;

  // For bounce: capture forward frames, then reverse (minus endpoints to avoid duplicate)
  const captureCount = isBounce ? (totalFrames * 2 - 2) : totalFrames;

  console.log(`  Frames: ${totalFrames} (${isBounce ? 'bounce → ' + captureCount + ' total' : 'loop'})`);
  console.log(`  Peak frame: ${peakFrame}`);

  // ── Pause the animation ──
  await page.evaluate(() => {
    if (typeof pause === 'function') pause();
  });

  // ── Hide controls, center the stage ──
  await page.evaluate(() => {
    // Hide all controls
    document.querySelectorAll('.controls, .mode-toggle, h1').forEach(el => {
      el.style.display = 'none';
    });

    // Make the stage fill the viewport and center
    const stage = document.getElementById('stage');
    stage.style.position = 'fixed';
    stage.style.top = '0';
    stage.style.left = '0';
    stage.style.width = '100vw';
    stage.style.height = '100vh';
    stage.style.border = 'none';
    stage.style.borderRadius = '0';
    stage.style.margin = '0';
    stage.style.padding = '0';
    stage.style.display = 'flex';
    stage.style.alignItems = 'center';
    stage.style.justifyContent = 'center';
    stage.style.background = 'transparent';

    // Scale up the font for video resolution
    stage.style.fontSize = '28px';

    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';
  });

  await new Promise(r => setTimeout(r, 300));

  // ── Capture frames ──
  console.log(`  Capturing ${captureCount} frames...`);

  // Build the frame order
  const frameOrder = [];
  for (let i = 0; i < totalFrames; i++) frameOrder.push(i);
  if (isBounce) {
    for (let i = totalFrames - 2; i > 0; i--) frameOrder.push(i);
  }

  for (let fi = 0; fi < frameOrder.length; fi++) {
    const frameIdx = frameOrder[fi];

    // Set frame
    await page.evaluate((idx) => {
      currentFrame = idx;
      render();
    }, frameIdx);

    await new Promise(r => setTimeout(r, 80)); // let render settle

    const framePath = join(framesDir, `frame_${String(fi).padStart(4, '0')}.png`);
    await page.screenshot({
      path: framePath,
      omitBackground: true, // transparent background
    });

    // Also save the peak frame as a separate still
    if (frameIdx === peakFrame && fi < totalFrames) {
      await page.screenshot({
        path: join(outDir, 'peak-frame.png'),
        omitBackground: true,
      });
      // Also save one with the dark background for thumbnail use
      await page.evaluate(() => {
        document.getElementById('stage').style.background = '#020204';
      });
      await page.screenshot({
        path: join(outDir, 'thumbnail.png'),
        omitBackground: false,
      });
      await page.evaluate(() => {
        document.getElementById('stage').style.background = 'transparent';
      });
    }

    if ((fi + 1) % 10 === 0 || fi === frameOrder.length - 1) {
      process.stdout.write(`\r  Captured ${fi + 1}/${frameOrder.length}`);
    }
  }
  console.log('');

  await browser.close();

  // ── Stitch with FFmpeg ──
  const inputPattern = join(framesDir, 'frame_%04d.png');

  if (exportWebm) {
    const webmPath = join(outDir, 'animation.webm');
    console.log(`  Encoding WebM (VP9 + alpha)...`);
    try {
      execSync(
        `ffmpeg -y -framerate ${fps} -i "${inputPattern}" ` +
        `-c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 ` +
        `-b:v 2M -an "${webmPath}"`,
        { stdio: 'pipe' }
      );
      console.log(`  → ${webmPath}`);
    } catch (e) {
      console.error(`  WebM encoding failed: ${e.message}`);
    }
  }

  if (exportMp4) {
    const mp4Path = join(outDir, 'animation.mp4');
    console.log(`  Encoding MP4 (on black, for blend modes)...`);
    try {
      execSync(
        `ffmpeg -y -framerate ${fps} -i "${inputPattern}" ` +
        `-c:v libx264 -pix_fmt yuv420p -crf 18 ` +
        `-vf "split[s0][s1];[s0]drawbox=c=black:replace=1:t=fill[bg];[bg][s1]overlay=format=auto" ` +
        `-an "${mp4Path}"`,
        { stdio: 'pipe' }
      );
      console.log(`  → ${mp4Path}`);
    } catch (e) {
      // Simpler fallback: just render on black
      try {
        execSync(
          `ffmpeg -y -framerate ${fps} -i "${inputPattern}" ` +
          `-c:v libx264 -pix_fmt yuv420p -crf 18 -an "${mp4Path}"`,
          { stdio: 'pipe' }
        );
        console.log(`  → ${mp4Path}`);
      } catch (e2) {
        console.error(`  MP4 encoding failed: ${e2.message}`);
      }
    }
  }

  if (exportMov) {
    const movPath = join(outDir, 'animation.mov');
    console.log(`  Encoding MOV (ProRes 4444 + alpha)...`);
    try {
      execSync(
        `ffmpeg -y -framerate ${fps} -i "${inputPattern}" ` +
        `-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le ` +
        `-an "${movPath}"`,
        { stdio: 'pipe' }
      );
      console.log(`  → ${movPath}`);
    } catch (e) {
      console.error(`  MOV encoding failed: ${e.message}`);
    }
  }

  // ── Cleanup frames unless keepFrames ──
  if (!keepFrames) {
    const pngs = readdirSync(framesDir).filter(f => f.endsWith('.png'));
    for (const f of pngs) unlinkSync(join(framesDir, f));
    try { require('fs').rmdirSync(framesDir); } catch {}
    console.log(`  Cleaned up ${pngs.length} frame PNGs`);
  } else {
    const pngs = readdirSync(framesDir).filter(f => f.endsWith('.png'));
    console.log(`  Kept ${pngs.length} frame PNGs in ${framesDir}`);
  }

  console.log(`  Done!\n`);

  return {
    outDir,
    totalFrames: captureCount,
    peakFrame,
    files: {
      webm: exportWebm ? join(outDir, 'animation.webm') : null,
      mp4: exportMp4 ? join(outDir, 'animation.mp4') : null,
      mov: exportMov ? join(outDir, 'animation.mov') : null,
      peakFrame: join(outDir, 'peak-frame.png'),
      thumbnail: join(outDir, 'thumbnail.png'),
    },
  };
}
