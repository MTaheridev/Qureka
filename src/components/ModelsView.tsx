'use client';

import { useEffect, useState } from 'react';
import type { AiModelInput, AiModelView, AiTestResult } from '../../shared/ipc';
import { errorMessage, getApi } from '@/lib/api';
import { formatWhen } from '@/lib/format';
import { FadeIn, SpotlightCard, StartHereCard } from '@/components/bits';
import { useSettings } from '@/lib/settings';
import { Badge, ErrorBanner, Icon, Notice, Spinner } from './ui';

const BLANK: AiModelInput = {
  name: 'AvalAI Claude Haiku',
  protocol: 'openai',
  baseUrl: 'https://api.avalai.ir/v1',
  model: 'claude-haiku-5-5',
  apiKey: '',
};

export function ModelsView({
  keyStorage,
  onChanged,
}: {
  keyStorage: string | null;
  onChanged?: () => void;
}) {
  const [models, setModels] = useState<AiModelView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editing, setEditing] = useState<AiModelView | null | undefined>(undefined);
  const [form, setForm] = useState<AiModelInput>(BLANK);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [test, setTest] = useState<{ target: string; result: AiTestResult } | null>(null);
  const [cardTest, setCardTest] = useState<{ target: string; result: AiTestResult } | null>(null);
  const { tr } = useSettings();

  async function load() {
    setLoading(true);
    try {
      const rows = await getApi().models.list();
      setModels(rows);
      setLoadError(null);
      onChanged?.();
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function field<K extends keyof AiModelInput>(key: K, value: AiModelInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startCreate() {
    setForm(BLANK);
    setEditing(null);
    setFormError(null);
    setTest(null);
  }

  function startEdit(model: AiModelView) {
    setForm({
      name: model.name,
      protocol: model.protocol,
      baseUrl: model.baseUrl,
      model: model.model,
      apiKey: '',
    });
    setEditing(model);
    setFormError(null);
    setTest(null);
  }

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await getApi().models.update(editing.id, form);
      } else {
        await getApi().models.create(form);
      }
      setEditing(undefined);
      await load();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    const target = editing ? editing.id : 'form';
    setTesting(target);
    setTest(null);
    try {
      const result = await getApi().models.test(form, editing?.id);
      setTest({ target, result });
    } catch (error) {
      setTest({
        target,
        result: { ok: false, message: errorMessage(error), latencyMs: 0 },
      });
    } finally {
      setTesting(null);
    }
  }

  async function remove(model: AiModelView) {
    if (!window.confirm(`Delete “${model.name}”? Connections using it will need another model.`)) {
      return;
    }
    try {
      await getApi().models.remove(model.id);
      if (editing?.id === model.id) setEditing(undefined);
      await load();
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }

  return (
    <FadeIn className="page">
      <header className="page-head">
        <div>
          <h1>{tr('brainTitle')}</h1>
          <p className="subtitle">{tr('brainSubtitle')}</p>
        </div>
        <button type="button" className="button primary" onClick={startCreate}>
          <Icon name="plus" size={16} /> {tr('addBrain')}
        </button>
      </header>

      {!loading && models.length === 0 && editing === undefined ? (
        <StartHereCard
          title="You only need one model to start"
          description="Paste an API key, pick a model name like claude-haiku-5-5, tap Test, then Save. Keys are encrypted on this computer."
        >
          <div style={{ marginTop: 16 }}>
            <button type="button" className="button primary" onClick={startCreate}>
              <Icon name="plus" size={16} /> Add your first AI brain
            </button>
          </div>
        </StartHereCard>
      ) : null}

      {loadError ? <ErrorBanner message={loadError} /> : null}

      {editing !== undefined ? (
        <section className="panel form-panel">
          <header className="panel-head">
            <div>
              <h2>{editing ? `Edit ${editing.name}` : 'New AI model'}</h2>
              <p className="muted">
                {editing
                  ? 'Leave the API key blank to keep the stored key.'
                  : 'The key is encrypted with the operating system key storage.'}
              </p>
            </div>
            <button
              type="button"
              className="button ghost"
              onClick={() => setEditing(undefined)}
              disabled={saving}
            >
              Cancel
            </button>
          </header>

          {formError ? <ErrorBanner message={formError} /> : null}

          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input
                value={form.name}
                onChange={(event) => field('name', event.target.value)}
                placeholder="Production analyst"
                autoFocus
              />
            </label>

            <label className="field">
              <span>Model</span>
              <input
                value={form.model}
                onChange={(event) => field('model', event.target.value)}
                placeholder="claude-haiku-5-5"
              />
            </label>

            <div className="field field-wide">
              <span>Protocol</span>
              <div className="segmented">
                <button
                  type="button"
                  className={form.protocol === 'openai' ? 'active' : ''}
                  onClick={() => field('protocol', 'openai')}
                >
                  OpenAI compatible
                </button>
                <button
                  type="button"
                  className={form.protocol === 'anthropic' ? 'active' : ''}
                  onClick={() => field('protocol', 'anthropic')}
                >
                  Anthropic compatible
                </button>
              </div>
            </div>

            <label className="field field-wide">
              <span>Base URL</span>
              <input
                value={form.baseUrl}
                onChange={(event) => field('baseUrl', event.target.value)}
                placeholder={
                  form.protocol === 'anthropic'
                    ? 'https://api.anthropic.com'
                    : 'https://api.avalai.ir/v1'
                }
                spellCheck={false}
              />
              <small>
                {form.protocol === 'openai'
                  ? 'Requests go to /chat/completions. A bare host gets /v1 added automatically.'
                  : 'Requests go to /v1/messages.'}
              </small>
            </label>

            <label className="field field-wide">
              <span>API key</span>
              <input
                type="password"
                value={form.apiKey}
                onChange={(event) => field('apiKey', event.target.value)}
                placeholder={editing?.hasApiKey ? 'Stored key — leave blank to keep' : 'sk-…'}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>

          {test ? (
            <div className={`banner ${test.result.ok ? 'banner-ok' : 'banner-bad'}`}>
              <Icon name={test.result.ok ? 'check' : 'alert'} size={17} />
              <span>
                {test.result.message}
                {test.result.latencyMs > 0 ? ` (${test.result.latencyMs} ms)` : ''}
              </span>
            </div>
          ) : null}

          <div className="form-actions">
            <button
              type="button"
              className="button"
              onClick={() => void runTest()}
              disabled={testing !== null || saving}
            >
              {testing === (editing?.id ?? 'form') ? <Spinner label="Testing" /> : 'Test connection'}
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => void save()}
              disabled={saving || testing !== null}
            >
              {saving ? <Spinner label="Saving" /> : editing ? 'Save changes' : 'Add model'}
            </button>
          </div>
        </section>
      ) : null}

      {loading ? (
        <div className="loading-row">
          <Spinner label="Loading models" />
        </div>
      ) : models.length === 0 ? null : (
        <div className="card-grid">
          {models.map((model) => (
            <SpotlightCard
              key={model.id}
              className="model-card"
              theme="dark"
              spotlightColor="rgba(56, 189, 248, 0.9)"
              intensity={0.16}
              spotlightSize={260}
              borderGlow={0.7}
            >
              <div className="model-head">
                <div>
                  <h3>{model.name}</h3>
                  <span className="mono muted small">{model.model}</span>
                </div>
                <Badge tone={model.protocol === 'anthropic' ? 'warn' : 'accent'}>
                  {model.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                </Badge>
              </div>
              <div className="model-url mono">{model.baseUrl}</div>
              <div className="model-meta">
                <span>{model.hasApiKey ? 'Key stored' : 'No key'}</span>
                <span>added {formatWhen(model.createdAt)}</span>
              </div>
              {cardTest?.target === model.id ? (
                <Notice tone={cardTest.result.ok ? 'ok' : 'bad'}>
                  <Icon name={cardTest.result.ok ? 'check' : 'alert'} size={15} />
                  <span>
                    {cardTest.result.message}
                    {cardTest.result.latencyMs > 0 ? ` (${cardTest.result.latencyMs} ms)` : ''}
                  </span>
                </Notice>
              ) : null}
              <div className="card-actions">
                <button
                  type="button"
                  className="button small"
                  onClick={() => {
                    setTesting(model.id);
                    setCardTest(null);
                    void (async () => {
                      try {
                        const result = await getApi().models.test(
                          {
                            name: model.name,
                            protocol: model.protocol,
                            baseUrl: model.baseUrl,
                            model: model.model,
                            apiKey: '',
                          },
                          model.id,
                        );
                        setCardTest({ target: model.id, result });
                      } catch (error) {
                        setCardTest({
                          target: model.id,
                          result: { ok: false, message: errorMessage(error), latencyMs: 0 },
                        });
                      } finally {
                        setTesting(null);
                      }
                    })();
                  }}
                  disabled={testing !== null}
                >
                  {testing === model.id ? <Spinner label="Testing" /> : 'Test'}
                </button>
                <button type="button" className="button small" onClick={() => startEdit(model)}>
                  <Icon name="edit" size={14} /> Edit
                </button>
                <button
                  type="button"
                  className="button small danger"
                  onClick={() => void remove(model)}
                >
                  <Icon name="trash" size={14} /> Delete
                </button>
              </div>
            </SpotlightCard>
          ))}
        </div>
      )}

      <p className="page-footnote">
        <Icon name="lock" size={14} /> API keys are encrypted with{' '}
        {keyStorage ?? 'the operating system key storage'} and never leave this computer except in
        requests to the provider you configure.
      </p>
    </FadeIn>
  );
}
