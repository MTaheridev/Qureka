import type {
  AppLanguage,
  AskResult,
  CellValue,
  ChatHistory,
  ChatMessageView,
  ClarifyPayload,
  ConversationView,
  ReportData,
  ReportPage,
} from '../../shared/ipc';
import { getPrisma } from '../db/client';
import { complete, type AiConfig } from '../ai/client';
import { parseWithSchema } from '../ai/json';
import {
  isConstantOnlySelect,
  repairMessages,
  responseMode,
  sqlMessages,
  sqlResponseSchema,
  type HistoryMessage,
} from '../ai/prompts';
import { detectLanguage } from '../ai/detect-language';
import { schemaToText } from '../ai/schema-text';
import { assertReadOnlySql } from '../engines/sql-guard';
import { resolveAiConfig } from './ai-models';
import { loadConnectionContext } from './connections';
import {
  bufferLearningTurn,
  formatProjectMemory,
} from './knowledge-learn';
import { captureRun, readRunPage, readRunRows, removeRunFile, toRunView, type CapturedRun } from './runs';
import { measureContext, packContext, type ContextSource } from './context';
import { projectMemoryUsage } from './knowledge-learn';

const DEFAULT_TITLE = 'New chat';

type MessageRow = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  sql: string | null;
  explanation: string | null;
  error: string | null;
  payloadJson: string | null;
  createdAt: Date;
  run: {
    id: string;
    columnsJson: string;
    displayRowsJson: string;
    rowCount: number;
    durationMs: number;
    truncated: boolean;
    resultPath: string | null;
  } | null;
};

type ConversationRow = {
  id: string;
  connectionId: string;
  title: string;
  contextSummary: string | null;
  contextUntilId: string | null;
  updatedAt: Date;
  _count?: { messages: number };
};

function toConversationView(row: ConversationRow): ConversationView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    messageCount: row._count?.messages ?? 0,
  };
}

function toMessageView(row: MessageRow): ChatMessageView {
  return {
    id: row.id,
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    // AI SQL is never exposed to the UI — only results + business explanation.
    sql: null,
    explanation: row.explanation,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    run: row.run ? toRunView(row.run) : null,
    clarify: parseClarify(row.payloadJson),
  };
}

function parseClarify(payloadJson: string | null): ClarifyPayload | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as { question?: unknown; options?: unknown };
    const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
      : [];
    if (!question || options.length !== 4) return null;
    return { question, options: options.map((option) => option.trim()) };
  } catch {
    return null;
  }
}

function titleFromMessage(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  return compact.length > 70 ? `${compact.slice(0, 69)}…` : compact || DEFAULT_TITLE;
}

async function messageRows(conversationId: string): Promise<MessageRow[]> {
  const prisma = getPrisma();
  return prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    include: { run: true },
  });
}

async function getConversationOrThrow(conversationId: string): Promise<ConversationRow> {
  const prisma = getPrisma();
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { _count: { select: { messages: true } } },
  });
  if (!row) throw new Error('This chat no longer exists.');
  return row;
}

export async function listConversations(connectionId: string): Promise<ConversationView[]> {
  const prisma = getPrisma();
  const rows = await prisma.conversation.findMany({
    where: { connectionId },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { messages: true } } },
  });
  if (rows.length === 0) {
    const created = await createConversation(connectionId);
    return [created];
  }
  return rows.map(toConversationView);
}

export async function createConversation(
  connectionId: string,
  title?: string,
): Promise<ConversationView> {
  const prisma = getPrisma();
  const connection = await prisma.dbConnection.findUnique({ where: { id: connectionId } });
  if (!connection) throw new Error('This project no longer exists.');

  const created = await prisma.conversation.create({
    data: {
      connectionId,
      title: (title ?? DEFAULT_TITLE).trim().slice(0, 120) || DEFAULT_TITLE,
    },
    include: { _count: { select: { messages: true } } },
  });
  return toConversationView(created);
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<ConversationView> {
  const next = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!next) throw new Error('Give the chat a name.');
  const prisma = getPrisma();
  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { title: next },
    include: { _count: { select: { messages: true } } },
  });
  return toConversationView(updated);
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const prisma = getPrisma();
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { messages: { include: { run: true } } },
  });
  if (!conversation) return;

  const files = conversation.messages
    .map((message) => message.run?.resultPath)
    .filter((value): value is string => typeof value === 'string');

  const connectionId = conversation.connectionId;
  await prisma.conversation.delete({ where: { id: conversationId } });
  for (const file of files) await removeRunFile(file);

  const remaining = await prisma.conversation.count({ where: { connectionId } });
  if (remaining === 0) {
    await createConversation(connectionId);
  }
}

