import { Router, Request, Response } from 'express';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getDb } from '../db/connection.js';

const router = Router();
const EXEC_TIMEOUT = 15_000;

interface ProjectRow {
  path: string | null;
  git_push_disabled: number;
  git_protected_branches: string;
}

function getProject(projectId: string, userId?: string): ProjectRow | null {
  let row: ProjectRow | undefined;
  if (userId) {
    row = getDb().prepare('SELECT path, git_push_disabled, git_protected_branches FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId) as ProjectRow | undefined;
  } else {
    row = getDb().prepare('SELECT path, git_push_disabled, git_protected_branches FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  }
  return row ?? null;
}

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, timeout: EXEC_TIMEOUT, encoding: 'utf-8' }).trim();
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, timeout: EXEC_TIMEOUT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// GET /status/:projectId
router.get('/status/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found or has no path' });

  if (!isGitRepo(project.path)) {
    return res.json({ isGitRepo: false });
  }

  try {
    let branch = 'main';
    try {
      branch = git('rev-parse --abbrev-ref HEAD', project.path);
    } catch {
      // Fresh repo with no commits — fall back to default branch name
      try {
        const symbolic = git('symbolic-ref --short HEAD', project.path);
        if (symbolic) branch = symbolic;
      } catch { /* stick with 'main' */ }
    }

    let ahead = 0;
    let behind = 0;
    try {
      const counts = git('rev-list --left-right --count HEAD...@{upstream}', project.path);
      const parts = counts.split(/\s+/);
      ahead = parseInt(parts[0]) || 0;
      behind = parseInt(parts[1]) || 0;
    } catch {
      // No upstream configured or no commits yet
    }

    // Don't use git() helper here -- its .trim() strips leading spaces from porcelain format
    // which corrupts the XY status columns (position 0-1 are meaningful)
    const statusOutput = execSync('git status --porcelain -u', { cwd: project.path, timeout: EXEC_TIMEOUT, encoding: 'utf-8' }).replace(/\n$/, '');
    const files = statusOutput
      ? statusOutput.split('\n').map(line => {
          const indexStatus = line[0];
          const workTreeStatus = line[1];
          const filePath = line.substring(3);

          // A file can appear in both staged and unstaged
          const entries: { path: string; status: string; staged: boolean }[] = [];

          if (indexStatus !== ' ' && indexStatus !== '?') {
            entries.push({ path: filePath, status: indexStatus, staged: true });
          }
          if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
            entries.push({ path: filePath, status: workTreeStatus, staged: false });
          }
          if (indexStatus === '?' && workTreeStatus === '?') {
            entries.push({ path: filePath, status: '??', staged: false });
          }

          return entries;
        }).flat()
      : [];

    res.json({ isGitRepo: true, branch, ahead, behind, files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /diff/:projectId
router.get('/diff/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found' });

  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: 'path query param required' });

  const staged = req.query.staged === 'true';

  try {
    let diff: string;
    const quoted = JSON.stringify(filePath);

    if (staged) {
      diff = git(`diff --cached -- ${quoted}`, project.path);
      // For newly staged files, --cached may return empty if it's a new file
      // Use diff --cached --no-ext-diff to get the full add diff
      if (!diff) {
        try {
          diff = git(`diff --cached --no-ext-diff -- ${quoted}`, project.path);
        } catch { /* ignore */ }
      }
      // Still empty? Show staged file content directly
      if (!diff) {
        try {
          const content = git(`show :${quoted}`, project.path);
          const lines = content.split('\n');
          diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` +
            lines.map(l => `+${l}`).join('\n');
        } catch { /* ignore */ }
      }
    } else {
      // Check if the file is tracked
      let tracked = false;
      try {
        git(`ls-files --error-unmatch -- ${quoted}`, project.path);
        tracked = true;
      } catch { /* untracked */ }

      if (tracked) {
        diff = git(`diff -- ${quoted}`, project.path);
      } else {
        // Untracked file — read content and format as new file diff
        const fullPath = resolve(project.path, filePath);
        // Safety: ensure the resolved path is within the project
        if (!fullPath.startsWith(resolve(project.path))) {
          return res.status(400).json({ error: 'Invalid file path' });
        }
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` +
          lines.map(l => `+${l}`).join('\n');
      }
    }

    res.json({ path: filePath, diff: diff || '' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /branches/:projectId
router.get('/branches/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found' });

  try {
    const output = git('branch -a', project.path);
    const branches = output.split('\n').filter(Boolean).map(line => {
      const current = line.startsWith('*');
      const name = line.replace(/^\*?\s+/, '').replace(/^remotes\//, '');
      const remote = line.includes('remotes/');
      return { name, current, remote };
    });
    res.json(branches);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /log/:projectId
router.get('/log/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found' });

  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

  try {
    const output = git(`log --format=%H%n%h%n%s%n%an%n%ai -n ${limit}`, project.path);
    if (!output) return res.json([]);

    const lines = output.split('\n');
    const entries = [];
    for (let i = 0; i + 4 < lines.length; i += 5) {
      entries.push({
        hash: lines[i],
        shortHash: lines[i + 1],
        message: lines[i + 2],
        author: lines[i + 3],
        date: lines[i + 4],
      });
    }
    res.json(entries);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /stage/:projectId
router.post('/stage/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found' });

  const { paths } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'paths array required' });

  try {
    const escaped = paths.map(p => JSON.stringify(p)).join(' ');
    git(`add -- ${escaped}`, project.path);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /unstage/:projectId
router.post('/unstage/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found' });

  const { paths } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'paths array required' });

  try {
    const escaped = paths.map(p => JSON.stringify(p)).join(' ');
    git(`reset HEAD -- ${escaped}`, project.path);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /commit/:projectId
router.post('/commit/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found' });

  const { message } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message string required' });

  try {
    git(`commit -m ${JSON.stringify(message)}`, project.path);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /checkout/:projectId
router.post('/checkout/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found' });

  const { branch } = req.body;
  if (!branch || typeof branch !== 'string') return res.status(400).json({ error: 'branch string required' });

  try {
    git(`checkout ${JSON.stringify(branch)}`, project.path);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /pull/:projectId
router.post('/pull/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found' });

  try {
    const output = git('pull', project.path);
    res.json({ ok: true, output });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /push/:projectId
router.post('/push/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found' });

  // Enforce git_push_disabled
  if (project.git_push_disabled) {
    return res.status(403).json({ error: 'Push is disabled for this project (pull-only mode)' });
  }

  // Enforce protected branches
  if (project.git_protected_branches) {
    try {
      const currentBranch = git('rev-parse --abbrev-ref HEAD', project.path);
      const protectedList = project.git_protected_branches.split(',').map(b => b.trim()).filter(Boolean);
      if (protectedList.includes(currentBranch)) {
        return res.status(403).json({ error: `Push to protected branch "${currentBranch}" is not allowed` });
      }
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const output = git('push', project.path);
    res.json({ ok: true, output });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /init/:projectId
router.post('/init/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found or has no path' });

  if (isGitRepo(project.path)) {
    return res.status(400).json({ error: 'Already a git repository' });
  }

  try {
    git('init', project.path);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /clone/:projectId
router.post('/clone/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found or has no path' });

  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url string required' });

  try {
    // Clone into the project directory (which already exists), so use "." as target
    execSync(`git clone ${JSON.stringify(url)} .`, {
      cwd: project.path,
      timeout: 60_000, // clones can be slow
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    // Auto-set git_origin_url from the clone URL
    getDb().prepare("UPDATE projects SET git_origin_url = ?, updated_at = datetime('now') WHERE id = ?")
      .run(url, req.params.projectId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

export default router;
