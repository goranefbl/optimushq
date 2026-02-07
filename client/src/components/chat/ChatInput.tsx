import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowUp, Square, X, ChevronDown, Sparkles, Check, Eye, MessageSquare, Zap } from 'lucide-react';
import { api } from '../../api/http';
import type { PermissionMode } from '../../../../shared/types';

interface PendingImage {
  name: string;
  preview: string; // object URL for display
  data: string;    // base64 data
}

const MODELS = [
  { value: 'sonnet', label: 'Sonnet', desc: 'Balanced speed and intelligence' },
  { value: 'haiku', label: 'Haiku', desc: 'Fast and lightweight' },
  { value: 'opus', label: 'Opus', desc: 'Most capable, highest quality' },
];

const MODES: { value: PermissionMode; label: string; desc: string; icon: typeof Eye }[] = [
  { value: 'execute', label: 'Execute', desc: 'Full autonomous execution', icon: Zap },
  { value: 'ask', label: 'Ask', desc: 'Confirms before making edits', icon: MessageSquare },
  { value: 'explore', label: 'Explore', desc: 'Read-only, no file changes', icon: Eye },
];

interface Props {
  onSend: (content: string, images?: string[], model?: string, thinking?: boolean, mode?: PermissionMode) => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  defaultModel?: string;
  defaultThinking?: boolean;
  defaultMode?: PermissionMode;
  sessionId?: string | null;
}

