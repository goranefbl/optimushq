import { WebSocket, WebSocketServer } from 'ws';
import { v4 as uuid, v4 as randomUUID } from 'uuid';
import { spawn as cpSpawn } from 'child_process';
import { getDb } from '../db/connection.js';
import { assembleContext } from '../claude/context.js';
import { spawnClaude, killProcess } from '../claude/spawn.js';
import type { WsClientMessage, WsServerMessage, PermissionMode } from '../../../shared/types.js';

// Track actively streaming sessions
const streamingSessions = new Set<string>();

// Message queue for messages sent while agent is working
interface QueuedMessage {
  content: string;
  images?: string[];
  model?: string;
  thinking?: boolean;
  mode?: PermissionMode;
}
const messageQueue = new Map<string, QueuedMessage[]>();

let wssRef: WebSocketServer | null = null;

// Per-connection user info
interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  userRole?: string;
  impersonateUserId?: string; // Admin impersonating another user
}

function send(ws: WebSocket, msg: WsServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToUser(userId: string, msg: WsServerMessage) {
  if (!wssRef) return;
  const data = JSON.stringify(msg);
  for (const client of wssRef.clients) {
    const authClient = client as AuthenticatedWebSocket;
    if (authClient.readyState === WebSocket.OPEN) {
      // Send to the user directly, or to admins impersonating this user
      if (authClient.userId === userId || authClient.impersonateUserId === userId) {
        authClient.send(data);
      }
    }
  }
}

function broadcast(msg: WsServerMessage) {
  if (!wssRef) return;
  const data = JSON.stringify(msg);
  for (const client of wssRef.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/** Get the owner user_id for a session */
function getSessionOwner(sessionId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sessionId) as { user_id: string } | undefined;
  return row?.user_id || null;
}

/** Broadcast a message only to the owner of a session */
function broadcastToSessionOwner(sessionId: string, msg: WsServerMessage) {
  const ownerId = getSessionOwner(sessionId);
  if (ownerId) {
    broadcastToUser(ownerId, msg);
  } else {
    broadcast(msg);
  }
}

async function autoSummarize(sessionId: string) {
  try {
    const db = getDb();

    // Check project's auto_summarize flag
    const session = db.prepare(
      'SELECT p.auto_summarize FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?'
    ).get(sessionId) as { auto_summarize: number } | undefined;
    if (!session || !session.auto_summarize) return;

    // Only summarize every 5 messages to avoid excessive API calls
    const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId) as { c: number };
    if (msgCount.c < 4 || msgCount.c % 5 !== 0) return;

    // Get last 20 messages
    const messages = db.prepare(
      'SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 20'
    ).all(sessionId) as { role: string; content: string }[];
    if (messages.length < 2) return;

    const transcript = messages
      .reverse()
      .map(m => `${m.role}: ${m.content.substring(0, 500)}`)
      .join('\n\n');

    const prompt = `Summarize this conversation for context continuity. Focus on what was discussed, decisions made, and current state. Under 200 words.\n\n${transcript}`;

    const summary = await new Promise<string>((resolve, reject) => {
      const args = [
        '--print',
        '--model', 'haiku',
        '--dangerously-skip-permissions',
        '--', prompt,
      ];

      const child = cpSpawn('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env, HOME: process.env.HOME || '/home/claude' },
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else reject(new Error(stderr || `exit code ${code}`));
      });
      child.on('error', reject);
    });

    db.prepare("UPDATE memory SET summary = ?, updated_at = datetime('now') WHERE session_id = ?")
      .run(summary, sessionId);
  } catch (err) {
    console.error('[MEMORY] Auto-summarize failed:', err);
  }
}

async function extractMemoryEntries(sessionId: string) {
  try {
    const db = getDb();

    // Only run every 10 messages, minimum 10
    const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId) as { c: number };
    if (msgCount.c < 10 || msgCount.c % 10 !== 0) return;

    // Get session's project_id
    const session = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as { project_id: string } | undefined;
    if (!session) return;

    // Get last 10 messages
    const messages = db.prepare(
      'SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 10'
    ).all(sessionId) as { role: string; content: string }[];
    if (messages.length < 10) return;

    const transcript = messages
      .reverse()
      .map(m => `${m.role}: ${m.content.substring(0, 500)}`)
      .join('\n\n');

    const prompt = `Extract up to 3 important memory entries from this conversation segment. Each entry should capture a decision, feature, bug, todo, or important context.

Return ONLY a JSON array (no markdown, no explanation). Each object must have:
- "category": one of "decision", "feature", "bug", "content", "todo", "context"
- "title": short title (under 80 chars)
- "content": detailed description (1-3 sentences)
- "tags": array of 1-3 tag strings

If nothing notable, return an empty array [].

Conversation:
${transcript}`;

    const response = await new Promise<string>((resolve, reject) => {
      const args = [
        '--print',
        '--model', 'haiku',
        '--dangerously-skip-permissions',
        '--', prompt,
      ];

      const child = cpSpawn('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env, HOME: process.env.HOME || '/home/claude' },
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else reject(new Error(stderr || `exit code ${code}`));
      });
      child.on('error', reject);
    });

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = response;
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const entries = JSON.parse(jsonStr) as { category: string; title: string; content: string; tags: string[] }[];
    if (!Array.isArray(entries) || entries.length === 0) return;

    const validCategories = ['decision', 'feature', 'bug', 'content', 'todo', 'context'];
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    for (const entry of entries.slice(0, 3)) {
      if (!validCategories.includes(entry.category) || !entry.title || !entry.content) continue;

      // Deduplicate by title within 24h
      const existing = db.prepare(
        'SELECT id FROM memory_entries WHERE project_id = ? AND title = ? AND created_at > ?'
      ).get(session.project_id, entry.title, oneDayAgo);
      if (existing) continue;

      const entryId = randomUUID();
      const tags = JSON.stringify(entry.tags || []);
      db.prepare('INSERT INTO memory_entries (id, project_id, session_id, category, title, content, tags) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(entryId, session.project_id, sessionId, entry.category, entry.title, entry.content, tags);
    }

    console.log('[MEMORY] Extracted memory entries for session', sessionId);
  } catch (err) {
    console.error('[MEMORY] Auto-extract memory entries failed:', err);
  }
}

