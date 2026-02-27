import { readFileSync } from 'fs';
import { basename } from 'path';

/**
 * Parse a Zoom VTT transcript into structured session data.
 *
 * Zoom format:
 *   WEBVTT
 *
 *   1
 *   00:00:02.656 --> 00:00:03.230
 *   Speaker Name: Dialogue text here.
 */

function parseTimestamp(ts) {
  const parts = ts.trim().match(/(\d+):(\d+):(\d+)\.(\d+)/);
  if (!parts) return 0;
  return parseInt(parts[1]) * 3600
       + parseInt(parts[2]) * 60
       + parseInt(parts[3])
       + parseInt(parts[4]) / 1000;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function extractCharacterName(speakerName) {
  const match = speakerName.match(/\(([^)]+)\)/);
  return match ? match[1] : null;
}

export function parseVTT(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/);

  // Skip WEBVTT header
  let i = 0;
  if (lines[0]?.trim().startsWith('WEBVTT')) i = 1;
  while (i < lines.length && lines[i].trim() === '') i++;

  const cues = [];
  let autoId = 0;

  while (i < lines.length) {
    // Skip blank lines
    if (lines[i].trim() === '') { i++; continue; }

    // Try to parse: either "cueId\ntimestamp" or just "timestamp" (no cue ID)
    const line = lines[i].trim();

    let cueId;
    let tsLine;

    // Check if current line is a timestamp
    const directTsMatch = line.match(/^(\d+:\d+:\d+\.\d+)\s*-->\s*(\d+:\d+:\d+\.\d+)/);

    if (directTsMatch) {
      // No cue ID — auto-caption format (Zoom .cc.vtt or similar)
      autoId++;
      cueId = autoId;
      tsLine = directTsMatch;
      i++;
    } else {
      // Try numeric cue ID followed by timestamp on next line
      const numericId = parseInt(line);
      if (isNaN(numericId)) { i++; continue; }
      cueId = numericId;
      autoId = numericId;
      i++;

      if (i >= lines.length) break;
      tsLine = lines[i].match(/^(\d+:\d+:\d+\.\d+)\s*-->\s*(\d+:\d+:\d+\.\d+)/);
      if (!tsLine) { i++; continue; }
      i++;
    }

    const start = parseTimestamp(tsLine[1]);
    const end = parseTimestamp(tsLine[2]);

    // Collect content lines until blank line or next timestamp/cue
    const contentLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      // Stop if we hit a timestamp line (next cue without blank separator)
      if (lines[i].match(/^\d+:\d+:\d+\.\d+\s*-->\s*\d+:\d+:\d+\.\d+/)) break;
      // Stop if we hit a numeric cue ID followed by a timestamp
      if (/^\d+$/.test(lines[i].trim()) && i + 1 < lines.length &&
          lines[i + 1].match(/^\d+:\d+:\d+\.\d+\s*-->\s*\d+:\d+:\d+\.\d+/)) break;
      contentLines.push(lines[i]);
      i++;
    }
    const fullText = contentLines.join(' ').trim();
    if (!fullText) continue;

    // Parse speaker from "Speaker Name: dialogue text"
    const speakerMatch = fullText.match(/^(.+?):\s+(.+)$/);
    let speaker = null;
    let text = fullText;
    if (speakerMatch) {
      speaker = speakerMatch[1].trim();
      text = speakerMatch[2].trim();
    }

    cues.push({ id: cueId, start, end, speaker, text });
  }

  // Build speaker stats
  const speakerMap = new Map();
  for (const cue of cues) {
    if (!cue.speaker) continue;
    if (!speakerMap.has(cue.speaker)) {
      speakerMap.set(cue.speaker, {
        name: cue.speaker,
        character: extractCharacterName(cue.speaker),
        cueCount: 0,
        totalSpeakingTime: 0,
        totalTextLength: 0,
      });
    }
    const s = speakerMap.get(cue.speaker);
    s.cueCount++;
    s.totalSpeakingTime += (cue.end - cue.start);
    s.totalTextLength += cue.text.length;
  }

  const speakers = [...speakerMap.values()].map(s => ({
    ...s,
    totalSpeakingTime: Math.round(s.totalSpeakingTime * 10) / 10,
    avgTextLength: Math.round(s.totalTextLength / s.cueCount),
  }));

  // Auto-detect DM: highest speaking time AND longest average text
  // DM narrates in long blocks; players respond in short bursts
  speakers.sort((a, b) => b.totalSpeakingTime - a.totalSpeakingTime);
  const dmCandidate = speakers.find(s =>
    s.totalSpeakingTime === speakers[0].totalSpeakingTime
    || (s.avgTextLength > 30 && s.totalSpeakingTime > speakers[0].totalSpeakingTime * 0.5)
  );

  for (const s of speakers) {
    if (s.name === dmCandidate?.name) {
      s.role = 'dm';
      s.alias = 'DM';
    } else {
      s.role = 'player';
    }
  }

  // Detect session segments
  const segments = detectSegments(cues, dmCandidate?.name);

  // Session metadata
  const lastCue = cues[cues.length - 1];
  const duration = lastCue ? lastCue.end : 0;

  return {
    sessionFile: basename(filePath),
    parsedAt: new Date().toISOString(),
    duration: formatDuration(duration),
    durationSeconds: Math.round(duration),
    totalCues: cues.length,
    speakers,
    segments,
    cues,
  };
}

