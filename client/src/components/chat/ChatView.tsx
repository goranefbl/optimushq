import React, { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble';
import StreamingIndicator from './StreamingIndicator';
import ChatInput from './ChatInput';
import type { Message, PermissionMode } from '../../../../shared/types';

interface ToolActivity {
  type: 'use' | 'result';
  tool: string;
  input?: Record<string, unknown>;
  result?: string;
}

interface Props {
  messages: Message[];
  streaming: boolean;
  streamContent: string;
  toolActivities: ToolActivity[];
  activeSkills: string[];
  error: string | null;
  lastCost: number | null;
  queuedMessages: Message[];
  queueTransition: boolean;
  onSend: (content: string, images?: string[], model?: string, thinking?: boolean, mode?: PermissionMode) => void;
  onStop: () => void;
  hasSession: boolean;
  defaultModel?: string;
  defaultThinking?: boolean;
  defaultMode?: PermissionMode;
  sessionId?: string | null;
}

export default function ChatView({
  messages, streaming, streamContent, toolActivities, activeSkills, error, lastCost,
  queuedMessages, queueTransition,
  onSend, onStop, hasSession, defaultModel, defaultThinking, defaultMode, sessionId,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamContent, toolActivities]);

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4">
        <div className="max-w-4xl mx-auto min-w-0">
          {!hasSession && (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              Select or create a session to start chatting
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {streaming && (
            <StreamingIndicator content={streamContent} toolActivities={toolActivities} activeSkills={activeSkills} queueTransition={queueTransition} />
          )}
          {error && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-300 text-sm">
              {error}
            </div>
          )}
          {lastCost !== null && !streaming && (
            <div className="text-center text-xs text-gray-600 mb-2">
              Cost: ${lastCost.toFixed(4)}
            </div>
          )}
        </div>
      </div>
      {queuedMessages.length > 0 && (
        <div className="border-t border-gray-800/50 bg-[#0d1117]/80 px-4 py-2">
          <div className="max-w-4xl mx-auto space-y-1.5">
            {queuedMessages.map((m) => (
              <div key={m.id} className="flex items-center justify-end gap-2">
                <span className="text-[11px] text-gray-500">(Queued)</span>
                <div className="bg-accent-600/40 text-white/70 rounded-lg px-3 py-1.5 text-sm max-w-[70%] truncate">
                  {m.content}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <ChatInput onSend={onSend} onStop={onStop} streaming={streaming} disabled={!hasSession} defaultModel={defaultModel} defaultThinking={defaultThinking} defaultMode={defaultMode} sessionId={sessionId} />
    </div>
  );
}
