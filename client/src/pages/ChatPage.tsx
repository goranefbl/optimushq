import React, { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/http';
import { useProjects } from '../hooks/useProjects';
import { useSessions } from '../hooks/useSessions';
import { useChat } from '../hooks/useChat';
import { useMemory } from '../hooks/useMemory';
import { useProjectMemory } from '../hooks/useProjectMemory';
import { useAgents } from '../hooks/useAgents';
import { useSessionSkills } from '../hooks/useSkills';
import { useSessionApis } from '../hooks/useApis';
import MainLayout from '../components/layout/MainLayout';
import Sidebar from '../components/layout/Sidebar';
import Header from '../components/layout/Header';
import ChatView from '../components/chat/ChatView';
import MemoryPanel from '../components/memory/MemoryPanel';
import SkillToggleList from '../components/skills/SkillToggleList';
import ApiToggleList from '../components/apis/ApiToggleList';
import FileExplorer from '../components/files/FileExplorer';
import SourceControl from '../components/git/SourceControl';
import type { SessionStatus, PermissionMode } from '../../../shared/types';

function useModelDefaults() {
  const [defaultModel, setDefaultModel] = useState<string | undefined>();
  const [defaultThinking, setDefaultThinking] = useState<boolean | undefined>();
  const [defaultMode, setDefaultMode] = useState<PermissionMode | undefined>();
  useEffect(() => {
    api.get<Record<string, any>>('/settings').then((data) => {
      if (data.default_model?.value) setDefaultModel(data.default_model.value);
      if (data.default_thinking?.value) setDefaultThinking(data.default_thinking.value === 'true');
      if (data.default_mode?.value) setDefaultMode(data.default_mode.value as PermissionMode);
    }).catch(() => {});
  }, []);
  return { defaultModel, defaultThinking, defaultMode };
}

function useGeneralProjectId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ generalProjectId: string | null }>('/config').then(data => {
      setId(data.generalProjectId);
    }).catch(() => {});
  }, []);
  return id;
}

