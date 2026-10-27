'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionView, SchemaSummary } from '../../shared/ipc';
import { errorMessage, getApi } from '@/lib/api';
import {
  ENGINE_LABELS,
  formatCount,
  formatWhen,
  statusLabel,
} from '@/lib/format';
import { useProgressFeed } from '@/lib/hooks';
import { ChatPanel } from './ChatPanel';
import { KnowledgePanel } from './KnowledgePanel';
import { ReadOnlyChecks, ReadOnlyPill } from './ReadOnlyChecks';
import { SetupPanel } from './SetupPanel';
import { useSettings } from '@/lib/settings';
import { ThinkingIndicator } from './ThinkingIndicator';
import { Badge, BusyLine, EmptyState, ErrorBanner, Icon, Notice, Spinner } from './ui';

type Tab = 'overview' | 'setup' | 'knowledge' | 'chat';

export function ConnectionWorkspace({
  id,
  onBack,
  onChanged,
  onReadyToChat,
}: {
  id: string;
  onBack: () => void;
  onChanged?: () => void | Promise<void>;
  onReadyToChat?: () => void;
}) {
  const { tr } = useSettings();
  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: tr('tabOverview') },
    { id: 'setup', label: tr('tabSetup') },
    { id: 'knowledge', label: tr('tabKnowledge') },
    { id: 'chat', label: tr('tabChat') },
  ];
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [summary, setSummary] = useState<SchemaSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('setup');
  const [action, setAction] = useState<'reprobe' | 'refresh' | 'export' | 'delete' | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const progress = useProgressFeed();
  const onChangedRef = useRef(onChanged);
  const onReadyRef = useRef(onReadyToChat);
  onChangedRef.current = onChanged;
  onReadyRef.current = onReadyToChat;

  const load = useCallback(async () => {
    try {
      const [connectionRow, schemaRow] = await Promise.all([
        getApi().connections.get(id),
        getApi().connections.schema(id),
      ]);
      setConnection(connectionRow);
      setSummary(schemaRow);
      setError(null);
      await onChangedRef.current?.();
      return connectionRow;
    } catch (loadError) {
      setError(errorMessage(loadError));
      return null;
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    void (async () => {
      const row = await load();
      if (!row) return;
      if (row.status === 'ready' && row.readOnly?.verdict === 'read-only') setTab('chat');
      else if (row.status === 'failed') setTab('overview');
      else setTab('setup');
    })();
  }, [load]);

  async function reprobe() {
    setAction('reprobe');
    setToast(null);
    try {
      const report = await getApi().connections.reprobe(id);
      await load();
      setToast(
        report.verdict === 'read-only'
          ? { tone: 'ok', text: 'The credentials are still read-only.' }
          : {
              tone: 'bad',
              text: 'These credentials can write. Onboarding and chat stay blocked.',
            },
      );
    } catch (reprobeError) {
      setToast({ tone: 'bad', text: errorMessage(reprobeError) });
    } finally {
      setAction(null);
    }
  }

  async function refresh() {
    setAction('refresh');
    setToast(null);
    try {
      const schema = await getApi().connections.refresh(id);
      setSummary(schema);
      await load();
      setToast({ tone: 'ok', text: 'Schema refreshed from the database.' });
    } catch (refreshError) {
      setToast({ tone: 'bad', text: errorMessage(refreshError) });
    } finally {
      setAction(null);
    }
  }

  async function exportSchema() {
    setAction('export');
    setToast(null);
    try {
      const result = await getApi().connections.exportSchema(id);
      if (result) {
        setToast({
          tone: 'ok',
          text: `Schema exported to ${result.path} (${result.rows.toLocaleString()} rows).`,
        });
      }
    } catch (exportError) {
      setToast({ tone: 'bad', text: errorMessage(exportError) });
    } finally {
      setAction(null);
    }
  }

  async function remove() {
    if (!connection) return;
    if (
      !window.confirm(
        `Delete project “${connection.name}”? Its questions, knowledge base, chats and exported result files will be removed.`,
      )
    ) {
      return;
    }
    setAction('delete');
    setToast(null);
    try {
      await getApi().connections.remove(id);
      onBack();
    } catch (deleteError) {
      setToast({ tone: 'bad', text: errorMessage(deleteError) });
      setAction(null);
    }
  }

  if (loading) {
    return (
      <div className="loading-row">
        <Spinner label="Opening project" />
      </div>
    );
  }

  if (!connection) {
    return (
      <EmptyState
        icon="database"
        title="Project not found"
        description={error ?? 'It may have been deleted.'}
        action={
          <button type="button" className="button primary" onClick={onBack}>
            Back to projects
          </button>
        }
      />
    );
  }

  const readOnly = connection.readOnly?.verdict === 'read-only';

  return (
    <div className="workspace">
      <header className="workspace-head">
        <button type="button" className="button ghost back" onClick={onBack}>
          <Icon name="back" size={16} /> Projects
        </button>

        <div className="workspace-title">
          <div className="workspace-line">
            <h1>{connection.name}</h1>
            <Badge
              tone={
                connection.status === 'ready'
                  ? 'ok'
                  : connection.status === 'failed'
                    ? 'bad'
                    : connection.status === 'questions'
                      ? 'warn'
                      : 'neutral'
              }
            >
              {statusLabel(connection.status)}
            </Badge>
            <ReadOnlyPill report={connection.readOnly} />
          </div>
          <span className="workspace-target mono">
            {ENGINE_LABELS[connection.engine]} · {connection.target} ·{' '}
            {connection.tableCount === null ? 'schema not read' : `${formatCount(connection.tableCount)} tables`}
          </span>
        </div>

        <div className="workspace-actions">
          <button
            type="button"
            className="button small"
            onClick={() => void reprobe()}
            disabled={action !== null}
          >
            {action === 'reprobe' ? <Spinner /> : <Icon name="lock" size={14} />} Re-probe
          </button>
          <button
            type="button"
            className="button small danger"
            onClick={() => void remove()}
            disabled={action !== null}
          >
            {action === 'delete' ? <Spinner /> : <Icon name="trash" size={14} />} Delete
          </button>
        </div>
      </header>

      {connection.statusDetail ? <ErrorBanner message={connection.statusDetail} /> : null}
      {error ? <ErrorBanner message={error} /> : null}
      {action === 'reprobe' || action === 'refresh' ? (
        <ThinkingIndicator mode="analyzing" detail={progress?.message ?? null} />
      ) : action ? (
        <BusyLine
          message={
            action === 'export' ? 'Exporting the schema' : 'Deleting the connection'
          }
          detail={progress?.message ?? null}
        />
      ) : null}
      {toast ? <Notice tone={toast.tone}>{toast.text}</Notice> : null}

      <nav className="tabs" aria-label="Connection sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? 'tab active' : 'tab'}
            onClick={() => {
              if (tab === 'chat' && item.id !== 'chat') {
                void getApi().chat.flushLearning(id).catch(() => undefined);
              }
              setTab(item.id);
            }}
          >
            {item.label}
            {item.id === 'chat' && !readOnly ? <Icon name="lock" size={12} /> : null}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <div className="overview-layout">
          <div className="stack">
            {connection.readOnly ? (
              <ReadOnlyChecks report={connection.readOnly} />
            ) : (
              <Notice tone="warn">
                <Icon name="alert" size={16} />
                <span>No read-only verification has been recorded for this connection.</span>
                <button type="button" className="button small" onClick={() => void reprobe()}>
                  Re-probe now
                </button>
              </Notice>
            )}

            <section className="panel">
              <header className="panel-head">
                <div>
                  <h2>Schema</h2>
                  <p className="muted small">
                    {summary
                      ? `${formatCount(summary.tables.length)} tables, read ${formatWhen(summary.fetchedAt)}`
                      : 'No schema snapshot yet.'}
                  </p>
                </div>
                <div className="panel-actions">
                  <button
                    type="button"
                    className="button small"
                    onClick={() => void refresh()}
                    disabled={action !== null || !readOnly}
                  >
                    {action === 'refresh' ? <Spinner /> : <Icon name="refresh" size={14} />} Refresh
                  </button>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => void exportSchema()}
                    disabled={action !== null || !summary}
                  >
                    {action === 'export' ? <Spinner /> : <Icon name="download" size={14} />} Export CSV
                  </button>
                </div>
              </header>

              {summary ? (
                <div className="schema-list">
                  <div className="schema-row schema-row-head">
                    <span>Table</span>
                    <span>Rows</span>
                    <span>Columns</span>
                  </div>
                  {summary.tables.map((table) => (
                    <div key={`${table.schema}.${table.name}`} className="schema-row">
                      <span className="mono">
                        {table.schema && table.schema !== 'main' ? `${table.schema}.` : ''}
                        {table.name}
                      </span>
                      <span className="muted">{formatCount(table.rowCount)}</span>
                      <span className="muted">{table.columnCount}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  The schema is missing. Re-probe the connection, then use Refresh to read tables and
                  sample rows.
                </p>
              )}
            </section>
          </div>

          <aside className="stack">
            <section className="panel side-card">
              <h3>Next step</h3>
              {connection.status === 'ready' ? (
                <>
                  <p className="muted small">
                    The knowledge base is ready. Ask in natural language and export any result.
                  </p>
                  <button type="button" className="button primary block" onClick={() => setTab('chat')}>
                    <Icon name="chat" size={15} /> Open chat
                  </button>
                  <button type="button" className="button ghost block" onClick={() => setTab('knowledge')}>
                    View knowledge base
                  </button>
                </>
              ) : connection.status === 'failed' ? (
                <>
                  <p className="muted small">
                    The connection needs attention before onboarding can continue. Re-probe the
                    credentials, then refresh the schema.
                  </p>
                  <button type="button" className="button block" onClick={() => void reprobe()}>
                    <Icon name="lock" size={15} /> Re-probe
                  </button>
                </>
              ) : connection.status === 'questions' ? (
                <>
                  <p className="muted small">
                    Answer the onboarding questions, then build the knowledge base to unlock chat.
                  </p>
                  <button type="button" className="button primary block" onClick={() => setTab('setup')}>
                    Continue onboarding
                  </button>
                </>
              ) : (
                <>
                  <p className="muted small">
                    The connection is saved. Start onboarding so the AI can ask about the business
                    meaning of this schema.
                  </p>
                  <button type="button" className="button primary block" onClick={() => setTab('setup')}>
                    Start onboarding
                  </button>
                </>
              )}
            </section>

            <section className="panel side-card">
              <h3>Details</h3>
              <dl className="details">
                <div>
                  <dt>Engine</dt>
                  <dd>{ENGINE_LABELS[connection.engine]}</dd>
                </div>
                <div>
                  <dt>AI model</dt>
                  <dd>{connection.aiModelName ?? '—'}</dd>
                </div>
                <div>
                  <dt>Knowledge</dt>
                  <dd>{connection.hasKnowledge ? 'built' : 'not built'}</dd>
                </div>
                <div>
                  <dt>Tables</dt>
                  <dd>{formatCount(connection.tableCount)}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatWhen(connection.createdAt)}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{formatWhen(connection.updatedAt)}</dd>
                </div>
              </dl>
            </section>
          </aside>
        </div>
      ) : null}

      {tab === 'setup' ? (
        <SetupPanel
          connection={connection}
          onChanged={async () => {
            const row = await load();
            if (row?.status === 'ready' && row.readOnly?.verdict === 'read-only') {
              onReadyRef.current?.();
            }
          }}
          onOpenKnowledge={() => setTab('knowledge')}
          onOpenChat={() => {
            setTab('chat');
            onReadyRef.current?.();
          }}
        />
      ) : null}

      {tab === 'knowledge' ? (
        <KnowledgePanel
          connection={connection}
          onSetup={() => setTab('setup')}
          onChat={() => {
            setTab('chat');
            onReadyRef.current?.();
          }}
        />
      ) : null}

      {tab === 'chat' ? (
        <ChatPanel connection={connection} onSetup={() => setTab('setup')} />
      ) : null}
    </div>
  );
}
