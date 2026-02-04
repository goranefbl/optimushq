import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDb } from '../db/connection.js';
import { decryptEnv } from './mcps.js';
import { whatsappService } from '../services/whatsapp.js';

const router = Router();

// Generate MCP config from database (same logic as spawn.ts)
function generateMcpConfig(): string {
  const db = getDb();
  const servers = db.prepare('SELECT name, command, args, env FROM mcp_servers WHERE enabled = 1').all() as {
    name: string; command: string; args: string; env: string;
  }[];

  const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  for (const s of servers) {
    const key = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const entry: { command: string; args: string[]; env?: Record<string, string> } = {
      command: s.command,
      args: JSON.parse(s.args),
    };
    const env = decryptEnv(s.env);
    if (Object.keys(env).length > 0) entry.env = env;
    mcpServers[key] = entry;
  }

  const configPath = path.join(os.tmpdir(), 'whatsapp-mcp-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), 'utf-8');
  return configPath;
}

// Set up user lookup - supports both phone numbers and LIDs
whatsappService.setUserLookup(async (identifier: string) => {
  const db = getDb();
  // Look up by phone column (can contain either phone number or LID)
  const user = db.prepare('SELECT id FROM users WHERE phone = ?').get(identifier) as { id: string } | undefined;
  if (!user) {
    console.log(`[WhatsApp] No user found for identifier: ${identifier}`);
    return null;
  }

  // Get user's general project
  const project = db.prepare('SELECT id FROM projects WHERE user_id = ? AND is_general = 1').get(user.id) as { id: string } | undefined;
  return project ? { userId: user.id, projectId: project.id } : null;
});

// Set up MCP config generator
whatsappService.setMcpConfigGenerator(generateMcpConfig);

// Admin only middleware
function adminOnly(req: Request, res: Response, next: Function) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// Get WhatsApp status
router.get('/status', adminOnly, async (req: Request, res: Response) => {
  try {
    const status = whatsappService.getStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get QR code as image
router.get('/qr', adminOnly, async (req: Request, res: Response) => {
  try {
    const status = whatsappService.getStatus();

    if (status.connected) {
      return res.status(400).json({ error: 'Already connected' });
    }

    if (!status.qrCode) {
      return res.status(202).json({ message: 'QR code not ready yet, try again in a few seconds' });
    }

    // Convert QR string to image
    const qrImage = await QRCode.toDataURL(status.qrCode, { width: 256 });
    res.json({ qrCode: qrImage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Initialize WhatsApp (start the client)
router.post('/initialize', adminOnly, async (req: Request, res: Response) => {
  try {
    if (whatsappService.getStatus().connected) {
      return res.json({ message: 'Already connected' });
    }

    if (whatsappService.isInitializing()) {
      return res.json({ message: 'Already initializing' });
    }

    // Start initialization in background
    whatsappService.initialize();
    res.json({ message: 'Initializing WhatsApp, check /qr for QR code' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect WhatsApp
router.post('/disconnect', adminOnly, async (req: Request, res: Response) => {
  try {
    await whatsappService.disconnect();
    res.json({ message: 'Disconnected' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