/** Authenticate a WebSocket token, return user info or null */
export function authenticateWsToken(token: string): { id: string; role: string } | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT u.id, u.role FROM auth_tokens t JOIN users u ON t.user_id = u.id WHERE t.token = ?
  `).get(token) as { id: string; role: string } | undefined;
  return row || null;
}

export function setupWebSocket(wss: WebSocketServer) {
  wssRef = wss;
  wss.on('connection', (ws, req) => {
    const authWs = ws as AuthenticatedWebSocket;

    // Authenticate via token query param
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (token) {
      const user = authenticateWsToken(token);
      if (user) {
        authWs.userId = user.id;
        authWs.userRole = user.role;
        // Handle admin impersonation
        const impersonateId = url.searchParams.get('impersonate');
        if (impersonateId && user.role === 'admin') {
          authWs.impersonateUserId = impersonateId;
        }
      } else {
        ws.close(4001, 'Invalid token');
        return;
      }
    } else {
      ws.close(4001, 'Token required');
      return;
    }

    console.log(`[WS] Client connected, userId=${authWs.userId}`);
    // Inform new client of any active streaming sessions
    if (streamingSessions.size > 0) {
      send(ws, { type: 'chat:streaming', sessionIds: Array.from(streamingSessions) });
    }
    ws.on('message', (raw) => {
      console.log('[WS] Received:', raw.toString().substring(0, 200));
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.log('[WS] Failed to parse message');
        return;
      }

      // Validate session ownership for all session-related messages
      if (msg.sessionId && authWs.userId) {
        const owner = getSessionOwner(msg.sessionId);
        if (owner && owner !== authWs.userId && authWs.userRole !== 'admin') {
          send(ws, { type: 'chat:error', sessionId: msg.sessionId, error: 'Access denied' });
          return;
        }
      }

      if (msg.type === 'chat:send') {
        console.log(`[WS] chat:send session=${msg.sessionId} content="${msg.content.substring(0, 50)}" images=${(msg.images || []).length} model=${msg.model || 'default'} thinking=${!!msg.thinking} mode=${msg.mode || 'execute'}`);
        try {
          handleChatSend(ws, msg.sessionId, msg.content, msg.images, msg.model, msg.thinking, msg.mode);
        } catch (err: any) {
          console.error(`[WS] handleChatSend error:`, err);
          send(ws, { type: 'chat:error', sessionId: msg.sessionId, error: err.message });
        }
      } else if (msg.type === 'chat:stop') {
        // Clear the queue so queued messages are discarded on stop
        messageQueue.delete(msg.sessionId);
        killProcess(msg.sessionId);
      }
    });
    ws.on('close', () => console.log('[WS] Client disconnected'));
  });
}

function handleChatSend(ws: WebSocket, sessionId: string, content: string, images?: string[], model?: string, thinking?: boolean, mode?: PermissionMode) {
  // If already streaming, queue without saving to DB yet (save when dequeued
  // so the user message appears after the current assistant response)
  if (streamingSessions.has(sessionId)) {
    const queue = messageQueue.get(sessionId) || [];
    queue.push({ content, images, model, thinking, mode });
    messageQueue.set(sessionId, queue);
    console.log(`[CHAT] Queued message for session ${sessionId}, queue length=${queue.length}`);
    broadcastToSessionOwner(sessionId, { type: 'chat:queued', sessionId });
    return;
  }

  saveUserMessage(sessionId, content);
  spawnForSession(sessionId, content, images, model, thinking, mode);
}

export function saveUserMessage(sessionId: string, content: string) {
  const db = getDb();
  const userMsgId = uuid();
  db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
    .run(userMsgId, sessionId, 'user', content);
  db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);
  console.log(`[CHAT] Saved user message ${userMsgId}`);
}

export function spawnForSession(sessionId: string, content: string, images?: string[], model?: string, thinking?: boolean, mode?: PermissionMode) {
  const db = getDb();

  // Get project path for this session (used for path validation in hooks)
  const sessionProject = db.prepare(`
    SELECT p.path FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?
  `).get(sessionId) as { path: string | null } | undefined;
  const projectPath = sessionProject?.path || null;

  // Build message for Claude -- append image references if present
  let claudeContent = content;
  if (images && images.length > 0) {
    const imageRefs = images.map(p => `[Attached image: ${p}]`).join('\n');
    claudeContent = `${content}\n\n${imageRefs}\n\nThe user attached ${images.length} image(s). Read them using the file read tool to see what was shared.`;
  }

  // Assemble context
  let ctx: ReturnType<typeof assembleContext>;
  try {
    ctx = assembleContext(sessionId, claudeContent, model, mode);
    console.log(`[CHAT] Context assembled: model=${ctx.model}, systemPrompt=${ctx.systemPrompt.substring(0, 80)}...`);
    console.log(`[CHAT] Full message length: ${ctx.fullMessage.length}`);
  } catch (err: any) {
    console.error(`[CHAT] Context assembly error:`, err.message);
    broadcastToSessionOwner(sessionId, { type: 'chat:error', sessionId, error: err.message });
    return;
  }

  const assistantMsgId = uuid();
  let fullText = '';
  const toolInteractions: { tool: string; input: unknown; result?: string }[] = [];

  streamingSessions.add(sessionId);

  // Notify client of active skills
  if (ctx.activeSkills.length > 0) {
    broadcastToSessionOwner(sessionId, { type: 'chat:skills', sessionId, skills: ctx.activeSkills });
  }

  console.log(`[CHAT] Spawning claude... projectPath=${projectPath}`);
  spawnClaude(
    sessionId,
    ctx.fullMessage,
    {
      systemPrompt: ctx.systemPrompt,
      model: ctx.model,
      thinking: !!thinking,
      allowedTools: ctx.allowedTools,
      disallowedTools: ctx.disallowedTools,
      maxTurns: ctx.maxTurns,
    },
    (event) => {
      switch (event.type) {
        case 'text':
          fullText += event.content || '';
          broadcastToSessionOwner(sessionId, { type: 'chat:chunk', sessionId, content: event.content || '' });
          break;

        case 'tool_use':
          toolInteractions.push({ tool: event.tool || '', input: event.toolInput || {} });
          broadcastToSessionOwner(sessionId, {
            type: 'chat:tool_use',
            sessionId,
            tool: event.tool || '',
            input: event.toolInput || {},
          });
          break;

        case 'tool_result': {
          // Attach result to last tool interaction
          const last = toolInteractions[toolInteractions.length - 1];
          if (last) last.result = event.toolResult;
          broadcastToSessionOwner(sessionId, {
            type: 'chat:tool_result',
            sessionId,
            tool: event.tool || '',
            result: event.toolResult || '',
          });
          break;
        }

        case 'done': {
          streamingSessions.delete(sessionId);
          const finalText = event.content || fullText;
          const isInterrupted = !!event.interrupted;

          // Save assistant message with tool interactions and interrupted flag
          db.prepare('INSERT OR REPLACE INTO messages (id, session_id, role, content, tool_use, interrupted) VALUES (?, ?, ?, ?, ?, ?)')
            .run(
              assistantMsgId,
              sessionId,
              'assistant',
              finalText,
              toolInteractions.length > 0 ? JSON.stringify(toolInteractions) : null,
              isInterrupted ? 1 : 0,
            );

          // Check if there are queued messages remaining
          const queue = messageQueue.get(sessionId) || [];
          const hasMore = !isInterrupted && queue.length > 0;

          broadcastToSessionOwner(sessionId, {
            type: 'chat:done',
            sessionId,
            messageId: assistantMsgId,
            cost: event.cost,
            interrupted: isInterrupted || undefined,
            hasMore: hasMore || undefined,
          });

          if (!isInterrupted) {
            // Auto-update memory (fire-and-forget)
            autoSummarize(sessionId);
            extractMemoryEntries(sessionId);

            // Auto-title on first exchange
            const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId) as { c: number };
            if (msgCount.c === 2) {
              const title = content.substring(0, 60) + (content.length > 60 ? '...' : '');
              db.prepare("UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, sessionId);
            }

            // Process next queued message if any
            if (queue.length > 0) {
              const next = queue.shift()!;
              if (queue.length === 0) {
                messageQueue.delete(sessionId);
              }
              saveUserMessage(sessionId, next.content);
              setTimeout(() => spawnForSession(sessionId, next.content, next.images, next.model, next.thinking, next.mode), 0);
            }
          } else {
            // Interrupted: discard any queued messages
            messageQueue.delete(sessionId);
          }
          break;
        }

        case 'error':
          streamingSessions.delete(sessionId);
          messageQueue.delete(sessionId);
          broadcastToSessionOwner(sessionId, { type: 'chat:error', sessionId, error: event.content || 'Unknown error' });
          break;
      }
    },
    projectPath,
  );
}
