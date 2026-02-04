import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { onboardUser } from '../db/onboard.js';

const router = Router();

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

router.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body;
  const db = getDb();

  const user = db.prepare('SELECT id, email, username, password_hash, role FROM users WHERE username = ?').get(username) as {
    id: string; email: string; username: string; password_hash: string; role: string;
  } | undefined;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = generateToken();
  db.prepare('INSERT INTO auth_tokens (token, user_id) VALUES (?, ?)').run(token, user.id);

  res.json({
    token,
    username: user.username,
    email: user.email,
    role: user.role,
    userId: user.id,
  });
});

router.post('/logout', (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    getDb().prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
  }
  res.json({ ok: true });
});

router.get('/me', (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const db = getDb();
  const row = db.prepare(`
    SELECT u.id, u.email, u.username, u.role, u.phone
    FROM auth_tokens t JOIN users u ON t.user_id = u.id
    WHERE t.token = ?
  `).get(token) as { id: string; email: string; username: string; role: string; phone: string | null } | undefined;

  if (!row) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ userId: row.id, username: row.username, email: row.email, role: row.role, phone: row.phone });
});

router.put('/me', (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const db = getDb();
  const row = db.prepare('SELECT u.id FROM auth_tokens t JOIN users u ON t.user_id = u.id WHERE t.token = ?')
    .get(token) as { id: string } | undefined;

  if (!row) return res.status(401).json({ error: 'Not authenticated' });

  const { phone } = req.body;
  if (phone !== undefined) {
    // Normalize phone: remove spaces, dashes, and leading +
    const normalized = phone ? phone.replace(/[\s\-\+]/g, '') : null;
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(normalized, row.id);
  }

  res.json({ ok: true });
});

/** Inline auth helper for routes that run before the global authMiddleware */
function requireAdmin(req: Request, res: Response): boolean {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'Not authenticated' }); return false; }
  const db = getDb();
  const row = db.prepare('SELECT u.id, u.email, u.username, u.role FROM auth_tokens t JOIN users u ON t.user_id = u.id WHERE t.token = ?')
    .get(token) as { id: string; email: string; username: string; role: string } | undefined;
  if (!row) { res.status(401).json({ error: 'Not authenticated' }); return false; }
  if (row.role !== 'admin') { res.status(403).json({ error: 'Admin only' }); return false; }
  req.user = { id: row.id, email: row.email, username: row.username, role: row.role as 'admin' | 'user' };
  return true;
}

// Admin-only: register new user
router.post('/register', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const { username, password, email } = req.body;
  if (!username || !password || !email) {
    return res.status(400).json({ error: 'username, password, and email required' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
  if (existing) {
    return res.status(409).json({ error: 'User already exists' });
  }

  const userId = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(userId, email, username, hash, 'user');

  // Onboard user (clone agents, create general project, etc.)
  onboardUser(userId);

  res.status(201).json({ userId, username, email, role: 'user' });
});

// Admin-only: list all users for admin switcher
router.get('/users', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const rows = getDb().prepare('SELECT id, email, username, role, created_at FROM users ORDER BY created_at ASC').all();
  res.json(rows);
});

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip auth for login endpoint and static files
  if (req.path === '/api/auth/login') return next();
  if (!req.path.startsWith('/api/')) return next();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const db = getDb();
  const row = db.prepare(`
    SELECT u.id, u.email, u.username, u.role
    FROM auth_tokens t JOIN users u ON t.user_id = u.id
    WHERE t.token = ?
  `).get(token) as { id: string; email: string; username: string; role: string } | undefined;

  if (!row) return res.status(401).json({ error: 'Not authenticated' });

  req.user = { id: row.id, email: row.email, username: row.username, role: row.role as 'admin' | 'user' };

  // Admin impersonation
  const impersonateUserId = req.headers['x-impersonate-user'] as string | undefined;
  if (impersonateUserId && row.role === 'admin' && impersonateUserId !== row.id) {
    const target = db.prepare('SELECT id, email, username, role FROM users WHERE id = ?').get(impersonateUserId) as {
      id: string; email: string; username: string; role: string;
    } | undefined;
    if (target) {
      req.impersonatedBy = row.id;
      req.user = { id: target.id, email: target.email, username: target.username, role: target.role as 'admin' | 'user' };
    }
  }

  return next();
}

export default router;
