import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getDb } from '../db/connection.js';

const router = Router();
const PROJECTS_ROOT = '/home/claude/projects';

// Ports reserved by system services (claude-chat, knjigoo, vip-nightlife-crm, etc.)
const RESERVED_PORTS = new Set([3118, 3119, 3120, 3121]);

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

function ensureProjectFolder(userId: string, slug: string): string {
  const userDir = join(PROJECTS_ROOT, userId);
  const fullPath = join(userDir, slug);
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
  }
  return fullPath;
}

router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const rows = getDb().prepare("SELECT * FROM projects WHERE user_id = ? AND is_general = 0 ORDER BY updated_at DESC").all(userId);
  res.json(rows);
});

router.get('/:id', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { name, description = '', path: customPath } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = uuid();

  let projectPath: string;
  if (customPath && existsSync(customPath)) {
    projectPath = customPath;
  } else {
    const slug = slugify(name);
    projectPath = ensureProjectFolder(userId, slug);
  }

  let gitOriginUrl = '';
  try {
    gitOriginUrl = execSync('git config --get remote.origin.url', {
      cwd: projectPath, timeout: 5000, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
  } catch { /* not a git repo or no remote */ }

  const usedPorts = getDb().prepare('SELECT dev_port FROM projects WHERE dev_port IS NOT NULL ORDER BY dev_port ASC').all() as { dev_port: number }[];
  const usedSet = new Set(usedPorts.map(r => r.dev_port));
  let devPort: number | null = null;
  for (let p = 3100; p <= 3999; p++) {
    if (!usedSet.has(p) && !RESERVED_PORTS.has(p)) { devPort = p; break; }
  }

  getDb().prepare('INSERT INTO projects (id, name, description, path, git_push_disabled, git_origin_url, dev_port, user_id) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(id, name, description, projectPath, gitOriginUrl, devPort, userId);
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id);
  res.status(201).json(row);
});

router.put('/:id', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { name, description, path, git_origin_url, git_push_disabled, git_protected_branches, color, auto_summarize, dev_port, server_config } = req.body;
  const db = getDb();
  const existing = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), path = COALESCE(?, path), git_origin_url = COALESCE(?, git_origin_url), git_push_disabled = COALESCE(?, git_push_disabled), git_protected_branches = COALESCE(?, git_protected_branches), color = COALESCE(?, color), auto_summarize = COALESCE(?, auto_summarize), dev_port = COALESCE(?, dev_port), server_config = COALESCE(?, server_config), updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(name ?? null, description ?? null, path ?? null, git_origin_url ?? null, git_push_disabled ?? null, git_protected_branches ?? null, color ?? null, auto_summarize ?? null, dev_port ?? null, server_config ?? null, req.params.id, userId);
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const db = getDb();
  const project = db.prepare('SELECT path, dev_port FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, userId) as { path: string | null; dev_port: number | null } | undefined;
  if (!project) return res.status(404).json({ error: 'Not found' });

  if (project?.path && existsSync(project.path)) {
    const composePath = join(project.path, 'docker-compose.yml');
    if (existsSync(composePath)) {
      try {
        execSync('sudo docker compose down -v', { cwd: project.path, timeout: 30_000, stdio: 'pipe' });
      } catch { /* ignore */ }
    }
    if (project.dev_port) {
      try {
        execSync(`fuser -k ${project.dev_port}/tcp`, { timeout: 5_000, stdio: 'pipe' });
      } catch { /* ignore */ }
    }
    try {
      rmSync(project.path, { recursive: true, force: true });
    } catch { /* ignore */ }

    // Clean up Claude Code cache directories
    const cacheSlug = project.path.replace(/\//g, '-');
    const claudeProjectCache = join('/home/claude/.claude/projects', cacheSlug);
    const claudeCliCache = join('/home/claude/.cache/claude-cli-nodejs', cacheSlug);
    try { rmSync(claudeProjectCache, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(claudeCliCache, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(req.params.id, userId);
  res.status(204).end();
});

export default router;
