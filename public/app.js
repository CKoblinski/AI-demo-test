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

// ── Plan Review (Screen 3) — Expandable Clip Cards ──

function renderPlan(session) {
  const container = document.getElementById('segments-plan');
  container.innerHTML = '';

  if (!session.segments) return;

  session.segments.forEach((seg, i) => {
    const card = document.createElement('div');
    card.className = 'clip-card';
    card.id = `plan-clip-${i}`;

    const startMin = Math.floor((seg.startTime || 0) / 60);
    const startSec = Math.floor((seg.startTime || 0) % 60);
    const endMin = Math.floor((seg.endTime || 0) / 60);
    const endSec = Math.floor((seg.endTime || 0) % 60);
    const timeStr = `${pad(startMin)}:${pad(startSec)} - ${pad(endMin)}:${pad(endSec)}`;

    const animations = seg.animations || [];
    const decisionSummary = animations.map(a => a.decision).join(' / ');

    // Build animation concept cards
    let animCardsHtml = '';
    for (const anim of animations) {
      let previewHtml = '';
      let libraryLabel = '';

      if (anim.decision === 'REUSE' && anim.libraryMatch) {
        // Lazy load: data-src set on expand
        previewHtml = `<iframe class="library-preview lazy-iframe"
          data-src="/library/${anim.libraryMatch.id}/animation.html"
          sandbox="allow-scripts"></iframe>`;
        libraryLabel = `<div class="library-preview-label">Reusing: ${esc(anim.libraryMatch.name)}</div>`;
      } else if (anim.decision === 'ADAPT' && anim.libraryMatch) {
        previewHtml = `<iframe class="library-preview lazy-iframe"
          data-src="/library/${anim.libraryMatch.id}/animation.html"
          sandbox="allow-scripts"></iframe>`;
        libraryLabel = `<div class="library-preview-label">Adapting: ${esc(anim.libraryMatch.name)} &mdash; ${esc(anim.reason || '')}</div>`;
      }

      animCardsHtml += `
        <div class="anim-concept">
          <div class="anim-concept-header">
            <div class="anim-order">${anim.order}</div>
            <div class="anim-concept-title">${esc(anim.concept)}</div>
            <span class="decision-badge decision-badge-${anim.decision}">${anim.decision}</span>
          </div>
          <div class="anim-description">
            <strong>Emotion:</strong> ${esc(anim.emotion || 'N/A')}
            ${anim.durationWeight ? ` &middot; <strong>Weight:</strong> ${Math.round(anim.durationWeight * 100)}%` : ''}
          </div>
          ${previewHtml}
          ${libraryLabel}
        </div>
      `;
    }

    card.innerHTML = `
      <div class="clip-header" onclick="toggleClip(${i})">
        <div class="segment-number">${i + 1}</div>
        <div class="segment-title">${esc(seg.title)}</div>
        <span class="badge badge-${seg.type}">${(seg.type || '').replace('_', ' ')}</span>
        <span style="font-size:0.75rem;color:var(--text-dim);margin-left:auto">${timeStr}</span>
        <span class="clip-expand-icon">&#9654;</span>
      </div>
      <div class="clip-summary">
        ${esc(seg.emotionalArc || '')}
        <br><span style="font-size:0.8rem">${animations.length} animation${animations.length !== 1 ? 's' : ''}: ${decisionSummary}</span>
      </div>
      <div class="clip-body">
        <div class="clip-animations">
          ${animCardsHtml}
        </div>
        ${seg.whyItsGood ? `<div class="clip-why">${esc(seg.whyItsGood)}</div>` : ''}
      </div>
    `;

    container.appendChild(card);
  });

  // Auto-expand the first clip
  const firstClip = document.querySelector('.clip-card');
  if (firstClip) {
    firstClip.classList.add('expanded');
    loadLazyIframes(firstClip);
  }

  if (session.estimatedMinutes) {
    document.getElementById('time-estimate').textContent =
      `Estimated generation time: ~${session.estimatedMinutes} minutes`;
  }
}

window.toggleClip = function(index) {
  const card = document.getElementById(`plan-clip-${index}`);
  if (!card) return;
  card.classList.toggle('expanded');
  // Lazy-load iframes when expanding
  if (card.classList.contains('expanded')) {
    loadLazyIframes(card);
  }
};

