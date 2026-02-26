// ═══════════════════════════════════════
// D&D Shorts Factory — Frontend
// ═══════════════════════════════════════

let currentSessionId = null;
let pollInterval = null;

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
  pollSession(); // immediate first poll
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
      showScreen('plan');
      renderPlan(session);
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

// ── Plan Review (Screen 3) ──

function renderPlan(session) {
  const container = document.getElementById('segments-plan');
  container.innerHTML = '';

  if (!session.segments) return;

  session.segments.forEach((seg, i) => {
    const card = document.createElement('div');
    card.className = 'segment-card';

    const startMin = Math.floor((seg.startTime || 0) / 60);
    const startSec = Math.floor((seg.startTime || 0) % 60);
    const endMin = Math.floor((seg.endTime || 0) / 60);
    const endSec = Math.floor((seg.endTime || 0) % 60);
    const timeStr = `${pad(startMin)}:${pad(startSec)} - ${pad(endMin)}:${pad(endSec)}`;

    card.innerHTML = `
      <div class="segment-header">
        <div class="segment-number">${i + 1}</div>
        <div class="segment-title">${esc(seg.title)}</div>
        <span class="badge badge-${seg.type}">${seg.type.replace('_', ' ')}</span>
      </div>
      <div class="segment-meta">
        <span>${timeStr}</span>
        <span>~${seg.estimatedClipDuration || 20}s clip</span>
        <span class="segment-decision decision-${seg.decision}">${seg.decision}</span>
      </div>
      <div class="segment-description">
        ${esc(seg.emotionalArc || '')}
      </div>
      ${seg.whyItsGood ? `<div class="segment-description" style="color:var(--text-dim)">${esc(seg.whyItsGood)}</div>` : ''}
      <div class="segment-concept">
        <strong>Animation:</strong> ${esc(seg.concept)}
        ${seg.libraryMatch ? `<br><strong>Based on:</strong> ${esc(seg.libraryMatch.name)}` : ''}
        ${seg.reason ? `<br><em style="color:var(--text-dim)">${esc(seg.reason)}</em>` : ''}
      </div>
    `;

    container.appendChild(card);
  });

  if (session.estimatedMinutes) {
    document.getElementById('time-estimate').textContent =
      `Estimated generation time: ~${session.estimatedMinutes} minutes`;
  }
}

// ── Approve ──

document.getElementById('approve-btn').addEventListener('click', async () => {
  const btn = document.getElementById('approve-btn');
  btn.disabled = true;
  btn.textContent = 'Starting generation...';

  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/approve`, { method: 'POST' });
    const data = await res.json();

    if (res.ok) {
      showScreen('generating');
      startPolling();
    } else {
      alert(`Error: ${data.error}`);
      btn.disabled = false;
      btn.textContent = 'Approve All & Generate';
    }
  } catch (err) {
    alert(`Failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Approve All & Generate';
  }
});

// ── Generating (Screen 4) ──

function renderGenerating(session) {
  const container = document.getElementById('segments-progress');
  container.innerHTML = '';

  if (!session.segments) return;

  session.segments.forEach((seg, i) => {
    const card = document.createElement('div');
    card.className = `segment-card`;

    const statusClass = `status-${seg.status}`;
    const statusText = {
      pending: 'Waiting...',
      generating: 'Generating animation...',
      generated: 'Animation ready',
      exporting: 'Exporting video...',
      complete: 'Done!',
      failed: `Failed: ${seg.error || 'unknown'}`,
      export_failed: `Export failed: ${seg.error || 'unknown'}`,
    }[seg.status] || seg.status;

    card.innerHTML = `
      <div class="segment-header">
        <div class="segment-number">${i + 1}</div>
        <div class="segment-title">${esc(seg.title)}</div>
      </div>
      <div class="segment-status ${statusClass}">
        <div class="status-dot"></div>
        <span>${statusText}</span>
      </div>
    `;

    container.appendChild(card);
  });

  document.getElementById('gen-progress').style.width = session.progress.percent + '%';
  document.getElementById('gen-message').textContent = session.progress.message;
}

// ── Results (Screen 5) ──

function renderResults(session) {
  const container = document.getElementById('segments-results');
  container.innerHTML = '';

  if (!session.segments) return;

  session.segments.forEach((seg, i) => {
    const card = document.createElement('div');
    card.className = 'segment-card';
    card.id = `result-seg-${i}`;

    const hasExport = seg.status === 'complete' && seg.exportFiles;
    const segPath = seg.segDir || '';

    let previewHtml = '';
    if (seg.status === 'complete' || seg.status === 'generated' || seg.status === 'export_failed') {
      previewHtml = `<iframe class="preview-frame" src="/api/sessions/${currentSessionId}/segments/${i}/preview" sandbox="allow-scripts"></iframe>`;
    }

    let downloadHtml = '';
    if (hasExport) {
      downloadHtml = `
        <div class="download-links">
          <a href="${segPath}/animation.webm" download>WebM</a>
          <a href="${segPath}/animation.mp4" download>MP4</a>
          <a href="${segPath}/peak-frame.png" download>Peak Frame</a>
          <a href="${segPath}/thumbnail.png" download>Thumbnail</a>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="segment-header">
        <div class="segment-number">${i + 1}</div>
        <div class="segment-title">${esc(seg.title)}</div>
        <span class="badge badge-${seg.type}">${seg.type.replace('_', ' ')}</span>
      </div>
      ${previewHtml}
      ${downloadHtml}
      <div class="segment-actions">
        ${seg.status === 'complete' ? `<button class="btn-danger" onclick="showRejectInput(${i})">Reject</button>` : ''}
        ${seg.status === 'generating' ? '<span style="color:var(--warning);font-size:0.8rem">Regenerating...</span>' : ''}
        ${seg.error ? `<span style="color:var(--error);font-size:0.8rem">${esc(seg.error)}</span>` : ''}
      </div>
      <div class="reject-input" id="reject-input-${i}">
        <input type="text" placeholder="What should change? (1-2 sentences)" id="reject-text-${i}">
        <button class="btn-danger" onclick="rejectSegment(${i})">Submit</button>
      </div>
    `;

    container.appendChild(card);
  });
}

window.showRejectInput = function(index) {
  document.getElementById(`reject-input-${index}`).classList.add('visible');
  document.getElementById(`reject-text-${index}`).focus();
};

window.rejectSegment = async function(index) {
  const input = document.getElementById(`reject-text-${index}`);
  const rationale = input.value.trim();
  if (!rationale) { input.focus(); return; }

  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/segments/${index}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rationale }),
    });

    if (res.ok) {
      // Start polling to watch regeneration
      startPolling();
    } else {
      const data = await res.json();
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
};

// ── Download All ──

document.getElementById('download-btn').addEventListener('click', () => {
  window.location.href = `/api/sessions/${currentSessionId}/download`;
});

// ── New Session ──

document.getElementById('new-session-btn').addEventListener('click', () => {
  currentSessionId = null;
  selectedFile = null;
  dropZone.classList.remove('has-file');
  dropZone.querySelector('p').innerHTML = 'Drop your <strong>.vtt</strong> file here';
  dropZone.querySelector('.drop-sub').textContent = 'or click to browse';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Analyze Transcript';
  contextInput.value = '';
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
