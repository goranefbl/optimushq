import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http, { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createSchema } from './db/schema.js';
import { seed } from './db/seed.js';
import { getDb } from './db/connection.js';
import { setupWebSocket } from './ws/handler.js';
import projectsRouter from './routes/projects.js';
import sessionsRouter from './routes/sessions.js';
import agentsRouter from './routes/agents.js';
import skillsRouter from './routes/skills.js';
import memoryRouter from './routes/memory.js';
import exportRouter from './routes/exportRoute.js';
import authRouter, { authMiddleware } from './routes/auth.js';
import settingsRouter, { getBaseDomain } from './routes/settings.js';
import filesRouter from './routes/files.js';
import gitRouter from './routes/git.js';
import mcpsRouter from './routes/mcps.js';
import apisRouter from './routes/apis.js';
import internalRouter from './routes/internal.js';
import whatsappRouter from './routes/whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

// Set up Claude Code hooks for project path validation
function setupPathValidationHook() {
  const homeDir = process.env.HOME || '/home/claude';
  const claudeDir = path.join(homeDir, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const hookPath = path.join(hooksDir, 'validate-path.js');

  // Create directories if needed
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // Write the hook script
  const hookScript = `#!/usr/bin/env node
// Hook script to validate file paths are within PROJECT_PATH
// Used by OptimusHQ to enforce project isolation

const path = require('path');

const projectPath = process.env.PROJECT_PATH;
if (!projectPath) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const tool = data.tool_name || data.tool || '';
    const toolInput = data.tool_input || {};

    let filePath = '';
    if (['Write', 'Edit', 'Read'].includes(tool)) {
      filePath = toolInput.file_path || '';
    } else {
      process.exit(0);
    }

    if (!filePath) process.exit(0);

    const resolvedFile = path.resolve(filePath);
    const resolvedProject = path.resolve(projectPath);

    if (resolvedFile.startsWith(resolvedProject + path.sep) || resolvedFile === resolvedProject) {
      process.exit(0);
    }
    if (resolvedFile.startsWith('/tmp/') || resolvedFile.startsWith('/tmp')) {
      process.exit(0);
    }

    process.stderr.write('Security: Cannot access "' + filePath + '" - outside project directory "' + projectPath + '"\\n');
    process.exit(2);
  } catch (e) {
    process.exit(0);
  }
});
`;

  fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });

  // Update settings.json to include the hook
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  // Set up PreToolUse hook for path validation
  const hooks = (settings.hooks || {}) as Record<string, unknown>;
  const preToolUse = [
    {
      matcher: 'Write|Edit|Read',
      hooks: [{ type: 'command', command: `node ${hookPath}` }],
    },
  ];
  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log('[INIT] Path validation hook configured');
}

// Find package root (handles both direct and nested build outputs)
function findPackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'client', 'dist', 'index.html'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.join(__dirname, '..', '..'); // fallback
}
const PKG_ROOT = findPackageRoot();

// Init DB
createSchema();
seed();

// Set up security hook for project isolation
setupPathValidationHook();

const app = express();

