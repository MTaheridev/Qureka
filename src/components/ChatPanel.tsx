'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type {
  AiModelView,
  ChatMessageView,
  ConnectionView,
  ConversationView,
  ExportFormat,
  RunView,
} from '../../shared/ipc';
import { errorMessage, getApi } from '@/lib/api';
import { formatWhen } from '@/lib/format';
import { useProgressFeed } from '@/lib/hooks';
import { SuggestionChips } from '@/components/bits';
import { useSettings } from '@/lib/settings';
import { ThinkingIndicator } from './ThinkingIndicator';
import { EmptyState, ErrorBanner, Icon, Spinner } from './ui';

const FORMATS: { format: ExportFormat; label: string }[] = [
  { format: 'xlsx', label: 'Excel' },
  { format: 'csv', label: 'CSV' },
  { format: 'pdf', label: 'PDF' },
];

function cellText(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  return String(value);
}

export function ChatPanel({
  connection,
  onSetup,
  compact = false,
  models = [],
  activeModel = null,
  onSelectModel,
  onManageModels,
}: {
  connection: ConnectionView;
  onSetup: () => void;
  compact?: boolean;
  models?: AiModelView[];
  activeModel?: AiModelView | null;
  onSelectModel?: (modelId: string) => void;
  onManageModels?: () => void;
}) {
  const [chats, setChats] = useState<ConversationView[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [exporting, setExporting] = useState<{ runId: string; format: ExportFormat } | null>(null);
  const [exportNote, setExportNote] = useState<{ runId: string; ok: boolean; text: string } | null>(null);
  const progress = useProgressFeed();
  const endRef = useRef<HTMLDivElement>(null);
  const { tr, settings } = useSettings();

  useEffect(() => {
    if (!modelMenuOpen) return;
    function onDocClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.composer-model-wrap')) setModelMenuOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [modelMenuOpen]);

  const ready = connection.status === 'ready' && connection.readOnly?.verdict === 'read-only';

  async function refreshChats(preferredId?: string | null) {
    const list = await getApi().chat.list(connection.id);
    setChats(list);
    const nextId =
      (preferredId && list.some((chat) => chat.id === preferredId) ? preferredId : null) ??
      list[0]?.id ??
      null;
    setActiveChatId(nextId);
    return nextId;
  }

  async function loadHistory(conversationId: string) {
    const history = await getApi().chat.history(conversationId);
    setMessages(history);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setActiveChatId(null);
      setMessages([]);
      try {
        const list = await getApi().chat.list(connection.id);
        if (cancelled) return;
        setChats(list);
        const first = list[0]?.id ?? null;
        setActiveChatId(first);
        if (first) {
          const history = await getApi().chat.history(first);
          if (!cancelled) setMessages(history);
        }
        setError(null);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      void getApi().chat.flushLearning(connection.id).catch(() => undefined);
    };
  }, [connection.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, sending]);

  async function selectChat(conversationId: string) {
    if (conversationId === activeChatId || switching || sending) return;
    setSwitching(true);
    setError(null);
    setExportNote(null);
    try {
      void getApi().chat.flushLearning(connection.id).catch(() => undefined);
      setActiveChatId(conversationId);
      await loadHistory(conversationId);
    } catch (selectError) {
      setError(errorMessage(selectError));
    } finally {
      setSwitching(false);
    }
  }

  async function newChat() {
    setError(null);
    try {
      void getApi().chat.flushLearning(connection.id).catch(() => undefined);
      const created = await getApi().chat.create(connection.id);
      await refreshChats(created.id);
      setMessages([]);
      setExportNote(null);
    } catch (createError) {
      setError(errorMessage(createError));
    }
  }

  async function send(override?: string) {
    const question = (override ?? input).trim();
    if (!question || sending || !activeChatId) return;
    setSending(true);
    setError(null);
    if (!override) setInput('');
    else setInput('');
    try {
      const result = await getApi().chat.ask(activeChatId, question);
      setMessages(result.messages);
      setChats((current) => {
        const others = current.filter((chat) => chat.id !== result.conversation.id);
        return [result.conversation, ...others];
      });
    } catch (sendError) {
      setError(errorMessage(sendError));
      setInput(question);
    } finally {
      setSending(false);
    }
  }

  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    function onAgentAsk(event: Event) {
      const detail = (event as CustomEvent<{ question?: string; projectId?: string }>).detail;
      if (!detail?.question || detail.projectId !== connection.id) return;
      void sendRef.current(detail.question);
    }
    window.addEventListener('qureka:agent-ask', onAgentAsk);
    return () => window.removeEventListener('qureka:agent-ask', onAgentAsk);
  }, [connection.id]);

  async function exportRun(runId: string, format: ExportFormat) {
    setExporting({ runId, format });
    setExportNote(null);
    try {
      const result = await getApi().exports.run(runId, format);
      if (result) {
        setExportNote({
          runId,
          ok: true,
          text: `Saved ${result.rows.toLocaleString()} rows to ${result.path}`,
        });
      }
    } catch (exportError) {
      setExportNote({ runId, ok: false, text: errorMessage(exportError) });
    } finally {
      setExporting(null);
    }
  }

  if (!ready) {
    return (
      <EmptyState
        icon="lock"
        title={tr('chatsLocked')}
        description={
          connection.readOnly?.verdict !== 'read-only'
            ? tr('chatsLockedReadonly')
            : tr('chatsLockedSetup')
        }
        action={
          <button type="button" className="button primary" onClick={onSetup}>
            {tr('goSetup')}
          </button>
        }
      />
    );
  }

  if (loading) {
    return (
      <div className="loading-row">
        <Spinner label="Loading chats" />
      </div>
    );
  }

  return (
    <div className={`chat-layout ${compact ? 'compact' : ''}`}>
      <aside className="chat-rail" aria-label="Chats in this project">
        <div className="chat-rail-head">
          <div>
            <strong>Chats</strong>
            <span className="muted small">In this project</span>
          </div>
          <button type="button" className="button small primary" onClick={() => void newChat()}>
            <Icon name="plus" size={14} /> New
          </button>
        </div>
        <div className="chat-rail-list">
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={chat.id === activeChatId ? 'chat-rail-item active' : 'chat-rail-item'}
              onClick={() => void selectChat(chat.id)}
              disabled={switching || sending}
            >
              <span className="chat-rail-title">{chat.title}</span>
              <span className="muted small">
                {chat.messageCount} msg · {formatWhen(chat.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="chat">
      {error ? <ErrorBanner message={error} /> : null}

      <div className="messages">
        {messages.length === 0 ? (
          <div className="chat-intro">
            <span className="chat-intro-icon">
              <Icon name="chat" size={22} />
            </span>
            <h3>{tr('chatAskTitle')}</h3>
            <p className="muted">{tr('chatAskDetail')}</p>
            <SuggestionChips
              items={
                settings.language === 'fa'
                  ? [
                      'این دیتابیس درباره چیست؟',
                      '۱۰ مشتری بزرگ از نظر درآمد را نشان بده',
                      'هر ماه چند سفارش ثبت شده؟',
                      'کدام جدول‌ها مهم‌ترند؟',
                    ]
                  : [
                      'What is this database about?',
                      'Show me the 10 largest customers by revenue',
                      'How many orders were created each month?',
                      'Which tables matter most?',
                    ]
              }
              onPick={setInput}
            />
          </div>
        ) : (
          messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              exporting={exporting}
              exportNote={exportNote}
              knowledgeLabel={tr('knowledgeAnswer')}
              onExport={(format) => {
                if (message.run) void exportRun(message.run.id, format);
              }}
            />
          ))
        )}
        {sending ? (
          <ThinkingIndicator
            mode="thinking"
            detail={progress?.message ?? null}
          />
        ) : null}
        <div ref={endRef} />
      </div>

      <div className={`composer ${compact ? 'composer-agent' : ''}`}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={compact ? 1 : 2}
          placeholder={
            compact
              ? tr('agentPlaceholder')
              : tr('chatPlaceholder', { name: connection.name })
          }
          disabled={sending || !activeChatId}
        />
        {compact ? (
          <div className="composer-model-wrap">
            <button
              type="button"
              className="composer-model"
              onClick={(event) => {
                event.stopPropagation();
                setModelMenuOpen((open) => !open);
              }}
              disabled={sending}
            >
              <span>{activeModel?.name ?? tr('capsuleNoModel')}</span>
              <Icon name="chevron-down" size={14} />
            </button>
            {modelMenuOpen ? (
              <div className="composer-model-menu" role="listbox">
                {models.length === 0 ? (
                  <button
                    type="button"
                    className="composer-model-option"
                    onClick={() => {
                      setModelMenuOpen(false);
                      onManageModels?.();
                    }}
                  >
                    {tr('addBrain')}
                  </button>
                ) : (
                  models.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className={`composer-model-option ${model.id === activeModel?.id ? 'active' : ''}`}
                      onClick={() => {
                        setModelMenuOpen(false);
                        onSelectModel?.(model.id);
                      }}
                    >
                      <strong>{model.name}</strong>
                      <span>{model.model}</span>
                    </button>
                  ))
                )}
                <button
                  type="button"
                  className="composer-model-option accent"
                  onClick={() => {
                    setModelMenuOpen(false);
                    onManageModels?.();
                  }}
                >
                  {tr('manageModels')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className={`button primary send ${compact ? 'agent-send' : ''}`}
          onClick={() => void send()}
          disabled={sending || input.trim().length === 0 || !activeChatId}
          aria-label="Send question"
        >
          {sending ? <Spinner /> : <Icon name="send" size={18} />}
        </button>
        {compact ? null : (
          <span className="composer-hint muted small">
            Enter to send · Shift+Enter for a new line · read-only · no secrets
          </span>
        )}
      </div>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  exporting,
  exportNote,
  knowledgeLabel,
  onExport,
}: {
  message: ChatMessageView;
  exporting: { runId: string; format: ExportFormat } | null;
  exportNote: { runId: string; ok: boolean; text: string } | null;
  knowledgeLabel: string;
  onExport: (format: ExportFormat) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="message user">
        <div className="bubble">{message.content}</div>
        <span className="message-time">{formatWhen(message.createdAt)}</span>
      </div>
    );
  }

  return (
    <div className="message assistant">
      <div className="avatar">
        <Icon name="sparkle" size={15} />
      </div>
      <div className="message-body">
        {!message.error && !message.run ? (
          <span className="answer-pill">{knowledgeLabel}</span>
        ) : null}
        <div className={`markdown ${message.error ? 'markdown-error' : ''}`}>
          <ReactMarkdown>{message.content}</ReactMarkdown>
        </div>

        {message.run ? (
          <ResultView
            run={message.run}
            exporting={exporting}
            note={exportNote}
            onExport={onExport}
          />
        ) : null}

        <span className="message-time">{formatWhen(message.createdAt)}</span>
      </div>
    </div>
  );
}

function ResultView({
  run,
  exporting,
  note,
  onExport,
}: {
  run: RunView;
  exporting: { runId: string; format: ExportFormat } | null;
  note: { runId: string; ok: boolean; text: string } | null;
  onExport: (format: ExportFormat) => void;
}) {
  const singleWide =
    run.rowCount === 1 &&
    run.rows[0] &&
    run.columns.length >= 2 &&
    run.columns.every((column, index) => {
      const value = run.rows[0]?.[index];
      return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    });

  return (
    <section className="result">
      <div className="result-head">
        <span>
          <strong>{run.rowCount.toLocaleString()}</strong>{' '}
          {run.rowCount === 1 ? 'row' : 'rows'} · {run.durationMs.toLocaleString()} ms
          {run.truncated ? ' · capture limit reached' : ''}
        </span>
        {run.canExport ? (
          <div className="export-actions">
            {FORMATS.map(({ format, label }) => {
              const active = exporting?.runId === run.id && exporting.format === format;
              return (
                <button
                  key={format}
                  type="button"
                  className="button small"
                  onClick={() => onExport(format)}
                  disabled={exporting !== null}
                >
                  {active ? <Spinner /> : <Icon name="download" size={14} />} {label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {run.truncated ? (
        <p className="muted small result-note">
          The result exceeded the 200,000-row capture limit. Exports contain only the captured rows.
        </p>
      ) : null}

      {singleWide && run.rows[0] ? (
        <dl className="result-facts">
          {run.columns.map((column, index) => (
            <div key={`${column}-${index}`} className="result-fact">
              <dt>{column}</dt>
              <dd className={run.rows[0]?.[index] === null ? 'cell-null' : undefined}>
                {cellText(run.rows[0]?.[index] ?? null)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="grid-scroll">
          <table className="data-grid">
            <thead>
              <tr>
                {run.columns.map((column, index) => (
                  <th key={`${column}-${index}`}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {run.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {run.columns.map((column, columnIndex) => {
                    const value = row[columnIndex];
                    return (
                      <td key={`${column}-${columnIndex}`} className={value === null ? 'cell-null' : ''}>
                        {cellText(value ?? null)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {run.rowCount > run.rows.length ? (
        <p className="muted small result-note">
          Showing the first {run.rows.length.toLocaleString()} of {run.rowCount.toLocaleString()} rows.
          Export the result to get every captured row.
        </p>
      ) : null}

      {note?.runId === run.id ? (
        <div className={`banner ${note.ok ? 'banner-ok' : 'banner-bad'}`}>
          <Icon name={note.ok ? 'check' : 'alert'} size={15} />
          <span>{note.text}</span>
        </div>
      ) : null}
    </section>
  );
}