/**
 * Detect session segments: pre-game banter, recap, gameplay.
 *
 * Heuristic:
 * - Pre-game banter: short exchanges, casual, no sustained DM narration
 * - Recap: first sustained DM monologue (3+ consecutive DM cues, total > 60s)
 * - Gameplay: everything after the recap
 */
function detectSegments(cues, dmName) {
  if (!dmName || cues.length === 0) {
    return [{ type: 'gameplay', startCue: 1, endCue: cues.length, startTime: 0, endTime: cues[cues.length - 1]?.end || 0 }];
  }

  // Find the first sustained DM monologue (recap)
  let recapStart = -1;
  let recapEnd = -1;

  for (let i = 0; i < cues.length - 2; i++) {
    // Look for 3+ consecutive DM cues
    if (cues[i].speaker !== dmName) continue;

    let consecutive = 1;
    let j = i + 1;
    while (j < cues.length && cues[j].speaker === dmName) {
      consecutive++;
      j++;
    }

    // A recap is 3+ consecutive DM cues spanning at least 45 seconds
    if (consecutive >= 3) {
      const span = cues[j - 1].end - cues[i].start;
      if (span >= 45) {
        recapStart = i;
        // Recap continues as long as the DM keeps talking with at most
        // 1 short interruption between DM blocks
        let k = j;
        while (k < cues.length) {
          // Allow a short non-DM interruption (1-2 cues)
          let gap = 0;
          while (k < cues.length && cues[k].speaker !== dmName) { gap++; k++; }
          if (gap > 2 || k >= cues.length) break;
          // DM continues
          while (k < cues.length && cues[k].speaker === dmName) k++;
        }
        recapEnd = k - 1;
        break;
      }
    }
  }

  const segments = [];
  const lastTime = cues[cues.length - 1].end;

  if (recapStart > 0) {
    segments.push({
      type: 'pre-session-banter',
      startCue: cues[0].id,
      endCue: cues[recapStart - 1].id,
      startTime: cues[0].start,
      endTime: cues[recapStart].start,
    });
  }

  if (recapStart >= 0) {
    segments.push({
      type: 'recap',
      startCue: cues[recapStart].id,
      endCue: cues[recapEnd].id,
      startTime: cues[recapStart].start,
      endTime: cues[recapEnd].end,
    });
    segments.push({
      type: 'gameplay',
      startCue: cues[recapEnd + 1]?.id || cues[recapEnd].id,
      endCue: cues[cues.length - 1].id,
      startTime: cues[recapEnd + 1]?.start || cues[recapEnd].end,
      endTime: lastTime,
    });
  } else {
    segments.push({
      type: 'gameplay',
      startCue: cues[0].id,
      endCue: cues[cues.length - 1].id,
      startTime: cues[0].start,
      endTime: lastTime,
    });
  }

  return segments;
}
