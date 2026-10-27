'use client';

import { useEffect, useState } from 'react';
import type {
  AiModelView,
  ConnectionInput,
  ConnectionView,
  EngineId,
  ReadOnlyReport,
} from '../../shared/ipc';
import { FadeIn, GuidedSteps, SpotlightCard, StartHereCard, WizardSteps } from '@/components/bits';
import { errorMessage, getApi } from '@/lib/api';
import { ENGINE_LABELS, ENGINE_PORTS, formatCount, formatWhen, statusLabel } from '@/lib/format';
import { useProgressFeed } from '@/lib/hooks';
import { useSettings } from '@/lib/settings';
import { ReadOnlyChecks, ReadOnlyPill } from './ReadOnlyChecks';
import { Badge, BusyLine, EmptyState, ErrorBanner, Icon, Notice, Spinner } from './ui';

const ENGINES: EngineId[] = ['postgres', 'mysql', 'mssql', 'sqlite'];
const WIZARD = ['Basics', 'Database', 'Connect'];

function blankForm(): ConnectionInput {
  return {
    name: '',
    engine: 'postgres',
    aiModelId: '',
    host: 'localhost',
    port: ENGINE_PORTS.postgres,
    database: '',
    username: '',
    password: '',
    ssl: false,
  };
}

function statusTone(status: ConnectionView['status']): 'neutral' | 'ok' | 'warn' | 'bad' {
  if (status === 'ready') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'questions') return 'warn';
  return 'neutral';
}