async function usageFields(
  connectionId: string,
  rows: MessageRow[],
  summary: string | null,
  untilId: string | null,
) {
  const usage = measureContext(rows, summary, untilId);
  const memory = await projectMemoryUsage(connectionId);
  return {
    contextUsed: usage.used,
    contextLimit: usage.limit,
    memoryUsed: memory.used,
    memoryLimit: memory.limit,
  };
}

export async function getHistory(conversationId: string): Promise<ChatHistory> {
  const conversation = await getConversationOrThrow(conversationId);
  const rows = await messageRows(conversationId);
  return {
    messages: rows.map(toMessageView),
    ...(await usageFields(conversation.connectionId, rows, conversation.contextSummary, conversation.contextUntilId)),
  };
}

export async function clearConversation(conversationId: string): Promise<ConversationView> {
  const prisma = getPrisma();
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { messages: { include: { run: true } } },
  });
  if (!conversation) throw new Error('This chat no longer exists.');

  const files = conversation.messages
    .map((message) => message.run?.resultPath)
    .filter((value): value is string => typeof value === 'string');

  await prisma.message.deleteMany({ where: { conversationId } });
  for (const file of files) await removeRunFile(file);

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { title: DEFAULT_TITLE, contextSummary: null, contextUntilId: null, updatedAt: new Date() },
    include: { _count: { select: { messages: true } } },
  });
  return toConversationView(updated);
}

function buildContent(input: {
  apology?: string;
  note?: string;
  captured: CapturedRun;
  language?: AppLanguage;
}): string {
  const fa = input.language === 'fa';
  const parts: string[] = [];
  const apology = input.apology?.trim();
  const note = input.note?.trim();
  if (apology) parts.push(apology);
  if (note) parts.push(note);
  if (input.captured.rowCount === 0) {
    parts.push(fa ? 'هیچ ردیفی با این درخواست مطابقت نداشت.' : 'No rows matched.');
  }
  if (input.captured.truncated) {
    parts.push(
      fa
        ? 'نتیجه از حد ذخیره بزرگ‌تر بود. خروجی فقط ردیف‌های ذخیره‌شده را دارد.'
        : 'The result hit the capture limit. Exports include only the saved rows.',
    );
  }
  return parts.join('\n\n');
}

function toContextSource(row: MessageRow): ContextSource {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    sql: row.sql,
    explanation: row.explanation,
    payloadJson: row.payloadJson,
    run: row.run ? { rowCount: row.run.rowCount } : null,
  };
}

async function saveAssistantMessage(input: {
  conversationId: string;
  content: string;
  sql: string | null;
  explanation: string | null;
  error: string | null;
  payload?: ClarifyPayload | null;
  captured?: CapturedRun;
}): Promise<void> {
  const prisma = getPrisma();
  const message = await prisma.message.create({
    data: {
      conversationId: input.conversationId,
      role: 'assistant',
      content: input.content,
      sql: input.sql,
      explanation: input.explanation,
      error: input.error,
      payloadJson: input.payload ? JSON.stringify(input.payload) : null,
    },
  });

  if (input.captured) {
    try {
      await prisma.queryRun.create({
        data: {
          messageId: message.id,
          sql: input.sql ?? '',
          columnsJson: JSON.stringify(input.captured.columns),
          displayRowsJson: JSON.stringify(input.captured.displayRows),
          rowCount: input.captured.rowCount,
          durationMs: input.captured.durationMs,
          truncated: input.captured.truncated,
          resultPath: input.captured.resultPath,
        },
      });
    } catch (error) {
      await removeRunFile(input.captured.resultPath);
      throw error;
    }
  }

  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: { updatedAt: new Date() },
  });
}

type AnalystResult =
  | { kind: 'answer'; answer: string; title?: string; apology: string }
  | { kind: 'clarify'; question: string; options: string[]; apology: string }
  | {
      kind: 'query';
      sql: string;
      title: string;
      note: string;
      apology: string;
      captured: CapturedRun;
    };

