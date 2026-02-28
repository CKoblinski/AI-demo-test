// ═══════════════════════════════════════
// D&D Shorts Factory — Frontend (Pixel Art Pipeline)
// ═══════════════════════════════════════

let currentSessionId = null;
let pollInterval = null;
let selectedMomentIndex = null;
let cachedSession = null; // cache for returning to plan screen

// ── Screen Navigation ──

function showScreen(name) {
  // Auto-switch to Factory tab if we're on another tab
  const factoryPanel = document.getElementById('tab-factory');
  if (factoryPanel && !factoryPanel.classList.contains('active')) {
    switchTab('factory');
  }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}

// ── Upload Screen ──

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const submitBtn = document.getElementById('submit-btn');
const contextInput = document.getElementById('user-context');

let selectedFile = null;

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.vtt')) {
    selectFile(file);
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) selectFile(fileInput.files[0]);
});

function selectFile(file) {
  selectedFile = file;
  dropZone.classList.add('has-file');
  dropZone.querySelector('p').textContent = file.name;
  dropZone.querySelector('.drop-sub').textContent = `${(file.size / 1024).toFixed(0)} KB`;
  submitBtn.disabled = false;
}

submitBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading...';

  const formData = new FormData();
  formData.append('vtt', selectedFile);
  formData.append('context', contextInput.value);
  const modelRadio = document.querySelector('input[name="analysis-model"]:checked');
  if (modelRadio) formData.append('analysisModel', modelRadio.value);

  try {
    const res = await fetch('/api/sessions', { method: 'POST', body: formData });
    const data = await res.json();

    if (res.ok) {
      currentSessionId = data.id;
      showScreen('analyzing');
      startPolling();
    } else {
      alert(`Error: ${data.error}`);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Analyze Transcript';
    }
  } catch (err) {
    alert(`Upload failed: ${err.message}`);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Analyze Transcript';
  }
});

// ── Polling ──

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(pollSession, 2500);
  pollSession();
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function pollSession() {
  if (!currentSessionId) return;

  try {
    const res = await fetch(`/api/sessions/${currentSessionId}`);
    const session = await res.json();

    if (!res.ok) {
      console.error('Poll error:', session.error);
      return;
    }

    updateUI(session);
  } catch (err) {
    console.error('Poll failed:', err);
  }
}

function updateUI(session) {
  switch (session.stage) {
    case 'uploaded':
    case 'analyzing':
      showScreen('analyzing');
      document.getElementById('analyze-message').textContent = session.progress.message;
      document.getElementById('analyze-progress').style.width = session.progress.percent + '%';
      break;

    case 'plan_ready':
      stopPolling();
      cachedSession = session;
      showScreen('plan');
      renderMoments(session);
      break;

    case 'planning':
      // Director AI is working — show analyzing screen with director message
      showScreen('analyzing');
      document.getElementById('analyze-message').textContent = session.progress.message || 'Director AI is planning sequences...';
      document.getElementById('analyze-progress').style.width = session.progress.percent + '%';
      document.querySelector('.spinner').style.display = '';
      break;

    case 'storyboard_ready':
      stopPolling();
      cachedSession = session;
      if (session.selectedMoment != null) selectedMomentIndex = session.selectedMoment;
      showScreen('storyboard');
      renderStoryboard(session);
      break;

    case 'generating':
    case 'exporting':
      showScreen('generating');
      renderGenerating(session);
      break;

    case 'rerunning_sequence':
      showScreen('generating');
      renderRerunProgress(session);
      break;

    case 'complete':
      stopPolling();
      showScreen('results');
      renderResults(session);
      break;

    case 'failed':
      stopPolling();
      showScreen('analyzing');
      document.getElementById('analyze-message').textContent = session.progress.message || 'Something went wrong';
      document.querySelector('.spinner').style.display = 'none';
      break;
  }
}

// ── Moment Selector (Screen 3) ──

function renderMoments(session) {
  const container = document.getElementById('moments-list');
  container.innerHTML = '';

  if (!session.highlights) return;

  const cues = session.cues || [];

  session.highlights.forEach((h, i) => {
    const card = document.createElement('div');
    card.className = 'moment-card' + (selectedMomentIndex === i ? ' selected' : '');
    card.id = `moment-${i}`;
    card.onclick = () => selectMoment(i);

    // Time display
    const startMin = Math.floor((h.startTime || 0) / 60);
    const startSec = Math.floor((h.startTime || 0) % 60);
    const endMin = Math.floor((h.endTime || 0) / 60);
    const endSec = Math.floor((h.endTime || 0) % 60);
    const timeStr = `${pad(startMin)}:${pad(startSec)} - ${pad(endMin)}:${pad(endSec)}`;

    // Build transcript excerpt
    let transcriptHtml = '';
    if (h.dialogueExcerpt && h.dialogueExcerpt.length > 0) {
      transcriptHtml = '<div class="moment-transcript">';
      for (const line of h.dialogueExcerpt) {
        transcriptHtml += `<div class="transcript-line">`;
        if (line.speaker) {
          transcriptHtml += `<span class="transcript-speaker">${esc(line.speaker)}:</span> `;
        }
        transcriptHtml += `<span class="transcript-text">${esc(line.text)}</span>`;
        transcriptHtml += `</div>`;
      }
      transcriptHtml += '</div>';
    }

    // Wider transcript context — pull cues around the moment time range
    let contextHtml = '';
    if (cues.length > 0 && h.startTime !== undefined) {
      const nearbyCues = cues.filter(c =>
        c.start >= (h.startTime - 10) && c.start <= (h.endTime + 10)
      ).slice(0, 20);

      if (nearbyCues.length > 0) {
        contextHtml = '<details class="moment-context-details"><summary>Full transcript context</summary><div class="moment-context-cues">';
        for (const c of nearbyCues) {
          const ts = `${pad(Math.floor(c.start / 60))}:${pad(Math.floor(c.start % 60))}`;
          const speaker = c.speaker ? `<span class="transcript-speaker">${esc(c.speaker)}:</span> ` : '';
          contextHtml += `<div class="context-cue"><span class="cue-time">${ts}</span> ${speaker}${esc(c.text)}</div>`;
        }
        contextHtml += '</div></details>';
      }
    }

    // Speaker descriptions needed
    let speakerNeedHtml = '';
    if (h.speakerDescriptionNeeded && h.speakerDescriptionNeeded.length > 0) {
      speakerNeedHtml = `<div class="speakers-needed">Needs description: ${h.speakerDescriptionNeeded.map(s => `<span class="speaker-tag">${esc(s)}</span>`).join(' ')}</div>`;
    }

    // Visual concept
    let visualHtml = '';
    if (h.visualConcept) {
      visualHtml = `<div class="visual-concept">${esc(h.visualConcept)}</div>`;
    }

    card.innerHTML = `
      <div class="moment-header">
        <div class="moment-radio">${selectedMomentIndex === i ? '&#9679;' : '&#9675;'}</div>
        <div class="moment-rank">${h.rank || i + 1}</div>
        <div class="moment-title">${esc(h.title)}</div>
        <span class="badge badge-${h.type}">${(h.type || '').replace(/_/g, ' ')}</span>
      </div>
      <div class="moment-meta">
        <span>${timeStr}</span>
        <span>${esc(h.emotionalArc || '')}</span>
      </div>
      ${transcriptHtml}
      ${visualHtml}
      ${speakerNeedHtml}
      ${contextHtml}
      ${h.whyItsGood ? `<div class="moment-why">${esc(h.whyItsGood)}</div>` : ''}
    `;

    container.appendChild(card);
  });

  // Restore previous selection state
  updateGenerateButton();
}

function selectMoment(index) {
  selectedMomentIndex = index;

  // Update visual state
  document.querySelectorAll('.moment-card').forEach((card, i) => {
    card.classList.toggle('selected', i === index);
    const radio = card.querySelector('.moment-radio');
    if (radio) radio.innerHTML = i === index ? '&#9679;' : '&#9675;';
  });

  updateGenerateButton();
}

function updateGenerateButton() {
  const btn = document.getElementById('generate-btn');
  btn.disabled = selectedMomentIndex === null;
}

// ── Generate (submit moment + direction) ──