// Subdomain proxy: <project>.wpgens.com -> project's dev_port
// Must be before cors/json/auth so it proxies raw requests
function proxyToDevServer(
  req: express.Request,
  res: express.Response,
  port: number,
  retriesLeft: number = 3,
  delayMs: number = 1500,
): void {
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host || '', 'x-forwarded-for': req.socket.remoteAddress || '' },
  }, (proxyRes) => {
    const status = proxyRes.statusCode || 502;
    // Retry on 404 for page/document requests (likely server still initializing)
    // Don't retry asset requests (_next/static, .js, .css, etc.) to avoid delays
    const isPageRequest = !req.url?.match(/\.(js|css|map|ico|png|jpg|svg|woff2?|ttf)$/) && !req.url?.startsWith('/_next/');
    if (status === 404 && isPageRequest && retriesLeft > 0) {
      proxyRes.resume(); // drain response
      setTimeout(() => proxyToDevServer(req, res, port, retriesLeft - 1, delayMs), delayMs);
      return;
    }
    res.writeHead(status, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    if (retriesLeft > 0) {
      setTimeout(() => proxyToDevServer(req, res, port, retriesLeft - 1, delayMs), delayMs);
    } else {
      res.status(502).send(`Dev server not running on port ${port}`);
    }
  });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '')) {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

app.use((req, res, next) => {
  const host = req.headers.host || '';
  const baseDomain = getBaseDomain();
  // Match <project>.<base-domain> but skip reserved subdomains
  const domainPattern = new RegExp(`^([^.]+)\\.${baseDomain.replace(/\./g, '\\.')}$`);
  const match = host.match(domainPattern);
  if (!match) return next();
  const reserved = ['agents', 'agent', 'www', 'mail', 'ftp', 'api'];
  if (reserved.includes(match[1])) return next();

  const subdomain = match[1];
  const db = getDb();
  // Match subdomain to project folder name (last segment of path)
  const project = db.prepare(
    "SELECT dev_port, path FROM projects WHERE dev_port IS NOT NULL AND path LIKE ?"
  ).get(`%/${subdomain}`) as { dev_port: number; path: string } | undefined;

  if (!project) {
    return res.status(404).send(`No project found for subdomain: ${subdomain}`);
  }

  proxyToDevServer(req, res, project.dev_port);
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Auth routes (before middleware)
app.use('/api/auth', authRouter);

// Internal API (localhost only, before auth middleware)
app.use('/api/internal', (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || '';
  const allowed = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  if (!allowed.includes(ip)) {
    return res.status(403).json({ error: 'Forbidden: localhost only' });
  }
  next();
}, internalRouter);

// Health check (before auth middleware so it's always accessible)
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Auth middleware — protects all /api/* routes except /api/auth/login
app.use(authMiddleware);

// API Routes
app.use('/api/projects', projectsRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/skills', skillsRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/export', exportRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/files', filesRouter);
app.use('/api/git', gitRouter);
app.use('/api/mcps', mcpsRouter);
app.use('/api/apis', apisRouter);
app.use('/api/whatsapp', whatsappRouter);

// File upload for chat — saves base64 file to temp dir, returns path
const UPLOAD_DIR = '/tmp/chat-uploads';
app.post('/api/upload/image', (req, res) => {
  const { data, filename } = req.body; // data = base64 string, filename = original name
  if (!data) return res.status(400).json({ error: 'data (base64) required' });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = (filename || 'file').split('.').pop() || 'bin';
  const prefix = ext === 'csv' ? 'csv' : 'img';
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;
  const filePath = path.join(UPLOAD_DIR, name);
  const buffer = Buffer.from(data, 'base64');
  fs.writeFileSync(filePath, buffer);
  res.json({ path: filePath, size: buffer.length });
});

// Activity log - scoped to user
app.get('/api/activity', (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { project_id, limit = '50' } = req.query;
  const db = getDb();
  const lim = Math.min(parseInt(limit as string) || 50, 200);
  let rows;
  if (project_id) {
    rows = db.prepare(`
      SELECT a.*, s.title as session_title, p.name as project_name
      FROM activity_log a
      JOIN sessions s ON a.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      WHERE s.project_id = ? AND s.user_id = ?
      ORDER BY a.created_at DESC LIMIT ?
    `).all(project_id, userId, lim);
  } else {
    rows = db.prepare(`
      SELECT a.*, s.title as session_title, p.name as project_name
      FROM activity_log a
      JOIN sessions s ON a.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      WHERE s.user_id = ?
      ORDER BY a.created_at DESC LIMIT ?
    `).all(userId, lim);
  }
  res.json(rows);
});

// Expose per-user general project ID to client
app.get('/api/config', (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const general = db.prepare("SELECT id FROM projects WHERE user_id = ? AND is_general = 1").get(userId) as { id: string } | undefined;
  res.json({ generalProjectId: general?.id || null });
});

// Logs endpoint - reads PM2 log files
app.get('/api/logs', (req, res) => {
  const logType = req.query.type === 'error' ? 'error' : 'out';
  const lines = Math.min(parseInt(req.query.lines as string) || 100, 1000);
  const logFile = path.join(
    process.env.HOME || '/home/claude',
    '.pm2', 'logs', `claude-chat-${logType}-0.log`
  );
  try {
    if (!fs.existsSync(logFile)) {
      return res.json({ logs: `Log file not found: ${logFile}` });
    }
    const content = fs.readFileSync(logFile, 'utf-8');
    const allLines = content.split('\n');
    const tail = allLines.slice(-lines).join('\n');
    res.json({ logs: tail });
  } catch (err: any) {
    res.json({ logs: `Error reading logs: ${err.message}` });
  }
});

// Serve user projects: reverse proxy if dev_port set, otherwise static files
const PROJECTS_DIR = '/home/claude/projects';
app.use('/preview', (req, res, next) => {
  // Extract project folder name from URL: /preview/<folder>/...
  const match = req.path.match(/^\/([^/]+)/);
  if (!match) return next();
  const folderName = match[1];

  // Look up project by path to check for dev_port
  const db = getDb();
  const project = db.prepare("SELECT dev_port FROM projects WHERE path LIKE ?").get(`%/${folderName}`) as { dev_port: number | null } | undefined;

  if (project?.dev_port) {
    // Reverse proxy to the dev server
    const subPath = req.url.replace(`/${folderName}`, '') || '/';
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: project.dev_port,
      path: subPath,
      method: req.method,
      headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host || '', 'x-forwarded-for': req.socket.remoteAddress || '' },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      // Dev server not running, fall through to static
      express.static(PROJECTS_DIR, { extensions: ['html'] })(req, res, next);
    });
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  } else {
    // Static file serving (original behavior)
    express.static(PROJECTS_DIR, { extensions: ['html'] })(req, res, next);
  }
});

// API to list available preview projects
app.get('/api/preview-projects', (_req, res) => {
  try {
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    const projects = entries
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, url: `/preview/${e.name}/` }));
    res.json(projects);
  } catch {
    res.json([]);
  }
});

// Serve blog images and other public files
const publicDir = path.join(PKG_ROOT, 'public');
app.use(express.static(publicDir));

// Serve client static files in production
const clientDist = path.join(PKG_ROOT, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// HTTP + WS server
const server = createServer(app);
const wss = new WebSocketServer({ server });
setupWebSocket(wss);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
