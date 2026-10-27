'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AiModelView, AppInfo, ConnectionView, DbStatus } from '../../shared/ipc';
import { ChatPanel } from '@/components/ChatPanel';
import { ConnectionsView } from '@/components/ConnectionsView';
import { ModelsView } from '@/components/ModelsView';
import { Icon, Spinner } from '@/components/ui';
import { errorMessage, getApi } from '@/lib/api';
import { useSettings } from '@/lib/settings';

type Panel = 'agent' | 'projects' | 'models';

export function AgentShell() {
  const { tr, theme, language, update } = useSettings();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [loading, setLoading] = useState(true);

  const [panel, setPanel] = useState<Panel>('agent');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [projects, setProjects] = useState<ConnectionView[]>([]);
  const [models, setModels] = useState<AiModelView[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const activeModel =
    models.find((m) => m.id === activeProject?.aiModelId) ?? models[0] ?? null;

  const filteredProjects = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(q) ||
        project.target.toLowerCase().includes(q) ||
        project.status.toLowerCase().includes(q),
    );
  }, [projects, projectQuery]);

  const refresh = useCallback(async () => {
    const api = getApi();
    const [info, status, modelRows, projectRows] = await Promise.all([
      api.getAppInfo(),
      api.getDbStatus(),
      api.models.list(),
      api.connections.list(),
    ]);
    setAppInfo(info);
    setDbStatus(status);
    setModels(modelRows);
    setProjects(projectRows);
    setActiveProjectId((current) => {
      if (current && projectRows.some((row) => row.id === current)) return current;
      const ready = projectRows.find((row) => row.status === 'ready');
      return ready?.id ?? projectRows[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (!window.easyReporter) {
            if (!cancelled) setBridgeMissing(true);
            return;
          }
          await refresh();
          if (!cancelled) setBootError(null);
        } catch (error) {
          if (!cancelled) {
            if (!window.easyReporter) setBridgeMissing(true);
            else setBootError(errorMessage(error));
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!projectModalOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setProjectModalOpen(false);
        setProjectQuery('');
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [projectModalOpen]);

  if (bridgeMissing) {
    return (
      <main className="bridge-page">
        <div className="bridge-card fade-in">
          <span className="empty-icon">
            <Icon name="database" size={26} />
          </span>
          <h1>Open EasyReporter as a desktop app</h1>
          <p>
            This page is running in a browser without the desktop bridge. Start it with{' '}
            <code>npm run dev</code> or open the installed app.
          </p>
        </div>
      </main>
    );
  }

  const readyToChat =
    activeProject?.status === 'ready' && activeProject.readOnly?.verdict === 'read-only';

  function goHome() {
    setPanel('agent');
    setSettingsOpen(false);
    setProjectModalOpen(false);
  }

  function openProjects() {
    setPanel('projects');
    setSettingsOpen(true);
    setProjectModalOpen(false);
  }

  function openModels() {
    setPanel('models');
    setSettingsOpen(true);
    setProjectModalOpen(false);
  }

  async function toggleTheme() {
    await update({ theme: theme === 'dark' ? 'light' : 'dark' });
  }

  async function toggleLanguage() {
    await update({ language: language === 'en' ? 'fa' : 'en' });
  }

  async function selectProject(id: string) {
    setActiveProjectId(id);
    setProjectModalOpen(false);
    setProjectQuery('');
    setPanel('agent');
    setSettingsOpen(false);
  }

  async function changeModel(modelId: string) {
    if (!activeProject) return;
    try {
      await getApi().connections.setAiModel(activeProject.id, modelId);
      await refresh();
    } catch (error) {
      setBootError(errorMessage(error));
    }
  }

  return (
    <div className="agent-app" data-lang={language} data-theme={theme}>
      <header className="agent-top">
        <button type="button" className="agent-brand" onClick={goHome}>
          <span className="agent-brand-mark" aria-hidden="true">
            <Icon name="sparkle" size={22} />
          </span>
          <span className="agent-brand-copy">
            <strong>Easy Reporter</strong>
            <span>{tr('agentTagline')}</span>
          </span>
        </button>

        <div className="agent-capsules">
          {settingsOpen ? (
            <>
              <button type="button" className="nav-bubble" onClick={() => void toggleTheme()}>
                <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={18} />
                <span>{theme === 'dark' ? tr('themeDark') : tr('themeLight')}</span>
              </button>
              <button type="button" className="nav-bubble" onClick={() => void toggleLanguage()}>
                <Icon name="language" size={18} />
                <span>{language === 'fa' ? 'فارسی' : 'English'}</span>
              </button>
              <button
                type="button"
                className={`nav-bubble ${panel === 'models' ? 'active' : ''}`}
                onClick={openModels}
              >
                <Icon name="sparkle" size={18} />
                <span>{tr('navModels')}</span>
              </button>
              <button
                type="button"
                className={`nav-bubble ${panel === 'projects' ? 'active' : ''}`}
                onClick={openProjects}
              >
                <Icon name="folder" size={18} />
                <span>{tr('navProjectsShort')}</span>
              </button>
              <button
                type="button"
                className="nav-bubble nav-bubble-icon"
                onClick={goHome}
                aria-label={tr('navHome')}
                title={tr('navHome')}
              >
                <Icon name="home" size={18} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="nav-bubble nav-bubble-project"
                onClick={() => {
                  setProjectModalOpen(true);
                  setProjectQuery('');
                }}
              >
                <Icon name="folder" size={18} />
                <span>{activeProject?.name ?? tr('capsuleNoProject')}</span>
              </button>
              <button
                type="button"
                className="nav-bubble nav-bubble-icon"
                onClick={() => setSettingsOpen(true)}
                aria-label={tr('navSettings')}
                title={tr('navSettings')}
              >
                <Icon name="settings" size={18} />
              </button>
            </>
          )}
        </div>
      </header>

      <div className="agent-stage">
        <main className="stage-main">
          {loading ? (
            <div className="agent-loading">
              <Spinner label={tr('loading')} />
            </div>
          ) : bootError ? (
            <div className="agent-empty">
              <p>{bootError}</p>
            </div>
          ) : panel === 'models' ? (
            <div className="stage-scroll">
              <ModelsView
                keyStorage={appInfo?.keyStorage ?? null}
                onChanged={() => void refresh()}
              />
            </div>
          ) : panel === 'projects' ? (
            <div className="stage-scroll">
              <ConnectionsView
                onOpen={(id) => {
                  setActiveProjectId(id);
                  goHome();
                }}
                onModels={openModels}
                onChanged={() => void refresh()}
              />
            </div>
          ) : readyToChat && activeProject ? (
            <div className="stage-chat">
              <ChatPanel
                key={activeProject.id}
                connection={activeProject}
                onSetup={openProjects}
                models={models}
                activeModel={activeModel}
                onSelectModel={(id) => void changeModel(id)}
                onManageModels={openModels}
                compact
              />
            </div>
          ) : (
            <AgentWelcome
              hint={
                !models.length
                  ? tr('homeNeedModel')
                  : !projects.length
                    ? tr('homeNeedProject')
                    : activeProject && !readyToChat
                      ? tr('homeNeedSetup')
                      : tr('homeReadyHint')
              }
              onAction={() => {
                if (!models.length) openModels();
                else openProjects();
              }}
              actionLabel={
                !models.length
                  ? tr('addBrain')
                  : !projects.length
                    ? tr('createFirstProject')
                    : tr('manageProjects')
              }
            />
          )}
        </main>
      </div>

      <footer className="agent-foot border-white/40 border-t-[0.5px]">
        <span>{tr('footerDisclaimer')}</span>
        <span>Version {appInfo?.version ?? '0.0.1'}</span>
        <span>
          {tr('footerCreditBefore')}
          <a href="https://taheri.vercel.app" target="_blank" rel="noreferrer">
            nerdy dev
          </a>
          {tr('footerCreditAfter')}
        </span>
        {dbStatus?.exists ? (
          <span className="foot-dot ok" title={tr('vaultReady')} />
        ) : (
          <span className="foot-dot warn" title={tr('vault')} />
        )}
      </footer>

      {projectModalOpen ? (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={() => {
            setProjectModalOpen(false);
            setProjectQuery('');
          }}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-label={tr('projectPickerTitle')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="project-modal-head">
              <div>
                <h2>{tr('projectPickerTitle')}</h2>
                <p>{tr('projectPickerSubtitle')}</p>
              </div>
              <button
                type="button"
                className="nav-bubble nav-bubble-icon"
                onClick={() => {
                  setProjectModalOpen(false);
                  setProjectQuery('');
                }}
                aria-label={tr('close')}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            <label className="project-search">
              <Icon name="search" size={16} />
              <input
                autoFocus
                value={projectQuery}
                onChange={(event) => setProjectQuery(event.target.value)}
                placeholder={tr('projectSearchPlaceholder')}
              />
            </label>

            <div className="project-modal-list" role="listbox">
              {filteredProjects.length === 0 ? (
                <p className="project-modal-empty">
                  {projects.length === 0 ? tr('railNoProjects') : tr('projectSearchEmpty')}
                </p>
              ) : (
                filteredProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="option"
                    aria-selected={project.id === activeProjectId}
                    className={`project-modal-item ${project.id === activeProjectId ? 'active' : ''}`}
                    onClick={() => void selectProject(project.id)}
                  >
                    <span className="project-modal-icon">
                      <Icon name="folder" size={16} />
                    </span>
                    <span className="project-modal-copy">
                      <strong>{project.name}</strong>
                      <em>
                        {project.target} · {project.status}
                      </em>
                    </span>
                    {project.id === activeProjectId ? <Icon name="check" size={16} /> : null}
                  </button>
                ))
              )}
            </div>

            <div className="project-modal-foot">
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setProjectModalOpen(false);
                  setProjectQuery('');
                  openProjects();
                }}
              >
                {projects.length === 0 ? tr('createFirstProject') : tr('manageProjects')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AgentWelcome({
  hint,
  onAction,
  actionLabel,
}: {
  hint: string;
  onAction: () => void;
  actionLabel: string;
}) {
  const { tr } = useSettings();
  return (
    <div className="agent-welcome">
      <div className="agent-welcome-body">
        <div className="agent-hero-mark">
          <Icon name="sparkle" size={28} />
        </div>
        <h1>{tr('chatAskTitle')}</h1>
        <p>{hint || tr('homeEmptyDetail')}</p>
        <button type="button" className="button primary agent-hero-cta" onClick={onAction}>
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
