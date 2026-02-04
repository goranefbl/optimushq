import React, { useState, useEffect, useCallback, useContext } from 'react';
import { api } from '../api/http';
import PageShell from '../components/layout/PageShell';
import {
  Settings, Shield, Key, Save, Eye, EyeOff, Check, X,
  Plus, Trash2, ToggleLeft, ToggleRight, Palette, Cpu, Zap, MessageSquare,
  Phone, Loader2, Power, PowerOff, RefreshCw
} from 'lucide-react';
import type { PermissionMode } from '../../../shared/types';
import { useTheme } from '../hooks/useTheme';
import { THEME_COLORS, type ThemeColorName } from '../theme/colors';
import { AuthContext } from '../App';

// All Claude Code built-in tools
const ALL_TOOLS = [
  { name: 'Bash', description: 'Execute shell commands' },
  { name: 'Read', description: 'Read file contents' },
  { name: 'Write', description: 'Create or overwrite files' },
  { name: 'Edit', description: 'Make targeted edits to files' },
  { name: 'Glob', description: 'Find files by pattern' },
  { name: 'Grep', description: 'Search file contents' },
  { name: 'WebFetch', description: 'Fetch content from URLs' },
  { name: 'WebSearch', description: 'Search the web' },
  { name: 'NotebookEdit', description: 'Edit Jupyter notebooks' },
  { name: 'Task', description: 'Launch sub-agents' },
];

// MCP tools
const MCP_TOOLS = [
  { name: 'mcp__chrome-devtools__take_screenshot', description: 'Take browser screenshots' },
  { name: 'mcp__chrome-devtools__navigate_page', description: 'Navigate browser pages' },
  { name: 'mcp__chrome-devtools__click', description: 'Click browser elements' },
  { name: 'mcp__chrome-devtools__fill', description: 'Fill form inputs' },
  { name: 'mcp__chrome-devtools__take_snapshot', description: 'Take page snapshots' },
  { name: 'mcp__chrome-devtools__evaluate_script', description: 'Run JavaScript in browser' },
];

interface TokenConfig {
  key: string;
  label: string;
  placeholder: string;
}

const TOKENS: TokenConfig[] = [
  { key: 'token_github', label: 'GitHub Token', placeholder: 'ghp_xxxx or github_pat_xxxx' },
];

interface WhatsAppStatus {
  connected: boolean;
  phoneNumber?: string;
  qrCode?: string;
}

