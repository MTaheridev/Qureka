'use client';

import { useEffect, useState } from 'react';
import type {
  AppLanguage,
  ConnectionView,
  KnowledgeView,
  OnboardingQuestionView,
} from '../../shared/ipc';
import { errorMessage, getApi } from '@/lib/api';
import { useProgressFeed } from '@/lib/hooks';
import { useSettings } from '@/lib/settings';
import { ThinkingIndicator } from './ThinkingIndicator';
import { EmptyState, ErrorBanner, Icon, Notice, Spinner } from './ui';

export function SetupPanel({
  connection,
  onChanged,
  onOpenKnowledge,
  onOpenChat,
}: {
  connection: ConnectionView;
  onChanged: () => void | Promise<void>;
  onOpenKnowledge: () => void;
  onOpenChat?: () => void;
}) {
  const { tr, settings } = useSettings();
  const [questions, setQuestions] = useState<OnboardingQuestionView[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeView | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [brief, setBrief] = useState(connection.businessBrief ?? '');
  const [questionLang, setQuestionLang] = useState<AppLanguage>(settings.language);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'questions' | 'build' | 'brief' | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [builtNow, setBuiltNow] = useState(false);
  const progress = useProgressFeed();

  const readOnly = connection.readOnly?.verdict === 'read-only';
  const canPrepare = readOnly && connection.status !== 'failed';

  useEffect(() => {
    setBrief(connection.businessBrief ?? '');
  }, [connection.id, connection.businessBrief]);

  async function generateQuestions() {
    setBusy('questions');
    setError(null);
    try {
      await getApi().connections.setBusinessBrief(connection.id, brief);
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

  async function saveBrief() {
    setBusy('brief');
    setError(null);
    try {
      await getApi().connections.setBusinessBrief(connection.id, brief);
      await onChanged();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(null);
    }
  }

  async function build() {
    setBusy('build');
    setError(null);
    setBuiltNow(false);
    try {
      if (brief.trim() !== (connection.businessBrief ?? '').trim()) {
        await getApi().connections.setBusinessBrief(connection.id, brief);
      }
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
      {busy === 'questions' || busy === 'build' ? (
        <ThinkingIndicator
          mode="thinking"
          detail={progress?.message ?? null}
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
        <section className="panel stack setup-brief">
          <div className="section-head">
            <h2>Describe this database</h2>
          </div>
          <p className="muted">
            In a few sentences, tell the AI what this database is for — who uses it, what the main
            entities mean, and anything the schema alone would miss. Optional, but questions get
            sharper with it.
          </p>
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="Example: This is our online shop. orders are customer purchases; status 3 means cancelled; amounts are in IRR; timestamps are Asia/Tehran."
            rows={6}
            disabled={!canPrepare || busy !== null}
          />
          <div className="question-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => void saveBrief()}
              disabled={!canPrepare || busy !== null}
            >
              {busy === 'brief' ? <Spinner label="Saving" /> : 'Save description'}
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => void generateQuestions()}
              disabled={!canPrepare || busy !== null}
            >
              <Icon name="sparkle" size={16} /> Generate questions
            </button>
          </div>
          <EmptyState
            icon="sparkle"
            title="Then the AI interviews you"
            description="After you generate questions, answer them and build the knowledge base. The model uses your description plus the schema."
          />
        </section>
      ) : (
        <div className="setup-layout">
          <section className="stack">
            <div className="section-head">
              <h2>Onboarding questions</h2>
              <div className="question-lang-row">
                <span className="muted small">
                  {answered} of {questions.length} answered
                </span>
                <div className="segmented" role="group" aria-label={tr('questionLangLabel')}>
                  <button
                    type="button"
                    className={questionLang === 'en' ? 'active' : undefined}
                    onClick={() => setQuestionLang('en')}
                  >
                    {tr('questionLangEn')}
                  </button>
                  <button
                    type="button"
                    className={questionLang === 'fa' ? 'active' : undefined}
                    onClick={() => setQuestionLang('fa')}
                  >
                    {tr('questionLangFa')}
                  </button>
                </div>
              </div>
            </div>

            <details className="setup-brief-edit">
              <summary>Database description</summary>
              <textarea
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                rows={4}
                disabled={busy !== null}
              />
              <button
                type="button"
                className="button small"
                onClick={() => void saveBrief()}
                disabled={busy !== null}
              >
                {busy === 'brief' ? <Spinner label="Saving" /> : 'Save description'}
              </button>
            </details>

            <ol className="question-list">
              {questions.map((question, index) => {
                const value = answers[question.id] ?? '';
                const isSaved = savedId === question.id;
                const promptText =
                  questionLang === 'fa'
                    ? question.promptFa || question.prompt
                    : question.prompt;
                return (
                  <li key={question.id} className="question">
                    <div className="question-head" dir={questionLang === 'fa' ? 'rtl' : 'ltr'}>
                      <span className="question-index">Q{index + 1}</span>
                      <p>{promptText}</p>
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
                Qureka turns the schema, your description, sample rows and answers into a structured
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

            {builtNow || connection.status === 'ready' ? (
              <Notice tone="ok">
                <Icon name="check" size={16} />
                <span>The knowledge base is ready. You can ask questions and export reports.</span>
                {onOpenChat ? (
                  <button type="button" className="button small primary" onClick={onOpenChat}>
                    Open chat <Icon name="arrow-right" size={14} />
                  </button>
                ) : null}
              </Notice>
            ) : null}

            <section className="panel side-card">
              <h3>How it flows</h3>
              <ol className="steps">
                <li className="done">Schema snapshot and samples</li>
                <li className={brief.trim() ? 'done' : ''}>Your description</li>
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
