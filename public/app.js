// ═══════════════════════════════════════
// D&D Shorts Factory — Frontend (Pixel Art Pipeline)
// ═══════════════════════════════════════

let currentSessionId = null;
let pollInterval = null;
let selectedMomentIndex = null;
let cachedSession = null; // cache for returning to plan screen

// ── Screen Navigation ──

function showScreen(name) {
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

    case 'generating':
    case 'exporting':
      showScreen('generating');
      renderGenerating(session);
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
  btn.textContent = 'Starting generation...';

  const direction = document.getElementById('direction-text').value;

  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ momentIndex: selectedMomentIndex, direction }),
    });
    const data = await res.json();

    if (res.ok) {
      showScreen('generating');
      startPolling();
    } else {
      alert(`Error: ${data.error}`);
      btn.disabled = false;
      btn.textContent = 'Generate Pixel Art Scene';
    }
  } catch (err) {
    alert(`Failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Generate Pixel Art Scene';
  }
});

// ── Generating (Screen 4) — Per-asset progress ──

const GEN_STEPS = ['portrait', 'mouthVariants', 'background', 'assembly', 'export'];

function renderGenerating(session) {
  const gen = session.generation;
  if (!gen) {
    // Fallback for ASCII pipeline sessions
    document.getElementById('gen-progress').style.width = session.progress.percent + '%';
    document.getElementById('gen-message').textContent = session.progress.message;
    return;
  }

  // Update each step
  for (const step of GEN_STEPS) {
    const stepEl = document.getElementById(`step-${step}`);
    if (!stepEl) continue;

    const data = gen[step] || {};
    const status = data.status || 'pending';

    // Update step class for styling
    stepEl.className = `gen-step gen-step-${status}`;

    // Update detail text
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

    // Update thumbnail if available
    const thumbEl = document.getElementById(`step-${step}-thumb`);
    if (thumbEl && data.thumbnailBase64 && !thumbEl.dataset.loaded) {
      thumbEl.innerHTML = `<img src="data:image/png;base64,${data.thumbnailBase64}" alt="${step}" />`;
      thumbEl.dataset.loaded = 'true';
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

// ── Results (Screen 5) ──

function renderResults(session) {
  const preview = document.getElementById('result-preview');
  const assets = document.getElementById('result-assets');
  preview.innerHTML = '';
  assets.innerHTML = '';

  const gen = session.generation;

  // Video preview
  if (gen && gen.export && gen.export.files) {
    const files = gen.export.files;

    if (files.html) {
      // Iframe preview of the HTML scene
      const relPath = files.html.replace(/.*output\//, '/output/');
      preview.innerHTML = `
        <div class="preview-container">
          <iframe class="scene-preview-frame" src="${relPath}" sandbox="allow-scripts"></iframe>
        </div>
      `;
    }

    // Asset download grid
    let downloadHtml = '<h3>Download Assets</h3><div class="asset-grid">';

    if (files.mp4) {
      const relPath = files.mp4.replace(/.*output\//, '/output/');
      downloadHtml += `<a class="asset-card" href="${relPath}" download>
        <div class="asset-icon">MP4</div>
        <div class="asset-label">Video</div>
      </a>`;
    }
    if (files.gif) {
      const relPath = files.gif.replace(/.*output\//, '/output/');
      downloadHtml += `<a class="asset-card" href="${relPath}" download>
        <div class="asset-icon">GIF</div>
        <div class="asset-label">Animation</div>
      </a>`;
    }
    if (files.html) {
      const relPath = files.html.replace(/.*output\//, '/output/');
      downloadHtml += `<a class="asset-card" href="${relPath}" download>
        <div class="asset-icon">HTML</div>
        <div class="asset-label">Interactive</div>
      </a>`;
    }
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
  }

  // Cost summary
  if (gen && gen.totalCost) {
    const costDiv = document.createElement('div');
    costDiv.className = 'result-cost';
    costDiv.textContent = `Total cost: ~$${gen.totalCost.toFixed(2)}`;
    assets.appendChild(costDiv);
  }
}

// ── Pick Another Moment ──

document.getElementById('pick-another-btn').addEventListener('click', () => {
  // Reset generation-related state but keep session and direction
  const btn = document.getElementById('generate-btn');
  btn.disabled = selectedMomentIndex === null;
  btn.textContent = 'Generate Pixel Art Scene';

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

// ── Init ──

loadRecentSessions();
