import express from 'express';
import multer from 'multer';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  createSession, getSession, listSessions,
  runAnalysis, runGeneration, regenerateSegment, createSessionZip,
} from './src/job-runner.js';
import { listAnimations } from './src/library.js';

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

// File upload
const upload = multer({
  dest: join(__dirname, 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.vtt') || file.mimetype === 'text/vtt') {
      cb(null, true);
    } else {
      cb(new Error('Only .vtt files are accepted'));
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
app.post('/api/sessions', upload.single('vtt'), async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
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

  // Include segments when plan is ready
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
      decision: s.decision,
      concept: s.concept,
      reason: s.reason,
      libraryMatch: s.libraryMatch ? {
        id: s.libraryMatch.id,
        name: s.libraryMatch.name,
      } : null,
      status: s.status,
      error: s.error,
      exportFiles: s.exportFiles,
      segDir: s.segDir ? s.segDir.replace(resolve(__dirname), '') : null,
    }));
  }

  // Include highlights for plan review
  if (session.highlights) {
    response.highlights = session.highlights;
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
      decision: s.decision,
      concept: s.concept,
    })),
  }, null, 2));

  // Start generation in background
  runGeneration(session.id).catch(err => {
    console.error(`Generation failed for session ${session.id}:`, err.message);
  });

  res.json({ message: 'Generation started', stage: 'generating' });
});

// Reject a segment and regenerate
app.post('/api/sessions/:id/segments/:index/reject', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const index = parseInt(req.params.index);
  const { rationale } = req.body;

  if (!rationale || rationale.trim().length === 0) {
    return res.status(400).json({ error: 'Rationale is required' });
  }

  // Start regeneration in background
  regenerateSegment(session.id, index, rationale).catch(err => {
    console.error(`Regeneration failed for session ${session.id} segment ${index}:`, err.message);
  });

  res.json({ message: 'Regeneration started' });
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

// Serve animation HTML for iframe preview
app.get('/api/sessions/:id/segments/:index/preview', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const seg = session.segments?.[parseInt(req.params.index)];
  if (!seg || !seg.segDir) return res.status(404).json({ error: 'Segment not found' });

  const htmlPath = join(seg.segDir, 'animation.html');
  if (!existsSync(htmlPath)) return res.status(404).json({ error: 'Animation not yet generated' });

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