document.getElementById('generate-btn').addEventListener('click', async () => {
  if (selectedMomentIndex === null) return;

  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  btn.textContent = 'Planning sequences...';

  const direction = document.getElementById('direction-text').value;

  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ momentIndex: selectedMomentIndex, direction }),
    });
    const data = await res.json();

    if (res.ok) {
      startPolling();
    } else {
      alert(`Error: ${data.error}`);
      btn.disabled = false;
      btn.textContent = 'Plan Sequences';
    }
  } catch (err) {
    alert(`Failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Plan Sequences';
  }
});

// ── Generating (Screen 4) — Per-asset + per-sequence progress ──

const GEN_STEPS = ['portrait', 'mouthVariants', 'background', 'assembly', 'export'];

function renderGenerating(session) {
  // Keep cancel button enabled while generating
  const cancelBtn = document.getElementById('cancel-gen-btn');
  if (cancelBtn) {
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel Generation';
  }

  const gen = session.generation;
  if (!gen) {
    document.getElementById('gen-progress').style.width = session.progress.percent + '%';
    document.getElementById('gen-message').textContent = session.progress.message;
    return;
  }

  // ── Multi-sequence progress ──
  if (gen.sequences && Array.isArray(gen.sequences)) {
    document.getElementById('gen-steps').style.display = 'none';
    const seqContainer = document.getElementById('gen-sequences');
    seqContainer.style.display = '';

    // Build sequence cards if needed
    if (seqContainer.children.length !== gen.sequences.length + 2) {
      // +2 for assembly and export rows
      seqContainer.innerHTML = '';

      gen.sequences.forEach((sq, i) => {
        const card = document.createElement('div');
        card.className = 'gen-seq-card';
        card.id = `gen-seq-${i}`;
        const icon = SEQ_TYPE_ICONS[sq.type] || '\uD83C\uDFAC';
        const typeLabel = SEQ_TYPE_LABELS[sq.type] || sq.type;
        card.innerHTML = `
          <div class="gen-seq-header">
            <span class="gen-seq-num">${i + 1}</span>
            <span class="gen-seq-icon">${icon}</span>
            <span class="gen-seq-type">${typeLabel}</span>
            ${sq.speaker ? `<span class="gen-seq-speaker">${esc(sq.speaker)}</span>` : ''}
            <span class="gen-seq-status" id="gen-seq-status-${i}">pending</span>
          </div>
          <div class="gen-seq-assets" id="gen-seq-assets-${i}"></div>
        `;
        seqContainer.appendChild(card);
      });

      // Assembly row
      const asmCard = document.createElement('div');
      asmCard.className = 'gen-seq-card';
      asmCard.id = 'gen-seq-assembly';
      asmCard.innerHTML = `
        <div class="gen-seq-header">
          <span class="gen-seq-num">&bull;</span>
          <span class="gen-seq-icon">\uD83D\uDDC2</span>
          <span class="gen-seq-type">Assembly</span>
          <span class="gen-seq-status" id="gen-seq-status-assembly">pending</span>
        </div>
      `;
      seqContainer.appendChild(asmCard);

      // Export row
      const expCard = document.createElement('div');
      expCard.className = 'gen-seq-card';
      expCard.id = 'gen-seq-export';
      expCard.innerHTML = `
        <div class="gen-seq-header">
          <span class="gen-seq-num">&bull;</span>
          <span class="gen-seq-icon">\uD83C\uDFAC</span>
          <span class="gen-seq-type">Export Video</span>
          <span class="gen-seq-status" id="gen-seq-status-export">pending</span>
        </div>
      `;
      seqContainer.appendChild(expCard);
    }

    // Update sequence statuses
    gen.sequences.forEach((sq, i) => {
      const statusEl = document.getElementById(`gen-seq-status-${i}`);
      const card = document.getElementById(`gen-seq-${i}`);
      if (statusEl) {
        statusEl.textContent = sq.status;
        statusEl.className = `gen-seq-status gen-seq-status-${sq.status}`;
      }
      if (card) {
        card.className = `gen-seq-card gen-seq-${sq.status}`;
      }

      // Show per-asset detail
      const assetsEl = document.getElementById(`gen-seq-assets-${i}`);
      if (assetsEl && sq.assets) {
        const assetParts = [];
        for (const [key, val] of Object.entries(sq.assets)) {
          const statusIcon = val.status === 'complete' ? '\u2705' : val.status === 'generating' ? '\u23F3' : '\u23F8';
          assetParts.push(`<span class="gen-asset-tag gen-asset-${val.status}">${statusIcon} ${key}${val.sizeKB ? ` (${val.sizeKB}KB)` : ''}</span>`);
        }
        assetsEl.innerHTML = assetParts.join(' ');
      }
    });

    // Assembly + export status
    const asmStatus = document.getElementById('gen-seq-status-assembly');
    if (asmStatus && gen.assembly) {
      asmStatus.textContent = gen.assembly.status;
      asmStatus.className = `gen-seq-status gen-seq-status-${gen.assembly.status}`;
    }
    const expStatus = document.getElementById('gen-seq-status-export');
    if (expStatus && gen.export) {
      expStatus.textContent = gen.export.status;
      expStatus.className = `gen-seq-status gen-seq-status-${gen.export.status}`;
    }

  } else {
    // ── Legacy single-scene progress ──
    document.getElementById('gen-steps').style.display = '';
    document.getElementById('gen-sequences').style.display = 'none';

    for (const step of GEN_STEPS) {
      const stepEl = document.getElementById(`step-${step}`);
      if (!stepEl) continue;

      const data = gen[step] || {};
      const status = data.status || 'pending';

      stepEl.className = `gen-step gen-step-${status}`;

      const detailEl = document.getElementById(`step-${step}-detail`);
      if (detailEl) {
        if (status === 'pending') detailEl.textContent = '';
        else if (status === 'generating' || status === 'assembling' || status === 'exporting') detailEl.textContent = 'Working...';
        else if (status === 'complete') {
          const parts = [];
          if (data.sizeKB) parts.push(`${data.sizeKB} KB`);
          if (data.durationMs) parts.push(`${(data.durationMs / 1000).toFixed(1)}s`);
          if (data.count) parts.push(`${data.count} variants`);
          detailEl.textContent = parts.join(' · ') || 'Done';
        }
        else if (status === 'failed') detailEl.textContent = data.error || 'Failed';
      }

      const thumbEl = document.getElementById(`step-${step}-thumb`);
      if (thumbEl && data.thumbnailBase64 && !thumbEl.dataset.loaded) {
        thumbEl.innerHTML = `<img src="data:image/png;base64,${data.thumbnailBase64}" alt="${step}" />`;
        thumbEl.dataset.loaded = 'true';
      }
    }
  }

  // Progress bar and message
  document.getElementById('gen-progress').style.width = session.progress.percent + '%';
  document.getElementById('gen-message').textContent = session.progress.message;

  // Cost
  const costEl = document.getElementById('gen-cost');
  if (costEl && gen.totalCost) {
    costEl.textContent = `Cost so far: ~$${gen.totalCost.toFixed(2)}`;
  }
}

// ── Storyboard (Screen 3.5) ──

const SEQ_TYPE_ICONS = {
  dialogue: '\uD83D\uDCAC',         // 💬
  dm_description: '\uD83D\uDCDC',   // 📜
  close_up: '\uD83D\uDD0D',         // 🔍
  establishing_shot: '\uD83C\uDF04', // 🌄
  impact: '\uD83D\uDCA5',           // 💥
  // Legacy aliases
  action_closeup: '\u2694\uFE0F',    // ⚔️
  reaction: '\uD83D\uDE2E',          // 😮
};

const SEQ_TYPE_LABELS = {
  dialogue: 'Dialogue',
  dm_description: 'DM Description',
  close_up: 'Close-up',
  establishing_shot: 'Establishing Shot',
  impact: 'Impact',
  // Legacy aliases
  action_closeup: 'Action Close-up',
  reaction: 'Reaction',
};

// ── Storyboard Editor State ──
let editableSequences = []; // working copy of sequences for editing

const SEQ_TYPES = ['establishing_shot', 'dialogue', 'dm_description', 'close_up', 'impact'];

const IMPACT_EFFECTS = ['flash_white', 'flash_red', 'comic_bam', 'comic_slash', 'blood_spray', 'shatter', 'custom'];

const TRANSITION_TYPES = ['cut', 'fade', 'flash'];

function renderStoryboard(session) {
  const container = document.getElementById('storyboard-sequences');
  const summary = document.getElementById('storyboard-summary');
  const qcDiv = document.getElementById('storyboard-qc');
  const sceneCtxDiv = document.getElementById('storyboard-scene-context');
  container.innerHTML = '';
  summary.innerHTML = '';
  qcDiv.innerHTML = '';
  if (sceneCtxDiv) sceneCtxDiv.innerHTML = '';

  const sb = session.storyboard;
  if (!sb || !sb.plan || !sb.plan.sequences) {
    container.innerHTML = '<p>No storyboard data available.</p>';
    return;
  }

  // Deep clone sequences into editable state
  editableSequences = JSON.parse(JSON.stringify(sb.plan.sequences));

  renderSequenceCards();
  renderSummary();

  // Scene context brief (collapsible)
  if (sceneCtxDiv && sb.sceneContext) {
    const sc = sb.sceneContext;
    let scHtml = '<details class="sb-scene-ctx"><summary class="sb-scene-ctx-toggle">Scene Context (from transcript analysis)</summary><div class="sb-scene-ctx-body">';
    const fields = [
      ['Setting', sc.setting],
      ['Conflict', sc.conflict],
      ['Enemies / NPCs', sc.enemiesAndNPCs],
      ['Positioning', sc.spatialPositioning],
      ['Lead-up', sc.leadUp],
      ['Emotional Temperature', sc.emotionalTemperature],
    ];
    for (const [label, val] of fields) {
      if (val) scHtml += `<div class="sb-scene-ctx-field"><strong>${esc(label)}:</strong> ${esc(val)}</div>`;
    }
    if (sc.dmDescriptions && sc.dmDescriptions.length > 0) {
      scHtml += '<div class="sb-scene-ctx-field"><strong>DM Descriptions:</strong></div>';
      for (const d of sc.dmDescriptions) {
        scHtml += `<div class="sb-scene-ctx-dm">"${esc(d)}"</div>`;
      }
    }
    scHtml += '</div></details>';
    sceneCtxDiv.innerHTML = scHtml;
  }

  // QC notes
  let qcHtml = '';

  // Technical QC (auto-fixes)
  if (sb.qcResult && sb.qcResult.fixes && sb.qcResult.fixes.length > 0) {
    qcHtml += '<div class="sb-qc-header">Technical QC (auto-fixed)</div>';
    for (const fix of sb.qcResult.fixes) {
      qcHtml += `<div class="sb-qc-fix">Seq ${fix.sequenceOrder}: ${esc(fix.issue)}</div>`;
    }
  }

  // Creative QC (3-dimension Sonnet check)
  if (sb.creativeResult && sb.creativeResult.dimensions) {
    const cr = sb.creativeResult;
    const passIcon = '✓';
    const failIcon = '✗';
    qcHtml += `<div class="sb-qc-header sb-qc-creative-header">Creative QC — ${cr.passCount}/3 passed ${cr.passCount >= 2 ? passIcon : failIcon}</div>`;
    const dimLabels = {
      cinematicPacing: 'Cinematic Pacing',
      characterFidelity: 'Character Fidelity',
      sceneCoherence: 'Scene Coherence',
    };
    for (const [key, dim] of Object.entries(cr.dimensions)) {
      const passed = dim.pass;
      const label = dimLabels[key] || key;
      qcHtml += `<div class="sb-qc-dim ${passed ? 'sb-qc-pass' : 'sb-qc-fail'}">${passed ? passIcon : failIcon} ${esc(label)}${dim.feedback ? ': ' + esc(dim.feedback) : ''}</div>`;
    }
    if (cr.overallFeedback) {
      qcHtml += `<div class="sb-qc-overall">${esc(cr.overallFeedback)}</div>`;
    }
  }

  if (qcHtml) qcDiv.innerHTML = qcHtml;
}

function renderSequenceCards() {
  const container = document.getElementById('storyboard-sequences');
  container.innerHTML = '';

  editableSequences.forEach((seq, i) => {
    const card = document.createElement('div');
    card.className = `storyboard-card storyboard-type-${seq.type}`;
    card.dataset.index = i;

    const icon = SEQ_TYPE_ICONS[seq.type] || '\uD83C\uDFAC';

    // ── Card header with type selector, duration, reorder + delete ──
    const totalDur = editableSequences.reduce((s, sq) => s + (sq.durationSec || 0), 0);
    const durationPct = totalDur > 0 ? Math.round((seq.durationSec / totalDur) * 100) : 50;

    let headerHtml = `
      <div class="sb-card-header sb-card-header-edit">
        <span class="sb-order">${i + 1}</span>
        <span class="sb-icon">${icon}</span>
        <select class="sb-type-select" data-idx="${i}">
          ${SEQ_TYPES.map(t => `<option value="${t}" ${t === seq.type ? 'selected' : ''}>${SEQ_TYPE_LABELS[t] || t}</option>`).join('')}
        </select>
        <input type="number" class="sb-duration-input" data-idx="${i}" value="${seq.durationSec || 5}" min="1" max="30" title="Duration (seconds)">
        <span class="sb-duration-unit">s</span>
        <select class="sb-transition-select" data-idx="${i}" title="Transition">
          ${TRANSITION_TYPES.map(t => `<option value="${t}" ${t === (seq.transitionIn || 'cut') ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <div class="sb-card-actions">
          <button class="sb-move-btn" data-idx="${i}" data-dir="up" title="Move up" ${i === 0 ? 'disabled' : ''}>&#x25B2;</button>
          <button class="sb-move-btn" data-idx="${i}" data-dir="down" title="Move down" ${i === editableSequences.length - 1 ? 'disabled' : ''}>&#x25BC;</button>
          <button class="sb-delete-btn" data-idx="${i}" title="Delete sequence">&#x2715;</button>
        </div>
      </div>
      <div class="sb-duration-bar">
        <div class="sb-duration-fill" style="width: ${durationPct}%"></div>
      </div>
    `;

    // ── Type-specific editable fields ──
    let fieldsHtml = '';

    if (seq.type === 'dialogue' || seq.type === 'dm_description') {
      // Speaker
      if (seq.type === 'dialogue') {
        fieldsHtml += `
          <div class="sb-field">
            <label>Speaker</label>
            <input type="text" class="sb-input sb-speaker-input" data-idx="${i}" data-field="speaker" value="${esc(seq.speaker || '')}" placeholder="Character name">
          </div>`;
      } else {
        fieldsHtml += `<div class="sb-speaker sb-narrator">Narrator (DM)</div>`;
      }

      // Dialogue lines
      fieldsHtml += `<div class="sb-field"><label>Dialogue Lines</label><div class="sb-dialogue-editor" data-idx="${i}">`;
      if (seq.dialogueLines && seq.dialogueLines.length > 0) {
        seq.dialogueLines.forEach((line, li) => {
          fieldsHtml += `
            <div class="sb-dialogue-row">
              <input type="text" class="sb-input sb-dialogue-text" data-idx="${i}" data-line="${li}" value="${esc(line.text || '')}" placeholder="Dialogue text">
              <input type="number" class="sb-cue-id" data-idx="${i}" data-line="${li}" value="${line.cueId || ''}" placeholder="Cue#" title="Cue ID from transcript">
              <button class="sb-remove-line-btn" data-idx="${i}" data-line="${li}" title="Remove line">&#x2715;</button>
            </div>`;
        });
      }
      fieldsHtml += `<button class="btn-small sb-add-line-btn" data-idx="${i}">+ Add Line</button></div></div>`;

      // Background
      if (seq.reuseBackgroundFrom) {
        fieldsHtml += `
          <div class="sb-field sb-reuse-indicator">
            <label>Background <span class="sb-reuse-tag">reused from seq ${seq.reuseBackgroundFrom}</span></label>
            <button class="btn-small sb-unreuse-btn" data-idx="${i}">Write New Description</button>
          </div>`;
      } else {
        fieldsHtml += `
          <div class="sb-field">
            <label>Background Description</label>
            <textarea class="sb-textarea" data-idx="${i}" data-field="backgroundDescription" rows="2" placeholder="Scene background...">${esc(seq.backgroundDescription || '')}</textarea>
          </div>`;
      }

      // Portrait (not for DM — auto-generated)
      if (seq.type === 'dialogue') {
        fieldsHtml += `
          <div class="sb-field">
            <label>Portrait Description</label>
            <textarea class="sb-textarea" data-idx="${i}" data-field="portraitDescription" rows="2" placeholder="Character appearance, expression...">${esc(seq.portraitDescription || '')}</textarea>
          </div>`;
      }

    } else if (seq.type === 'close_up') {
      fieldsHtml += `
        <div class="sb-field">
          <label>Action Description (frame-by-frame)</label>
          <textarea class="sb-textarea" data-idx="${i}" data-field="actionDescription" rows="3" placeholder="Frame 1: ... Frame 2: ... Frame 3: ...">${esc(seq.actionDescription || '')}</textarea>
        </div>
        <div class="sb-field sb-inline-fields">
          <div>
            <label>Frames</label>
            <input type="number" class="sb-input sb-frame-count" data-idx="${i}" value="${seq.frameCount || 3}" min="3" max="5">
          </div>
          <div>
            <label>Bounce</label>
            <input type="checkbox" class="sb-bounce-check" data-idx="${i}" ${seq.bounceMode !== false ? 'checked' : ''}>
          </div>
        </div>`;

      // Reference image upload
      fieldsHtml += `
        <div class="sb-field">
          <label>Reference Image <span class="optional">(optional)</span></label>
          <div class="sb-ref-upload">
            <input type="file" class="sb-ref-file" data-idx="${i}" accept="image/*">
            ${seq._refImagePreview ? `<img src="${seq._refImagePreview}" class="sb-ref-preview">` : ''}
          </div>
        </div>`;

    } else if (seq.type === 'establishing_shot') {
      fieldsHtml += `
        <div class="sb-field">
          <label>Background Description</label>
          <textarea class="sb-textarea" data-idx="${i}" data-field="backgroundDescription" rows="3" placeholder="Describe the establishing shot scene...">${esc(seq.backgroundDescription || '')}</textarea>
        </div>`;

      // Reference image upload
      fieldsHtml += `
        <div class="sb-field">
          <label>Reference Image <span class="optional">(optional)</span></label>
          <div class="sb-ref-upload">
            <input type="file" class="sb-ref-file" data-idx="${i}" accept="image/*">
            ${seq._refImagePreview ? `<img src="${seq._refImagePreview}" class="sb-ref-preview">` : ''}
          </div>
        </div>`;

    } else if (seq.type === 'impact') {
      fieldsHtml += `
        <div class="sb-field sb-inline-fields">
          <div>
            <label>Effect</label>
            <select class="sb-effect-select" data-idx="${i}">
              ${IMPACT_EFFECTS.map(e => `<option value="${e}" ${e === (seq.effectName || 'flash_white') ? 'selected' : ''}>${e.replace(/_/g, ' ')}</option>`).join('')}
            </select>
          </div>
          <div class="sb-custom-text-wrap" style="display: ${(seq.effectName === 'custom' || seq.effectName === 'comic_bam') ? '' : 'none'}">
            <label>Text</label>
            <input type="text" class="sb-input sb-custom-text" data-idx="${i}" value="${esc(seq.customText || '')}" placeholder="BAM!">
          </div>
        </div>`;
    }

    // ── Background Mood (for types that use backgrounds) ──
    if (['dialogue', 'dm_description', 'establishing_shot', 'close_up'].includes(seq.type)) {
      fieldsHtml += `
        <div class="sb-field">
          <label>Background Mood</label>
          <select class="sb-mood-select" data-idx="${i}">
            ${['dark', 'tense', 'mysterious', 'heroic', 'calm', 'sad', 'neutral'].map(m =>
              `<option value="${m}" ${m === (seq.backgroundMood || 'neutral') ? 'selected' : ''}>${m}</option>`
            ).join('')}
          </select>
        </div>`;
    }

    // ── Visual Notes ──
    fieldsHtml += `
      <div class="sb-field">
        <label>Style / Visual Notes</label>
        <textarea class="sb-textarea sb-visual-notes-input" data-idx="${i}" data-field="visualNotes" rows="1" placeholder="Palette, lighting, consistency notes...">${esc(seq.visualNotes || '')}</textarea>
      </div>`;

    // ── User Notes ──
    fieldsHtml += `
      <div class="sb-field">
        <label>Your Notes <span class="optional">(passed to generation)</span></label>
        <textarea class="sb-textarea sb-user-notes" data-idx="${i}" data-field="userNotes" rows="1" placeholder="Extra context, reminders, instructions...">${esc(seq.userNotes || '')}</textarea>
      </div>`;

    card.innerHTML = headerHtml + `<div class="sb-card-fields">${fieldsHtml}</div>`;
    container.appendChild(card);
  });

  // Bind events
  bindStoryboardEvents();
}

function bindStoryboardEvents() {
  // Type change
  document.querySelectorAll('.sb-type-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const newType = e.target.value;
      const seq = editableSequences[idx];

      // Preserve shared fields, clear type-specific ones
      seq.type = newType;

      // Set sensible defaults for new type
      if (newType === 'impact' && !seq.effectName) seq.effectName = 'flash_white';
      if (newType === 'close_up' && !seq.frameCount) seq.frameCount = 3;
      if (newType === 'close_up' && seq.bounceMode === undefined) seq.bounceMode = true;
      if (newType === 'dialogue' && !seq.speaker) seq.speaker = '';
      if (newType === 'dialogue' && !seq.dialogueLines) seq.dialogueLines = [{ text: '', cueId: null }];
      if (newType === 'dm_description' && !seq.dialogueLines) seq.dialogueLines = [{ text: '', cueId: null }];
      if (newType === 'impact') {
        seq.durationSec = Math.min(seq.durationSec || 1, 2);
      }

      renderSequenceCards();
      renderSummary();
    });
  });

  // Duration change
  document.querySelectorAll('.sb-duration-input').forEach(el => {
    el.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      editableSequences[idx].durationSec = parseInt(e.target.value) || 5;
      renderSummary();
    });
  });

  // Transition change
  document.querySelectorAll('.sb-transition-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      editableSequences[idx].transitionIn = e.target.value;
    });
  });

  // Text inputs — speaker
  document.querySelectorAll('.sb-speaker-input').forEach(el => {
    el.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      editableSequences[idx].speaker = e.target.value;
    });
  });

  // Text areas — generic field binding
  document.querySelectorAll('.sb-textarea[data-field]').forEach(el => {
    el.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const field = e.target.dataset.field;
      editableSequences[idx][field] = e.target.value;
    });
  });

  // Dialogue text inputs
  document.querySelectorAll('.sb-dialogue-text').forEach(el => {
    el.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const li = parseInt(e.target.dataset.line);
      if (editableSequences[idx].dialogueLines && editableSequences[idx].dialogueLines[li]) {
        editableSequences[idx].dialogueLines[li].text = e.target.value;
      }
    });
  });

  // Cue ID inputs
  document.querySelectorAll('.sb-cue-id').forEach(el => {
    el.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const li = parseInt(e.target.dataset.line);
      if (editableSequences[idx].dialogueLines && editableSequences[idx].dialogueLines[li]) {
        editableSequences[idx].dialogueLines[li].cueId = parseInt(e.target.value) || null;
      }
    });
  });

  // Add dialogue line
  document.querySelectorAll('.sb-add-line-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      if (!editableSequences[idx].dialogueLines) editableSequences[idx].dialogueLines = [];
      editableSequences[idx].dialogueLines.push({ text: '', cueId: null });
      renderSequenceCards();
      renderSummary();
    });
  });

  // Remove dialogue line
  document.querySelectorAll('.sb-remove-line-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const li = parseInt(e.target.dataset.line);
      if (editableSequences[idx].dialogueLines) {
        editableSequences[idx].dialogueLines.splice(li, 1);
      }
      renderSequenceCards();
      renderSummary();
    });
  });

  // Frame count
  document.querySelectorAll('.sb-frame-count').forEach(el => {
    el.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      editableSequences[idx].frameCount = parseInt(e.target.value) || 3;
      renderSummary();
    });
  });

  // Bounce mode
  document.querySelectorAll('.sb-bounce-check').forEach(el => {
    el.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      editableSequences[idx].bounceMode = e.target.checked;
    });
  });

  // Impact effect
  document.querySelectorAll('.sb-effect-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      editableSequences[idx].effectName = e.target.value;
      // Show/hide custom text
      const wrap = e.target.closest('.sb-inline-fields').querySelector('.sb-custom-text-wrap');
      if (wrap) {
        wrap.style.display = (e.target.value === 'custom' || e.target.value === 'comic_bam') ? '' : 'none';
      }
    });
  });

  // Custom text
  document.querySelectorAll('.sb-custom-text').forEach(el => {
    el.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      editableSequences[idx].customText = e.target.value;
    });
  });

  // Background mood
  document.querySelectorAll('.sb-mood-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      editableSequences[idx].backgroundMood = e.target.value;
    });
  });

  // Move up/down
  document.querySelectorAll('.sb-move-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const dir = e.target.dataset.dir;
      const targetIdx = dir === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= editableSequences.length) return;
      // Swap
      [editableSequences[idx], editableSequences[targetIdx]] = [editableSequences[targetIdx], editableSequences[idx]];
      renderSequenceCards();
      renderSummary();
    });
  });

  // Delete
  document.querySelectorAll('.sb-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      if (editableSequences.length <= 1) return; // must keep at least 1
      editableSequences.splice(idx, 1);
      renderSequenceCards();
      renderSummary();
    });
  });

  // Unreuse background (switch from reuse to custom description)
  document.querySelectorAll('.sb-unreuse-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      delete editableSequences[idx].reuseBackgroundFrom;
      editableSequences[idx].backgroundDescription = editableSequences[idx].backgroundDescription || '';
      renderSequenceCards();
    });
  });

  // Reference image upload
  document.querySelectorAll('.sb-ref-file').forEach(el => {
    el.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        editableSequences[idx]._refImagePreview = ev.target.result;
        editableSequences[idx].referenceImageBase64 = ev.target.result;
        renderSequenceCards();
      };
      reader.readAsDataURL(file);
    });
  });
}

