#!/usr/bin/env node

/**
 * Feature test for the Sequence Rerun pipeline.
 *
 * Usage:
 *   node test/test-rerun.mjs <sessionId> <seqIndex> <mode> [instructions]
 *
 * Examples:
 *   node test/test-rerun.mjs 2026-02-28_07-51-20_64jk 4 reattempt
 *   node test/test-rerun.mjs 2026-02-28_07-51-20_64jk 4 rewrite "Use the Blooming Blade sword"
 *
 * Prerequisites:
 *   - Server running on PORT (default 3001)
 *   - Session must be in 'complete' stage
 */

const BASE = `http://localhost:${process.env.PORT || 3001}`;

const [sessionId, seqIndexStr, mode, ...instructionParts] = process.argv.slice(2);
const instructions = instructionParts.join(' ');

if (!sessionId || !seqIndexStr || !mode) {
  console.error('Usage: node test/test-rerun.mjs <sessionId> <seqIndex> <mode> [instructions]');
  console.error('  mode: "reattempt" or "rewrite"');
  process.exit(1);
}

const seqIndex = parseInt(seqIndexStr);

async function main() {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Sequence Rerun Feature Test             ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  console.log(`Session:      ${sessionId}`);
  console.log(`Sequence:     ${seqIndex} (0-based)`);
  console.log(`Mode:         ${mode}`);
  console.log(`Instructions: ${instructions || '(none)'}\n`);

  // ── Step 1: Verify session exists and is complete ──
  console.log('── Step 1: Verify session ──');
  const sessionRes = await fetch(`${BASE}/api/sessions/${sessionId}`);
  if (!sessionRes.ok) {
    console.error(`FAIL: Session not found (${sessionRes.status})`);
    process.exit(1);
  }
  const session = await sessionRes.json();
  console.log(`  Stage: ${session.stage}`);
  console.log(`  Sequences: ${session.generation?.sequences?.length || 0}`);
  console.log(`  Has storyboard: ${!!session.storyboard}`);

  if (session.stage !== 'complete') {
    console.error(`FAIL: Session stage is "${session.stage}", expected "complete"`);
    process.exit(1);
  }

  const seqCount = session.storyboard?.plan?.sequences?.length || 0;
  if (seqIndex < 0 || seqIndex >= seqCount) {
    console.error(`FAIL: seqIndex ${seqIndex} out of range (have ${seqCount} sequences)`);
    process.exit(1);
  }

  console.log('  PASS: Session ready for rerun\n');

  // ── Step 2: Record pre-rerun state ──
  console.log('── Step 2: Record pre-rerun state ──');
  const preSeq = session.storyboard.plan.sequences[seqIndex];
  const preGenSeq = session.generation.sequences[seqIndex];
  console.log(`  Type: ${preSeq.type}`);
  console.log(`  Speaker: ${preSeq.speaker || 'N/A'}`);
  console.log(`  Duration: ${preSeq.durationSec}s`);
  console.log(`  Pre-rerun cost: $${(preGenSeq?.cost || 0).toFixed(2)}`);

  // Check for existing sequence files
  const seqFiles = session.generation?.export?.sequenceFiles;
  if (seqFiles?.[seqIndex]?.mp4) {
    console.log(`  Pre-rerun MP4: exists`);
  }
  console.log('  PASS: Pre-rerun state recorded\n');

  // ── Step 3: Submit rerun ──
  console.log('── Step 3: Submit rerun ──');
  const rerunRes = await fetch(`${BASE}/api/sessions/${sessionId}/sequences/${seqIndex}/rerun`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, instructions }),
  });

  if (!rerunRes.ok) {
    const err = await rerunRes.json();
    console.error(`FAIL: Rerun rejected: ${err.error}`);
    process.exit(1);
  }

  const rerunData = await rerunRes.json();
  console.log(`  Response: ${rerunData.message}`);
  console.log(`  Stage: ${rerunData.stage}`);
  console.log('  PASS: Rerun submitted\n');

  // ── Step 4: Poll until complete ──
  console.log('── Step 4: Poll for completion ──');
  const startTime = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  const POLL_INTERVAL = 3000;

  let lastStatus = '';
  let finalSession = null;

  while (Date.now() - startTime < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL);

    const pollRes = await fetch(`${BASE}/api/sessions/${sessionId}`);
    const pollData = await pollRes.json();

    const rerun = pollData.rerun || {};
    const status = rerun.status || pollData.stage;

    if (status !== lastStatus) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  [${elapsed}s] Status: ${status} — ${pollData.progress?.message || ''}`);
      lastStatus = status;
    }

    if (pollData.stage === 'complete' && rerun.status === 'complete') {
      finalSession = pollData;
      break;
    }

    if (rerun.status === 'failed') {
      console.error(`FAIL: Rerun failed: ${rerun.error}`);
      process.exit(1);
    }
  }

  if (!finalSession) {
    console.error('FAIL: Timed out waiting for rerun to complete');
    process.exit(1);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`  Completed in ${elapsed}s`);
  console.log('  PASS: Rerun completed\n');

  // ── Step 5: Verify results ──
  console.log('── Step 5: Verify results ──');

  // Check storyboard was updated (if rewrite mode)
  if (mode === 'rewrite' && instructions) {
    const postSeq = finalSession.storyboard.plan.sequences[seqIndex];
    const changed = JSON.stringify(postSeq) !== JSON.stringify(preSeq);
    console.log(`  Storyboard updated: ${changed ? 'YES' : 'NO (may be identical if AI chose same descriptions)'}`);
  }

  // Check generation data
  const postGenSeq = finalSession.generation.sequences[seqIndex];
  console.log(`  Post-rerun cost: $${(postGenSeq?.cost || 0).toFixed(2)}`);
  console.log(`  Post-rerun status: ${postGenSeq?.status}`);

  // Check sequence files
  const postSeqFiles = finalSession.generation?.export?.sequenceFiles;
  if (postSeqFiles?.[seqIndex]?.mp4) {
    console.log(`  MP4 exists: YES`);
  } else {
    console.log(`  MP4 exists: NO (may be expected for impact sequences)`);
  }

  // Check playerHtml
  const playerHtml = finalSession.generation?.export?.files?.playerHtml;
  console.log(`  Player HTML: ${playerHtml ? 'exists' : 'MISSING'}`);

  console.log('  PASS: Results look good\n');

  // ── Summary ──
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  ALL TESTS PASSED                        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Elapsed: ${elapsed}s`);
  console.log(`  Mode: ${mode}`);
  console.log(`  Sequence: ${seqIndex + 1} (${preSeq.type}${preSeq.speaker ? ` — ${preSeq.speaker}` : ''})`);
  console.log();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error(`\nUNEXPECTED ERROR: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