async function generateAndRun(input: {
  connectionId: string;
  engine: 'postgres' | 'mysql' | 'mssql' | 'sqlite';
  schemaText: string;
  knowledge: string | null;
  glossary: string | null;
  projectMemory: string | null;
  history: HistoryMessage[];
  summary?: string | null;
  question: string;
  config: AiConfig;
  language: AppLanguage;
  onProgress?: (message: string) => void;
}): Promise<AnalystResult> {
  let lastSql = '';
  let lastError = '';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    input.onProgress?.(
      attempt === 0
        ? input.language === 'fa'
          ? 'در حال پرسیدن از مدل هوش مصنوعی'
          : 'Asking the AI model'
        : input.language === 'fa'
          ? `تلاش مجدد پس از خطا (تلاش ${attempt + 1} از ۳)`
          : `Trying again after an error (attempt ${attempt + 1} of 3)`,
    );

    const messages =
      attempt === 0 || !lastSql
        ? sqlMessages({
            engine: input.engine,
            schemaText: input.schemaText,
            knowledge: input.knowledge,
            glossary: input.glossary,
            projectMemory: input.projectMemory,
            history: input.history,
            summary: input.summary,
            question: input.question,
            language: input.language,
          })
        : repairMessages({
            engine: input.engine,
            schemaText: input.schemaText,
            question: input.question,
            sql: lastSql,
            error: lastError,
            language: input.language,
          });

    const reply = await complete(input.config, messages, {
      maxTokens: 2_500,
      temperature: 0,
      timeoutMs: 120_000,
    });

    const parsed = parseWithSchema(reply, sqlResponseSchema);
    const mode = responseMode(parsed);
    const apology = parsed.apology?.trim() ?? '';
    if (mode === 'clarify') {
      const question = parsed.question?.trim() ?? '';
      const options = (parsed.options ?? []).map((option) => option.trim()).filter(Boolean);
      if (!question || options.length !== 4) {
        lastError = 'Clarify mode needs one question and exactly 4 options.';
        continue;
      }
      return { kind: 'clarify', question, options, apology };
    }
    if (mode === 'answer') {
      const answer = parsed.answer?.trim();
      if (!answer) {
        lastError = 'The model returned an empty answer.';
        continue;
      }
      return { kind: 'answer', answer, title: parsed.title, apology };
    }

    const rawSql = parsed.sql?.trim() ?? '';
    let statement: string;
    try {
      statement = assertReadOnlySql(rawSql);
    } catch (error) {
      lastSql = rawSql;
      lastError = error instanceof Error ? error.message : 'The query is not read-only.';
      continue;
    }

    if (isConstantOnlySelect(statement)) {
      lastSql = statement;
      lastError =
        'Constant-only SELECT is not allowed. For conceptual questions use mode "answer"; for data questions query real tables.';
      continue;
    }

    lastSql = statement;
    input.onProgress?.(
      input.language === 'fa' ? 'در حال اجرای کوئری' : 'Running the query',
    );
    try {
      const captured = await captureRun(input.connectionId, statement);
      return {
        kind: 'query',
        sql: statement,
        title: parsed.title?.trim() ?? '',
        note: parsed.note?.trim() ?? '',
        apology,
        captured,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'The query failed.';
    }
  }

  throw new Error(lastError || 'The AI model could not produce a working response.');
}

