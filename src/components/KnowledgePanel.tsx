'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ConnectionView, KnowledgeView } from '../../shared/ipc';
import { errorMessage, getApi } from '@/lib/api';
import { formatWhen } from '@/lib/format';
import { EmptyState, ErrorBanner, Icon, Spinner } from './ui';

export function KnowledgePanel({
  connection,
  onSetup,
  onChat,
}: {
  connection: ConnectionView;
  onSetup: () => void;
  onChat: () => void;
}) {
  const [knowledge, setKnowledge] = useState<KnowledgeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const row = await getApi().knowledge.get(connection.id);
        if (!cancelled) {
          setKnowledge(row);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection.id, connection.hasKnowledge]);

  if (loading) {
    return (
      <div className="loading-row">
        <Spinner label="Loading knowledge base" />
      </div>
    );
  }

  if (error) return <ErrorBanner message={error} />;

  if (!knowledge) {
    return (
      <EmptyState
        icon="sparkle"
        title="The knowledge base is not built yet"
        description="Answer the onboarding questions, then build the knowledge base. The chatbot will not run until it exists."
        action={
          <button type="button" className="button primary" onClick={onSetup}>
            Go to setup
          </button>
        }
      />
    );
  }

  return (
    <div className="knowledge-layout">
      <article className="panel knowledge-main">
        <header className="knowledge-head">
          <div>
            <span className="eyebrow">Knowledge base</span>
            <h2>{connection.name}</h2>
            <p className="muted">{knowledge.summary}</p>
          </div>
          <div className="knowledge-actions">
            <button type="button" className="button small" onClick={onSetup}>
              <Icon name="edit" size={14} /> Rebuild
            </button>
            <button
              type="button"
              className="button small primary"
              onClick={onChat}
              disabled={connection.status !== 'ready'}
            >
              <Icon name="chat" size={14} /> Open chat
            </button>
          </div>
        </header>
        <div className="knowledge-meta muted small">
          <span>updated {formatWhen(knowledge.updatedAt)}</span>
          <span>{knowledge.glossary.length} glossary terms</span>
        </div>
        <div className="markdown">
          <ReactMarkdown>{knowledge.content}</ReactMarkdown>
        </div>
      </article>

      <aside className="panel glossary">
        <h3>Glossary</h3>
        {knowledge.glossary.length === 0 ? (
          <p className="muted small">No glossary terms were generated.</p>
        ) : (
          <dl>
            {knowledge.glossary.map((entry) => (
              <div key={entry.term} className="glossary-entry">
                <dt>{entry.term}</dt>
                <dd>{entry.definition}</dd>
              </div>
            ))}
          </dl>
        )}
      </aside>
    </div>
  );
}
