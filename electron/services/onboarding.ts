import type { KnowledgeView, OnboardingQuestionView, SchemaSnapshot } from '../../shared/ipc';
import { getPrisma } from '../db/client';
import { complete } from '../ai/client';
import { AiResponseError, parseWithSchema } from '../ai/json';
import {
  knowledgeMessages,
  knowledgeRepairMessages,
  knowledgeResponseSchema,
  questionsMessages,
  questionsResponseSchema,
} from '../ai/prompts';
import { schemaToText } from '../ai/schema-text';
import { resolveAiConfig } from './ai-models';
import { loadConnectionContext, setConnectionStatus } from './connections';
import { getSettings } from './settings';

function requireReadyInputs(context: Awaited<ReturnType<typeof loadConnectionContext>>): SchemaSnapshot {
  if (context.report?.verdict !== 'read-only') {
    throw new Error('This connection is not verified as read-only.');
  }
  if (!context.snapshot) {
    throw new Error('The schema snapshot is missing. Reproof the connection to read it again.');
  }
  return context.snapshot;
}

function toQuestionView(row: {
  id: string;
  position: number;
  prompt: string;
  promptFa?: string | null;
  answer: string | null;
  skipped: boolean;
}): OnboardingQuestionView {
  const promptFa = (row.promptFa ?? '').trim() || row.prompt;
  return {
    id: row.id,
    position: row.position,
    prompt: row.prompt,
    promptFa,
    answer: row.answer,
    skipped: row.skipped,
  };
}

type BilingualQuestion = { en: string; fa: string };

const GENERIC_QUESTIONS: BilingualQuestion[] = [
  {
    en: 'Which tables are safe to ignore for reporting, and which are internal?',
    fa: 'کدام جداول برای گزارش‌گیری قابل چشم‌پوشی‌اند و کدام داخلی‌اند؟',
  },
  {
    en: 'What time zone are timestamps stored in, and how should dates be grouped?',
    fa: 'زمان‌ها در چه منطقه زمانی ذخیره می‌شوند و تاریخ‌ها چگونه باید گروه‌بندی شوند؟',
  },
  {
    en: 'Are there soft-deleted or archived rows? Which columns identify them?',
    fa: 'آیا ردیف‌های حذف نرم یا بایگانی‌شده وجود دارد؟ کدام ستون‌ها آن‌ها را مشخص می‌کنند؟',
  },
  {
    en: 'How should money columns be interpreted — currency, taxes, refunds, discounts?',
    fa: 'ستون‌های پولی چگونه تفسیر می‌شوند — ارز، مالیات، بازگشت وجه، تخفیف؟',
  },
  {
    en: 'Are there known data-quality issues or rows that should always be excluded?',
    fa: 'آیا مشکلات کیفیت داده یا ردیف‌هایی هست که همیشه باید حذف شوند؟',
  },
  {
    en: 'Which relationships join the most important tables for common reports?',
    fa: 'کدام روابط مهم‌ترین جداول را برای گزارش‌های رایج به هم وصل می‌کنند؟',
  },
  {
    en: 'What are the standard business metrics and how are they calculated?',
    fa: 'معیارهای استاندارد کسب‌وکار چیستند و چگونه محاسبه می‌شوند؟',
  },
  {
    en: 'How far back does historical data go, and is any period incomplete?',
    fa: 'داده‌های تاریخی تا کجا برمی‌گردند و آیا دوره‌ای ناقص است؟',
  },
  {
    en: 'What do the status and type values mean across the schema?',
    fa: 'مقادیر وضعیت و نوع در سراسر اسکیما چه معنایی دارند؟',
  },
  {
    en: 'Who uses these reports, and what decisions do they support?',
    fa: 'چه کسانی از این گزارش‌ها استفاده می‌کنند و چه تصمیم‌هایی را پشتیبانی می‌کنند؟',
  },
];

