import type { AiProtocol } from '../../shared/ipc';

export class AiRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AiRequestError';
  }
}

export interface AiConfig {
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

function endpoint(config: AiConfig): string {
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  if (!base) {
    throw new AiRequestError('The AI model base URL is empty.');
  }

  if (config.protocol === 'anthropic') {
    if (/\/messages$/.test(base)) return base;
    if (/\/v1$/.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }

  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/chat/completions`;
  if (/^https?:\/\/[^/]+\/?$/.test(base)) return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  if (!body) return `HTTP ${response.status} ${response.statusText}`.trim();
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        code?: number | string;
        metadata?: { raw?: string; provider_name?: string; remedy_hint?: string };
      } | string;
      message?: string;
    };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error === 'object') {
      const parts = [
        parsed.error.message,
        parsed.error.metadata?.raw,
        parsed.error.metadata?.remedy_hint,
      ].filter((part): part is string => Boolean(part && part.trim()));
      if (parts.length > 0) {
        const unique = [...new Set(parts.map((part) => part.trim()))];
        return unique.join(' — ').slice(0, 800);
      }
    }
    if (parsed.message) return parsed.message;
  } catch {
    // Fall back to the raw body.
  }
  return body.slice(0, 500);
}

export async function complete(
  config: AiConfig,
  messages: AiMessage[],
  options: CompleteOptions = {},
): Promise<string> {
  if (!config.apiKey.trim()) {
    throw new AiRequestError('No API key is configured for this AI model.');
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxTokens = options.maxTokens ?? 4096;
  const temperature = options.temperature ?? 0;
  const url = endpoint(config);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: Record<string, unknown>;

  if (config.protocol === 'anthropic') {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    body = {
      model: config.model,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({ role: message.role, content: message.content })),
    };
  } else {
    headers.authorization = `Bearer ${config.apiKey}`;
    // OpenRouter ranks apps that identify themselves; harmless for other OpenAI-compatible hosts.
    if (/openrouter\.ai/i.test(config.baseUrl)) {
      headers['HTTP-Referer'] = 'https://taheri.vercel.app';
      headers['X-Title'] = 'EasyReporter';
    }
    // Prefer the paid/standard route over the shared `:free` pool (often 429 rate-limited).
    const model = /openrouter\.ai/i.test(config.baseUrl)
      ? config.model.replace(/:free$/i, '')
      : config.model;
    body = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages,
    };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new AiRequestError(`The AI request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw new AiRequestError(error instanceof Error ? error.message : 'The AI request failed.');
  }

  if (!response.ok) {
    throw new AiRequestError(await readError(response), response.status);
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload) {
    throw new AiRequestError('The AI provider returned an empty response.');
  }

  if (config.protocol === 'anthropic') {
    const content = contentToText(payload.content);
    if (!content) throw new AiRequestError('The AI provider returned no text.');
    return content;
  }

  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as { message?: { content?: unknown }; text?: unknown };
    const text = contentToText(choice.message?.content ?? choice.text).trim();
    if (text) return text;
  }

  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  // OpenRouter sometimes returns a top-level error with HTTP 200.
  const embedded = payload.error as { message?: string } | string | undefined;
  if (typeof embedded === 'string' && embedded.trim()) {
    throw new AiRequestError(embedded.trim());
  }
  if (embedded && typeof embedded === 'object' && embedded.message) {
    throw new AiRequestError(embedded.message);
  }

  throw new AiRequestError('The AI provider response did not contain any text.');
}

export async function testConnection(config: AiConfig): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const started = Date.now();
  try {
    const reply = await complete(
      config,
      [
        { role: 'system', content: 'You are a connection test. Reply with the single word OK.' },
        { role: 'user', content: 'Reply with the single word OK.' },
      ],
      { maxTokens: 16, temperature: 0, timeoutMs: 30_000 },
    );
    return {
      ok: true,
      message: reply.trim() ? `Connected. Model replied: ${reply.trim().slice(0, 80)}` : 'Connected.',
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'The AI connection test failed.',
      latencyMs: Date.now() - started,
    };
  }
}
