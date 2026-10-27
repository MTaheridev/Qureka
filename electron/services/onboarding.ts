import type { KnowledgeView, OnboardingQuestionView, SchemaSnapshot } from '../../shared/ipc';
import { getPrisma } from '../db/client';
import { complete } from '../ai/client';
import { parseWithSchema } from '../ai/json';
import {
  knowledgeMessages,
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
  answer: string | null;
  skipped: boolean;
}): OnboardingQuestionView {
  return {
    id: row.id,
    position: row.position,
    prompt: row.prompt,
    answer: row.answer,
    skipped: row.skipped,
  };
}

const GENERIC_QUESTIONS = [
  'Which tables are safe to ignore for reporting, and which are internal?',
  'What time zone are timestamps stored in, and how should dates be grouped?',
  'Are there soft-deleted or archived rows? Which columns identify them?',
  'How should money columns be interpreted — currency, taxes, refunds, discounts?',
  'Are there known data-quality issues or rows that should always be excluded?',
  'Which relationships join the most important tables for common reports?',
  'What are the standard business metrics and how are they calculated?',
  'How far back does historical data go, and is any period incomplete?',
  'What do the status and type values mean across the schema?',
  'Who uses these reports, and what decisions do they support?',
];

function fallbackQuestions(snapshot: SchemaSnapshot): string[] {
  const questions: string[] = [];
  for (const table of snapshot.tables) {
    if (questions.length >= 10) break;
    questions.push(`What real-world thing does the table "${table.name}" represent, and what does one row mean?`);
  }
  for (const question of GENERIC_QUESTIONS) {
    if (questions.length >= 10) break;
    questions.push(question);
  }
  return questions;
}

function normalizeQuestions(candidate: string[], snapshot: SchemaSnapshot): string[] {
  const seen = new Set<string>();
  const questions: string[] = [];
  for (const raw of candidate) {
    const question = raw.replace(/\s+/g, ' ').trim();
    if (question.length < 5 || question.length > 400) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(question);
    if (questions.length >= 50) break;
  }

  if (questions.length < 10) {
    for (const question of fallbackQuestions(snapshot)) {
      const key = question.toLowerCase();
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
    questionsMessages(schemaText, context.row.name, language),
    { maxTokens: 2_500, temperature: 0.2, timeoutMs: 120_000 },
  );
  const parsed = parseWithSchema(reply, questionsResponseSchema);
  const questions = normalizeQuestions(parsed.questions, snapshot);

  if (questions.length === 0) {
    throw new Error('The AI model did not return any usable questions.');
  }

  await prisma.$transaction([
    prisma.onboardingQuestion.createMany({
      data: questions.map((prompt, index) => ({
        connectionId,
        position: index + 1,
        prompt,
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

function toKnowledgeView(row: {
  summary: string;
  content: string;
  glossaryJson: string;
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
  const reply = await complete(
    config,
    knowledgeMessages(
      schemaText,
      answers
        .filter((row) => typeof row.answer === 'string')
        .map((row) => ({ prompt: row.prompt, answer: row.answer ?? '' })),
      context.row.name,
      language,
    ),
    { maxTokens: 6_000, temperature: 0.1, timeoutMs: 180_000 },
  );

  const parsed = parseWithSchema(reply, knowledgeResponseSchema);
  const row = await prisma.knowledgeBase.upsert({
    where: { connectionId },
    create: {
      connectionId,
      summary: parsed.summary,
      content: parsed.content,
      tablesJson: JSON.stringify(parsed.tables),
      glossaryJson: JSON.stringify(parsed.glossary),
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
