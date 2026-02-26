import express from 'express';
import multer from 'multer';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  createSession, getSession, listSessions,
  runAnalysis, runGeneration, regenerateAnimation, createSessionZip,
} from './src/job-runner.js';
import { listAnimations, getAnimationHtml } from './src/library.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// File upload — accept .vtt by filename (browsers send various mimetypes)
const upload = multer({
  dest: join(__dirname, 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.vtt')) {
      cb(null, true);
    } else {
      cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only .vtt files are accepted'));
    }
  },
});

// Serve output files (animations, videos, etc.)
app.use('/output', express.static(join(__dirname, 'output')));

// Serve library files (for previews)
app.use('/library', express.static(join(__dirname, 'library')));

// ═══════════════════════════════════════
// API Routes
// ═══════════════════════════════════════

// Upload VTT and start analysis
app.post('/api/sessions', (req, res) => {
  upload.single('vtt')(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err.message);
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No VTT file uploaded' });
      }

      const userContext = req.body.context || '';
      const session = createSession(req.file.path, userContext);

      // Start analysis in background
      runAnalysis(session.id).catch(err => {
        console.error(`Analysis failed for session ${session.id}:`, err.message);
      });

      res.json({
        id: session.id,
        stage: session.stage,
        message: 'Analysis started',
      });
    } catch (err) {
      console.error('Session creation error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

// Get session status
app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Build response based on stage
  const response = {
    id: session.id,
    stage: session.stage,
    progress: session.progress,
    error: session.error,
    createdAt: session.createdAt,
    estimatedMinutes: session.estimatedMinutes,
  };

  // Include segments when plan is ready (nested animations model)
  if (session.segments) {
    response.segments = session.segments.map((s, i) => ({
      index: i,
      title: s.highlight.title,
      type: s.highlight.type,
      startTime: s.highlight.startTime,
      endTime: s.highlight.endTime,
      emotionalArc: s.highlight.emotionalArc,
      whyItsGood: s.highlight.whyItsGood,
      contextForViewers: s.highlight.contextForViewers,
      estimatedClipDuration: s.highlight.estimatedClipDuration,
      keyDialogue: s.highlight.keyDialogueCueIds ? 'Available' : null,
      status: s.status,
      segDir: s.segDir ? s.segDir.replace(resolve(__dirname), '') : null,
      // Nested animations per clip
      animations: (s.animations || []).map((a, ai) => ({
        index: ai,
        order: a.order,
        concept: a.concept,
        emotion: a.emotion,
        suggestedType: a.suggestedType,
        durationWeight: a.durationWeight,
        decision: a.decision,
        reason: a.reason,
        libraryMatch: a.libraryMatch ? { id: a.libraryMatch.id, name: a.libraryMatch.name } : null,
        status: a.status,
        error: a.error,
        exportFiles: a.exportFiles,
        animDir: a.animDir ? a.animDir.replace(resolve(__dirname), '') : null,
      })),
    }));
  }

  res.json(response);
});

// List all sessions
app.get('/api/sessions', (req, res) => {
  res.json(listSessions());
});

// Approve plan and start generation
app.post('/api/sessions/:id/approve', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.stage !== 'plan_ready') {
    return res.status(400).json({ error: `Cannot approve — session is in stage: ${session.stage}` });
  }

  // Save the approved plan
  const planPath = join(session.outDir, 'session-data', 'plan.json');
  const { writeFileSync } = await import('fs');
  writeFileSync(planPath, JSON.stringify({
    approvedAt: new Date().toISOString(),
    segments: session.segments.map(s => ({
      title: s.highlight.title,
      animations: s.animations.map(a => ({
        order: a.order,
        concept: a.concept,
        decision: a.decision,
        libraryMatch: a.libraryMatch ? a.libraryMatch.id : null,
      })),
    })),
  }, null, 2));

  // Start generation in background
  runGeneration(session.id).catch(err => {
    console.error(`Generation failed for session ${session.id}:`, err.message);
  });

  res.json({ message: 'Generation started', stage: 'generating' });
});

// Reject a specific animation within a clip and regenerate
app.post('/api/sessions/:id/segments/:segIndex/animations/:animIndex/reject', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const segIndex = parseInt(req.params.segIndex);
  const animIndex = parseInt(req.params.animIndex);
  const { rationale } = req.body;

  if (!rationale || rationale.trim().length === 0) {
    return res.status(400).json({ error: 'Rationale is required' });
  }

  // Start regeneration in background
  regenerateAnimation(session.id, segIndex, animIndex, rationale).catch(err => {
    console.error(`Regeneration failed for session ${session.id} seg ${segIndex} anim ${animIndex}:`, err.message);
  });

  res.json({ message: 'Regeneration started' });
});

// Preview a specific animation within a clip
app.get('/api/sessions/:id/segments/:segIndex/animations/:animIndex/preview', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const seg = session.segments?.[parseInt(req.params.segIndex)];
  if (!seg) return res.status(404).json({ error: 'Segment not found' });

  const anim = seg.animations?.[parseInt(req.params.animIndex)];
  if (!anim || !anim.animDir) return res.status(404).json({ error: 'Animation not found' });

  const htmlPath = join(anim.animDir, 'animation.html');
  if (!existsSync(htmlPath)) return res.status(404).json({ error: 'Animation not yet generated' });

  res.sendFile(htmlPath);
});

// Download session zip
app.get('/api/sessions/:id/download', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  try {
    const zipPath = await createSessionZip(session.id);
    res.download(zipPath, `dnd-shorts-${session.id}.zip`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get animation library
app.get('/api/library', (req, res) => {
  res.json(listAnimations());
});

// Library animation preview (for plan review iframes)
app.get('/api/library/:id/preview', (req, res) => {
  const htmlPath = join(__dirname, 'library', req.params.id, 'animation.html');
  if (!existsSync(htmlPath)) return res.status(404).json({ error: 'Library animation not found' });
  res.sendFile(htmlPath);
});

// ═══════════════════════════════════════
// Start
// ═══════════════════════════════════════

app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║  D&D Shorts Factory                           ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Server:  http://localhost:${PORT}`);
  console.log(`  Library: ${listAnimations().length} animations loaded`);
  console.log('');
});
