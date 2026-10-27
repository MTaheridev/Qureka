export const IPC_CHANNELS = {
  appGetInfo: 'app:get-info',
  dbGetStatus: 'db:get-status',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  modelsList: 'models:list',
  modelsCreate: 'models:create',
  modelsUpdate: 'models:update',
  modelsDelete: 'models:delete',
  modelsTest: 'models:test',

  connectionsList: 'connections:list',
  connectionsGet: 'connections:get',
  connectionsCreate: 'connections:create',
  connectionsDelete: 'connections:delete',
  connectionsSetAiModel: 'connections:set-ai-model',
  connectionsReprobe: 'connections:reprobe',
  connectionsRefresh: 'connections:refresh',
  connectionsSchema: 'connections:schema',
  connectionsExportSchema: 'connections:export-schema',
  connectionsPickSqlite: 'connections:pick-sqlite',

  onboardingStart: 'onboarding:start',
  onboardingQuestions: 'onboarding:questions',
  onboardingAnswer: 'onboarding:answer',
  onboardingBuildKnowledge: 'onboarding:build-knowledge',
  knowledgeGet: 'knowledge:get',

  chatList: 'chat:list',
  chatCreate: 'chat:create',
  chatRename: 'chat:rename',
  chatDelete: 'chat:delete',
  chatHistory: 'chat:history',
  chatAsk: 'chat:ask',
  chatRunSql: 'chat:run-sql',
  chatClear: 'chat:clear',

  exportsRun: 'exports:run',

  progress: 'app:progress',
} as const;

export type EngineId = 'postgres' | 'mysql' | 'mssql' | 'sqlite';
export type AiProtocol = 'openai' | 'anthropic';
export type ConnectionStatus = 'draft' | 'questions' | 'ready' | 'failed';
export type ExportFormat = 'csv' | 'xlsx' | 'pdf';
export type AppLanguage = 'en' | 'fa';
export type AppTheme = 'dark' | 'light';

export interface AppSettings {
  language: AppLanguage;
  theme: AppTheme;
}

export type AppSettingsPatch = Partial<AppSettings>;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  electronVersion: string;
  packaged: boolean;
  keyStorage: string;
}

export interface DbStatus {
  file: string;
  exists: boolean;
  sizeBytes: number | null;
  error?: string;
}

export interface AiModelInput {
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AiModelView {
  id: string;
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  createdAt: string;
}

export interface AiTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export interface ConnectionInput {
  name: string;
  engine: EngineId;
  aiModelId: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  filePath?: string;
  ssl?: boolean;
}

export interface ReadOnlyCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface ReadOnlyReport {
  verdict: 'read-only' | 'writable';
  engine: EngineId;
  checks: ReadOnlyCheck[];
  checkedAt: string;
}

export interface ConnectionView {
  id: string;
  name: string;
  engine: EngineId;
  status: ConnectionStatus;
  statusDetail: string | null;
  aiModelId: string | null;
  aiModelName: string | null;
  target: string;
  readOnly: ReadOnlyReport | null;
  tableCount: number | null;
  hasKnowledge: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CreateConnectionResult =
  | { ok: true; connection: ConnectionView }
  | { ok: false; error: string; report?: ReadOnlyReport };

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  references: { table: string; column: string } | null;
}

export interface TableInfo {
  schema: string;
  name: string;
  rowCount: number | null;
  columns: ColumnInfo[];
  sampleRows: CellValue[][];
  sampleColumns: string[];
}

export interface SchemaSnapshot {
  engine: EngineId;
  fetchedAt: string;
  tables: TableInfo[];
  truncated: boolean;
}

export interface SchemaSummary {
  fetchedAt: string;
  engine: EngineId;
  tables: { schema: string; name: string; rowCount: number | null; columnCount: number }[];
}

export interface OnboardingQuestionView {
  id: string;
  position: number;
  prompt: string;
  answer: string | null;
  skipped: boolean;
}

export interface GlossaryEntry {
  term: string;
  definition: string;
}

export interface KnowledgeView {
  summary: string;
  content: string;
  glossary: GlossaryEntry[];
  updatedAt: string;
}

export interface GlossaryInput {
  term: string;
  definition: string;
}

export type CellValue = string | number | boolean | null;

export interface RunView {
  id: string;
  columns: string[];
  rows: CellValue[][];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
  canExport: boolean;
}

export interface ChatMessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql: string | null;
  explanation: string | null;
  error: string | null;
  createdAt: string;
  run: RunView | null;
}

export interface ConversationView {
  id: string;
  connectionId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface AskResult {
  conversation: ConversationView;
  messages: ChatMessageView[];
}

export interface ExportResult {
  path: string;
  format: ExportFormat;
  rows: number;
  truncated: boolean;
}

export interface ProgressEvent {
  scope: 'onboarding' | 'chat' | 'connection' | 'export';
  connectionId: string;
  stage: string;
  message: string;
}

export interface EasyReporterApi {
  getAppInfo(): Promise<AppInfo>;
  getDbStatus(): Promise<DbStatus>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: AppSettingsPatch): Promise<AppSettings>;

  models: {
    list(): Promise<AiModelView[]>;
    create(input: AiModelInput): Promise<AiModelView>;
    update(id: string, input: AiModelInput): Promise<AiModelView>;
    remove(id: string): Promise<void>;
    test(input: AiModelInput, savedId?: string): Promise<AiTestResult>;
  };

  connections: {
    list(): Promise<ConnectionView[]>;
    get(id: string): Promise<ConnectionView | null>;
    create(input: ConnectionInput): Promise<CreateConnectionResult>;
    remove(id: string): Promise<void>;
    setAiModel(id: string, aiModelId: string): Promise<ConnectionView>;
    reprobe(id: string): Promise<ReadOnlyReport>;
    refresh(id: string): Promise<SchemaSummary | null>;
    schema(id: string): Promise<SchemaSummary | null>;
    exportSchema(id: string): Promise<ExportResult>;
    pickSqliteFile(): Promise<string | null>;
  };

  onboarding: {
    start(connectionId: string): Promise<OnboardingQuestionView[]>;
    questions(connectionId: string): Promise<OnboardingQuestionView[]>;
    answer(questionId: string, answer: string): Promise<void>;
    buildKnowledge(connectionId: string): Promise<KnowledgeView>;
  };

  knowledge: {
    get(connectionId: string): Promise<KnowledgeView | null>;
  };

  chat: {
    list(connectionId: string): Promise<ConversationView[]>;
    create(connectionId: string, title?: string): Promise<ConversationView>;
    rename(conversationId: string, title: string): Promise<ConversationView>;
    remove(conversationId: string): Promise<void>;
    history(conversationId: string): Promise<ChatMessageView[]>;
    ask(conversationId: string, message: string): Promise<AskResult>;
    runSql(conversationId: string, sql: string): Promise<AskResult>;
    clear(conversationId: string): Promise<ConversationView>;
  };

  exports: {
    run(runId: string, format: ExportFormat): Promise<ExportResult | null>;
  };

  onProgress(listener: (event: ProgressEvent) => void): () => void;
}

declare global {
  interface Window {
    easyReporter?: EasyReporterApi;
  }
}