export async function ask(
  conversationId: string,
  message: string,
  onProgress?: (message: string) => void,
): Promise<AskResult> {
  const question = String(message ?? '').trim();
  if (!question) throw new Error('Type a question first.');
  if (question.length > 4_000) throw new Error('The question is too long.');

  const conversation = await getConversationOrThrow(conversationId);
  const connectionId = conversation.connectionId;

  const context = await loadConnectionContext(connectionId);
  if (context.report?.verdict !== 'read-only') {
    throw new Error('This project is not verified as read-only, so chat is blocked.');
  }
  if (!context.snapshot) {
    throw new Error('The schema snapshot is missing. Reproof the project first.');
  }

  const prisma = getPrisma();
  const knowledgeRow = await prisma.knowledgeBase.findUnique({ where: { connectionId } });
  if (!knowledgeRow) {
    throw new Error('Finish onboarding first: the knowledge base for this project is missing.');
  }
  if (context.row.status !== 'ready') {
    throw new Error('This project is not ready yet. Finish onboarding first.');
  }

  const config = await resolveAiConfig(context.row.aiModelId);
  const language = detectLanguage(question);

  const userMessage = await prisma.message.create({
    data: { conversationId: conversation.id, role: 'user', content: question },
  });

  if (conversation.title === DEFAULT_TITLE) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { title: titleFromMessage(question) },
    });
  }

  const priorRows = (await messageRows(conversation.id)).filter((row) => row.id !== userMessage.id);
  const packed = await packContext({
    rows: priorRows.map(toContextSource),
    summary: conversation.contextSummary,
    untilId: conversation.contextUntilId,
    config,
    language,
    onProgress,
  });
  if (packed.summary !== (conversation.contextSummary ?? '') || packed.untilId !== conversation.contextUntilId) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { contextSummary: packed.summary || null, contextUntilId: packed.untilId },
    });
  }

  try {
    onProgress?.(
      language === 'fa' ? 'آماده‌سازی پایگاه دانش' : 'Preparing the knowledge base',
    );
    const schemaText = schemaToText(context.stored.engine, context.snapshot, {
      includeSamples: false,
      maxChars: 40_000,
    });
    const glossary = knowledgeRow.glossaryJson
      ? summarizeGlossary(knowledgeRow.glossaryJson)
      : null;
    const projectMemory = formatProjectMemory(knowledgeRow.memoryJson);

    const result = await generateAndRun({
      connectionId,
      engine: context.stored.engine,
      schemaText,
      knowledge: [knowledgeRow.summary, knowledgeRow.content].filter(Boolean).join('\n\n').slice(0, 25_000),
      glossary,
      projectMemory,
      history: packed.history,
      summary: packed.summary,
      question,
      config,
      language,
      onProgress,
    });

    if (result.kind === 'answer') {
      const content = [result.apology, result.answer].filter((part) => part.trim()).join('\n\n');
      await saveAssistantMessage({
        conversationId: conversation.id,
        content,
        sql: null,
        explanation: result.title ?? null,
        error: null,
      });
      bufferLearningTurn(connectionId, { role: 'user', content: question });
      bufferLearningTurn(connectionId, { role: 'assistant', content });
    } else if (result.kind === 'clarify') {
      await saveAssistantMessage({
        conversationId: conversation.id,
        content: result.apology,
        sql: null,
        explanation: null,
        error: null,
        payload: { question: result.question, options: result.options },
      });
      bufferLearningTurn(connectionId, { role: 'user', content: question });
      bufferLearningTurn(connectionId, {
        role: 'assistant',
        content: [result.apology, result.question].filter((part) => part.trim()).join('\n'),
      });
    } else {
      const assistantContent = buildContent({
        apology: result.apology,
        note: result.note,
        captured: result.captured,
        language,
      });
      await saveAssistantMessage({
        conversationId: conversation.id,
        content: assistantContent,
        sql: result.sql,
        explanation: result.title || null,
        error: null,
        captured: result.captured,
      });
      bufferLearningTurn(connectionId, { role: 'user', content: question });
      bufferLearningTurn(connectionId, {
        role: 'assistant',
        content: [result.title, assistantContent].filter(Boolean).join('\n'),
      });
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'The request failed.';
    await saveAssistantMessage({
      conversationId: conversation.id,
      content:
        language === 'fa'
          ? `نتوانستم این درخواست را کامل کنم. ${messageText}`
          : `I couldn't complete that request. ${messageText}`,
      sql: null,
      explanation: null,
      error: messageText,
    });
  }

  const rows = await messageRows(conversation.id);
  const updated = await getConversationOrThrow(conversation.id);
  return {
    conversation: toConversationView(updated),
    messages: rows.map(toMessageView),
    ...(await usageFields(updated.connectionId, rows, updated.contextSummary, updated.contextUntilId)),
  };
}

function summarizeGlossary(glossaryJson: string): string | null {
  try {
    const entries = JSON.parse(glossaryJson) as Array<{ term?: unknown; definition?: unknown }>;
    if (!Array.isArray(entries)) return null;
    const lines = entries
      .filter(
        (entry) =>
          typeof entry?.term === 'string' &&
          typeof entry?.definition === 'string',
      )
      .slice(0, 80)
      .map((entry) => `- ${String(entry.term)}: ${String(entry.definition)}`);
    return lines.length > 0 ? lines.join('\n') : null;
  } catch {
    return null;
  }
}

