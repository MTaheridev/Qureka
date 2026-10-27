import { z } from 'zod';
import type { AppLanguage, EngineId } from '../../shared/ipc';
import type { AiMessage } from './client';
import { engineLabel } from './schema-text';

export const questionsResponseSchema = z.object({
  questions: z.array(z.string().trim().min(5).max(400)).min(1).max(60),
});

export const knowledgeResponseSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  content: z.string().trim().min(1),
  glossary: z
    .array(
      z.object({
        term: z.string().trim().min(1).max(120),
        definition: z.string().trim().min(1).max(1_000),
      }),
    )
    .max(200)
    .default([]),
  tables: z
    .array(
      z.object({
        schema: z.string().trim().max(120).optional().default(''),
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000).optional().default(''),
        columns: z.record(z.string(), z.string().max(1_000)).optional().default({}),
      }),
    )
    .max(500)
    .default([]),
});

export const sqlResponseSchema = z
  .object({
    mode: z.enum(['answer', 'query']).optional(),
    answer: z.string().trim().max(8_000).optional(),
    sql: z.string().trim().optional(),
    explanation: z.string().trim().max(4_000).optional().default(''),
    title: z.string().trim().max(160).optional(),
  })
  .superRefine((value, ctx) => {
    const mode = value.mode ?? (value.answer && !value.sql ? 'answer' : 'query');
    if (mode === 'answer') {
      if (!value.answer?.trim()) {
        ctx.addIssue({
          code: 'custom',
          message: 'Answer mode requires a non-empty "answer" field.',
          path: ['answer'],
        });
      }
      return;
    }
    if (!value.sql?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'Query mode requires a non-empty "sql" field.',
        path: ['sql'],
      });
    }
  });

export type KnowledgeResponse = z.infer<typeof knowledgeResponseSchema>;
export type SqlResponse = z.infer<typeof sqlResponseSchema>;

export function responseMode(parsed: SqlResponse): 'answer' | 'query' {
  if (parsed.mode === 'answer' || parsed.mode === 'query') return parsed.mode;
  return parsed.answer && !parsed.sql ? 'answer' : 'query';
}

const BASE_SYSTEM = [
  'You are EasyReporter, a senior data analyst embedded in a desktop reporting application.',
  'You reverse-engineer business meaning from database schemas, ask targeted questions, and write correct read-only SQL.',
  'The database credentials are read-only, so your SQL must never attempt to write data or structure.',
  'You only use tables and columns that appear in the provided schema. You never invent names.',
  'Safety limits: never help change, delete, or insert data; never dump passwords, API keys, tokens, secrets, private keys, SSNs, full credit-card numbers, or similar sensitive fields.',
  'If the user asks for secrets or write operations, refuse in answer mode and explain that EasyReporter is read-only analytics only.',
  'Never show or mention SQL to the end user in answer text, titles, or explanations — the app hides SQL. Write explanations as plain business language only.',
  'You return strict JSON with no markdown fences and no text outside the JSON object.',
].join(' ');

export function languageDirective(language: AppLanguage = 'en'): string {
  if (language === 'fa') {
    return [
      'LANGUAGE RULE (mandatory): The app UI is Persian (fa).',
      'Every natural-language field you produce MUST be written entirely in Persian (Farsi): questions, answers, titles, explanations, summaries, glossary terms/definitions, knowledge content, and refusal messages.',
      'Keep SQL identifiers, JSON keys, mode values ("answer"/"query"), and SQL code in English/technical form as required by the schema.',
      'Do not mix English prose into user-facing text except unavoidable proper nouns or table/column names.',
    ].join(' ');
  }
  return [
    'LANGUAGE RULE: The app UI is English.',
    'Write all natural-language fields (answers, titles, explanations, questions, knowledge, glossary) in clear English.',
  ].join(' ');
}

function withLanguage(system: string, language: AppLanguage = 'en'): string {
  return `${system} ${languageDirective(language)}`;
}

