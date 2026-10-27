import type { KnowledgeView } from '../../shared/ipc';
import { getPrisma } from '../db/client';
import { complete } from '../ai/client';
import { parseWithSchema } from '../ai/json';
import {
  knowledgeLearnMessages,
  knowledgeLearnResponseSchema,
  type KnowledgeLearnResponse,
} from '../ai/prompts';
import { detectLanguage } from '../ai/detect-language';
import { resolveAiConfig } from './ai-models';
import { loadConnectionContext } from './connections';
import { toKnowledgeView } from './onboarding';

const IDLE_MS = 60_000;
const MAX_BUFFERED_TURNS = 24;
const MAX_MEMORY_INSIGHTS = 80;

type BufferedTurn = {
  role: 'user' | 'assistant';
  content: string;
};

type BufferState = {
  turns: BufferedTurn[];
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
};

const buffers = new Map<string, BufferState>();

function getBuffer(connectionId: string): BufferState {
  let state = buffers.get(connectionId);
  if (!state) {
    state = { turns: [], timer: null, flushing: false };
    buffers.set(connectionId, state);
  }
  return state;
}

function scheduleIdleFlush(connectionId: string): void {
  const state = getBuffer(connectionId);
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    void flushLearning(connectionId).catch(() => undefined);
  }, IDLE_MS);
}

/** Record a successful chat turn for later project-memory learning. */
export function bufferLearningTurn(
  connectionId: string,
  turn: BufferedTurn,
): void {
  const content = turn.content.trim().slice(0, 2_000);
  if (!content) return;
  const state = getBuffer(connectionId);
  state.turns.push({ role: turn.role, content });
  if (state.turns.length > MAX_BUFFERED_TURNS) {
    state.turns.splice(0, state.turns.length - MAX_BUFFERED_TURNS);
  }
  scheduleIdleFlush(connectionId);
}

function parseMemoryInsights(memoryJson: string | null | undefined): Array<{
  kind: string;
  text: string;
}> {
  if (!memoryJson?.trim()) return [];
  try {
    const parsed = JSON.parse(memoryJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is { kind: string; text: string } =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as { text?: unknown }).text === 'string',
      )
      .map((entry) => ({
        kind: typeof entry.kind === 'string' ? entry.kind : 'fact',
        text: entry.text.trim(),
      }))
      .filter((entry) => entry.text.length > 0);
  } catch {
    return [];
  }
}

function mergeLearnResult(
  existingMemory: string | null | undefined,
  existingGlossaryJson: string,
  existingSummary: string,
  existingContent: string,
  learned: KnowledgeLearnResponse,
): {
  memoryJson: string;
  glossaryJson: string;
  summary: string;
  content: string;
} {
  const insights = parseMemoryInsights(existingMemory);
  const seen = new Set(insights.map((entry) => entry.text.toLowerCase()));
  for (const insight of learned.insights) {
    const text = insight.text.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    insights.push({ kind: insight.kind, text });
  }
  const trimmedInsights = insights.slice(-MAX_MEMORY_INSIGHTS);

  let glossary: Array<{ term: string; definition: string }> = [];
  try {
    const parsed = JSON.parse(existingGlossaryJson) as unknown;
    if (Array.isArray(parsed)) {
      glossary = parsed.filter(
        (entry): entry is { term: string; definition: string } =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as { term?: unknown }).term === 'string' &&
          typeof (entry as { definition?: unknown }).definition === 'string',
      );
    }
  } catch {
    glossary = [];
  }
  const glossarySeen = new Set(glossary.map((entry) => entry.term.toLowerCase()));
  for (const entry of learned.glossary ?? []) {
    const term = entry.term.trim();
    const definition = entry.definition.trim();
    if (!term || !definition) continue;
    const key = term.toLowerCase();
    if (glossarySeen.has(key)) continue;
    glossarySeen.add(key);
    glossary.push({ term, definition });
  }

  const summaryPatch = learned.summaryPatch?.trim() ?? '';
  const contentAppend = learned.contentAppend?.trim() ?? '';
  const summary =
    summaryPatch && !existingSummary.includes(summaryPatch)
      ? `${existingSummary.trim()}\n\n${summaryPatch}`.slice(0, 4_000)
      : existingSummary;
  const content =
    contentAppend && !existingContent.includes(contentAppend)
      ? `${existingContent.trim()}\n\n### Learned from chats\n${contentAppend}`.slice(0, 40_000)
      : existingContent;

  return {
    memoryJson: JSON.stringify(trimmedInsights),
    glossaryJson: JSON.stringify(glossary.slice(0, 200)),
    summary,
    content,
  };
}

export async function flushLearning(connectionId: string): Promise<KnowledgeView | null> {
  const state = getBuffer(connectionId);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.flushing) return null;
  if (state.turns.length === 0) {
    const prisma = getPrisma();
    const row = await prisma.knowledgeBase.findUnique({ where: { connectionId } });
    return row ? toKnowledgeView(row) : null;
  }

  state.flushing = true;
  const turns = state.turns.splice(0, state.turns.length);

  try {
    const context = await loadConnectionContext(connectionId);
    const prisma = getPrisma();
    const knowledgeRow = await prisma.knowledgeBase.findUnique({ where: { connectionId } });
    if (!knowledgeRow) return null;

    const config = await resolveAiConfig(context.row.aiModelId);
    const language = detectLanguage(turns.find((turn) => turn.role === 'user')?.content ?? '');
    const reply = await complete(
      config,
      knowledgeLearnMessages({
        connectionName: context.row.name,
        existingSummary: knowledgeRow.summary,
        existingMemory: knowledgeRow.memoryJson,
        turns,
        language,
      }),
      { maxTokens: 2_500, temperature: 0.1, timeoutMs: 90_000, json: true },
    );

    const learned = parseWithSchema(reply, knowledgeLearnResponseSchema);
    if (
      learned.insights.length === 0 &&
      !learned.summaryPatch?.trim() &&
      !learned.contentAppend?.trim() &&
      (learned.glossary?.length ?? 0) === 0
    ) {
      return toKnowledgeView(knowledgeRow);
    }

    const merged = mergeLearnResult(
      knowledgeRow.memoryJson,
      knowledgeRow.glossaryJson,
      knowledgeRow.summary,
      knowledgeRow.content,
      learned,
    );

    const updated = await prisma.knowledgeBase.update({
      where: { connectionId },
      data: {
        memoryJson: merged.memoryJson,
        memoryUpdatedAt: new Date(),
        glossaryJson: merged.glossaryJson,
        summary: merged.summary,
        content: merged.content,
      },
    });
    return toKnowledgeView(updated);
  } catch {
    // Put turns back so a later flush can retry; never break chat.
    state.turns.unshift(...turns);
    if (state.turns.length > MAX_BUFFERED_TURNS) {
      state.turns.splice(0, state.turns.length - MAX_BUFFERED_TURNS);
    }
    return null;
  } finally {
    state.flushing = false;
  }
}

export function formatProjectMemory(memoryJson: string | null | undefined): string | null {
  const insights = parseMemoryInsights(memoryJson);
  if (insights.length === 0) return null;
  return insights
    .slice(-40)
    .map((entry) => `- [${entry.kind}] ${entry.text}`)
    .join('\n')
    .slice(0, 8_000);
}