function loadLazyIframes(container) {
  container.querySelectorAll('.lazy-iframe').forEach(iframe => {
    if (!iframe.src && iframe.dataset.src) {
      iframe.src = iframe.dataset.src;
      iframe.classList.remove('lazy-iframe');
    }
  });
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

// ── Generating (Screen 4) — Per-animation status ──

function renderGenerating(session) {
  const container = document.getElementById('segments-progress');
  container.innerHTML = '';

  if (!session.segments) return;

  session.segments.forEach((seg, i) => {
    const card = document.createElement('div');
    card.className = 'segment-card';

    const animations = seg.animations || [];
    let animStatusHtml = '';
    for (const anim of animations) {
      const statusClass = `status-${anim.status}`;
      const statusText = {
        pending: 'Waiting...',
        generating: 'Generating...',
        generated: 'Ready',
        exporting: 'Exporting...',
        complete: 'Done',
        failed: `Failed: ${anim.error || 'unknown'}`,
        export_failed: `Export failed`,
      }[anim.status] || anim.status;

      animStatusHtml += `
        <div class="segment-status ${statusClass}" style="padding-left:38px">
          <div class="status-dot"></div>
          <span style="font-size:0.8rem;flex:1">${anim.order}. ${esc(anim.concept).substring(0, 60)}${anim.concept.length > 60 ? '...' : ''}</span>
          <span style="font-size:0.75rem;color:var(--text-dim)">${statusText}</span>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="segment-header">
        <div class="segment-number">${i + 1}</div>
        <div class="segment-title">${esc(seg.title)}</div>
      </div>
      ${animStatusHtml}
    `;

    container.appendChild(card);
  });

  document.getElementById('gen-progress').style.width = session.progress.percent + '%';
  document.getElementById('gen-message').textContent = session.progress.message;
}

// ── Results (Screen 5) — Per-animation previews + reject ──

function renderResults(session) {
  const container = document.getElementById('segments-results');
  container.innerHTML = '';

  if (!session.segments) return;

  session.segments.forEach((seg, i) => {
    const card = document.createElement('div');
    card.className = 'segment-card';
    card.id = `result-seg-${i}`;

    const animations = seg.animations || [];
    let animResultsHtml = '';

    animations.forEach((anim, ai) => {
      let previewHtml = '';
      if (['complete', 'generated', 'export_failed'].includes(anim.status)) {
        previewHtml = `<iframe class="preview-frame" style="height:200px;"
          src="/api/sessions/${currentSessionId}/segments/${i}/animations/${ai}/preview"
          sandbox="allow-scripts"></iframe>`;
      }

      const hasExport = anim.status === 'complete' && anim.exportFiles;
      const animPath = anim.animDir || '';
      let downloadHtml = '';
      if (hasExport) {
        downloadHtml = `
          <div class="download-links">
            <a href="${animPath}/animation.webm" download>WebM</a>
            <a href="${animPath}/animation.mp4" download>MP4</a>
            <a href="${animPath}/peak-frame.png" download>Peak Frame</a>
          </div>
        `;
      }

      animResultsHtml += `
        <div class="anim-concept" style="margin-bottom:12px">
          <div class="anim-concept-header">
            <div class="anim-order">${anim.order}</div>
            <div class="anim-concept-title">${esc(anim.concept)}</div>
            <span class="decision-badge decision-badge-${anim.decision}">${anim.decision}</span>
          </div>
          ${previewHtml}
          ${downloadHtml}
          <div class="segment-actions" style="margin-top:8px">
            ${anim.status === 'complete' ? `<button class="btn-danger" onclick="showRejectInput(${i}, ${ai})">Reject</button>` : ''}
            ${anim.status === 'generating' ? '<span style="color:var(--warning);font-size:0.8rem">Regenerating...</span>' : ''}
            ${anim.error ? `<span style="color:var(--error);font-size:0.8rem">${esc(anim.error)}</span>` : ''}
          </div>
          <div class="reject-input" id="reject-input-${i}-${ai}">
            <input type="text" placeholder="What should change? (1-2 sentences)" id="reject-text-${i}-${ai}">
            <button class="btn-danger" onclick="rejectAnimation(${i}, ${ai})">Submit</button>
          </div>
        </div>
      `;
    });

    card.innerHTML = `
      <div class="segment-header">
        <div class="segment-number">${i + 1}</div>
        <div class="segment-title">${esc(seg.title)}</div>
        <span class="badge badge-${seg.type}">${(seg.type || '').replace('_', ' ')}</span>
      </div>
      ${animResultsHtml}
    `;

    container.appendChild(card);
  });
}

window.showRejectInput = function(segIndex, animIndex) {
  document.getElementById(`reject-input-${segIndex}-${animIndex}`).classList.add('visible');
  document.getElementById(`reject-text-${segIndex}-${animIndex}`).focus();
};

window.rejectAnimation = async function(segIndex, animIndex) {
  const input = document.getElementById(`reject-text-${segIndex}-${animIndex}`);
  const rationale = input.value.trim();
  if (!rationale) { input.focus(); return; }

  try {
    const res = await fetch(
      `/api/sessions/${currentSessionId}/segments/${segIndex}/animations/${animIndex}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rationale }),
      }
    );

    if (res.ok) {
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