export default function ConfigPage() {
  const { role } = useContext(AuthContext);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [disallowedTools, setDisallowedTools] = useState<string[]>([]);
  const [toolMode, setToolMode] = useState<'all' | 'allowed' | 'disallowed'>('all');
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [showToken, setShowToken] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [customTool, setCustomTool] = useState('');
  const [defaultModel, setDefaultModel] = useState('sonnet');
  const [defaultThinking, setDefaultThinking] = useState(false);
  const [defaultMode, setDefaultMode] = useState<PermissionMode>('execute');
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSaved, setModelSaved] = useState(false);
  const { color: themeColor, setColor: setThemeColor, colorNames } = useTheme();

  // Profile state
  const [phone, setPhone] = useState('');
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneSaved, setPhoneSaved] = useState(false);

  // WhatsApp state (admin only)
  const [waStatus, setWaStatus] = useState<WhatsAppStatus | null>(null);
  const [waQrImage, setWaQrImage] = useState<string | null>(null);
  const [waLoading, setWaLoading] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    const data = await api.get<Record<string, any>>('/settings');
    setSettings(data);
    // Load tool settings
    if (data.allowed_tools) {
      const tools = JSON.parse(data.allowed_tools.value);
      if (tools.length > 0) {
        setAllowedTools(tools);
        setToolMode('allowed');
      }
    }
    if (data.disallowed_tools) {
      const tools = JSON.parse(data.disallowed_tools.value);
      if (tools.length > 0) {
        setDisallowedTools(tools);
        if (!data.allowed_tools || JSON.parse(data.allowed_tools.value).length === 0) {
          setToolMode('disallowed');
        }
      }
    }
    if (data.default_model?.value) setDefaultModel(data.default_model.value);
    if (data.default_thinking?.value) setDefaultThinking(data.default_thinking.value === 'true');
    if (data.default_mode?.value) setDefaultMode(data.default_mode.value as PermissionMode);
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  // Fetch profile (phone)
  useEffect(() => {
    api.get<{ phone: string | null }>('/auth/me').then(data => {
      if (data.phone) setPhone(data.phone);
    });
  }, []);

  const handleSavePhone = async () => {
    setPhoneSaving(true);
    try {
      await api.put('/auth/me', { phone });
      setPhoneSaved(true);
      setTimeout(() => setPhoneSaved(false), 2000);
    } finally {
      setPhoneSaving(false);
    }
  };

  // WhatsApp functions (admin only)
  const fetchWhatsAppStatus = useCallback(async () => {
    if (role !== 'admin') return;

    try {
      const status = await api.get<WhatsAppStatus>('/whatsapp/status');
      setWaStatus(status);
      setWaError(null);

      // If not connected, try to get QR code
      if (!status.connected) {
        try {
          const qr = await api.get<{ qrCode: string }>('/whatsapp/qr');
          setWaQrImage(qr.qrCode);
        } catch {
          setWaQrImage(null);
        }
      } else {
        setWaQrImage(null);
      }
    } catch (err: any) {
      setWaError(err.message || 'Failed to fetch WhatsApp status');
    }
  }, [role]);

  useEffect(() => {
    if (role === 'admin') {
      fetchWhatsAppStatus();
      // Poll every 5 seconds when waiting for QR scan
      const interval = setInterval(fetchWhatsAppStatus, 5000);
      return () => clearInterval(interval);
    }
  }, [role, fetchWhatsAppStatus]);

  const handleWhatsAppInit = async () => {
    setWaLoading(true);
    setWaError(null);
    try {
      await api.post('/whatsapp/initialize');
      // Wait a bit then refresh status
      setTimeout(fetchWhatsAppStatus, 2000);
    } catch (err: any) {
      setWaError(err.message || 'Failed to initialize WhatsApp');
    } finally {
      setWaLoading(false);
    }
  };

  const handleWhatsAppDisconnect = async () => {
    setWaLoading(true);
    setWaError(null);
    try {
      await api.post('/whatsapp/disconnect');
      setWaStatus({ connected: false });
      setWaQrImage(null);
    } catch (err: any) {
      setWaError(err.message || 'Failed to disconnect WhatsApp');
    } finally {
      setWaLoading(false);
    }
  };

  const handleSaveTools = async () => {
    setSaving(true);
    try {
      if (toolMode === 'all') {
        await api.put('/settings/allowed_tools', { value: '[]' });
        await api.put('/settings/disallowed_tools', { value: '[]' });
      } else if (toolMode === 'allowed') {
        await api.put('/settings/allowed_tools', { value: JSON.stringify(allowedTools) });
        await api.put('/settings/disallowed_tools', { value: '[]' });
      } else {
        await api.put('/settings/allowed_tools', { value: '[]' });
        await api.put('/settings/disallowed_tools', { value: JSON.stringify(disallowedTools) });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveToken = async (tokenKey: string) => {
    const value = tokenInputs[tokenKey];
    if (!value) return;
    await api.put(`/settings/${tokenKey}`, { value });
    setTokenInputs(prev => ({ ...prev, [tokenKey]: '' }));
    fetchSettings();
  };

  const handleDeleteToken = async (tokenKey: string) => {
    await api.del(`/settings/${tokenKey}`);
    fetchSettings();
  };

  const toggleTool = (toolName: string, list: 'allowed' | 'disallowed') => {
    if (list === 'allowed') {
      setAllowedTools(prev =>
        prev.includes(toolName) ? prev.filter(t => t !== toolName) : [...prev, toolName]
      );
    } else {
      setDisallowedTools(prev =>
        prev.includes(toolName) ? prev.filter(t => t !== toolName) : [...prev, toolName]
      );
    }
  };

  const addCustomTool = () => {
    if (!customTool.trim()) return;
    if (toolMode === 'allowed') {
      setAllowedTools(prev => [...prev, customTool.trim()]);
    } else {
      setDisallowedTools(prev => [...prev, customTool.trim()]);
    }
    setCustomTool('');
  };

  const handleSaveModel = async () => {
    setModelSaving(true);
    setModelSaved(false);
    try {
      await api.put('/settings/default_model', { value: defaultModel });
      await api.put('/settings/default_thinking', { value: String(defaultThinking) });
      await api.put('/settings/default_mode', { value: defaultMode });
      setModelSaved(true);
      setTimeout(() => setModelSaved(false), 2000);
    } finally {
      setModelSaving(false);
    }
  };

  const activeList = toolMode === 'allowed' ? allowedTools : disallowedTools;
  const activeToggle = toolMode === 'allowed' ? 'allowed' : 'disallowed';

  return (
    <PageShell>
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-8">
            <Settings size={22} className="text-accent-400" />
            <h1 className="text-xl font-bold text-white">Configuration</h1>
          </div>

          {/* Profile */}
          <section className="mb-10">
            <div className="flex items-center gap-2 mb-4">
              <Phone size={16} className="text-gray-400" />
              <h2 className="text-base font-semibold text-white">Profile</h2>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Set your phone number to receive WhatsApp messages from agents.
            </p>
            <div className="flex gap-3">
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Phone number (e.g., 38160123456)"
                className="flex-1 bg-[#161b22] border border-gray-800/60 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-accent-600/50 focus:outline-none"
              />
              <button
                onClick={handleSavePhone}
                disabled={phoneSaving}
                className="px-4 py-2.5 rounded-lg bg-accent-600 hover:bg-accent-500 text-white text-sm font-medium flex items-center gap-2 disabled:opacity-50"
              >
                {phoneSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {phoneSaved ? 'Saved!' : 'Save'}
              </button>
            </div>
            <p className="text-xs text-gray-600 mt-2">
              Enter your phone number in international format without + (e.g., 38160123456 for Serbia).
            </p>
          </section>

          {/* Theme Color */}
          <section className="mb-10">
            <div className="flex items-center gap-2 mb-4">
              <Palette size={16} className="text-gray-400" />
              <h2 className="text-base font-semibold text-white">Theme Color</h2>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Choose an accent color for the interface.
            </p>
            <div className="flex flex-wrap gap-3">
              {colorNames.map((name) => {
                const rgb = THEME_COLORS[name as ThemeColorName][500];
                const isSelected = themeColor === name;
                return (
                  <button
                    key={name}
                    onClick={() => setThemeColor(name as ThemeColorName)}
                    title={name}
                    className="relative w-8 h-8 rounded-full border-2 transition-all"
                    style={{
                      backgroundColor: `rgb(${rgb.replace(/ /g, ', ')})`,
                      borderColor: isSelected ? 'white' : 'transparent',
                    }}
                  >
                    {isSelected && (
                      <Check size={14} className="absolute inset-0 m-auto text-white drop-shadow" />
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Model Defaults */}
          <section className="mb-10">
            <div className="flex items-center gap-2 mb-4">
              <Cpu size={16} className="text-gray-400" />
              <h2 className="text-base font-semibold text-white">Model</h2>
            </div>
            <p className="text-sm text-gray-500 mb-5">
              Set the default model and thinking mode for new messages. These can be overridden per-message in the chat input.
            </p>

            {/* Model selection */}
            <div className="mb-5">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Default Model</label>
              <div className="flex gap-2">
                {[
                  { value: 'haiku', label: 'Haiku', desc: 'Fast & light' },
                  { value: 'sonnet', label: 'Sonnet', desc: 'Balanced' },
                  { value: 'opus', label: 'Opus', desc: 'Most capable' },
                ].map(m => (
                  <button
                    key={m.value}
                    onClick={() => setDefaultModel(m.value)}
                    className={`flex-1 px-4 py-3 rounded-lg border text-left transition-colors ${
                      defaultModel === m.value
                        ? 'bg-accent-600/15 border-accent-600/40 text-accent-400'
                        : 'bg-[#161b22] border-gray-800/60 text-gray-400 hover:border-gray-700 hover:text-gray-300'
                    }`}
                  >
                    <div className="text-sm font-medium">{m.label}</div>
                    <div className="text-xs text-gray-600 mt-0.5">{m.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Thinking toggle */}
            <div className="mb-5">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Extended Thinking</label>
              <button
                onClick={() => setDefaultThinking(!defaultThinking)}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg border w-full text-left transition-colors ${
                  defaultThinking
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                    : 'bg-[#161b22] border-gray-800/60 text-gray-400 hover:border-gray-700 hover:text-gray-300'
                }`}
              >
                {defaultThinking ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                <div>
                  <div className="text-sm font-medium">{defaultThinking ? 'Thinking Enabled' : 'Thinking Disabled'}</div>
                  <div className="text-xs text-gray-600 mt-0.5">Extended reasoning before responding — uses more tokens but produces higher quality answers</div>
                </div>
              </button>
            </div>

            {/* Default Mode */}
            <div className="mb-5">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Default Mode</label>
              <div className="flex gap-2">
                {([
                  { value: 'execute' as PermissionMode, label: 'Execute', desc: 'Full autonomous', icon: Zap },
                  { value: 'ask' as PermissionMode, label: 'Ask', desc: 'Confirms edits', icon: MessageSquare },
                  { value: 'explore' as PermissionMode, label: 'Explore', desc: 'Read-only', icon: Eye },
                ]).map(m => {
                  const Icon = m.icon;
                  return (
                    <button
                      key={m.value}
                      onClick={() => setDefaultMode(m.value)}
                      className={`flex-1 px-4 py-3 rounded-lg border text-left transition-colors ${
                        defaultMode === m.value
                          ? 'bg-accent-600/15 border-accent-600/40 text-accent-400'
                          : 'bg-[#161b22] border-gray-800/60 text-gray-400 hover:border-gray-700 hover:text-gray-300'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Icon size={14} />
                        <span className="text-sm font-medium">{m.label}</span>
                      </div>
                      <div className="text-xs text-gray-600 mt-0.5">{m.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              onClick={handleSaveModel}
              disabled={modelSaving}
              className="flex items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-700 disabled:opacity-50 rounded-md text-sm text-white font-medium transition-colors"
            >
              {modelSaved ? <Check size={14} /> : <Save size={14} />}
              {modelSaved ? 'Saved' : modelSaving ? 'Saving...' : 'Save Model Config'}
            </button>
          </section>

          {/* Tools Configuration */}
          <section className="mb-10">
            <div className="flex items-center gap-2 mb-4">
              <Shield size={16} className="text-gray-400" />
              <h2 className="text-base font-semibold text-white">Tools Configuration</h2>
            </div>
            <p className="text-sm text-gray-500 mb-5">
              Control which tools Claude agents can use. Changes apply to new chat messages.
            </p>

            {/* Mode selector */}
            <div className="flex gap-2 mb-5">
              {[
                { key: 'all' as const, label: 'All Tools Enabled' },
                { key: 'allowed' as const, label: 'Allowlist' },
                { key: 'disallowed' as const, label: 'Blocklist' },
              ].map(mode => (
                <button
                  key={mode.key}
                  onClick={() => setToolMode(mode.key)}
                  className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                    toolMode === mode.key
                      ? 'bg-accent-600/20 text-accent-400 border border-accent-600/30'
                      : 'bg-[#161b22] text-gray-400 border border-gray-800/60 hover:text-gray-300'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>

            {toolMode === 'all' && (
              <div className="bg-[#161b22] border border-gray-800/60 rounded-lg p-4 mb-4">
                <p className="text-sm text-gray-400">All built-in and MCP tools are enabled. The agent has full access.</p>
              </div>
            )}

            {toolMode !== 'all' && (
              <>
                <p className="text-xs text-gray-500 mb-3">
                  {toolMode === 'allowed'
                    ? 'Only checked tools will be available to the agent. Everything else is blocked.'
                    : 'Checked tools will be blocked. Everything else is allowed.'}
                </p>

                {/* Built-in tools */}
                <div className="mb-4">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Built-in Tools</h3>
                  <div className="bg-[#161b22] border border-gray-800/60 rounded-lg divide-y divide-gray-800/40">
                    {ALL_TOOLS.map(tool => (
                      <label
                        key={tool.name}
                        className="flex items-center justify-between px-4 py-2.5 cursor-pointer hover:bg-gray-800/30 transition-colors"
                      >
                        <div className="flex-1">
                          <span className="text-sm text-gray-200 font-mono">{tool.name}</span>
                          <span className="text-xs text-gray-600 ml-2">{tool.description}</span>
                        </div>
                        <button
                          onClick={() => toggleTool(tool.name, activeToggle)}
                          className="flex-shrink-0"
                        >
                          {activeList.includes(tool.name) ? (
                            <ToggleRight size={22} className={toolMode === 'allowed' ? 'text-emerald-400' : 'text-red-400'} />
                          ) : (
                            <ToggleLeft size={22} className="text-gray-600" />
                          )}
                        </button>
                      </label>
                    ))}
                  </div>
                </div>

                {/* MCP tools */}
                <div className="mb-4">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Chrome DevTools (MCP)</h3>
                  <div className="bg-[#161b22] border border-gray-800/60 rounded-lg divide-y divide-gray-800/40">
                    {MCP_TOOLS.map(tool => (
                      <label
                        key={tool.name}
                        className="flex items-center justify-between px-4 py-2.5 cursor-pointer hover:bg-gray-800/30 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-gray-200 font-mono truncate block">{tool.name.replace('mcp__chrome-devtools__', 'chrome: ')}</span>
                          <span className="text-xs text-gray-600">{tool.description}</span>
                        </div>
                        <button
                          onClick={() => toggleTool(tool.name, activeToggle)}
                          className="flex-shrink-0 ml-2"
                        >
                          {activeList.includes(tool.name) ? (
                            <ToggleRight size={22} className={toolMode === 'allowed' ? 'text-emerald-400' : 'text-red-400'} />
                          ) : (
                            <ToggleLeft size={22} className="text-gray-600" />
                          )}
                        </button>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Custom tool */}
                <div className="flex gap-2 mb-4">
                  <input
                    value={customTool}
                    onChange={(e) => setCustomTool(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addCustomTool()}
                    placeholder="Add custom tool pattern (e.g. Bash(git:*))"
                    className="flex-1 bg-[#161b22] border border-gray-800/60 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-accent-500/50"
                  />
                  <button
                    onClick={addCustomTool}
                    disabled={!customTool.trim()}
                    className="px-3 py-2 bg-[#161b22] border border-gray-800/60 rounded-md text-gray-400 hover:text-gray-300 disabled:opacity-30 transition-colors"
                  >
                    <Plus size={16} />
                  </button>
                </div>

                {/* Custom entries */}
                {activeList.filter(t => !ALL_TOOLS.some(at => at.name === t) && !MCP_TOOLS.some(mt => mt.name === t)).length > 0 && (
                  <div className="mb-4">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Custom Patterns</h3>
                    <div className="flex flex-wrap gap-2">
                      {activeList
                        .filter(t => !ALL_TOOLS.some(at => at.name === t) && !MCP_TOOLS.some(mt => mt.name === t))
                        .map(t => (
                          <span key={t} className="flex items-center gap-1.5 px-2.5 py-1 bg-[#161b22] border border-gray-800/60 rounded-md text-sm font-mono text-gray-300">
                            {t}
                            <button
                              onClick={() => toggleTool(t, activeToggle)}
                              className="text-gray-600 hover:text-red-400"
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))}
                    </div>
                  </div>
                )}
              </>
            )}

            <button
              onClick={handleSaveTools}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-700 disabled:opacity-50 rounded-md text-sm text-white font-medium transition-colors"
            >
              {saved ? <Check size={14} /> : <Save size={14} />}
              {saved ? 'Saved' : saving ? 'Saving...' : 'Save Tools Config'}
            </button>
          </section>

          {/* Tokens */}
          <section className="mb-10">
            <div className="flex items-center gap-2 mb-4">
              <Key size={16} className="text-gray-400" />
              <h2 className="text-base font-semibold text-white">Tokens & API Keys</h2>
            </div>
            <p className="text-sm text-gray-500 mb-5">
              Tokens are encrypted at rest using AES-256. They are never exposed in the API — only masked previews are shown.
            </p>

            <div className="space-y-4">
              {TOKENS.map(token => {
                const stored = settings[token.key];
                const hasValue = stored?.hasValue;
                return (
                  <div key={token.key} className="bg-[#161b22] border border-gray-800/60 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-medium text-gray-200">{token.label}</h3>
                      {hasValue && (
                        <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                          <Check size={12} /> Configured
                        </span>
                      )}
                    </div>

                    {hasValue && (
                      <div className="flex items-center gap-2 mb-3">
                        <code className="text-xs text-gray-500 bg-[#0d1117] px-2 py-1 rounded font-mono">
                          {stored.value}
                        </code>
                        <button
                          onClick={() => handleDeleteToken(token.key)}
                          className="text-gray-600 hover:text-red-400 transition-colors"
                          title="Remove token"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          type={showToken[token.key] ? 'text' : 'password'}
                          value={tokenInputs[token.key] || ''}
                          onChange={(e) => setTokenInputs(prev => ({ ...prev, [token.key]: e.target.value }))}
                          placeholder={hasValue ? 'Enter new token to replace' : token.placeholder}
                          className="w-full bg-[#0d1117] border border-gray-800/60 rounded-md px-3 py-2 pr-10 text-sm text-white placeholder-gray-600 font-mono focus:outline-none focus:border-accent-500/50"
                        />
                        <button
                          onClick={() => setShowToken(prev => ({ ...prev, [token.key]: !prev[token.key] }))}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400"
                        >
                          {showToken[token.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                      <button
                        onClick={() => handleSaveToken(token.key)}
                        disabled={!tokenInputs[token.key]}
                        className="px-3 py-2 bg-accent-600 hover:bg-accent-700 disabled:opacity-30 rounded-md text-sm text-white transition-colors"
                      >
                        <Save size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* WhatsApp Integration (Admin Only) */}
          {role === 'admin' && (
            <section className="mb-10">
              <div className="flex items-center gap-2 mb-4">
                <Phone size={16} className="text-green-400" />
                <h2 className="text-base font-semibold text-white">WhatsApp Integration</h2>
              </div>
              <p className="text-sm text-gray-500 mb-5">
                Connect WhatsApp to allow users to chat with agents via their phone number. Users must have their phone number configured in their profile.
              </p>

              <div className="bg-[#161b22] border border-gray-800/60 rounded-lg p-5">
                {waError && (
                  <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-md text-sm text-red-400">
                    {waError}
                  </div>
                )}

                {waStatus?.connected ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse" />
                      <div>
                        <div className="text-sm font-medium text-green-400">Connected</div>
                        {waStatus.phoneNumber && (
                          <div className="text-xs text-gray-500">+{waStatus.phoneNumber}</div>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-gray-500">
                      WhatsApp is connected and ready to receive messages. Users can message this number and the system will route to their account based on their registered phone number.
                    </p>
                    <button
                      onClick={handleWhatsAppDisconnect}
                      disabled={waLoading}
                      className="flex items-center gap-2 px-4 py-2 bg-red-600/20 hover:bg-red-600/30 border border-red-600/30 rounded-md text-sm text-red-400 font-medium transition-colors disabled:opacity-50"
                    >
                      {waLoading ? <Loader2 size={14} className="animate-spin" /> : <PowerOff size={14} />}
                      Disconnect
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-3 h-3 bg-gray-600 rounded-full" />
                      <div className="text-sm text-gray-400">Not connected</div>
                    </div>

                    {waQrImage ? (
                      <div className="space-y-3">
                        <p className="text-xs text-gray-500">
                          Scan this QR code with WhatsApp on your phone to connect:
                        </p>
                        <div className="bg-white p-4 rounded-lg inline-block">
                          <img src={waQrImage} alt="WhatsApp QR Code" className="w-64 h-64" />
                        </div>
                        <p className="text-xs text-gray-600">
                          Open WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device
                        </p>
                        <button
                          onClick={fetchWhatsAppStatus}
                          className="flex items-center gap-2 px-3 py-1.5 bg-[#0d1117] border border-gray-800/60 rounded-md text-xs text-gray-400 hover:text-gray-300 transition-colors"
                        >
                          <RefreshCw size={12} />
                          Refresh
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-xs text-gray-500">
                          Start the WhatsApp connection process to receive a QR code.
                        </p>
                        <button
                          onClick={handleWhatsAppInit}
                          disabled={waLoading}
                          className="flex items-center gap-2 px-4 py-2 bg-green-600/20 hover:bg-green-600/30 border border-green-600/30 rounded-md text-sm text-green-400 font-medium transition-colors disabled:opacity-50"
                        >
                          {waLoading ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
                          Initialize WhatsApp
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </PageShell>
  );
}