export function ConnectionsView({
  onOpen,
  onModels,
  onChanged,
}: {
  onOpen: (id: string) => void;
  onModels: () => void;
  onChanged?: () => void;
}) {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [models, setModels] = useState<AiModelView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [form, setForm] = useState<ConnectionInput>(blankForm);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createReport, setCreateReport] = useState<ReadOnlyReport | null>(null);
  const progress = useProgressFeed();
  const { tr } = useSettings();

  async function load() {
    setLoading(true);
    try {
      const api = getApi();
      const [connectionRows, modelRows] = await Promise.all([
        api.connections.list(),
        api.models.list(),
      ]);
      setConnections(connectionRows);
      setModels(modelRows);
      setError(null);
      onChanged?.();
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function field<K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function openForm() {
    const next = blankForm();
    next.aiModelId = models[0]?.id ?? '';
    setForm(next);
    setWizardStep(0);
    setCreateError(null);
    setCreateReport(null);
    setShowForm(true);
  }

  function selectEngine(engine: EngineId) {
    setForm((current) => ({
      ...current,
      engine,
      port: engine === 'sqlite' ? undefined : ENGINE_PORTS[engine],
      ssl: engine === 'sqlite' ? false : current.ssl,
    }));
  }

  async function browseSqlite() {
    try {
      const filePath = await getApi().connections.pickSqliteFile();
      if (filePath) field('filePath', filePath);
    } catch (browseError) {
      setCreateError(errorMessage(browseError));
    }
  }

  function canAdvanceBasics() {
    return Boolean(form.name.trim() && (form.aiModelId || models[0]?.id));
  }

  function canAdvanceDatabase() {
    if (form.engine === 'sqlite') return Boolean(form.filePath?.trim());
    return Boolean(form.host?.trim() && form.database?.trim() && form.username?.trim());
  }

  async function submit() {
    setCreating(true);
    setCreateError(null);
    setCreateReport(null);
    try {
      const result = await getApi().connections.create({
        ...form,
        aiModelId: form.aiModelId || models[0]?.id || '',
      });
      if (!result.ok) {
        setCreateError(result.error);
        setCreateReport(result.report ?? null);
        return;
      }
      setShowForm(false);
      await load();
      onOpen(result.connection.id);
    } catch (submitError) {
      setCreateError(errorMessage(submitError));
    } finally {
      setCreating(false);
    }
  }

  async function remove(connection: ConnectionView) {
    if (!window.confirm(`Delete project “${connection.name}”?`)) return;
    try {
      await getApi().connections.remove(connection.id);
      await load();
    } catch (removeError) {
      setError(errorMessage(removeError));
    }
  }

  return (
    <FadeIn className="page">
      <header className="page-head">
        <div>
          <h1>{tr('projectsTitle')}</h1>
          <p className="subtitle">{tr('projectsSubtitle')}</p>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={openForm}
          disabled={models.length === 0}
        >
          <Icon name="plus" size={16} /> {tr('newProject')}
        </button>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {models.length === 0 && !loading ? (
        <StartHereCard title={tr('firstBrainTitle')} description={tr('firstBrainDetail')}>
          <div style={{ marginTop: 16 }}>
            <button type="button" className="button primary" onClick={onModels}>
              {tr('goBrain')} <Icon name="arrow-right" size={14} />
            </button>
          </div>
        </StartHereCard>
      ) : null}

      {showForm ? (
        <section className="panel form-panel">
          <header className="panel-head">
            <div>
              <h2>New project</h2>
              <p className="muted">Three short steps. We will refuse any account that can write.</p>
            </div>
            <button
              type="button"
              className="button ghost"
              onClick={() => setShowForm(false)}
              disabled={creating}
            >
              Cancel
            </button>
          </header>

          <WizardSteps steps={WIZARD} current={wizardStep} />

          {createError ? <ErrorBanner message={createError} /> : null}
          {createReport ? <ReadOnlyChecks report={createReport} /> : null}
          {creating ? (
            <BusyLine
              message="Checking your database"
              detail={progress?.message ?? 'Proving credentials cannot write'}
            />
          ) : null}

          {wizardStep === 0 ? (
            <div className="form-grid">
              <label className="field field-wide">
                <span>Give this project a friendly name</span>
                <input
                  value={form.name}
                  onChange={(event) => field('name', event.target.value)}
                  placeholder="Sales warehouse"
                  autoFocus
                />
                <small>Something you will recognize later — not the server hostname.</small>
              </label>

              <label className="field field-wide">
                <span>Which AI brain should answer questions?</span>
                <select
                  value={form.aiModelId}
                  onChange={(event) => field('aiModelId', event.target.value)}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} · {model.model}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          {wizardStep === 1 ? (
            <div className="form-grid">
              <div className="field field-wide">
                <span>What kind of database is it?</span>
                <div className="segmented">
                  {ENGINES.map((engine) => (
                    <button
                      key={engine}
                      type="button"
                      className={form.engine === engine ? 'active' : ''}
                      onClick={() => selectEngine(engine)}
                    >
                      {ENGINE_LABELS[engine]}
                    </button>
                  ))}
                </div>
              </div>

              {form.engine === 'sqlite' ? (
                <div className="field field-wide">
                  <span>Pick the .db file on this computer</span>
                  <div className="input-row">
                    <input
                      value={form.filePath ?? ''}
                      onChange={(event) => field('filePath', event.target.value)}
                      placeholder="/path/to/database.db"
                      spellCheck={false}
                    />
                    <button type="button" className="button" onClick={() => void browseSqlite()}>
                      Browse…
                    </button>
                  </div>
                  <small>Opened query-only — the file is never modified.</small>
                </div>
              ) : (
                <>
                  <label className="field">
                    <span>Host</span>
                    <input
                      value={form.host ?? ''}
                      onChange={(event) => field('host', event.target.value)}
                      placeholder="localhost"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field narrow">
                    <span>Port</span>
                    <input
                      type="number"
                      value={form.port ?? ''}
                      onChange={(event) =>
                        field('port', event.target.value ? Number(event.target.value) : undefined)
                      }
                      min={1}
                      max={65535}
                    />
                  </label>
                  <label className="field">
                    <span>Database name</span>
                    <input
                      value={form.database ?? ''}
                      onChange={(event) => field('database', event.target.value)}
                      placeholder="analytics"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    <span>Read-only username</span>
                    <input
                      value={form.username ?? ''}
                      onChange={(event) => field('username', event.target.value)}
                      placeholder="report_reader"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field field-wide">
                    <span>Password</span>
                    <input
                      type="password"
                      value={form.password ?? ''}
                      onChange={(event) => field('password', event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <label className="check-field field-wide">
                    <input
                      type="checkbox"
                      checked={form.ssl === true}
                      onChange={(event) => field('ssl', event.target.checked)}
                    />
                    <span>Use TLS / SSL</span>
                  </label>
                </>
              )}
            </div>
          ) : null}

          {wizardStep === 2 ? (
            <div className="stack">
              <Notice tone="info">
                <Icon name="lock" size={16} />
                <span>
                  Next we connect once and try tiny write tests. If they succeed, the project is{' '}
                  <strong>not</strong> saved. Credentials stay encrypted on this computer.
                </span>
              </Notice>
              <div className="panel" style={{ boxShadow: 'none' }}>
                <h3>Review</h3>
                <p className="muted small" style={{ margin: '6px 0 0' }}>
                  <strong>{form.name || 'Untitled'}</strong> · {ENGINE_LABELS[form.engine]} ·{' '}
                  {form.engine === 'sqlite'
                    ? form.filePath || 'no file'
                    : `${form.host}/${form.database} as ${form.username}`}
                </p>
              </div>
            </div>
          ) : null}

          <div className="form-actions">
            <button
              type="button"
              className="button ghost"
              disabled={creating || wizardStep === 0}
              onClick={() => setWizardStep((step) => Math.max(0, step - 1))}
            >
              Back
            </button>
            {wizardStep < 2 ? (
              <button
                type="button"
                className="button primary"
                disabled={
                  creating || (wizardStep === 0 ? !canAdvanceBasics() : !canAdvanceDatabase())
                }
                onClick={() => setWizardStep((step) => Math.min(2, step + 1))}
              >
                Continue <Icon name="arrow-right" size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                onClick={() => void submit()}
                disabled={creating}
              >
                {creating ? <Spinner label="Verifying" /> : 'Verify & connect'}
              </button>
            )}
          </div>
        </section>
      ) : null}

      {loading ? (
        <div className="loading-row">
          <Spinner label="Loading projects" />
        </div>
      ) : connections.length === 0 && !showForm ? (
        <EmptyState
          icon="database"
          title="No projects yet"
          description="Connect a read-only database. We will guide you through naming it, picking the engine, and verifying safety."
          action={
            models.length > 0 ? (
              <>
                <button type="button" className="button primary" onClick={openForm}>
                  <Icon name="plus" size={16} /> Create your first project
                </button>
                <GuidedSteps
                  title="What happens next"
                  steps={[
                    {
                      id: 'name',
                      title: 'Name it',
                      detail: 'Pick a friendly label and an AI brain.',
                      active: true,
                    },
                    {
                      id: 'db',
                      title: 'Point at the database',
                      detail: 'Postgres, MySQL, SQL Server, or a SQLite file.',
                    },
                    {
                      id: 'ask',
                      title: 'Ask questions',
                      detail: 'We build a knowledge base, then you chat in plain English.',
                    },
                  ]}
                />
              </>
            ) : undefined
          }
        />
      ) : (
        <div className="card-grid">
          {connections.map((connection) => (
            <SpotlightCard
              key={connection.id}
              className="model-card project-card"
              theme="dark"
              spotlightColor="rgba(56, 189, 248, 0.9)"
              intensity={0.16}
              spotlightSize={260}
              borderGlow={0.7}
            >
              <div className="model-head">
                <div>
                  <h3 className="connection-name">{connection.name}</h3>
                  <span className="mono muted small">{ENGINE_LABELS[connection.engine]}</span>
                </div>
                <Badge tone={statusTone(connection.status)}>
                  {statusLabel(connection.status)}
                </Badge>
              </div>
              <div className="model-url mono">{connection.target}</div>
              <div className="model-meta">
                <span>
                  {connection.tableCount === null
                    ? 'schema not read'
                    : `${formatCount(connection.tableCount)} tables`}
                  {' · '}
                  {connection.aiModelName ?? 'no AI model'}
                </span>
                <span>updated {formatWhen(connection.updatedAt)}</span>
              </div>
              <div className="project-card-pill">
                <ReadOnlyPill report={connection.readOnly} />
              </div>
              <div className="card-actions">
                <button
                  type="button"
                  className="button small primary"
                  onClick={() => onOpen(connection.id)}
                >
                  Open <Icon name="arrow-right" size={14} />
                </button>
                <button
                  type="button"
                  className="button small danger"
                  onClick={() => void remove(connection)}
                >
                  <Icon name="trash" size={14} /> Delete
                </button>
              </div>
            </SpotlightCard>
          ))}
        </div>
      )}
    </FadeIn>
  );
}