export default function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const projectFromUrl = searchParams.get('project');
  const sessionFromUrl = searchParams.get('session');
  // null = general chat (uses GENERAL_PROJECT_ID), otherwise a real project id
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(projectFromUrl);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(sessionFromUrl);

  // Sync state when URL changes (e.g. clicking "Chat" nav clears the project param)
  useEffect(() => {
    if (projectFromUrl !== selectedProjectId) {
      setSelectedProjectId(projectFromUrl);
      if (!sessionFromUrl) setSelectedSessionId(null);
    }
    if (sessionFromUrl && sessionFromUrl !== selectedSessionId) {
      setSelectedSessionId(sessionFromUrl);
    }
  }, [projectFromUrl, sessionFromUrl]);
  const [showMemory, setShowMemory] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [activeView, setActiveView] = useState<'chat' | 'files' | 'source_control'>('chat');

  const generalProjectId = useGeneralProjectId();
  const { projects, create: createProject, remove: removeProject } = useProjects();
  // When no project selected, show sessions for the General project
  const activeProjectId = selectedProjectId || generalProjectId || '';
  const { sessions, loading: sessionsLoading, create: createSession, update: updateSession, remove: removeSession, refresh: refreshSessions } = useSessions(activeProjectId);
  const { agents } = useAgents();
  const { messages, streaming, streamContent, toolActivities, error, lastCost, queuedMessages, queueTransition, messagesLoaded, activeSkills, send, stop } = useChat(selectedSessionId);
  const { memory, refresh: refreshMemory } = useMemory(selectedSessionId);
  const isRealProject = selectedProjectId && selectedProjectId !== generalProjectId;
  const { memory: projectMemory, update: updateProjectMemory, refresh: refreshProjectMemory } = useProjectMemory(isRealProject ? selectedProjectId : null);
  const { defaultModel, defaultThinking, defaultMode } = useModelDefaults();
  const { skills: sessionSkills, toggle: toggleSkill } = useSessionSkills(selectedSessionId, selectedProjectId);
  const { apis: sessionApis, toggle: toggleApi } = useSessionApis(selectedSessionId, selectedProjectId);

  // Check if current project has a path (file explorer only for real projects)
  const currentProject = projects.find((p) => p.id === selectedProjectId);
  const hasProject = !!currentProject?.path;

  // Reset to chat view when switching away from a project
  useEffect(() => {
    if (!hasProject && activeView !== 'chat') {
      setActiveView('chat');
    }
  }, [hasProject, activeView]);

  // Auto-select first session or auto-create one when none exist
  useEffect(() => {
    if (selectedSessionId) return;
    if (sessionsLoading) return;
    if (sessions.length > 0) {
      setSelectedSessionId(sessions[0].id);
    } else if (agents.length > 0) {
      const defaultAgent = agents.find((a) => a.is_default) || agents[0];
      createSession(defaultAgent.id).then((s) => {
        if (s) setSelectedSessionId(s.id);
      });
    }
  }, [sessions, selectedSessionId, sessionsLoading, agents]);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const selectedAgentId = selectedSession?.agent_id || null;

  const handleCreateProject = useCallback(async (name: string) => {
    const p = await createProject(name);
    setSelectedProjectId(p.id);
    setSelectedSessionId(null);
  }, [createProject]);

  const handleCreateSession = useCallback(async () => {
    if (agents.length === 0) return;
    const defaultAgent = agents.find((a) => a.is_default) || agents[0];
    const s = await createSession(defaultAgent.id);
    if (s) setSelectedSessionId(s.id);
  }, [agents, createSession]);

  const handleSelectAgent = useCallback(async (agentId: string) => {
    if (!selectedSessionId) return;
    await api.put(`/sessions/${selectedSessionId}`, { agent_id: agentId });
    refreshSessions();
  }, [selectedSessionId, refreshSessions]);

  const handleExport = useCallback(() => {
    if (!selectedSessionId) return;
    window.open(`/api/export/${selectedSessionId}`, '_blank');
  }, [selectedSessionId]);

  const handleStatusChange = useCallback(async (status: SessionStatus) => {
    if (!selectedSessionId) return;
    await api.patch(`/sessions/${selectedSessionId}/status`, { status, actor: 'user' });
    refreshSessions();
  }, [selectedSessionId, refreshSessions]);

  const handleDeleteProject = useCallback(async (id: string) => {
    await removeProject(id);
    if (selectedProjectId === id) {
      setSelectedProjectId(null);
      setSelectedSessionId(null);
    }
  }, [removeProject, selectedProjectId]);

  const handleDeleteSession = useCallback(async (id: string) => {
    await removeSession(id);
    if (selectedSessionId === id) setSelectedSessionId(null);
  }, [removeSession, selectedSessionId]);

  const handleRenameSession = useCallback(async (id: string, title: string) => {
    await updateSession(id, { title });
  }, [updateSession]);

  React.useEffect(() => {
    if (selectedSessionId && !streaming) {
      refreshMemory();
      refreshProjectMemory();
    }
  }, [messages.length, streaming]);

  // Auto-send pending message from skill/MCP import redirect
  React.useEffect(() => {
    if (!selectedSessionId || streaming || !messagesLoaded) return;
    const raw = sessionStorage.getItem('pendingChatMessage');
    if (!raw) return;
    try {
      const { sessionId, content } = JSON.parse(raw) as { sessionId: string; content: string };
      if (sessionId === selectedSessionId) {
        sessionStorage.removeItem('pendingChatMessage');
        send(content);
      }
    } catch {
      sessionStorage.removeItem('pendingChatMessage');
    }
  }, [selectedSessionId, streaming, messagesLoaded, send]);

  const rightPanel = showMemory ? (
    <MemoryPanel
      memory={memory}
      projectMemory={isRealProject ? projectMemory : undefined}
      onUpdateProjectSummary={isRealProject ? (summary) => updateProjectMemory(summary) : undefined}
    />
  ) : showSkills ? (
    <>
      <SkillToggleList skills={sessionSkills} onToggle={toggleSkill} />
      <ApiToggleList apis={sessionApis} onToggle={toggleApi} />
    </>
  ) : undefined;

  return (
    <MainLayout
      sidebar={
        <Sidebar
          projects={projects}
          sessions={sessions}
          selectedProjectId={selectedProjectId}
          selectedSessionId={selectedSessionId}
          onSelectProject={(id) => { setSelectedProjectId(id); setSelectedSessionId(null); setSearchParams({ project: id }); }}
          onSelectSession={(id) => { setSelectedSessionId(id); setSearchParams(prev => { const p: Record<string, string> = {}; const proj = prev.get('project'); if (proj) p.project = proj; p.session = id; return p; }); }}
          onCreateProject={handleCreateProject}
          onCreateSession={handleCreateSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
        />
      }
      header={
        <Header
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={handleSelectAgent}
          onToggleMemory={() => { setShowMemory(!showMemory); setShowSkills(false); }}
          onToggleSkills={() => { setShowSkills(!showSkills); setShowMemory(false); }}
          onExport={handleExport}
          sessionId={selectedSessionId}
          sessionStatus={selectedSession?.status}
          onStatusChange={handleStatusChange}
          activeView={activeView}
          onToggleView={setActiveView}
          hasProject={hasProject}
          projectPath={currentProject?.path}
        />
      }
      rightPanel={activeView === 'chat' ? rightPanel : undefined}
    >
      {/* Both views stay mounted; inactive is hidden with CSS */}
      <div style={{ display: activeView === 'chat' ? 'contents' : 'none' }}>
        <ChatView
          messages={messages}
          streaming={streaming}
          streamContent={streamContent}
          toolActivities={toolActivities}
          activeSkills={activeSkills}
          error={error}
          lastCost={lastCost}
          queuedMessages={queuedMessages}
          queueTransition={queueTransition}
          onSend={send}
          onStop={stop}
          hasSession={!!selectedSessionId}
          defaultModel={defaultModel}
          defaultThinking={defaultThinking}
          defaultMode={(selectedSession?.mode as PermissionMode) || defaultMode}
          sessionId={selectedSessionId}
        />
      </div>
      {activeView === 'files' && hasProject && selectedProjectId && (
        <FileExplorer projectId={selectedProjectId} />
      )}
      {activeView === 'source_control' && hasProject && selectedProjectId && currentProject && (
        <SourceControl projectId={selectedProjectId} project={currentProject} />
      )}
    </MainLayout>
  );
}
