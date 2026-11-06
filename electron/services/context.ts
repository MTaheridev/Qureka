import type { AppLanguage } from '../../shared/ipc';
import { complete, type AiConfig } from '../ai/client';
import { contextSummaryMessages, type HistoryMessage } from '../ai/prompts';

export const CHAT_CONTEXT_LIMIT = 12_000;
const RECENT_BUDGET = 7_000;
const FOLD_AT = 4_000;
const TURN_CAP = 1_200;

export interface ContextSource {
  id: string;
  role: string;
  content: string;
  sql: string | null;
  explanation: string | null;
  payloadJson: string | null;
  run: { rowCount: number } | null;
}

export interface PackedContext {
  history: HistoryMessage[];
  summary: string;
  untilId: string | null;
  used: number;
  limit: number;
}

function cap(text: string, max = TURN_CAP): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function chosenQuestion(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as { question?: unknown };
    return typeof parsed.question === 'string' && parsed.question.trim() ? parsed.question.trim() : null;
  } catch {
    return null;
  }
}

export function turnLine(row: ContextSource, previous?: ContextSource): string {
  const answered = previous ? chosenQuestion(previous.payloadJson) : null;
  if (row.role === 'user' && answered) {
    return cap(`USER CHOSE: ${row.content}\nThis answered: ${answered}`);
  }
  const asked = chosenQuestion(row.payloadJson);
  if (row.role !== 'user' && asked) {
    return cap(`ASSISTANT ASKED: ${asked}`);
  }
  const who = row.role === 'user' ? 'USER' : 'ASSISTANT';
  const parts = [`${who}: ${row.content}`];
  if (row.explanation?.trim()) parts.push(`Report: ${row.explanation.trim()}`);
  if (row.run) parts.push(`Rows: ${row.run.rowCount}`);
  if (row.sql?.trim()) parts.push(`SQL: ${row.sql.trim()}`);
  return cap(parts.join('\n'));
}

function splitPending(
  rows: ContextSource[],
  untilId: string | null,
): { covered: boolean; pending: ContextSource[]; anchor?: ContextSource } {
  if (!untilId) return { covered: false, pending: rows };
  const index = rows.findIndex((row) => row.id === untilId);
  if (index < 0) return { covered: false, pending: rows };
  return { covered: true, pending: rows.slice(index + 1), anchor: rows[index] };
}

function takeRecent(
  rows: ContextSource[],
  anchor?: ContextSource,
): { recent: ContextSource[]; older: ContextSource[] } {
  const recent: ContextSource[] = [];
  let size = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const line = turnLine(row, rows[index - 1] ?? anchor);
    const keepMinimum = recent.length < 6;
    if (!keepMinimum && size + line.length > RECENT_BUDGET) break;
    recent.unshift(row);
    size += line.length + 1;
  }
  const recentIds = new Set(recent.map((row) => row.id));
  return { recent, older: rows.filter((row) => !recentIds.has(row.id)) };
}

export function measureContext(rows: ContextSource[], summary: string | null, untilId: string | null): {
  used: number;
  limit: number;
} {
  const { pending, anchor } = splitPending(rows, untilId);
  const body = pending
    .map((row, index) => turnLine(row, pending[index - 1] ?? anchor))
    .join('\n');
  return {
    used: (summary?.trim().length ?? 0) + body.length,
    limit: CHAT_CONTEXT_LIMIT,
  };
}

export async function packContext(input: {
  rows: ContextSource[];
  summary: string | null;
  untilId: string | null;
  config: AiConfig;
  language: AppLanguage;
  onProgress?: (message: string) => void;
}): Promise<PackedContext> {
  const existing = input.summary?.trim() ?? '';
  const { pending, anchor } = splitPending(input.rows, input.untilId);
  const { recent, older } = takeRecent(pending, anchor);
  let summary = existing;
  let untilId = input.untilId;
  let kept = recent;

  const olderText = older
    .map((row, index) => turnLine(row, older[index - 1] ?? anchor))
    .join('\n');

  if (older.length > 0 && olderText.length >= FOLD_AT) {
    input.onProgress?.(
      input.language === 'fa' ? 'در حال خلاصه کردن گفتگوی قبلی' : 'Summarizing earlier chat',
    );
    try {
      const reply = await complete(
        input.config,
        contextSummaryMessages({
          existing: summary,
          turns: olderText.slice(0, 14_000),
          language: input.language,
        }),
        { maxTokens: 700, temperature: 0, timeoutMs: 60_000 },
      );
      summary = reply.replace(/\s+/g, ' ').trim().slice(0, 1_800);
    } catch {
      summary = `${summary}\n${olderText}`.trim().slice(-1_500);
    }
    untilId = older[older.length - 1]?.id ?? untilId;
  } else if (older.length > 0) {
    kept = [...older, ...recent];
  }

  const history: HistoryMessage[] = kept.map((row) => {
    const index = pending.findIndex((item) => item.id === row.id);
    const previous = index > 0 ? pending[index - 1] : anchor;
    return {
      role: row.role === 'user' ? 'user' : 'assistant',
      content: turnLine(row, previous),
    };
  });
  const used = summary.length + history.reduce((sum, message) => sum + message.content.length + 1, 0);
  return { history, summary, untilId, used, limit: CHAT_CONTEXT_LIMIT };
}
