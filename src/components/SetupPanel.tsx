'use client';

import { useEffect, useState } from 'react';
import type {
  ConnectionView,
  KnowledgeView,
  OnboardingQuestionView,
} from '../../shared/ipc';
import { errorMessage, getApi } from '@/lib/api';
import { useProgressFeed } from '@/lib/hooks';
import { BusyLine, EmptyState, ErrorBanner, Icon, Notice, Spinner } from './ui';

export function SetupPanel({
  connection,
  onChanged,
  onOpenKnowledge,
}: {
  connection: ConnectionView;
  onChanged: () => void | Promise<void>;
  onOpenKnowledge: () => void;
}) {
  const [questions, setQuestions] = useState<OnboardingQuestionView[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeView | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'questions' | 'build' | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [builtNow, setBuiltNow] = useState(false);
  const progress = useProgressFeed();

  const readOnly = connection.readOnly?.verdict === 'read-only';
  const canPrepare = readOnly && connection.status !== 'failed';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [questionRows, knowledgeRow] = await Promise.all([
          getApi().onboarding.questions(connection.id),
          getApi().knowledge.get(connection.id),
        ]);
        if (cancelled) return;
        setQuestions(questionRows);
        setAnswers(
          Object.fromEntries(questionRows.map((question) => [question.id, question.answer ?? ''])),
        );
        setKnowledge(knowledgeRow);
        setError(null);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection.id]);

  async function generateQuestions() {
    setBusy('questions');
    setError(null);
    try {
      const rows = await getApi().onboarding.start(connection.id);
      setQuestions(rows);
      setAnswers(
        Object.fromEntries(rows.map((question) => [question.id, question.answer ?? ''])),
      );
      await onChanged();
    } catch (startError) {
      setError(errorMessage(startError));
    } finally {
      setBusy(null);
    }
  }

  async function saveAnswer(question: OnboardingQuestionView) {
    const value = answers[question.id] ?? '';
    setSavingId(question.id);
    setError(null);
    try {
      await getApi().onboarding.answer(question.id, value);
      const trimmed = value.trim();
      setQuestions((current) =>
        current.map((row) =>
          row.id === question.id
            ? { ...row, answer: trimmed || null, skipped: trimmed.length === 0 }
            : row,
        ),
      );
      setSavedId(question.id);
      window.setTimeout(() => setSavedId((current) => (current === question.id ? null : current)), 2200);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSavingId(null);
    }
  }

  async function build() {
    setBusy('build');
    setError(null);
    setBuiltNow(false);
    try {
      const result = await getApi().onboarding.buildKnowledge(connection.id);
      setKnowledge(result);
      setBuiltNow(true);
      await onChanged();
    } catch (buildError) {
      setError(errorMessage(buildError));
    } finally {
      setBusy(null);
    }
  }

  const answered = questions.filter((question) => {
    const value = (answers[question.id] ?? '').trim();
    return value.length > 0;
  }).length;

  if (loading) {
    return (
      <div className="loading-row">
        <Spinner label="Loading onboarding" />
      </div>
    );
  }

  return (
    <div className="stack">
      {error ? <ErrorBanner message={error} /> : null}
      {busy ? (
        <BusyLine
          message={busy === 'questions' ? 'Preparing onboarding questions' : 'Building the knowledge base'}
          detail={progress?.message ?? 'Talking to the AI model'}
        />
      ) : null}

      {!readOnly ? (
        <Notice tone="warn">
          <Icon name="alert" size={16} />
          <span>
            This connection is not verified as read-only, so onboarding is blocked. Re-probe the
            credentials from the overview tab.
          </span>
        </Notice>
      ) : null}

      {questions.length === 0 ? (
        <EmptyState
          icon="sparkle"
          title="Let the AI interview you"
          description="The model reads the schema snapshot and asks up to 50 targeted questions about business meaning, time zones, statuses and data quality. Your answers become part of the knowledge base used to write SQL."
          action={
            <button
              type="button"
              className="button primary"
              onClick={() => void generateQuestions()}
              disabled={!canPrepare || busy !== null}
            >
              <Icon name="sparkle" size={16} /> Generate questions
            </button>
          }
        />
      ) : (
        <div className="setup-layout">
          <section className="stack">
            <div className="section-head">
              <h2>Onboarding questions</h2>
              <span className="muted small">
                {answered} of {questions.length} answered
              </span>
            </div>

            <ol className="question-list">
              {questions.map((question, index) => {
                const value = answers[question.id] ?? '';
                const isSaved = savedId === question.id;
                return (
                  <li key={question.id} className="question">
                    <div className="question-head">
                      <span className="question-index">Q{index + 1}</span>
                      <p>{question.prompt}</p>
                    </div>
                    <textarea
                      value={value}
                      onChange={(event) =>
                        setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                      }
                      placeholder="Answer in your own words, or leave blank to skip."
                      rows={3}
                    />
                    <div className="question-foot">
                      <span className="muted small">
                        {value.trim() ? 'Included in the knowledge base' : 'Will be skipped if left blank'}
                      </span>
                      <div className="question-actions">
                        {isSaved ? (
                          <span className="saved-flag">
                            <Icon name="check" size={14} /> Saved
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="button small"
                          onClick={() => void saveAnswer(question)}
                          disabled={savingId === question.id || busy !== null}
                        >
                          {savingId === question.id ? <Spinner label="Saving" /> : 'Save answer'}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <aside className="stack setup-side">
            <section className="panel side-card">
              <h3>Knowledge base</h3>
              <p className="muted small">
                EasyReporter turns the schema, sample rows and your answers into a structured
                knowledge base. The chatbot uses it for every query.
              </p>
              <div className="progress-track" aria-hidden="true">
                <span style={{ width: `${questions.length === 0 ? 0 : (answered / questions.length) * 100}%` }} />
              </div>
              <div className="side-stat">
                <strong>{answered}</strong>
                <span>answered</span>
              </div>
              <button
                type="button"
                className="button primary block"
                onClick={() => void build()}
                disabled={busy !== null || !canPrepare}
              >
                {busy === 'build' ? (
                  <Spinner label="Building" />
                ) : knowledge ? (
                  'Rebuild knowledge base'
                ) : (
                  'Build knowledge base'
                )}
              </button>
              {knowledge ? (
                <button type="button" className="button ghost block" onClick={onOpenKnowledge}>
                  View knowledge base <Icon name="arrow-right" size={14} />
                </button>
              ) : null}
            </section>

            {builtNow ? (
              <Notice tone="ok">
                <Icon name="check" size={16} />
                <span>The knowledge base is ready. The chatbot for this connection is unlocked.</span>
              </Notice>
            ) : null}

            <section className="panel side-card">
              <h3>How it flows</h3>
              <ol className="steps">
                <li className={questions.length > 0 ? 'done' : ''}>Schema snapshot and samples</li>
                <li className={questions.length > 0 ? 'done' : ''}>Onboarding questions</li>
                <li className={knowledge ? 'done' : ''}>Knowledge base</li>
                <li className={connection.status === 'ready' ? 'done' : ''}>Read-only chat</li>
              </ol>
            </section>
          </aside>
        </div>
      )}

      {questions.length === 0 && knowledge ? (
        <Notice tone="info">
          <Icon name="check" size={16} />
          <span>A knowledge base already exists for this connection.</span>
          <button type="button" className="button small" onClick={onOpenKnowledge}>
            Open it
          </button>
        </Notice>
      ) : null}
    </div>
  );
}
