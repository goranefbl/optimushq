import React, { useState, useEffect, useCallback } from 'react';
import { GitBranch, ChevronDown, ChevronRight, Plus, Minus, Download, Upload, AlertCircle, FolderGit2, Globe } from 'lucide-react';
import { useGit } from '../../hooks/useGit';
import type { Project, GitFileStatus } from '../../../../shared/types';

interface Props {
  projectId: string;
  project: Project;
}

const STATUS_LABELS: Record<string, string> = {
  'M': 'Modified',
  'A': 'Added',
  'D': 'Deleted',
  'R': 'Renamed',
  'C': 'Copied',
  'U': 'Unmerged',
  '??': 'Untracked',
};

function statusColor(status: string): string {
  switch (status) {
    case 'M': return 'text-accent-400';
    case 'A': case '??': return 'text-green-400';
    case 'D': return 'text-red-400';
    case 'R': return 'text-blue-400';
    case 'U': return 'text-orange-400';
    default: return 'text-gray-400';
  }
}

export default function SourceControl({ projectId, project }: Props) {
  const {
    status, branches, log, loading, error,
    stage, unstage, commit, checkout, pull, push, getDiff, refresh, init, clone,
  } = useGit(projectId);

  const [commitMsg, setCommitMsg] = useState('');
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');

  useEffect(() => {
    refresh();
  }, [refresh]);

  const stagedFiles = status?.files?.filter(f => f.staged) || [];
  const unstagedFiles = status?.files?.filter(f => !f.staged) || [];

  const pushDisabled = !!project.git_push_disabled;
  const protectedBranches = project.git_protected_branches
    ? project.git_protected_branches.split(',').map(b => b.trim()).filter(Boolean)
    : [];
  const isOnProtectedBranch = status?.branch ? protectedBranches.includes(status.branch) : false;
  const pushBlocked = pushDisabled || isOnProtectedBranch;

  const handleViewDiff = useCallback(async (file: GitFileStatus) => {
    setDiffPath(file.path);
    setDiffContent(null);
    const result = await getDiff(file.path, file.staged);
    if (result) {
      setDiffContent(result.diff || '(No changes)');
      setDiffPath(result.path);
    }
  }, [getDiff]);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    setActionLoading(true);
    await commit(commitMsg.trim());
    setCommitMsg('');
    setActionLoading(false);
  }, [commit, commitMsg]);

  const handleStage = useCallback(async (paths: string[]) => {
    setActionLoading(true);
    await stage(paths);
    setActionLoading(false);
  }, [stage]);

  const handleUnstage = useCallback(async (paths: string[]) => {
    setActionLoading(true);
    await unstage(paths);
    setActionLoading(false);
  }, [unstage]);

  const handleCheckout = useCallback(async (branch: string) => {
    setActionLoading(true);
    await checkout(branch);
    setDiffContent(null);
    setDiffPath(null);
    setActionLoading(false);
  }, [checkout]);

  const handlePull = useCallback(async () => {
    setActionLoading(true);
    await pull();
    setActionLoading(false);
  }, [pull]);

  const handlePush = useCallback(async () => {
    if (pushBlocked) return;
    setActionLoading(true);
    await push();
    setActionLoading(false);
  }, [push, pushBlocked]);

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Loading source control...
      </div>
    );
  }

  if (status && !status.isGitRepo) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="max-w-sm w-full space-y-6 text-center">
          <div className="text-gray-500 space-y-1">
            <AlertCircle size={28} className="mx-auto mb-3 text-gray-600" />
            <div className="text-sm font-medium text-gray-300">No repository found</div>
            <div className="text-xs">Initialize a new repo or clone an existing one.</div>
          </div>

          <button
            onClick={init}
            disabled={loading}
            className="w-full flex items-center gap-3 bg-[#161b22] hover:bg-gray-800 border border-gray-700/50 rounded-lg px-4 py-3 text-left transition-colors disabled:opacity-50"
          >
            <FolderGit2 size={18} className="text-accent-500 shrink-0" />
            <div>
              <div className="text-sm text-white font-medium">Initialize Repository</div>
              <div className="text-xs text-gray-500">Create a new git repo in this project folder</div>
            </div>
          </button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-800" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-[#0d1117] px-2 text-xs text-gray-600">or</span>
            </div>
          </div>

          <div className="bg-[#161b22] border border-gray-700/50 rounded-lg px-4 py-3 space-y-2.5 text-left">
            <div className="flex items-center gap-2">
              <Globe size={16} className="text-blue-400 shrink-0" />
              <div className="text-sm text-white font-medium">Clone Repository</div>
            </div>
            <input
              type="text"
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-accent-500/50"
            />
            <button
              onClick={() => { if (cloneUrl.trim()) clone(cloneUrl.trim()); }}
              disabled={!cloneUrl.trim() || loading}
              className="w-full bg-accent-600 hover:bg-accent-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded transition-colors"
            >
              {loading ? 'Cloning...' : 'Clone'}
            </button>
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-900/10 border border-red-900/30 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left panel */}
      <div className="w-80 border-r border-gray-800/50 bg-[#0d1117] flex flex-col shrink-0">
        {/* Branch selector */}
        <div className="px-3 py-2 border-b border-gray-800/50">
          <div className="flex items-center gap-1.5 mb-2">
            <GitBranch size={14} className="text-gray-400" />
            <select
              value={status?.branch || ''}
              onChange={(e) => handleCheckout(e.target.value)}
              disabled={actionLoading}
              className="flex-1 text-xs bg-[#0d1117] border border-gray-700/50 rounded px-2 py-1 text-white focus:outline-none focus:border-accent-500/50"
            >
              {branches.filter(b => !b.remote).map(b => (
                <option key={b.name} value={b.name}>{b.name}</option>
              ))}
            </select>
          </div>

          {/* Commit input */}
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Commit message..."
            rows={2}
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-accent-500/50 resize-none"
          />
          <button
            onClick={handleCommit}
            disabled={!commitMsg.trim() || stagedFiles.length === 0 || actionLoading}
            className="w-full mt-1.5 bg-accent-600 hover:bg-accent-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded transition-colors"
          >
            Commit ({stagedFiles.length} staged)
          </button>
        </div>

        {/* File lists */}
        <div className="flex-1 overflow-y-auto">
          {/* Staged files */}
          <FileSection
            title="Staged Changes"
            files={stagedFiles}
            actionIcon={<Minus size={12} />}
            actionTitle="Unstage"
            onAction={(f) => handleUnstage([f.path])}
            onSelect={handleViewDiff}
            selectedPath={diffPath}
            defaultExpanded
          />

          {/* Unstaged files */}
          <FileSection
            title="Changes"
            files={unstagedFiles}
            actionIcon={<Plus size={12} />}
            actionTitle="Stage"
            onAction={(f) => handleStage([f.path])}
            onSelect={handleViewDiff}
            selectedPath={diffPath}
            defaultExpanded
            headerAction={unstagedFiles.length > 0 ? {
              icon: <Plus size={12} />,
              title: 'Stage All',
              onClick: () => handleStage(unstagedFiles.map(f => f.path)),
            } : undefined}
          />

          {/* Log section */}
          <div className="border-t border-gray-800/50">
            <button
              className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-gray-400 hover:text-gray-300"
              onClick={() => setShowLog(!showLog)}
            >
              {showLog ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Recent Commits ({log.length})
            </button>
            {showLog && (
              <div className="px-2 pb-2">
                {log.map(entry => (
                  <div key={entry.hash} className="px-2 py-1 text-xs text-gray-500 truncate">
                    <span className="text-accent-500/70 font-mono">{entry.shortHash}</span>
                    {' '}
                    <span className="text-gray-400">{entry.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Pull/Push footer */}
        <div className="border-t border-gray-800/50 px-3 py-2">
          {error && (
            <div className="text-xs text-red-400 mb-2 truncate" title={error}>
              {error}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-2">
            {(status?.ahead ?? 0) > 0 && <span className="text-green-400">{status!.ahead} ahead</span>}
            {(status?.ahead ?? 0) > 0 && (status?.behind ?? 0) > 0 && <span>|</span>}
            {(status?.behind ?? 0) > 0 && <span className="text-blue-400">{status!.behind} behind</span>}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handlePull}
              disabled={actionLoading}
              className="flex-1 flex items-center justify-center gap-1 bg-[#161b22] hover:bg-gray-800 border border-gray-700/50 text-gray-300 text-xs px-2 py-1.5 rounded transition-colors disabled:opacity-40"
            >
              <Download size={12} /> Pull
            </button>
            <button
              onClick={handlePush}
              disabled={actionLoading || pushBlocked}
              title={pushDisabled ? 'Push disabled (pull-only mode)' : isOnProtectedBranch ? `Branch "${status?.branch}" is protected` : 'Push'}
              className="flex-1 flex items-center justify-center gap-1 bg-[#161b22] hover:bg-gray-800 border border-gray-700/50 text-gray-300 text-xs px-2 py-1.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Upload size={12} /> Push
            </button>
          </div>
        </div>
      </div>

      {/* Right panel: Diff viewer */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0d1117]">
        {diffPath ? (
          <>
            <div className="h-8 flex items-center px-3 text-xs text-gray-400 border-b border-gray-800/50 font-mono">
              {diffPath}
            </div>
            {diffContent === null ? (
              <div className="flex items-center justify-center h-full text-gray-600 text-sm">
                Loading diff...
              </div>
            ) : (
              <div className="flex-1 overflow-auto p-3 font-mono text-xs leading-5">
                {diffContent.split('\n').map((line, i) => {
                  let color = 'text-gray-400';
                  let bg = '';
                  if (line.startsWith('+')) {
                    color = 'text-green-400';
                    bg = 'bg-green-900/20';
                  } else if (line.startsWith('-')) {
                    color = 'text-red-400';
                    bg = 'bg-red-900/20';
                  } else if (line.startsWith('@@')) {
                    color = 'text-blue-400';
                    bg = 'bg-blue-900/10';
                  } else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) {
                    color = 'text-gray-500';
                  }
                  return (
                    <div key={i} className={`${color} ${bg} px-1 whitespace-pre`}>
                      {line}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            Select a file to view diff
          </div>
        )}
      </div>
    </div>
  );
}

// --- FileSection sub-component ---

interface FileSectionProps {
  title: string;
  files: GitFileStatus[];
  actionIcon: React.ReactNode;
  actionTitle: string;
  onAction: (file: GitFileStatus) => void;
  onSelect: (file: GitFileStatus) => void;
  selectedPath: string | null;
  defaultExpanded?: boolean;
  headerAction?: {
    icon: React.ReactNode;
    title: string;
    onClick: () => void;
  };
}

function FileSection({
  title, files, actionIcon, actionTitle, onAction, onSelect,
  selectedPath, defaultExpanded, headerAction,
}: FileSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? true);

  return (
    <div className="border-t border-gray-800/50 first:border-t-0">
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-300"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title} ({files.length})
        </button>
        {headerAction && (
          <button
            className="text-gray-500 hover:text-gray-300 p-0.5"
            title={headerAction.title}
            onClick={headerAction.onClick}
          >
            {headerAction.icon}
          </button>
        )}
      </div>
      {expanded && files.map(file => (
        <div
          key={`${file.path}-${file.staged}`}
          className={`flex items-center gap-1 px-3 py-0.5 text-xs cursor-pointer hover:bg-gray-800/50 group ${
            selectedPath === file.path ? 'bg-gray-800 text-white' : 'text-gray-400'
          }`}
          onClick={() => onSelect(file)}
        >
          <span className={`shrink-0 font-mono w-4 text-center ${statusColor(file.status)}`}>
            {file.status === '??' ? 'U' : file.status}
          </span>
          <span className="truncate flex-1">{file.path}</span>
          <span className="text-[10px] text-gray-600">{STATUS_LABELS[file.status] || file.status}</span>
          <button
            className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-white p-0.5 transition-opacity"
            title={actionTitle}
            onClick={(e) => { e.stopPropagation(); onAction(file); }}
          >
            {actionIcon}
          </button>
        </div>
      ))}
    </div>
  );
}
