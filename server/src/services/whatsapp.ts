import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '..', '..', '..', 'whatsapp-auth');

export interface WhatsAppStatus {
  connected: boolean;
  phoneNumber?: string;
  qrCode?: string;
}

class WhatsAppService extends EventEmitter {
  private socket: WASocket | null = null;
  private status: WhatsAppStatus = { connected: false };
  private qrCode: string | null = null;
  private initializing = false;
  private onUserLookup: ((phone: string) => Promise<{ userId: string; projectId: string } | null>) | null = null;
  private onGetMcpConfig: (() => string) | null = null;

  setUserLookup(fn: (phone: string) => Promise<{ userId: string; projectId: string } | null>) {
    this.onUserLookup = fn;
  }

  setMcpConfigGenerator(fn: () => string) {
    this.onGetMcpConfig = fn;
  }

  getStatus(): WhatsAppStatus {
    return {
      connected: this.status.connected,
      phoneNumber: this.status.phoneNumber,
      qrCode: this.status.connected ? undefined : this.qrCode || undefined,
    };
  }

  async initialize(): Promise<void> {
    if (this.socket || this.initializing) return;
    this.initializing = true;

    console.log('[WhatsApp] Initializing with Baileys...');

    // Ensure auth directory exists
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    this.socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });

    this.socket.ev.on('creds.update', saveCreds);

    this.socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[WhatsApp] QR code received');
        this.qrCode = qr;
        this.emit('qr', qr);
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('[WhatsApp] Connection closed, reconnect:', shouldReconnect);

        this.status.connected = false;
        this.status.phoneNumber = undefined;
        this.emit('disconnected', lastDisconnect?.error?.message || 'Connection closed');

        if (shouldReconnect) {
          this.socket = null;
          this.initializing = false;
          setTimeout(() => this.initialize(), 3000);
        }
      } else if (connection === 'open') {
        console.log('[WhatsApp] Connected');
        this.status.connected = true;
        this.qrCode = null;

        // Get phone number from socket
        const user = this.socket?.user;
        if (user) {
          this.status.phoneNumber = user.id.split(':')[0].split('@')[0];
        }

        this.emit('ready');
      }
    });

    this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        await this.handleMessage(msg);
      }
    });

    this.initializing = false;
  }

  private async handleMessage(msg: proto.IWebMessageInfo): Promise<void> {
    const jid = msg.key?.remoteJid;
    if (!jid || jid.includes('@g.us')) return; // Ignore groups

    // Handle both @s.whatsapp.net and @lid formats
    let phone: string | null = null;

    if (jid.endsWith('@s.whatsapp.net')) {
      // Standard phone number format
      phone = jid.replace('@s.whatsapp.net', '').split(':')[0];
    } else if (jid.endsWith('@lid')) {
      // LID format - try to get phone from verifiedBizName or pushName, or look up contact
      // First check if we can get PN from the socket's store
      try {
        // Try to get phone number using socket's onWhatsApp query
        const lid = jid.replace('@lid', '');
        // For now, store and lookup by LID directly
        phone = lid;
        console.log(`[WhatsApp] LID message from ${lid}, looking up by LID`);
      } catch (err) {
        console.log(`[WhatsApp] Could not resolve LID to phone: ${err}`);
      }
    }

    if (!phone) {
      console.log(`[WhatsApp] Could not extract phone from jid: ${jid}`);
      return;
    }
    const text = msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text ||
                 '';

    if (!text) return;

    console.log(`[WhatsApp] Message from ${phone}: ${text}`);

    try {
      // Look up user by phone number
      let userId: string | null = null;
      let projectId: string | null = null;

      if (this.onUserLookup) {
        const result = await this.onUserLookup(phone);
        if (result) {
          userId = result.userId;
          projectId = result.projectId;
        }
      }

      if (!userId) {
        await this.sendMessage(jid, `Your ID is not registered.\n\nYour WhatsApp ID: ${phone}\n\nGo to Settings > WhatsApp in OptimusHQ and enter this ID in the phone field, then save.`);
        return;
      }

      // Send typing indicator
      await this.socket?.presenceSubscribe(jid);
      await this.socket?.sendPresenceUpdate('composing', jid);

      // Process with Claude
      const response = await this.askClaude(text, phone, userId);

      await this.socket?.sendPresenceUpdate('paused', jid);
      await this.sendMessage(jid, response);

      console.log(`[WhatsApp] Reply to ${phone}: ${response.substring(0, 100)}...`);
    } catch (err: any) {
      console.error('[WhatsApp] Error handling message:', err);
      await this.sendMessage(jid, 'Sorry, I encountered an error. Please try again.');
    }
  }

  private async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.socket) return;
    await this.socket.sendMessage(jid, { text });
  }

  private async askClaude(question: string, phone: string, userId: string): Promise<string> {
    const systemPrompt = `You are a helpful assistant providing status updates on projects via WhatsApp.
You have access to project-manager MCP tools to check project status, sessions, and activity.

When asked about projects:
- Use get_project_status to check specific project activity
- Use list_projects to see all available projects
- Use search_memory to find relevant information

Keep responses concise for WhatsApp (under 1000 chars when possible).
Use plain text formatting, no markdown.

User ID: ${userId}
Phone: ${phone}`;

    // Get MCP config path from generator
    const mcpConfigPath = this.onGetMcpConfig ? this.onGetMcpConfig() : '';

    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--model', 'sonnet',
        '--dangerously-skip-permissions',
        '--system-prompt', systemPrompt,
        '--max-turns', '5',
        '--', question,
      ];

      if (mcpConfigPath) {
        args.splice(4, 0, '--mcp-config', mcpConfigPath);
      }

      const child = spawn('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env, HOME: process.env.HOME || '/home/claude', USER_ID: userId },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `Claude exited with code ${code}`));
        }
      });

      child.on('error', reject);

      // Timeout after 2 minutes
      setTimeout(() => {
        child.kill();
        reject(new Error('Request timed out'));
      }, 120000);
    });
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      await this.socket.logout();
      this.socket = null;
    }
    this.status = { connected: false };
    this.qrCode = null;
    this.initializing = false;
  }

  isInitializing(): boolean {
    return this.initializing;
  }
}

export const whatsappService = new WhatsAppService();