function renderSummary() {
  const summary = document.getElementById('storyboard-summary');
  const totalDuration = editableSequences.reduce((s, sq) => s + (sq.durationSec || 0), 0);

  // Calculate cost
  const cost = editableSequences.reduce((sum, seq) => {
    if (seq.reuseBackgroundFrom) {
      if (seq.type === 'dialogue' || seq.type === 'dm_description') return sum + 0.12;
    }
    if (seq.type === 'dialogue' || seq.type === 'dm_description') return sum + 0.16;
    if (seq.type === 'close_up') return sum + 0.04 * (seq.frameCount || 3);
    if (seq.type === 'establishing_shot') return sum + 0.04;
    return sum;
  }, 0);

  summary.innerHTML = `
    <div class="sb-summary-row">
      <span>Total Duration</span>
      <strong>${totalDuration}s</strong>
    </div>
    <div class="sb-summary-row">
      <span>Sequences</span>
      <strong>${editableSequences.length}</strong>
    </div>
    <div class="sb-summary-row">
      <span>Estimated Cost</span>
      <strong>~$${cost.toFixed(2)}</strong>
    </div>
  `;
}

// Add sequence button
document.getElementById('add-sequence-btn').addEventListener('click', () => {
  editableSequences.push({
    type: 'dialogue',
    durationSec: 8,
    speaker: '',
    dialogueLines: [{ text: '', cueId: null }],
    backgroundDescription: '',
    portraitDescription: '',
    backgroundMood: 'neutral',
    visualNotes: '',
    transitionIn: 'cut',
    userNotes: '',
  });
  renderSequenceCards();
  renderSummary();
  // Scroll to new card
  const container = document.getElementById('storyboard-sequences');
  const lastCard = container.lastElementChild;
  if (lastCard) lastCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// Approve storyboard → save edits → start generation
document.getElementById('approve-storyboard-btn').addEventListener('click', async () => {
  if (!currentSessionId) return;
  const btn = document.getElementById('approve-storyboard-btn');
  btn.disabled = true;
  btn.textContent = 'Saving & starting...';

  try {
    // Step 1: Save edited storyboard
    const saveRes = await fetch(`/api/sessions/${currentSessionId}/storyboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sequences: editableSequences }),
    });
    const saveData = await saveRes.json();
    if (!saveRes.ok) {
      alert(`Save failed: ${saveData.error}`);
      btn.disabled = false;
      btn.textContent = 'Save & Generate';
      return;
    }

    // Step 2: Start generation
    const res = await fetch(`/api/sessions/${currentSessionId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        momentIndex: selectedMomentIndex,
        direction: document.getElementById('direction-text').value,
      }),
    });
    const data = await res.json();

    if (res.ok) {
      showScreen('generating');
      startPolling();
    } else {
      alert(`Error: ${data.error}`);
      btn.disabled = false;
      btn.textContent = 'Save & Generate';
    }
  } catch (err) {
    alert(`Failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Save & Generate';
  }
});

// Re-plan with different direction
document.getElementById('replan-btn').addEventListener('click', () => {
  // Go back to moment selector with direction editable
  const btn = document.getElementById('generate-btn');
  btn.disabled = selectedMomentIndex === null;
  btn.textContent = 'Plan Sequences';

  if (cachedSession) {
    showScreen('plan');
    renderMoments(cachedSession);
    setTimeout(() => document.getElementById('direction-text').focus(), 100);
  } else {
    startPolling();
  }
});

// Back to moments
document.getElementById('back-to-moments-btn').addEventListener('click', () => {
  const btn = document.getElementById('generate-btn');
  btn.disabled = selectedMomentIndex === null;
  btn.textContent = 'Plan Sequences';

  if (cachedSession) {
    showScreen('plan');
    renderMoments(cachedSession);
  } else {
    startPolling();
  }
});

// ── Results (Screen 5) ──

function renderResults(session) {
  const preview = document.getElementById('result-preview');
  const assets = document.getElementById('result-assets');
  preview.innerHTML = '';
  assets.innerHTML = '';

  const gen = session.generation;
  if (!gen || !gen.export) return;

  const files = gen.export.files || {};
  const seqFiles = gen.export.sequenceFiles || [];

  // ── Preview: Use playerHtml for multi-sequence, or html for legacy ──
  const previewFile = files.playerHtml || files.html;
  if (previewFile) {
    const relPath = previewFile.replace(/.*output\//, '/output/');
    preview.innerHTML = `
      <div class="preview-container">
        <iframe class="scene-preview-frame" src="${relPath}" sandbox="allow-scripts"></iframe>
      </div>
    `;
  }

  // ── Per-sequence MP4 downloads ──
  let downloadHtml = '';

  if (seqFiles.length > 0) {
    downloadHtml += '<h3>Sequence Videos</h3><div class="asset-grid">';
    seqFiles.forEach((sf, i) => {
      if (sf.mp4) {
        const relPath = sf.mp4.replace(/.*output\//, '/output/');
        const label = sf.speaker
          ? `${i + 1}. ${sf.speaker}`
          : `${i + 1}. ${(sf.type || 'scene').replace(/_/g, ' ')}`;
        downloadHtml += `<a class="asset-card" href="${relPath}" download>
          <div class="asset-icon">MP4</div>
          <div class="asset-label">${esc(label)}</div>
        </a>`;
      }
    });
    downloadHtml += '</div>';
  }

  // ── Other assets ──
  downloadHtml += '<h3>Other Assets</h3><div class="asset-grid">';

  if (files.mp4) {
    const relPath = files.mp4.replace(/.*output\//, '/output/');
    downloadHtml += `<a class="asset-card" href="${relPath}" download>
      <div class="asset-icon">MP4</div>
      <div class="asset-label">Combined Video</div>
    </a>`;
  }
  if (files.gif) {
    const relPath = files.gif.replace(/.*output\//, '/output/');
    downloadHtml += `<a class="asset-card" href="${relPath}" download>
      <div class="asset-icon">GIF</div>
      <div class="asset-label">Animation</div>
    </a>`;
  }
  if (files.playerHtml) {
    const relPath = files.playerHtml.replace(/.*output\//, '/output/');
    downloadHtml += `<a class="asset-card" href="${relPath}" download>
      <div class="asset-icon">HTML</div>
      <div class="asset-label">Full Scene</div>
    </a>`;
  } else if (files.html) {
    const relPath = files.html.replace(/.*output\//, '/output/');
    downloadHtml += `<a class="asset-card" href="${relPath}" download>
      <div class="asset-icon">HTML</div>
      <div class="asset-label">Interactive</div>
    </a>`;
  }

  // Legacy single-scene assets
  if (files.portraitPng) {
    const relPath = files.portraitPng.replace(/.*output\//, '/output/');
    downloadHtml += `<a class="asset-card" href="${relPath}" download>
      <div class="asset-icon">PNG</div>
      <div class="asset-label">Portrait</div>
    </a>`;
  }
  if (files.backgroundPng) {
    const relPath = files.backgroundPng.replace(/.*output\//, '/output/');
    downloadHtml += `<a class="asset-card" href="${relPath}" download>
      <div class="asset-icon">PNG</div>
      <div class="asset-label">Background</div>
    </a>`;
  }
  if (files.mouthVariantPngs && files.mouthVariantPngs.length > 0) {
    for (let i = 0; i < files.mouthVariantPngs.length; i++) {
      const relPath = files.mouthVariantPngs[i].replace(/.*output\//, '/output/');
      downloadHtml += `<a class="asset-card" href="${relPath}" download>
        <div class="asset-icon">PNG</div>
        <div class="asset-label">Mouth ${i + 1}</div>
      </a>`;
    }
  }

  downloadHtml += '</div>';
  assets.innerHTML = downloadHtml;

  // ── Multi-sequence breakdown ──
  if (gen.sequences && Array.isArray(gen.sequences) && gen.sequences.length > 0) {
    let seqHtml = '<h3 style="margin-top: 24px">Sequences</h3><div class="result-sequences">';
    gen.sequences.forEach((sq, i) => {
      const icon = SEQ_TYPE_ICONS[sq.type] || '\uD83C\uDFAC';
      const typeLabel = SEQ_TYPE_LABELS[sq.type] || sq.type;
      seqHtml += `
        <div class="result-seq-card">
          <span class="result-seq-num">${i + 1}</span>
          <span class="result-seq-icon">${icon}</span>
          <span class="result-seq-type">${typeLabel}</span>
          ${sq.speaker ? `<span class="result-seq-speaker">${esc(sq.speaker)}</span>` : ''}
          <span class="result-seq-cost">$${(sq.cost || 0).toFixed(2)}</span>
          <button class="btn-rerun" data-seq-index="${i}">Rerun</button>
        </div>
      `;
    });
    seqHtml += '</div>';
    assets.innerHTML += seqHtml;
  }

  // Cost summary
  if (gen.totalCost) {
    const costDiv = document.createElement('div');
    costDiv.className = 'result-cost';
    costDiv.textContent = `Total cost: ~$${gen.totalCost.toFixed(2)}`;
    assets.appendChild(costDiv);
  }
}

// ── Cancel Generation ──

document.getElementById('cancel-gen-btn').addEventListener('click', async () => {
  if (!currentSessionId) return;

  const btn = document.getElementById('cancel-gen-btn');
  btn.disabled = true;
  btn.textContent = 'Cancelling...';

  try {
    await fetch(`/api/sessions/${currentSessionId}/cancel`, { method: 'POST' });
    // Polling will detect plan_ready and switch to moment selector
  } catch (err) {
    console.error('Cancel failed:', err);
    btn.disabled = false;
    btn.textContent = 'Cancel Generation';
  }
});

// ── Edit Direction & Regenerate ──

document.getElementById('edit-regen-btn').addEventListener('click', () => {
  // Return to moment selector with same moment selected and direction preserved
  const btn = document.getElementById('generate-btn');
  btn.disabled = selectedMomentIndex === null;
  btn.textContent = 'Plan Sequences';

  // Clear generating step thumbnails
  document.querySelectorAll('.gen-step-thumb').forEach(el => {
    el.innerHTML = '';
    delete el.dataset.loaded;
  });

  if (cachedSession) {
    showScreen('plan');
    renderMoments(cachedSession);
    // Focus the direction textarea for editing
    setTimeout(() => document.getElementById('direction-text').focus(), 100);
  } else {
    startPolling();
  }
});

// ── Pick Another Moment ──

document.getElementById('pick-another-btn').addEventListener('click', () => {
  // Reset generation-related state but keep session and direction
  const btn = document.getElementById('generate-btn');
  btn.disabled = selectedMomentIndex === null;
  btn.textContent = 'Plan Sequences';

  // Clear generating step thumbnails
  document.querySelectorAll('.gen-step-thumb').forEach(el => {
    el.innerHTML = '';
    delete el.dataset.loaded;
  });

  if (cachedSession) {
    showScreen('plan');
    renderMoments(cachedSession);
  } else {
    // Re-fetch
    startPolling();
  }
});

// ── Download All ──

document.getElementById('download-btn').addEventListener('click', () => {
  window.location.href = `/api/sessions/${currentSessionId}/download`;
});

// ── New Session ──

document.getElementById('new-session-btn').addEventListener('click', () => {
  currentSessionId = null;
  selectedFile = null;
  selectedMomentIndex = null;
  cachedSession = null;
  dropZone.classList.remove('has-file');
  dropZone.querySelector('p').innerHTML = 'Drop your <strong>.vtt</strong> file here';
  dropZone.querySelector('.drop-sub').textContent = 'or click to browse';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Analyze Transcript';
  contextInput.value = '';
  document.getElementById('direction-text').value = '';
  showScreen('upload');
  loadRecentSessions();
});

// ── Rerun Sequence ──

let rerunSeqIndex = null;

// Event delegation for rerun buttons on sequence cards
document.getElementById('result-assets').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-rerun');
  if (!btn) return;
  rerunSeqIndex = parseInt(btn.dataset.seqIndex);
  openRerunModal(rerunSeqIndex);
});

function openRerunModal(seqIndex) {
  const modal = document.getElementById('rerun-modal');
  document.getElementById('rerun-seq-num').textContent = `#${seqIndex + 1}`;

  // Build description from cached session
  const gen = cachedSession?.generation;
  if (gen?.sequences?.[seqIndex]) {
    const sq = gen.sequences[seqIndex];
    const typeLabel = SEQ_TYPE_LABELS[sq.type] || sq.type;
    const desc = sq.speaker ? `${typeLabel} — ${sq.speaker}` : typeLabel;
    document.getElementById('rerun-seq-desc').textContent = desc;
  } else {
    document.getElementById('rerun-seq-desc').textContent = '';
  }

  // Reset form
  document.querySelector('input[name="rerun-mode"][value="reattempt"]').checked = true;
  document.getElementById('rerun-instructions-text').value = '';

  modal.style.display = 'flex';
}

function closeRerunModal() {
  document.getElementById('rerun-modal').style.display = 'none';
  rerunSeqIndex = null;
}

document.getElementById('rerun-cancel-btn').addEventListener('click', closeRerunModal);
document.querySelector('.modal-overlay').addEventListener('click', closeRerunModal);

document.getElementById('rerun-submit-btn').addEventListener('click', async () => {
  if (rerunSeqIndex === null || !currentSessionId) return;

  const mode = document.querySelector('input[name="rerun-mode"]:checked').value;
  const instructions = document.getElementById('rerun-instructions-text').value.trim();

  closeRerunModal();

  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/sequences/${rerunSeqIndex}/rerun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, instructions }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(`Rerun failed: ${err.error}`);
      return;
    }

    showScreen('generating');
    startPolling();
  } catch (err) {
    alert(`Rerun failed: ${err.message}`);
  }
});