function fallbackQuestions(snapshot: SchemaSnapshot): BilingualQuestion[] {
  const questions: BilingualQuestion[] = [];
  for (const table of snapshot.tables) {
    if (questions.length >= 10) break;
    questions.push({
      en: `What real-world thing does the table "${table.name}" represent, and what does one row mean?`,
      fa: `جدول «${table.name}» چه چیزی در دنیای واقعی را نشان می‌دهد و هر ردیف چه معنایی دارد؟`,
    });
  }
  for (const question of GENERIC_QUESTIONS) {
    if (questions.length >= 10) break;
    questions.push(question);
  }
  return questions;
}

function normalizeQuestions(candidate: BilingualQuestion[], snapshot: SchemaSnapshot): BilingualQuestion[] {
  const seen = new Set<string>();
  const questions: BilingualQuestion[] = [];
  for (const raw of candidate) {
    const en = String(raw.en ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const fa = String(raw.fa ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (en.length < 5 || en.length > 400) continue;
    if (fa.length < 5 || fa.length > 400) continue;
    const key = en.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push({ en, fa });
    if (questions.length >= 50) break;
  }

  if (questions.length < 10) {
    for (const question of fallbackQuestions(snapshot)) {
      const key = question.en.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      questions.push(question);
      if (questions.length >= 10) break;
    }
  }

  return questions;
}

export async function startOnboarding(
  connectionId: string,
  onProgress?: (message: string) => void,
): Promise<OnboardingQuestionView[]> {
  const prisma = getPrisma();
  const context = await loadConnectionContext(connectionId);
  const snapshot = requireReadyInputs(context);

  const existing = await prisma.onboardingQuestion.findMany({
    where: { connectionId },
    orderBy: { position: 'asc' },
  });
  if (existing.length > 0) {
    return existing.map(toQuestionView);
  }

  const config = await resolveAiConfig(context.row.aiModelId);
  onProgress?.('Preparing the schema for the AI analyst');
  const schemaText = schemaToText(context.stored.engine, snapshot, { includeSamples: true, maxChars: 50_000 });

  onProgress?.('Asking the AI model for onboarding questions');
  const language = getSettings().language;
  const reply = await complete(
    config,
    questionsMessages(schemaText, context.row.name, language, context.row.businessBrief),
    { maxTokens: 4_000, temperature: 0.2, timeoutMs: 120_000, json: true },
  );
  const parsed = parseWithSchema(reply, questionsResponseSchema);
  const questions = normalizeQuestions(parsed.questions, snapshot);

  if (questions.length === 0) {
    throw new Error('The AI model did not return any usable questions.');
  }

  await prisma.$transaction([
    prisma.onboardingQuestion.createMany({
      data: questions.map((question, index) => ({
        connectionId,
        position: index + 1,
        prompt: question.en,
        promptFa: question.fa,
      })),
    }),
    prisma.dbConnection.update({
      where: { id: connectionId },
      data: { status: 'questions', statusDetail: null },
    }),
  ]);

  const rows = await prisma.onboardingQuestion.findMany({
    where: { connectionId },
    orderBy: { position: 'asc' },
  });
  return rows.map(toQuestionView);
}

export async function getQuestions(connectionId: string): Promise<OnboardingQuestionView[]> {
  const prisma = getPrisma();
  const rows = await prisma.onboardingQuestion.findMany({
    where: { connectionId },
    orderBy: { position: 'asc' },
  });
  return rows.map(toQuestionView);
}

export async function answerQuestion(questionId: string, answer: string): Promise<void> {
  const prisma = getPrisma();
  const trimmed = String(answer ?? '').trim().slice(0, 4_000);
  const existing = await prisma.onboardingQuestion.findUnique({ where: { id: questionId } });
  if (!existing) throw new Error('This question no longer exists.');

  await prisma.onboardingQuestion.update({
    where: { id: questionId },
    data: {
      answer: trimmed ? trimmed : null,
      skipped: trimmed.length === 0,
    },
  });
}

export function toKnowledgeView(row: {
  summary: string;
  content: string;
  glossaryJson: string;
  memoryJson?: string | null;
  memoryUpdatedAt?: Date | null;
  updatedAt: Date;
}): KnowledgeView {
  let glossary: KnowledgeView['glossary'] = [];
  try {
    const parsed = JSON.parse(row.glossaryJson) as unknown;
    if (Array.isArray(parsed)) {
      glossary = parsed
        .filter(
          (entry): entry is { term: string; definition: string } =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            typeof (entry as { term?: unknown }).term === 'string' &&
            typeof (entry as { definition?: unknown }).definition === 'string',
        )
        .map((entry) => ({ term: entry.term, definition: entry.definition }));
    }
  } catch {
    glossary = [];
  }

  return {
    summary: row.summary,
    content: row.content,
    glossary,
    memory: row.memoryJson?.trim() ? row.memoryJson : null,
    memoryUpdatedAt: row.memoryUpdatedAt ? row.memoryUpdatedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getKnowledge(connectionId: string): Promise<KnowledgeView | null> {
  const prisma = getPrisma();
  const row = await prisma.knowledgeBase.findUnique({ where: { connectionId } });
  return row ? toKnowledgeView(row) : null;
}

export async function buildKnowledge(
  connectionId: string,
  onProgress?: (message: string) => void,
): Promise<KnowledgeView> {
  const prisma = getPrisma();
  const context = await loadConnectionContext(connectionId);
  const snapshot = requireReadyInputs(context);
  const config = await resolveAiConfig(context.row.aiModelId);

  const answers = await prisma.onboardingQuestion.findMany({
    where: { connectionId, answer: { not: null } },
    orderBy: { position: 'asc' },
  });

  onProgress?.('Summarizing the schema');
  const schemaText = schemaToText(context.stored.engine, snapshot, { includeSamples: true, maxChars: 55_000 });

  onProgress?.('Building the knowledge base');
  const language = getSettings().language;
  const answerPayload = answers
    .filter((row) => typeof row.answer === 'string')
    .map((row) => {
      const fa = (row.promptFa ?? '').trim();
      const prompt = fa && fa !== row.prompt ? `EN: ${row.prompt}\nFA: ${fa}` : row.prompt;
      return { prompt, answer: row.answer ?? '' };
    });

  let reply = await complete(
    config,
    knowledgeMessages(
      schemaText,
      answerPayload,
      context.row.name,
      language,
      context.row.businessBrief,
    ),
    { maxTokens: 8_000, temperature: 0.1, timeoutMs: 180_000, json: true },
  );

  let parsed;
  try {
    parsed = parseWithSchema(reply, knowledgeResponseSchema);
  } catch (firstError) {
    if (!(firstError instanceof AiResponseError)) throw firstError;
    onProgress?.('Repairing the knowledge base response');
    reply = await complete(
      config,
      knowledgeRepairMessages(reply, language),
      { maxTokens: 8_000, temperature: 0, timeoutMs: 180_000, json: true },
    );
    parsed = parseWithSchema(reply, knowledgeResponseSchema);
  }

  const existing = await prisma.knowledgeBase.findUnique({ where: { connectionId } });
  const row = await prisma.knowledgeBase.upsert({
    where: { connectionId },
    create: {
      connectionId,
      summary: parsed.summary,
      content: parsed.content,
      tablesJson: JSON.stringify(parsed.tables),
      glossaryJson: JSON.stringify(parsed.glossary),
      memoryJson: existing?.memoryJson ?? null,
      memoryUpdatedAt: existing?.memoryUpdatedAt ?? null,
    },
    update: {
      summary: parsed.summary,
      content: parsed.content,
      tablesJson: JSON.stringify(parsed.tables),
      glossaryJson: JSON.stringify(parsed.glossary),
    },
  });

  await setConnectionStatus(connectionId, 'ready', null);
  return toKnowledgeView(row);
}