export default function ChatInput({ onSend, onStop, streaming, disabled, defaultModel, defaultThinking, defaultMode, sessionId }: Props) {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [model, setModel] = useState(defaultModel || 'sonnet');
  const [thinking, setThinking] = useState(defaultThinking || false);
  const [mode, setMode] = useState<PermissionMode>(defaultMode || 'execute');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);

  // Sync defaults when they change
  useEffect(() => { if (defaultModel) setModel(defaultModel); }, [defaultModel]);
  useEffect(() => { if (defaultThinking !== undefined) setThinking(defaultThinking); }, [defaultThinking]);
  useEffect(() => { if (defaultMode) setMode(defaultMode); }, [defaultMode]);

  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  // Close model menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    if (showModelMenu) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModelMenu]);

  // Close mode menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setShowModeMenu(false);
      }
    };
    if (showModeMenu) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModeMenu]);

  const addImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    const newImages: PendingImage[] = [];
    for (const file of imageFiles) {
      const data = await fileToBase64(file);
      newImages.push({
        name: file.name,
        preview: URL.createObjectURL(file),
        data,
      });
    }
    setImages(prev => [...prev, ...newImages]);
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages(prev => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleSubmit = async () => {
    if ((!input.trim() && images.length === 0) || disabled) return;

    let imagePaths: string[] | undefined;

    if (images.length > 0) {
      setUploading(true);
      try {
        const uploads = await Promise.all(
          images.map(img =>
            api.post<{ path: string }>('/upload/image', { data: img.data, filename: img.name })
          )
        );
        imagePaths = uploads.map(u => u.path);
      } catch (err) {
        console.error('Failed to upload images:', err);
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    onSend(input.trim() || 'See attached image(s)', imagePaths, model, thinking, mode);
    setInput('');
    // Clean up previews
    images.forEach(img => URL.revokeObjectURL(img.preview));
    setImages([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addImageFiles(files);
    }
  }, [addImageFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    addImageFiles(files);
  }, [addImageFiles]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 300) + 'px';
    }
  }, [input]);

  const canSend = (input.trim() || images.length > 0) && !disabled && !uploading;
  const currentModel = MODELS.find(m => m.value === model) || MODELS[0];
  const currentMode = MODES.find(m => m.value === mode) || MODES[0];
  const ModeIcon = currentMode.icon;

  return (
    <div
      ref={dropRef}
      className="border-t border-gray-800/50 px-4 py-3 bg-[#0d1117]"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="max-w-4xl mx-auto">
        <div className="bg-[#161b22] border border-gray-700/50 rounded-xl focus-within:border-accent-500/50 transition-colors">
          {/* Image previews */}
          {images.length > 0 && (
            <div className="flex gap-2 px-4 pt-3 flex-wrap">
              {images.map((img, i) => (
                <div key={i} className="relative group">
                  <img
                    src={img.preview}
                    alt={img.name}
                    className="h-16 w-16 object-cover rounded-lg border border-gray-700"
                  />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -right-1.5 bg-gray-800 border border-gray-600 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={10} className="text-gray-300" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={disabled ? 'Select a session to start chatting...' : 'Message...'}
            disabled={disabled}
            rows={2}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm text-white placeholder-gray-600 focus:outline-none disabled:opacity-50"
          />

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-3 pb-2.5">
            <div className="flex items-center gap-1.5">
              {/* Model selector */}
              <div className="relative" ref={modelMenuRef}>
                <button
                  onClick={() => setShowModelMenu(!showModelMenu)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-colors ${
                    thinking
                      ? 'text-amber-400 hover:bg-amber-500/10'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60'
                  }`}
                >
                  {thinking && <Sparkles size={12} className="flex-shrink-0" />}
                  <span className="hidden sm:inline">{currentModel.label}</span>
                  <span className="sm:hidden">{currentModel.label.charAt(0)}</span>
                  <ChevronDown size={12} />
                </button>
                {showModelMenu && (
                  <div className="absolute bottom-full left-0 mb-1 bg-[#1c2129] border border-gray-700/60 rounded-lg shadow-xl z-50 min-w-[240px] py-1">
                    {MODELS.map((m) => (
                      <button
                        key={m.value}
                        onClick={() => { setModel(m.value); setShowModelMenu(false); }}
                        className={`w-full text-left px-3 py-2.5 transition-colors flex items-center gap-3 ${
                          model === m.value
                            ? 'bg-accent-600/15'
                            : 'hover:bg-gray-800/60'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm font-medium ${model === m.value ? 'text-accent-400' : 'text-gray-200'}`}>
                            {m.label}
                          </div>
                          <div className="text-[11px] text-gray-500 mt-0.5">{m.desc}</div>
                        </div>
                        {model === m.value && (
                          <Check size={14} className="text-accent-400 flex-shrink-0" />
                        )}
                      </button>
                    ))}
                    {/* Thinking toggle */}
                    <div className="border-t border-gray-700/40 mt-1 pt-1">
                      <button
                        onClick={() => { setThinking(!thinking); setShowModelMenu(false); }}
                        className={`w-full text-left px-3 py-2.5 transition-colors flex items-center gap-3 ${
                          thinking
                            ? 'bg-amber-500/10'
                            : 'hover:bg-gray-800/60'
                        }`}
                      >
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <Sparkles size={14} className={thinking ? 'text-amber-400' : 'text-gray-500'} />
                          <div>
                            <div className={`text-sm font-medium ${thinking ? 'text-amber-400' : 'text-gray-200'}`}>
                              Thinking
                            </div>
                            <div className="text-[11px] text-gray-500 mt-0.5">Extended reasoning before responding</div>
                          </div>
                        </div>
                        {thinking && (
                          <Check size={14} className="text-amber-400 flex-shrink-0" />
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Mode selector */}
              <div className="relative" ref={modeMenuRef}>
                <button
                  onClick={() => setShowModeMenu(!showModeMenu)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-colors ${
                    mode === 'explore'
                      ? 'text-blue-400 hover:bg-blue-500/10'
                      : mode === 'ask'
                        ? 'text-yellow-400 hover:bg-yellow-500/10'
                        : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60'
                  }`}
                >
                  <ModeIcon size={12} />
                  <span className="hidden sm:inline">{currentMode.label}</span>
                  <ChevronDown size={12} className="hidden sm:block" />
                </button>
                {showModeMenu && (
                  <div className="absolute bottom-full left-0 mb-1 bg-[#1c2129] border border-gray-700/60 rounded-lg shadow-xl z-50 min-w-[240px] py-1">
                    {MODES.map((m) => {
                      const Icon = m.icon;
                      return (
                        <button
                          key={m.value}
                          onClick={() => {
                            setMode(m.value);
                            setShowModeMenu(false);
                            if (sessionId) {
                              api.put(`/sessions/${sessionId}`, { mode: m.value }).catch(() => {});
                            }
                          }}
                          className={`w-full text-left px-3 py-2.5 transition-colors flex items-center gap-3 ${
                            mode === m.value
                              ? 'bg-accent-600/15'
                              : 'hover:bg-gray-800/60'
                          }`}
                        >
                          <Icon size={14} className={mode === m.value ? 'text-accent-400' : 'text-gray-500'} />
                          <div className="flex-1 min-w-0">
                            <div className={`text-sm font-medium ${mode === m.value ? 'text-accent-400' : 'text-gray-200'}`}>
                              {m.label}
                            </div>
                            <div className="text-[11px] text-gray-500 mt-0.5">{m.desc}</div>
                          </div>
                          {mode === m.value && (
                            <Check size={14} className="text-accent-400 flex-shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

            </div>

            {/* Send / Stop buttons */}
            <div className="flex items-center gap-1.5">
              {streaming && (
                <button
                  onClick={onStop}
                  className="p-1.5 bg-red-600 hover:bg-red-700 rounded-lg text-white transition-colors"
                  title="Stop"
                >
                  <Square size={14} />
                </button>
              )}
              <button
                onClick={handleSubmit}
                disabled={!canSend}
                className={`p-1.5 rounded-lg text-white transition-colors ${
                  streaming && canSend
                    ? 'bg-amber-600 hover:bg-amber-700'
                    : 'bg-accent-600 hover:bg-accent-700 disabled:bg-gray-700 disabled:text-gray-500'
                }`}
                title={streaming ? 'Queue message' : 'Send'}
              >
                <ArrowUp size={14} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip data URL prefix (e.g. "data:image/png;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