function renderRerunProgress(session) {
  const container = document.getElementById('gen-sequences');
  const rerun = session.rerun || {};
  const seqIdx = rerun.sequenceIndex ?? '?';
  const gen = session.generation;
  const sq = gen?.sequences?.[seqIdx];
  const typeLabel = sq ? (SEQ_TYPE_LABELS[sq.type] || sq.type) : '';
  const speaker = sq?.speaker || '';

  let statusText = 'Starting...';
  let statusIcon = '\u23F3';
  switch (rerun.status) {
    case 'rewriting': statusText = 'Director AI rewriting descriptions...'; statusIcon = '\uD83D\uDCDD'; break;
    case 'generating': statusText = 'Generating new assets...'; statusIcon = '\uD83C\uDFA8'; break;
    case 'assembling': statusText = 'Rebuilding sequence player...'; statusIcon = '\uD83D\uDD27'; break;
    case 'exporting': statusText = 'Exporting video...'; statusIcon = '\uD83C\uDFAC'; break;
    case 'complete': statusText = 'Complete!'; statusIcon = '\u2705'; break;
    case 'failed': statusText = `Failed: ${rerun.error || 'Unknown error'}`; statusIcon = '\u274C'; break;
  }

  container.innerHTML = `
    <div class="rerun-progress">
      <h3>Rerunning Sequence ${seqIdx + 1}</h3>
      <p class="rerun-detail">${typeLabel}${speaker ? ` — ${speaker}` : ''} (${rerun.mode === 'rewrite' ? 'Rewrite' : 'Re-attempt'})</p>
      <div class="rerun-status">${statusIcon} ${statusText}</div>
    </div>
  `;

  document.getElementById('gen-message').textContent = session.progress?.message || '';
  document.getElementById('gen-cost').textContent = '';

  // Update progress bar
  const pct = session.progress?.percent || 0;
  const bar = document.getElementById('gen-progress');
  if (bar) bar.style.width = pct + '%';

  // Show the sequences container and hide cancel button during rerun
  const seqContainer = document.getElementById('gen-sequences');
  if (seqContainer) seqContainer.style.display = 'block';
}