export async function runManualSql(
  conversationId: string,
  sqlInput: string,
  onProgress?: (message: string) => void,
): Promise<AskResult> {
  const conversation = await getConversationOrThrow(conversationId);
  const connectionId = conversation.connectionId;
  const context = await loadConnectionContext(connectionId);
  if (context.report?.verdict !== 'read-only') {
    throw new Error('This project is not verified as read-only, so queries are blocked.');
  }

  const prisma = getPrisma();
  await prisma.message.create({
    data: { conversationId: conversation.id, role: 'user', content: 'Run this SQL manually.' },
  });
  if (conversation.title === DEFAULT_TITLE) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { title: 'Manual SQL' },
    });
  }

  try {
    const statement = assertReadOnlySql(String(sqlInput ?? ''));
    onProgress?.('Running the query');
    const captured = await captureRun(connectionId, statement);
    await saveAssistantMessage({
      conversationId: conversation.id,
      content: buildContent({ captured }),
      sql: statement,
      explanation: null,
      error: null,
      captured,
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'The query failed.';
    await saveAssistantMessage({
      conversationId: conversation.id,
      content: `The query did not run. ${messageText}`,
      sql: String(sqlInput ?? '').trim() || null,
      explanation: null,
      error: messageText,
    });
  }

  const rows = await messageRows(conversation.id);
  const updated = await getConversationOrThrow(conversation.id);
  return {
    conversation: toConversationView(updated),
    messages: rows.map(toMessageView),
    ...(await usageFields(updated.connectionId, rows, updated.contextSummary, updated.contextUntilId)),
  };
}

export async function getReportPage(
  runId: string,
  offsetInput: number,
  limitInput: number,
): Promise<ReportPage | null> {
  const prisma = getPrisma();
  const run = await prisma.queryRun.findUnique({
    where: { id: runId },
    include: { message: true },
  });
  if (!run) return null;

  const limit = Math.min(100, Math.max(1, Math.floor(Number(limitInput) || 50)));
  const offset = Math.max(0, Math.floor(Number(offsetInput) || 0));
  let columns: string[] = [];
  try {
    columns = JSON.parse(run.columnsJson) as string[];
  } catch {
    columns = [];
  }

  let rows: CellValue[][] = [];
  if (run.resultPath) {
    rows = await readRunPage(run.resultPath, offset, limit);
  } else {
    try {
      const stored = JSON.parse(run.displayRowsJson) as CellValue[][];
      rows = stored.slice(offset, offset + limit);
    } catch {
      rows = [];
    }
  }

  return {
    runId: run.id,
    title: run.message.explanation?.trim() || null,
    columns,
    rows,
    rowCount: run.rowCount,
    offset,
    limit,
    truncated: run.truncated,
    canExport: Boolean(run.resultPath) && columns.length > 0,
  };
}

export async function getReportData(runId: string): Promise<ReportData | null> {
  const prisma = getPrisma();
  const run = await prisma.queryRun.findUnique({
    where: { id: runId },
    include: { message: true },
  });
  if (!run) return null;

  let columns: string[] = [];
  try {
    columns = JSON.parse(run.columnsJson) as string[];
  } catch {
    columns = [];
  }

  const rows: CellValue[][] = [];
  if (run.resultPath) {
    for await (const row of readRunRows(run.resultPath)) rows.push(row);
  } else {
    try {
      const stored = JSON.parse(run.displayRowsJson) as CellValue[][];
      rows.push(...stored);
    } catch {
      // Leave the report empty when the spill file and the preview are both unreadable.
    }
  }

  return {
    runId: run.id,
    title: run.message.explanation?.trim() || null,
    columns,
    rows,
    rowCount: run.rowCount,
    truncated: run.truncated,
    sql: run.sql?.trim() || null,
  };
}

export async function exportRunRows(runId: string): Promise<{ rows: AsyncGenerator<CellValue[]>; columns: string[] } | null> {
  const prisma = getPrisma();
  const run = await prisma.queryRun.findUnique({ where: { id: runId } });
  if (!run || !run.resultPath) return null;
  let columns: string[] = [];
  try {
    columns = JSON.parse(run.columnsJson) as string[];
  } catch {
    columns = [];
  }
  return { rows: readRunRows(run.resultPath), columns };
}
