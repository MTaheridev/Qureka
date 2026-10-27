import type {
  AppLanguage,
  AskResult,
  CellValue,
  ChatMessageView,
  ConversationView,
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
import { captureRun, readRunRows, removeRunFile, toRunView, type CapturedRun } from './runs';

const DEFAULT_TITLE = 'New chat';

type MessageRow = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  sql: string | null;
  explanation: string | null;
  error: string | null;
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
  };
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

export async function getHistory(conversationId: string): Promise<ChatMessageView[]> {
  await getConversationOrThrow(conversationId);
  const rows = await messageRows(conversationId);
  return rows.map(toMessageView);
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
    data: { title: DEFAULT_TITLE, updatedAt: new Date() },
    include: { _count: { select: { messages: true } } },
  });
  return toConversationView(updated);
}

function formatAnswer(columns: string[], row: CellValue[]): string {
  if (columns.length === 1) {
    const value = row[0];
    return value === null || value === undefined ? '—' : String(value);
  }
  return columns
    .map((column, index) => {
      const value = row[index];
      const text = value === null || value === undefined ? '—' : String(value);
      return `- **${column}:** ${text}`;
    })
    .join('\n');
}

function buildContent(
  explanation: string | null,
  captured: CapturedRun,
  language: AppLanguage = 'en',
): string {
  const parts: string[] = [];
  const note = explanation?.trim();
  if (note) parts.push(note);
  const fa = language === 'fa';

  if (captured.rowCount === 0) {
    parts.push(fa ? 'هیچ ردیفی با این درخواست مطابقت نداشت.' : 'No rows matched this request.');
  } else if (captured.rowCount === 1 && !captured.truncated && captured.displayRows[0]) {
    const answer = formatAnswer(captured.columns, captured.displayRows[0]);
    parts.push(
      captured.columns.length === 1
        ? fa
          ? `**پاسخ:** ${answer}`
          : `**Answer:** ${answer}`
        : answer,
    );
  } else {
    const rows = captured.rowCount.toLocaleString(fa ? 'fa-IR' : 'en-US');
    const ms = captured.durationMs.toLocaleString(fa ? 'fa-IR' : 'en-US');
    parts.push(
      fa
        ? `**${rows}** ردیف در ${ms} میلی‌ثانیه برگردانده شد.`
        : `Returned **${rows}** row${captured.rowCount === 1 ? '' : 's'} in ${ms} ms.`,
    );
  }
  if (captured.truncated) {
    parts.push(
      fa
        ? 'نتیجه از حد ذخیره بزرگ‌تر بود؛ خروجی‌ها فقط شامل ردیف‌های ذخیره‌شده هستند.'
        : 'The result was larger than the capture limit; exports contain only the captured rows.',
    );
  }
  return parts.join('\n\n');
}

async function historyForPrompt(conversationId: string, excludeMessageId: string): Promise<HistoryMessage[]> {
  const rows = await messageRows(conversationId);
  return rows
    .filter((row) => row.id !== excludeMessageId)
    .slice(-8)
    .map((row) => ({
      role: row.role === 'user' ? 'user' : 'assistant',
      content: [row.content, row.sql ? `SQL: ${row.sql}` : ''].filter(Boolean).join('\n').slice(0, 2_000),
    }));
}

async function saveAssistantMessage(input: {
  conversationId: string;
  content: string;
  sql: string | null;
  explanation: string | null;
  error: string | null;
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
  | { kind: 'answer'; answer: string; title?: string }
  | { kind: 'query'; sql: string; explanation: string; captured: CapturedRun };

async function generateAndRun(input: {
  connectionId: string;
  engine: 'postgres' | 'mysql' | 'mssql' | 'sqlite';
  schemaText: string;
  knowledge: string | null;
  glossary: string | null;
  projectMemory: string | null;
  history: HistoryMessage[];
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
    if (responseMode(parsed) === 'answer') {
      const answer = parsed.answer?.trim();
      if (!answer) {
        lastError = 'The model returned an empty answer.';
        continue;
      }
      return { kind: 'answer', answer, title: parsed.title };
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
      return { kind: 'query', sql: statement, explanation: parsed.explanation ?? '', captured };
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

  const history = await historyForPrompt(conversation.id, userMessage.id);

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
      history,
      question,
      config,
      language,
      onProgress,
    });

    if (result.kind === 'answer') {
      await saveAssistantMessage({
        conversationId: conversation.id,
        content: result.answer,
        sql: null,
        explanation: result.title ?? null,
        error: null,
      });
      bufferLearningTurn(connectionId, { role: 'user', content: question });
      bufferLearningTurn(connectionId, { role: 'assistant', content: result.answer });
    } else {
      const assistantContent = buildContent(result.explanation, result.captured, language);
      await saveAssistantMessage({
        conversationId: conversation.id,
        content: assistantContent,
        sql: result.sql,
        explanation: result.explanation,
        error: null,
        captured: result.captured,
      });
      bufferLearningTurn(connectionId, { role: 'user', content: question });
      bufferLearningTurn(connectionId, {
        role: 'assistant',
        content: [result.explanation, assistantContent].filter(Boolean).join('\n'),
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
      content: buildContent('Query executed from the SQL editor.', captured),
      sql: statement,
      explanation: 'Query executed from the SQL editor.',
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