// ── Recent Sessions ──

async function loadRecentSessions() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();

    const container = document.getElementById('sessions-list');
    if (sessions.length === 0) {
      container.innerHTML = '<p style="color:var(--text-dim);font-size:0.8rem">No sessions yet</p>';
      return;
    }

    container.innerHTML = sessions.slice(0, 5).map(s => `
      <div class="session-item" onclick="resumeSession('${s.id}')">
        <div>
          <span style="font-size:0.85rem">${s.id}</span>
          <span style="font-size:0.75rem;color:var(--text-dim);margin-left:8px">${new Date(s.createdAt).toLocaleString()}</span>
        </div>
        <span class="session-stage stage-${s.stage}">${s.stage.replace('_', ' ')}</span>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

window.resumeSession = function(id) {
  currentSessionId = id;
  startPolling();
};

// ── Helpers ──

function pad(n) { return String(n).padStart(2, '0'); }

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ═══════════════════════════════════════
// Tab Navigation System
// ═══════════════════════════════════════

function switchTab(tabName) {
  // Toggle tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Toggle tab panels
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });

  // Lazy-load tab data
  if (tabName === 'sessions') loadAllSessions();
  if (tabName === 'cards') loadKnowledgeBase();
}

// Bind tab buttons
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ═══════════════════════════════════════
// Sessions Tab
// ═══════════════════════════════════════

let allSessionsCache = null;

async function loadAllSessions() {
  const container = document.getElementById('all-sessions-list');
  if (!container) return;

  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    allSessionsCache = sessions;
    renderAllSessions(sessions);
  } catch (err) {
    container.innerHTML = `<p class="cards-empty">Failed to load sessions: ${err.message}</p>`;
  }
}

function renderAllSessions(sessions) {
  const container = document.getElementById('all-sessions-list');
  container.innerHTML = '';

  if (!sessions || sessions.length === 0) {
    container.innerHTML = '<p class="cards-empty">No sessions yet. Upload a VTT in the Factory tab to get started.</p>';
    return;
  }

  // Sort newest first
  const sorted = [...sessions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  sorted.forEach(s => {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.id = `session-row-${s.id}`;

    // Info
    const dateStr = new Date(s.createdAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const model = s.analysisModel ? s.analysisModel.replace('claude-', '').split('-')[0] : '';
    const momentTitle = s.momentTitle || s.id;
    const cost = s.totalCost ? `$${s.totalCost.toFixed(2)}` : '';

    // Stage badge
    const stage = s.stage || 'unknown';
    const stageColors = {
      complete: 'background:rgba(61,220,132,0.15);color:var(--success)',
      plan_ready: 'background:rgba(255,170,0,0.15);color:var(--warning)',
      storyboard_ready: 'background:rgba(255,170,0,0.15);color:var(--warning)',
      analyzing: 'background:rgba(200,160,48,0.15);color:var(--accent)',
      generating: 'background:rgba(200,160,48,0.15);color:var(--accent)',
      exporting: 'background:rgba(200,160,48,0.15);color:var(--accent)',
      failed: 'background:rgba(255,68,68,0.15);color:var(--error)',
    };
    const stageStyle = stageColors[stage] || 'background:rgba(255,255,255,0.05);color:var(--text-dim)';

    row.innerHTML = `
      <div class="session-row-info">
        <div class="session-row-title">${esc(momentTitle)}</div>
        <div class="session-row-meta">
          <span>${dateStr}</span>
          ${model ? `<span>${esc(model)}</span>` : ''}
          ${cost ? `<span>${cost}</span>` : ''}
        </div>
      </div>
      <span class="session-row-stage" style="${stageStyle}">${stage.replace(/_/g, ' ')}</span>
      <div class="session-row-actions">
        <button class="btn-small" onclick="resumeFromSessions('${s.id}')">Resume</button>
        ${stage === 'complete' ? `<button class="btn-small" onclick="downloadSession('${s.id}')">Download</button>` : ''}
        <button class="btn-small btn-danger" onclick="hideSession('${s.id}')">Hide</button>
      </div>
    `;

    container.appendChild(row);
  });
}

window.resumeFromSessions = function(id) {
  currentSessionId = id;
  switchTab('factory');
  startPolling();
};

window.downloadSession = function(id) {
  window.location.href = `/api/sessions/${id}/download`;
};

window.hideSession = async function(id) {
  try {
    const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (res.ok) {
      const row = document.getElementById(`session-row-${id}`);
      if (row) row.remove();
    } else {
      const err = await res.json();
      alert(`Failed: ${err.error}`);
    }
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
};

// ═══════════════════════════════════════
// Cards Tab (Knowledge Base)
// ═══════════════════════════════════════

let knowledgeCache = null;
let activeCardsSection = 'characters';

async function loadKnowledgeBase() {
  try {
    const res = await fetch('/api/knowledge');
    if (!res.ok) throw new Error('Failed to load knowledge base');
    knowledgeCache = await res.json();
    renderCardsSection(activeCardsSection);
  } catch (err) {
    const container = document.getElementById('cards-content');
    if (container) container.innerHTML = `<p class="cards-empty">Failed to load knowledge base: ${err.message}</p>`;
  }
}

// Sub-nav click
document.querySelectorAll('.cards-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeCardsSection = btn.dataset.section;
    document.querySelectorAll('.cards-nav-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderCardsSection(activeCardsSection);
  });
});

function renderCardsSection(section) {
  const container = document.getElementById('cards-content');
  if (!container || !knowledgeCache) return;
  container.innerHTML = '';

  switch (section) {
    case 'characters':
      renderEntityCards(container, filterEntities('pc'), 'character');
      break;
    case 'npcs':
      renderEntityCards(container, filterEntities('npc', 'creature', 'monster'), 'npc');
      break;
    case 'locations':
      renderEntityCards(container, filterEntities('location', 'place'), 'location');
      break;
    case 'portraits':
      renderPortraitGallery(container);
      break;
    case 'backgrounds':
      renderBackgroundGallery(container);
      break;
  }
}

function filterEntities(...types) {
  if (!knowledgeCache || !knowledgeCache.entities) return [];
  return knowledgeCache.entities.filter(e => {
    const t = (e.type || '').toLowerCase();
    return types.some(tp => t.includes(tp));
  });
}

function renderEntityCards(container, entities, section) {
  if (!entities || entities.length === 0) {
    container.innerHTML = `<p class="cards-empty">No ${section}s found in the knowledge base yet. Run an analysis to discover them.</p>`;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'entity-cards-grid';

  entities.forEach(entity => {
    const card = document.createElement('div');
    card.className = 'entity-card';

    // Color dot
    const color = entity.color || '#666';

    // Tags
    let tagsHtml = '';
    if (entity.tags && entity.tags.length > 0) {
      tagsHtml = `<div class="entity-tags">${entity.tags.map(t => `<span class="entity-tag">${esc(t)}</span>`).join('')}</div>`;
    }

    // Signature items
    let itemsHtml = '';
    if (entity.signatureItems && entity.signatureItems.length > 0) {
      itemsHtml = `<div class="entity-field-label">Signature Items</div><ul class="entity-items">${entity.signatureItems.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
    }

    // Key abilities
    let abilitiesHtml = '';
    if (entity.keyAbilities && entity.keyAbilities.length > 0) {
      abilitiesHtml = `<div class="entity-field-label">Key Abilities</div><ul class="entity-abilities">${entity.keyAbilities.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`;
    }

    // Conditional features
    let condHtml = '';
    if (entity.conditionalFeatures && entity.conditionalFeatures.length > 0) {
      condHtml = `<div class="entity-field-label">Conditional Features</div><div class="entity-field">${entity.conditionalFeatures.map(c => esc(c)).join('; ')}</div>`;
    }

    // Inline portrait thumbnail
    let portraitThumb = '';
    const portrait = findPortraitForEntity(entity.name);
    if (portrait) {
      const thumbSrc = portrait.imagePath ? `/${portrait.imagePath}` : `/data/portraits/${portrait.filename || portrait.id + '.png'}`;
      portraitThumb = `<img src="${thumbSrc}" class="entity-portrait-thumb" alt="${esc(entity.name)}" onerror="this.style.display='none'">`;
    }

    card.innerHTML = `
      <div class="entity-card-header">
        <div class="entity-color-dot" style="background:${esc(color)}"></div>
        <div class="entity-card-name">${esc(entity.name)}</div>
        ${portraitThumb}
        <span class="entity-card-type">${esc(entity.type || section)}</span>
      </div>
      <div class="entity-card-body">
        ${entity.visualDescription ? `
          <div>
            <div class="entity-field-label">Visual Description</div>
            <div class="entity-field entity-field-editable" data-entity-id="${esc(entity.id)}" data-field="visualDescription" onclick="startEntityEdit(this)">${esc(entity.visualDescription)}</div>
          </div>
        ` : ''}
        ${condHtml}
        ${itemsHtml}
        ${abilitiesHtml}
        ${tagsHtml}
      </div>
    `;

    grid.appendChild(card);
  });

  container.appendChild(grid);
}

