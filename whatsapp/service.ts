import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Generate MCP config path in temp directory (will be populated by caller)
const MCP_CONFIG_PATH = path.join(os.tmpdir(), 'whatsapp-mcp-config.json');

export interface WhatsAppStatus {
  connected: boolean;
  phoneNumber?: string;
  qrCode?: string;
}

class WhatsAppService extends EventEmitter {
  private client: InstanceType<typeof Client> | null = null;
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
    if (this.client || this.initializing) return;
    this.initializing = true;

    console.log('[WhatsApp] Initializing...');

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });

    this.client.on('qr', (qr: string) => {
      console.log('[WhatsApp] QR code received');
      this.qrCode = qr;
      this.emit('qr', qr);
    });

    this.client.on('ready', async () => {
      console.log('[WhatsApp] Client ready');
      this.status.connected = true;
      try {
        const info = this.client?.info;
        this.status.phoneNumber = info?.wid?.user || 'Unknown';
      } catch {
        this.status.phoneNumber = 'Connected';
      }
      this.qrCode = null;
      this.emit('ready');
    });

    this.client.on('authenticated', () => {
      console.log('[WhatsApp] Authenticated');
    });

    this.client.on('auth_failure', (msg: string) => {
      console.error('[WhatsApp] Auth failed:', msg);
      this.status.connected = false;
      this.emit('auth_failure', msg);
    });

    this.client.on('disconnected', (reason: string) => {
      console.log('[WhatsApp] Disconnected:', reason);
      this.status.connected = false;
      this.status.phoneNumber = undefined;
      this.emit('disconnected', reason);
    });

    this.client.on('message', async (msg: any) => {
      await this.handleMessage(msg);
    });

    try {
      await this.client.initialize();
    } catch (err) {
      console.error('[WhatsApp] Failed to initialize:', err);
      this.initializing = false;
      throw err;
    }

    this.initializing = false;
  }

  private async handleMessage(msg: any): Promise<void> {
    // Ignore group messages
    if (msg.from.includes('@g.us')) return;

    const phone = msg.from.replace('@c.us', '');
    console.log(`[WhatsApp] Message from ${phone}: ${msg.body}`);

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
        await msg.reply('Your phone number is not registered. Please add your phone number in your OptimusHQ profile settings.');
        return;
      }

      // Send typing indicator
      const chat = await msg.getChat();
      await chat.sendStateTyping();

      // Process with Claude
      const response = await this.askClaude(msg.body, phone, userId);
      await msg.reply(response);

      console.log(`[WhatsApp] Reply to ${phone}: ${response.substring(0, 100)}...`);
    } catch (err: any) {
      console.error('[WhatsApp] Error handling message:', err);
      await msg.reply('Sorry, I encountered an error. Please try again.');
    }
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

    // Get MCP config path from generator (populated by server with DB access)
    const mcpConfigPath = this.onGetMcpConfig ? this.onGetMcpConfig() : MCP_CONFIG_PATH;

    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--model', 'sonnet',
        '--dangerously-skip-permissions',
        '--mcp-config', mcpConfigPath,
        '--system-prompt', systemPrompt,
        '--max-turns', '5',
        '--', question,
      ];

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
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // Ignore logout errors
      }
      try {
        await this.client.destroy();
      } catch {
        // Ignore destroy errors
      }
      this.client = null;
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