export function questionsMessages(
  schemaText: string,
  connectionName: string,
  language: AppLanguage = 'en',
): AiMessage[] {
  return [
    { role: 'system', content: withLanguage(BASE_SYSTEM, language) },
    {
      role: 'user',
      content: [
        `Connection: ${connectionName}`,
        language === 'fa' ? 'Write every onboarding question in Persian.' : '',
        '',
        schemaText,
        '',
        'Create between 10 and 50 onboarding questions that a business user should answer so this schema can be used safely for reporting.',
        'Focus only on what cannot be inferred from the schema: business meaning, table grain, status values, units, definitions of metrics, date conventions, soft deletes, and ambiguous relationships.',
        'Do not ask about credentials, infrastructure, or anything unrelated to understanding this data.',
        'Use the exact table and column names. Keep each question short and answerable by a non-technical user.',
        'If the schema is already self-explanatory, stay near the lower end (10 questions); add more only where genuine ambiguity exists.',
        '',
        'Return JSON exactly in this shape:',
        '{"questions": ["question 1", "question 2"]}',
      ].join('\n'),
    },
  ];
}

export interface OnboardingAnswer {
  prompt: string;
  answer: string;
}

export function knowledgeMessages(
  schemaText: string,
  answers: OnboardingAnswer[],
  connectionName: string,
  language: AppLanguage = 'en',
): AiMessage[] {
  const answerText =
    answers.length === 0
      ? language === 'fa'
        ? 'کاربر به سوالات پاسخ نداده است. همه چیز را از اسکیما استخراج کن و فرضیات را مشخص کن.'
        : 'The user did not answer any onboarding questions. Derive everything from the schema and clearly mark assumptions.'
      : answers.map((entry) => `Q: ${entry.prompt}\nA: ${entry.answer}`).join('\n\n');

  return [
    { role: 'system', content: withLanguage(BASE_SYSTEM, language) },
    {
      role: 'user',
      content: [
        `Connection: ${connectionName}`,
        '',
        schemaText,
        '',
        'Business answers from the user:',
        answerText,
        '',
        language === 'fa'
          ? 'یک پایگاه دانش ساخت‌یافته بساز. خلاصه، محتوا، واژه‌نامه و یادداشت جداول را به فارسی بنویس. راهنمای SQL داخل تعاریف می‌تواند شناسه انگلیسی داشته باشد.'
          : 'Build a structured knowledge base that a SQL-writing assistant can rely on. Include:',
        language === 'fa'
          ? ''
          : '- A concise summary (2–5 sentences) of what this database is for.',
        language === 'fa'
          ? ''
          : '- Markdown content with sections: Overview, Entities and grain, Relationships and join paths, Metrics and calculations, Status/filter conventions, Date and time handling, Known ambiguities.',
        language === 'fa' ? '' : '- A glossary of business terms with definitions and, when useful, SQL hints.',
        language === 'fa'
          ? ''
          : '- Per-table notes describing what each table represents and what important columns mean.',
        '',
        'Return JSON exactly in this shape:',
        '{"summary":"...","content":"markdown...","glossary":[{"term":"...","definition":"..."}],"tables":[{"schema":"...","name":"...","description":"...","columns":{"column_name":"meaning"}}]}',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

const DIALECT_RULES: Record<EngineId, string[]> = {
  postgres: [
    'Use PostgreSQL syntax.',
    'Limit rows with LIMIT n.',
    'Use date_trunc / interval for date math and cast dates explicitly.',
    'Quote identifiers with double quotes only when necessary.',
  ],
  mysql: [
    'Use MySQL syntax.',
    'Limit rows with LIMIT n.',
    'Use backticks only when an identifier needs quoting.',
    'Prefer DATE_FORMAT / DATE_SUB for date handling.',
  ],
  mssql: [
    'Use Microsoft SQL Server (T-SQL) syntax.',
    'Limit rows with TOP (n) in the SELECT clause, or OFFSET/FETCH.',
    'Use datepart / DATEADD / DATEDIFF for date handling.',
    'Quote identifiers with brackets only when necessary. Do not use LIMIT.',
  ],
  sqlite: [
    'Use SQLite syntax.',
    'Limit rows with LIMIT n.',
    'SQLite has no RIGHT/FULL JOIN and limited date functions; use strftime/date when needed.',
    'Quote identifiers with double quotes only when necessary.',
  ],
};

export function sqlMessages(input: {
  engine: EngineId;
  schemaText: string;
  knowledge: string | null;
  glossary: string | null;
  history: HistoryMessage[];
  question: string;
  language?: AppLanguage;
}): AiMessage[] {
  const language = input.language ?? 'en';
  const historyText = input.history
    .slice(-8)
    .map((message) => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${message.content.slice(0, 2_000)}`)
    .join('\n');

  return [
    { role: 'system', content: withLanguage(BASE_SYSTEM, language) },
    {
      role: 'user',
      content: [
        `Database dialect: ${engineLabel(input.engine)}`,
        ...DIALECT_RULES[input.engine],
        '',
        'Schema:',
        input.schemaText,
        '',
        input.knowledge ? `Knowledge base:\n${input.knowledge}` : 'No knowledge base is available; rely on the schema.',
        input.glossary ? `\nGlossary:\n${input.glossary}` : '',
        historyText ? `\nConversation so far:\n${historyText}` : '',
        '',
        `User request: ${input.question}`,
        '',
        'Choose one response mode:',
        '',
        '1) mode "answer" — for conceptual questions that do not need a database query.',
        '   Examples: what is this database about, explain the schema, define a term, how are tables related,',
        '   what does a column mean, summarize the business model.',
        '   Write a clear prose answer from the knowledge base and schema. Do not invent SQL.',
        '   Prefer short markdown with a 1–2 sentence summary, then bullets for entities / relationships / caveats.',
        '',
        '2) mode "query" — only when the user needs numbers, lists, filters, rankings, or other live data.',
        '   Write one read-only SQL statement that starts with SELECT or WITH.',
        '   Never use INSERT, UPDATE, DELETE, MERGE, DDL, stored procedures, SELECT INTO, or multiple statements.',
        '   Do not end the statement with a semicolon.',
        '   Never answer with SELECT of string/number literals only (no real FROM table). That is not allowed.',
        '   Query real tables/columns from the schema. Use readable aliases. Avoid SELECT * unless necessary.',
        '   Never select password, secret, token, api_key, private_key, ssn, credit_card, cvv, or similar columns.',
        '   Prefer aggregates and masked identifiers when the user asks broadly for people or accounts.',
        '   Rankings need ORDER BY and a sensible LIMIT/TOP (default LIMIT 100 unless the user asks for more, max 1000).',
        '   The "explanation" and "title" must be business language only — never include SQL text there.',
        '',
        '3) Refuse with mode "answer" when the user asks to modify data or extract secrets.',
        '',
        language === 'fa'
          ? 'متن answer، explanation و title را فقط به فارسی بنویس.'
          : 'Write answer, explanation, and title in English.',
        '',
        'Return JSON exactly in one of these shapes:',
        '{"mode":"answer","answer":"Markdown prose...","title":"Short title"}',
        'or',
        '{"mode":"query","sql":"SELECT ...","explanation":"Business-language summary of the result intent (no SQL).","title":"Short report title"}',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

export function repairMessages(input: {
  engine: EngineId;
  schemaText: string;
  question: string;
  sql: string;
  error: string;
  language?: AppLanguage;
}): AiMessage[] {
  const language = input.language ?? 'en';
  return [
    { role: 'system', content: withLanguage(BASE_SYSTEM, language) },
    {
      role: 'user',
      content: [
        `Dialect: ${engineLabel(input.engine)}`,
        '',
        'Schema:',
        input.schemaText,
        '',
        `The user asked: ${input.question}`,
        '',
        'The previous query failed:',
        input.sql,
        '',
        'Error:',
        input.error,
        '',
        'Fix the query. Keep it read-only and return one SELECT or WITH statement without a trailing semicolon.',
        'If the request was conceptual and no SQL is appropriate, switch to answer mode instead.',
        'Never return SELECT of literals only.',
        'explanation and title must not contain SQL text.',
        language === 'fa'
          ? 'explanation و title و answer را فقط فارسی بنویس.'
          : 'Write explanation, title, and answer in English.',
        'Return JSON exactly in one of these shapes:',
        '{"mode":"query","sql":"SELECT ...","explanation":"What you fixed in business language.","title":"Short report title"}',
        'or',
        '{"mode":"answer","answer":"Markdown prose...","title":"Short title"}',
      ].join('\n'),
    },
  ];
}

/** True when the statement only projects constants and never reads a real table. */
export function isConstantOnlySelect(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return true;
  const upper = stripped.toUpperCase();
  if (!/\bFROM\b/.test(upper) && !/\bJOIN\b/.test(upper)) return true;
  // FROM dual / FROM (SELECT ...) with no base tables still smells constant-only.
  if (/\bFROM\s+DUAL\b/.test(upper)) return true;
  return false;
}