function findPortraitForEntity(name) {
  if (!knowledgeCache || !knowledgeCache.portraits) return null;
  const nameLower = name.toLowerCase();
  const matches = knowledgeCache.portraits.filter(p => {
    const entityMatch = (p.entityName && p.entityName.toLowerCase() === nameLower) ||
                        (p.entityId && p.entityId.toLowerCase() === nameLower);
    return entityMatch && p.rating !== 'bad';
  });
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

// ── Inline Entity Editing ──

window.startEntityEdit = function(el) {
  const entityId = el.dataset.entityId;
  const field = el.dataset.field;
  const currentValue = el.textContent;

  el.outerHTML = `
    <div class="entity-edit-area" data-entity-id="${esc(entityId)}" data-field="${esc(field)}">
      <textarea class="sb-textarea">${esc(currentValue)}</textarea>
      <div class="entity-edit-actions">
        <button class="btn-small" onclick="saveEntityEdit(this)">Save</button>
        <button class="btn-small" onclick="cancelEntityEdit(this, '${esc(currentValue).replace(/'/g, "\\'")}')">Cancel</button>
      </div>
    </div>
  `;
};

window.saveEntityEdit = async function(btn) {
  const area = btn.closest('.entity-edit-area');
  const entityId = area.dataset.entityId;
  const field = area.dataset.field;
  const newValue = area.querySelector('textarea').value;

  try {
    const res = await fetch(`/api/knowledge/characters/${entityId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: newValue }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(`Save failed: ${err.error}`);
      return;
    }

    // Update local cache
    if (knowledgeCache && knowledgeCache.entities) {
      const entity = knowledgeCache.entities.find(e => e.id === entityId);
      if (entity) entity[field] = newValue;
    }

    area.outerHTML = `<div class="entity-field entity-field-editable" data-entity-id="${esc(entityId)}" data-field="${esc(field)}" onclick="startEntityEdit(this)">${esc(newValue)}</div>`;
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
};

window.cancelEntityEdit = function(btn, originalValue) {
  const area = btn.closest('.entity-edit-area');
  const entityId = area.dataset.entityId;
  const field = area.dataset.field;
  area.outerHTML = `<div class="entity-field entity-field-editable" data-entity-id="${esc(entityId)}" data-field="${esc(field)}" onclick="startEntityEdit(this)">${originalValue}</div>`;
};

// ── Portrait Gallery ──

function renderPortraitGallery(container) {
  if (!knowledgeCache || !knowledgeCache.portraits || knowledgeCache.portraits.length === 0) {
    container.innerHTML = '<p class="cards-empty">No portraits indexed yet. Generate a scene in the Factory to add portraits.</p>';
    return;
  }

  const gallery = document.createElement('div');
  gallery.className = 'portrait-gallery';

  // Group by entity name (fall back to entityId)
  const groups = {};
  knowledgeCache.portraits.forEach(p => {
    const key = p.entityName || p.entityId || 'Unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  for (const [entityName, portraits] of Object.entries(groups)) {
    const groupDiv = document.createElement('div');
    groupDiv.innerHTML = `<div class="portrait-group-title">${esc(entityName)}</div>`;

    const grid = document.createElement('div');
    grid.className = 'portrait-grid';

    portraits.forEach(p => {
      const card = document.createElement('div');
      card.className = 'portrait-card';
      card.id = `portrait-${p.id}`;

      const goodActive = p.rating === 'good' ? ' active' : '';
      const badActive = p.rating === 'bad' ? ' active' : '';

      const imgSrc = p.imagePath ? `/${p.imagePath}` : `/data/portraits/${p.filename || p.id + '.png'}`;
      card.innerHTML = `
        <img src="${imgSrc}" alt="${esc(entityName)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 1 1%22><rect fill=%22%2312121a%22 width=%221%22 height=%221%22/></svg>'">
        <div class="portrait-card-info">${p.sessionId || p.mood || ''}</div>
        <div class="portrait-rating">
          <button class="portrait-rating-btn rating-good${goodActive}" onclick="ratePortrait('${p.id}', 'good', this)" title="Good — prefer this portrait">👍</button>
          <button class="portrait-rating-btn rating-bad${badActive}" onclick="ratePortrait('${p.id}', 'bad', this)" title="Bad — skip in future">👎</button>
        </div>
      `;

      grid.appendChild(card);
    });

    groupDiv.appendChild(grid);
    gallery.appendChild(groupDiv);
  }

  container.appendChild(gallery);
}

window.ratePortrait = async function(id, rating, btn) {
  // Toggle: if already active, set to null
  const isActive = btn.classList.contains('active');
  const newRating = isActive ? null : rating;

  try {
    const res = await fetch(`/api/knowledge/portraits/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: newRating }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(`Rating failed: ${err.error}`);
      return;
    }

    // Update local cache
    if (knowledgeCache && knowledgeCache.portraits) {
      const p = knowledgeCache.portraits.find(p => p.id === id);
      if (p) p.rating = newRating;
    }

    // Update UI — clear both buttons, set active on the toggled one
    const card = btn.closest('.portrait-rating');
    card.querySelectorAll('.portrait-rating-btn').forEach(b => b.classList.remove('active'));
    if (!isActive) btn.classList.add('active');

  } catch (err) {
    alert(`Rating failed: ${err.message}`);
  }
};

