import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getDb } from '../db/connection.js';
import { getToken } from '../routes/settings.js';
import { decryptEnv } from '../routes/mcps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'mcp-config.json');
const activeProcesses = new Map<string, ChildProcess>();
const killedSessions = new Set<string>();

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

  const config = JSON.stringify({ mcpServers }, null, 2);
  fs.writeFileSync(MCP_CONFIG_PATH, config, 'utf-8');
  return MCP_CONFIG_PATH;
}

export interface SpawnOptions {
  systemPrompt: string;
  model?: string;
  thinking?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
}

export interface StreamEvent {
  type: 'init' | 'text' | 'tool_use' | 'tool_result' | 'done' | 'error';
  content?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  cost?: number;
  sessionId?: string;
  interrupted?: boolean;
}

type EventHandler = (event: StreamEvent) => void;

export function spawnClaude(
  sessionId: string,
  userMessage: string,
  options: SpawnOptions,
  onEvent: EventHandler,
  projectPath?: string | null,
) {
  // Kill any existing process for this session
  killProcess(sessionId);

  // Generate mcp-config.json from enabled MCP servers in DB
  const mcpConfigPath = generateMcpConfig();

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--mcp-config', mcpConfigPath,
    '--system-prompt', options.systemPrompt,
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.thinking) {
    args.push('--settings', JSON.stringify({ alwaysThinkingEnabled: true }));
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push('--allowedTools', options.allowedTools.join(','));
  }

  if (options.disallowedTools && options.disallowedTools.length > 0) {
    args.push('--disallowedTools', options.disallowedTools.join(','));
  }

  if (options.maxTurns) {
    args.push('--max-turns', String(options.maxTurns));
  }

  // Pass user message as the prompt argument; use -- to prevent misparse
  args.push('--', userMessage);

  console.log(`[SPAWN] Running: claude ${args.map(a => a.length > 80 ? a.substring(0, 80) + '...' : a).join(' ')}`);
  console.log(`[SPAWN] Args count: ${args.length}`);

  // Get session's user_id for per-user settings
  const db = getDb();
  const sessionOwner = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sessionId) as { user_id: string } | undefined;
  const sessionUserId = sessionOwner?.user_id;

  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    HOME: process.env.HOME || '/home/claude',
  };
  if (sessionUserId) {
    spawnEnv.USER_ID = sessionUserId;
  }
  spawnEnv.SESSION_ID = sessionId;
  // Pass project path for hook-based path validation
  if (projectPath) {
    spawnEnv.PROJECT_PATH = projectPath;
  }
  const githubToken = getToken('token_github', sessionUserId);
  if (githubToken) {
    spawnEnv.GITHUB_TOKEN = githubToken;
  }

  const child = spawn('claude', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: spawnEnv,
    cwd: projectPath || undefined,
  });

  console.log(`[SPAWN] Process started, pid=${child.pid}`);
  activeProcesses.set(sessionId, child);

  let buffer = '';
  let fullText = '';
  let stderrText = '';
  const toolInteractions: { tool: string; input: unknown; result?: string }[] = [];

  child.stdout.on('data', (data: Buffer) => {
    const chunk = data.toString();
    console.log(`[SPAWN] stdout chunk (${chunk.length} bytes): ${chunk.substring(0, 200)}`);
    buffer += chunk;

    // Process complete lines (newline-delimited JSON)
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        console.log(`[SPAWN] Parsed event type=${event.type} subtype=${event.subtype || ''}`);
        processEvent(event, sessionId, onEvent, (t) => { fullText += t; }, toolInteractions);
      } catch (e: any) {
        console.log(`[SPAWN] Failed to parse line: ${line.substring(0, 100)} err=${e.message}`);
      }
    }
  });

  child.stderr.on('data', (data: Buffer) => {
    const chunk = data.toString();
    console.log(`[SPAWN] stderr: ${chunk.substring(0, 500)}`);
    stderrText += chunk;
  });

  child.on('close', (code) => {
    console.log(`[SPAWN] Process closed, code=${code}, fullText.length=${fullText.length}`);
    activeProcesses.delete(sessionId);

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        processEvent(event, sessionId, onEvent, (t) => { fullText += t; }, toolInteractions);
      } catch {
        // ignore
      }
    }

    // If this session was killed by the user, emit a synthetic done so the handler
    // can clean up streamingSessions and process any queued messages
    if (killedSessions.has(sessionId)) {
      killedSessions.delete(sessionId);
      console.log(`[SPAWN] Emitting synthetic done for killed session ${sessionId}, fullText.length=${fullText.length}`);
      onEvent({ type: 'done', content: fullText, interrupted: true });
      return;
    }

    if (code !== 0 && code !== null && !fullText) {
      console.log(`[SPAWN] Error exit. stderr: ${stderrText}`);
      onEvent({ type: 'error', content: stderrText || `Process exited with code ${code}` });
    }
  });

  child.on('error', (err) => {
    console.error(`[SPAWN] Process error:`, err.message);
    activeProcesses.delete(sessionId);
    onEvent({ type: 'error', content: err.message });
  });
}

function processEvent(
  raw: any,
  sessionId: string,
  onEvent: EventHandler,
  appendText: (t: string) => void,
  toolInteractions: { tool: string; input: unknown; result?: string }[],
) {
  if (raw.type === 'system' && raw.subtype === 'init') {
    onEvent({ type: 'init', sessionId: raw.session_id });
    return;
  }

  if (raw.type === 'assistant' && raw.message?.content) {
    for (const block of raw.message.content) {
      if (block.type === 'text' && block.text) {
        appendText(block.text);
        onEvent({ type: 'text', content: block.text });
      } else if (block.type === 'tool_use') {
        toolInteractions.push({ tool: block.name, input: block.input });
        onEvent({
          type: 'tool_use',
          tool: block.name,
          toolInput: block.input,
        });
      }
    }
  }

  if (raw.type === 'user') {
    // Handle tool results - CLI sends them as message.content array with tool_result blocks
    if (raw.message?.content) {
      for (const block of raw.message.content) {
        if (block.type === 'tool_result') {
          const result = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content || '');
          const last = toolInteractions[toolInteractions.length - 1];
          if (last) last.result = result;
          onEvent({
            type: 'tool_result',
            tool: last?.tool || 'unknown',
            toolResult: result.substring(0, 2000),
          });
        }
      }
    } else if (raw.tool_use_result) {
      // Legacy format fallback
      const result = typeof raw.tool_use_result.result === 'string'
        ? raw.tool_use_result.result
        : JSON.stringify(raw.tool_use_result.result);
      const last = toolInteractions[toolInteractions.length - 1];
      if (last) last.result = result;
      onEvent({
        type: 'tool_result',
        tool: last?.tool || 'unknown',
        toolResult: result.substring(0, 2000),
      });
    }
  }

  if (raw.type === 'result') {
    onEvent({
      type: 'done',
      content: raw.result || '',
      cost: raw.total_cost_usd,
    });
  }
}

export function killProcess(sessionId: string): boolean {
  const child = activeProcesses.get(sessionId);
  if (child) {
    killedSessions.add(sessionId);
    child.kill('SIGTERM');
    activeProcesses.delete(sessionId);
    return true;
  }
  return false;
}

export function getToolInteractions(): string {
  return ''; // Placeholder - interactions are tracked per-spawn call now
}
