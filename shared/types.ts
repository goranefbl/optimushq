// ---- DB Row Types ----

export interface Project {
  id: string;
  name: string;
  description: string;
  path: string | null;
  git_origin_url: string;
  git_push_disabled: number;
  git_protected_branches: string;
  color: string;
  auto_summarize: number;
  dev_port: number | null;
  server_config: string;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  name: string;
  system_prompt: string;
  icon: string;
  is_default: number;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface Skill {
  id: string;
  name: string;
  slug: string;
  description: string;
  prompt: string;
  is_global: number;
  scope: 'global' | 'project';
  project_id: string | null;
  project_ids: string[];
  source_url: string | null;
  icon: string;
  globs: string | null; // JSON array string
  created_at: string;
  updated_at: string;
}

export type SessionStatus = 'backlog' | 'in_progress' | 'review' | 'done';

export type PermissionMode = 'explore' | 'ask' | 'execute';

export interface Session {
  id: string;
  project_id: string;
  agent_id: string;
  title: string;
  status: SessionStatus;
  status_updated_at: string;
  mode: PermissionMode;
  created_at: string;
  updated_at: string;
}

export interface ActivityLog {
  id: string;
  session_id: string;
  action: string;
  actor: 'user' | 'ai';
  from_status: SessionStatus | null;
  to_status: SessionStatus | null;
  created_at: string;
  // joined fields
  session_title?: string;
  project_name?: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_use?: string; // JSON string of tool interactions
  interrupted?: number;
  created_at: string;
}

export interface Memory {
  id: string;
  session_id: string;
  summary: string;
  pinned_facts: string; // JSON array of strings
  created_at: string;
  updated_at: string;
}

export type MemoryCategory = 'decision' | 'feature' | 'bug' | 'content' | 'todo' | 'context';

export interface MemoryEntry {
  id: string;
  project_id: string;
  session_id: string | null;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string;
  created_at: string;
  project_name?: string;
}

export interface SessionSkill {
  session_id: string;
  skill_id: string;
  enabled: number;
}

export type ApiAuthType = 'none' | 'bearer' | 'header' | 'query' | 'basic';

export interface Api {
  id: string;
  name: string;
  description: string;
  base_url: string;
  auth_type: ApiAuthType;
  auth_config: string;
  spec: string;
  scope: 'global' | 'project';
  project_ids: string[];
  icon: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface McpServer {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string;   // JSON array string
  env: string;    // JSON object string
  enabled: number;
  is_default: number;
  is_internal: number;
  created_at: string;
  updated_at: string;
}

// ---- Git Types ----

export interface GitFileStatus {
  path: string;
  status: string; // 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '??' etc.
  staged: boolean;
}

export interface GitStatusResult {
  isGitRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  files?: GitFileStatus[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitDiffResult {
  path: string;
  diff: string;
}

// ---- WebSocket Message Envelopes ----

export interface WsSendMessage {
  type: 'chat:send';
  sessionId: string;
  content: string;
  images?: string[]; // file paths of uploaded images
  model?: string;    // per-message model override
  thinking?: boolean; // enable extended thinking
  mode?: PermissionMode; // permission mode: explore, ask, execute
}

export interface WsStopMessage {
  type: 'chat:stop';
  sessionId: string;
}

export interface WsChunkMessage {
  type: 'chat:chunk';
  sessionId: string;
  content: string;
}

export interface WsToolUseMessage {
  type: 'chat:tool_use';
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface WsToolResultMessage {
  type: 'chat:tool_result';
  sessionId: string;
  tool: string;
  result: string;
}

export interface WsDoneMessage {
  type: 'chat:done';
  sessionId: string;
  messageId: string;
  cost?: number;
  interrupted?: boolean;
  hasMore?: boolean;
}

export interface WsErrorMessage {
  type: 'chat:error';
  sessionId: string;
  error: string;
}

export interface WsStreamingMessage {
  type: 'chat:streaming';
  sessionIds: string[];
}

export interface WsQueuedMessage {
  type: 'chat:queued';
  sessionId: string;
}

export interface WsSkillsMessage {
  type: 'chat:skills';
  sessionId: string;
  skills: string[];
}

export type WsClientMessage = WsSendMessage | WsStopMessage;
export type WsServerMessage =
  | WsChunkMessage
  | WsToolUseMessage
  | WsToolResultMessage
  | WsDoneMessage
  | WsErrorMessage
  | WsStreamingMessage
  | WsQueuedMessage
  | WsSkillsMessage;