// ── Background Gallery ──

function renderBackgroundGallery(container) {
  if (!knowledgeCache || !knowledgeCache.backgrounds || knowledgeCache.backgrounds.length === 0) {
    container.innerHTML = '<p class="cards-empty">No backgrounds indexed yet. Generate a scene in the Factory to add backgrounds.</p>';
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'bg-gallery';

  knowledgeCache.backgrounds.forEach(bg => {
    const card = document.createElement('div');
    card.className = 'bg-card';
    card.id = `bg-${bg.id}`;

    const goodActive = bg.rating === 'good' ? ' active' : '';
    const badActive = bg.rating === 'bad' ? ' active' : '';

    const bgSrc = bg.imagePath ? `/${bg.imagePath}` : `/data/backgrounds/${bg.filename || bg.id + '.png'}`;
    card.innerHTML = `
      <img src="${bgSrc}" alt="background" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 9%22><rect fill=%22%2312121a%22 width=%2216%22 height=%229%22/></svg>'">
      <div class="bg-card-info">
        ${bg.locationTag ? `<span class="bg-card-tag">${esc(bg.locationTag)}</span>` : ''}
        ${bg.mood ? `<span class="bg-card-mood">${esc(bg.mood)}</span>` : ''}
      </div>
      <div class="portrait-rating">
        <button class="portrait-rating-btn rating-good${goodActive}" onclick="rateBackground('${bg.id}', 'good', this)">👍</button>
        <button class="portrait-rating-btn rating-bad${badActive}" onclick="rateBackground('${bg.id}', 'bad', this)">👎</button>
      </div>
    `;

    grid.appendChild(card);
  });

  container.appendChild(grid);
}

window.rateBackground = async function(id, rating, btn) {
  const isActive = btn.classList.contains('active');
  const newRating = isActive ? null : rating;

  try {
    const res = await fetch(`/api/knowledge/backgrounds/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: newRating }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(`Rating failed: ${err.error}`);
      return;
    }

    // Update local cache
    if (knowledgeCache && knowledgeCache.backgrounds) {
      const bg = knowledgeCache.backgrounds.find(b => b.id === id);
      if (bg) bg.rating = newRating;
    }

    const card = btn.closest('.portrait-rating');
    card.querySelectorAll('.portrait-rating-btn').forEach(b => b.classList.remove('active'));
    if (!isActive) btn.classList.add('active');

  } catch (err) {
    alert(`Rating failed: ${err.message}`);
  }
};

// ── Init ──

loadRecentSessions();
