import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Globe, Terminal, Search, FileText, Loader, Sparkles } from 'lucide-react';

interface ToolActivity {
  type: 'use' | 'result';
  tool: string;
  input?: Record<string, unknown>;
  result?: string;
}

interface Props {
  content: string;
  toolActivities: ToolActivity[];
  activeSkills?: string[];
  queueTransition?: boolean;
}

const toolIcons: Record<string, React.ReactNode> = {
  WebFetch: <Globe size={14} />,
  WebSearch: <Search size={14} />,
  Bash: <Terminal size={14} />,
  Read: <FileText size={14} />,
};

function getToolIcon(tool: string) {
  return toolIcons[tool] || <Terminal size={14} />;
}

function getToolLabel(activity: ToolActivity): string {
  if (activity.tool === 'WebFetch' && activity.input?.url) {
    return `Fetching ${activity.input.url}`;
  }
  if (activity.tool === 'WebSearch' && activity.input?.query) {
    return `Searching: ${activity.input.query}`;
  }
  if (activity.tool === 'Bash' && activity.input?.command) {
    const cmd = String(activity.input.command);
    return `Running: ${cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd}`;
  }
  if (activity.tool === 'Read' && activity.input?.file_path) {
    return `Reading: ${activity.input.file_path}`;
  }
  return `Using ${activity.tool}`;
}

export default function StreamingIndicator({ content, toolActivities, activeSkills, queueTransition }: Props) {
  const hasToolActivity = toolActivities.length > 0;
  const hasSkills = activeSkills && activeSkills.length > 0;

  if (!content && !hasToolActivity) {
    return (
      <div className="flex justify-start mb-4">
        <div className="bg-[#161b22] border border-gray-800/50 rounded-lg px-4 py-3">
          {hasSkills && (
            <div className="flex items-center gap-1.5 mb-2 flex-wrap">
              <Sparkles size={12} className="text-amber-400 flex-shrink-0" />
              {activeSkills.map(s => (
                <span key={s} className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">{s}</span>
              ))}
            </div>
          )}
          {queueTransition ? (
            <p className="text-sm text-gray-400 animate-pulse">Reading your message...</p>
          ) : (
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 bg-accent-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-2 h-2 bg-accent-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-2 h-2 bg-accent-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[85%] sm:max-w-[80%] bg-[#161b22] border border-gray-800/50 text-gray-200 rounded-lg px-4 py-3 overflow-hidden">
        {/* Active skills */}
        {hasSkills && (
          <div className="flex items-center gap-1.5 mb-2 flex-wrap">
            <Sparkles size={12} className="text-amber-400 flex-shrink-0" />
            {activeSkills.map(s => (
              <span key={s} className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">{s}</span>
            ))}
          </div>
        )}
        {/* Tool activities */}
        {hasToolActivity && (
          <div className="mb-2 space-y-1">
            {toolActivities.map((activity, i) => (
              <div
                key={i}
                className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${
                  activity.type === 'use'
                    ? 'bg-accent-900/20 text-accent-300 border border-accent-800/30'
                    : 'bg-green-900/20 text-green-300 border border-green-800/30'
                }`}
              >
                {activity.type === 'use' ? (
                  <>
                    {getToolIcon(activity.tool)}
                    <span>{getToolLabel(activity)}</span>
                    {i === toolActivities.length - 1 && activity.type === 'use' && (
                      <Loader size={12} className="animate-spin ml-auto" />
                    )}
                  </>
                ) : (
                  <>
                    <span className="text-green-400">Done</span>
                    <span className="truncate">{activity.result?.substring(0, 80)}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Streaming text */}
        {content && (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children, ...props }) => (
                  <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
                ),
              }}
            >{content}</ReactMarkdown>
          </div>
        )}

        <div className="mt-1">
          <span className="inline-block w-2 h-4 bg-accent-500 animate-pulse" />
        </div>
      </div>
    </div>
  );
}
