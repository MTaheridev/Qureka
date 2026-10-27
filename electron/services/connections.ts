import type {
  ConnectionInput,
  ConnectionStatus,
  ConnectionView,
  CreateConnectionResult,
  EngineId,
  ReadOnlyReport,
  SchemaSnapshot,
  SchemaSummary,
} from '../../shared/ipc';
import { getPrisma } from '../db/client';
import { createEngineAdapter } from '../engines/factory';
import { LIMITS } from '../engines/constants';
import type { EngineAdapter, StoredConnection } from '../engines/types';
import { describeTarget } from '../engines/values';
import { decryptSecret, encryptSecret } from './secrets';

const ENGINES: EngineId[] = ['postgres', 'mysql', 'mssql', 'sqlite'];
const DEFAULT_PORTS: Record<EngineId, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
  sqlite: 0,
};

type ConnectionRow = {
  id: string;
  name: string;
  engine: string;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  password: string | null;
  filePath: string | null;
  ssl: boolean;
  status: string;
  statusDetail: string | null;
  readOnlyReport: string | null;
  schemaJson: string | null;
  aiModelId: string | null;
  createdAt: Date;
  updatedAt: Date;
  aiModel?: { name: string } | null;
  knowledge?: { id: string } | null;
};

export interface ConnectionContext {
  row: ConnectionRow;
  stored: StoredConnection;
  report: ReadOnlyReport | null;
  snapshot: SchemaSnapshot | null;
}

function parseReport(value: string | null): ReadOnlyReport | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ReadOnlyReport;
  } catch {
    return null;
  }
}

export function parseSnapshot(value: string | null): SchemaSnapshot | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as SchemaSnapshot;
  } catch {
    return null;
  }
}

function toStored(row: ConnectionRow): StoredConnection {
  return {
    id: row.id,
    engine: row.engine as EngineId,
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    password: decryptSecret(row.password),
    filePath: row.filePath,
    ssl: row.ssl,
  };
}

function toView(row: ConnectionRow): ConnectionView {
  const snapshot = parseSnapshot(row.schemaJson);
  return {
    id: row.id,
    name: row.name,
    engine: row.engine as EngineId,
    status: row.status as ConnectionStatus,
    statusDetail: row.statusDetail,
    aiModelId: row.aiModelId,
    aiModelName: row.aiModel?.name ?? null,
    target: describeTarget(toStored(row)),
    readOnly: parseReport(row.readOnlyReport),
    tableCount: snapshot ? snapshot.tables.length : null,
    hasKnowledge: Boolean(row.knowledge),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const includeRelations = {
  aiModel: { select: { name: true } },
  knowledge: { select: { id: true } },
} as const;

export async function listConnections(): Promise<ConnectionView[]> {
  const prisma = getPrisma();
  const rows = await prisma.dbConnection.findMany({
    include: includeRelations,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toView);
}

export async function getConnectionView(id: string): Promise<ConnectionView | null> {
  const prisma = getPrisma();
  const row = await prisma.dbConnection.findUnique({ where: { id }, include: includeRelations });
  return row ? toView(row) : null;
}

export async function loadConnectionContext(id: string): Promise<ConnectionContext> {
  const prisma = getPrisma();
  const row = await prisma.dbConnection.findUnique({ where: { id }, include: includeRelations });
  if (!row) throw new Error('This database connection no longer exists.');
  return {
    row,
    stored: toStored(row),
    report: parseReport(row.readOnlyReport),
    snapshot: parseSnapshot(row.schemaJson),
  };
}

export async function loadEngineContext(id: string): Promise<ConnectionContext & { adapter: EngineAdapter }> {
  const context = await loadConnectionContext(id);
  if (context.report?.verdict !== 'read-only') {
    throw new Error('This connection is not verified as read-only. Reproof the credentials before continuing.');
  }
  return { ...context, adapter: createEngineAdapter(context.stored) };
}

function requireReadOnly(context: ConnectionContext): void {
  if (!context.report || context.report.verdict !== 'read-only') {
    throw new Error('This connection is not verified as read-only.');
  }
}

function normalizeInput(input: ConnectionInput): {
  name: string;
  engine: EngineId;
  aiModelId: string;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  password: string | null;
  filePath: string | null;
  ssl: boolean;
} {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Give the connection a name.');
  if (name.length > 120) throw new Error('The connection name is too long.');

  const engine = ENGINES.find((value) => value === input.engine);
  if (!engine) throw new Error('Choose a supported database engine.');

  const aiModelId = String(input.aiModelId ?? '').trim();
  if (!aiModelId) throw new Error('Select an AI model for this connection.');

  if (engine === 'sqlite') {
    const filePath = String(input.filePath ?? '').trim();
    if (!filePath) throw new Error('Choose a SQLite database file.');
    return {
      name,
      engine,
      aiModelId,
      host: null,
      port: null,
      database: null,
      username: null,
      password: null,
      filePath,
      ssl: false,
    };
  }

  const host = String(input.host ?? '').trim();
  const database = String(input.database ?? '').trim();
  const username = String(input.username ?? '').trim();
  if (!host) throw new Error('Enter the database host.');
  if (!database) throw new Error('Enter the database name.');
  if (!username) throw new Error('Enter the database user.');

  const port = input.port ? Number(input.port) : DEFAULT_PORTS[engine];
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('The database port must be between 1 and 65535.');
  }

  return {
    name,
    engine,
    aiModelId,
    host,
    port,
    database,
    username,
    password: input.password ?? null,
    filePath: null,
    ssl: input.ssl === true,
  };
}

export async function createConnection(
  input: ConnectionInput,
  onProgress?: (message: string) => void,
): Promise<CreateConnectionResult> {
  const normalized = normalizeInput(input);
  const prisma = getPrisma();

  const model = await prisma.aiModel.findUnique({ where: { id: normalized.aiModelId } });
  if (!model) {
    return { ok: false, error: 'The selected AI model no longer exists.' };
  }

  const stored: StoredConnection = {
    id: 'probe',
    engine: normalized.engine,
    host: normalized.host,
    port: normalized.port,
    database: normalized.database,
    username: normalized.username,
    password: normalized.password,
    filePath: normalized.filePath,
    ssl: normalized.ssl,
  };

  onProgress?.('Checking that these credentials cannot modify the database');
  const probeAdapter = createEngineAdapter(stored);
  let report: ReadOnlyReport;
  try {
    report = await probeAdapter.probeReadOnly();
  } catch (error) {
    await probeAdapter.close().catch(() => undefined);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The connection could not be verified.',
    };
  }
  await probeAdapter.close().catch(() => undefined);

  if (report.verdict !== 'read-only') {
    return {
      ok: false,
      error:
        'These credentials can modify the database. EasyReporter only accepts connections that cannot write, so create a read-only user and try again.',
      report,
    };
  }

  const row = await prisma.dbConnection.create({
    data: {
      name: normalized.name,
      engine: normalized.engine,
      host: normalized.host,
      port: normalized.port,
      database: normalized.database,
      username: normalized.username,
      password: encryptSecret(normalized.password),
      filePath: normalized.filePath,
      ssl: normalized.ssl,
      status: 'draft',
      readOnlyReport: JSON.stringify(report),
      aiModelId: normalized.aiModelId,
    },
    include: includeRelations,
  });

  onProgress?.('Reading tables, columns and sample rows');
  const adapter = createEngineAdapter({ ...stored, id: row.id });
  try {
    const snapshot = await adapter.introspect(
      {
        maxTables: LIMITS.maxTables,
        sampleRows: LIMITS.sampleRows,
        maxCellChars: LIMITS.sampleCellChars,
      },
      onProgress,
    );
    const updated = await prisma.dbConnection.update({
      where: { id: row.id },
      data: {
        schemaJson: JSON.stringify({ ...snapshot, engine: normalized.engine, fetchedAt: new Date().toISOString() }),
        statusDetail: null,
      },
      include: includeRelations,
    });
    return { ok: true, connection: toView(updated) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The schema could not be read.';
    const updated = await prisma.dbConnection.update({
      where: { id: row.id },
      data: { status: 'failed', statusDetail: message },
      include: includeRelations,
    });
    return { ok: true, connection: toView(updated) };
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

export async function setConnectionAiModel(
  id: string,
  aiModelId: string,
): Promise<ConnectionView> {
  const prisma = getPrisma();
  const modelId = String(aiModelId ?? '').trim();
  if (!modelId) throw new Error('Select an AI model.');
  const model = await prisma.aiModel.findUnique({ where: { id: modelId } });
  if (!model) throw new Error('The selected AI model no longer exists.');
  const row = await prisma.dbConnection.update({
    where: { id },
    data: { aiModelId: modelId },
    include: includeRelations,
  });
  return toView(row);
}

export async function removeConnection(id: string): Promise<void> {
  const prisma = getPrisma();
  const runs = await prisma.queryRun.findMany({
    where: { message: { conversation: { connectionId: id } } },
    select: { resultPath: true },
  });

  await prisma.dbConnection.delete({ where: { id } });

  const fs = await import('node:fs');
  for (const run of runs) {
    if (run.resultPath) {
      await fs.promises.rm(run.resultPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function reprobeConnection(id: string): Promise<ReadOnlyReport> {
  const context = await loadConnectionContext(id);
  const adapter = createEngineAdapter(context.stored);
  let report: ReadOnlyReport;
  try {
    report = await adapter.probeReadOnly();
  } finally {
    await adapter.close().catch(() => undefined);
  }

  const prisma = getPrisma();
  const currentStatus = context.row.status as ConnectionStatus;
  const nextStatus: ConnectionStatus =
    report.verdict === 'read-only'
      ? currentStatus === 'failed'
        ? 'draft'
        : currentStatus
      : 'failed';

  await prisma.dbConnection.update({
    where: { id },
    data: {
      readOnlyReport: JSON.stringify(report),
      status: nextStatus,
      statusDetail:
        report.verdict === 'read-only'
          ? null
          : 'These credentials can modify the database. EasyReporter blocked this connection.',
    },
  });

  return report;
}

export async function getSchemaSummary(id: string): Promise<SchemaSummary | null> {
  const context = await loadConnectionContext(id);
  if (!context.snapshot) return null;
  return {
    fetchedAt: context.snapshot.fetchedAt,
    engine: context.snapshot.engine,
    tables: context.snapshot.tables.map((table) => ({
      schema: table.schema,
      name: table.name,
      rowCount: table.rowCount,
      columnCount: table.columns.length,
    })),
  };
}

export async function getSchemaSnapshot(id: string): Promise<SchemaSnapshot | null> {
  const context = await loadConnectionContext(id);
  return context.snapshot;
}

export async function setConnectionStatus(
  id: string,
  status: ConnectionStatus,
  statusDetail: string | null = null,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.dbConnection.update({
    where: { id },
    data: { status, statusDetail },
  });
}

export async function refreshSchema(
  id: string,
  onProgress?: (message: string) => void,
): Promise<SchemaSnapshot> {
  const context = await loadConnectionContext(id);
  requireReadOnly(context);
  const adapter = createEngineAdapter(context.stored);
  try {
    const snapshot = await adapter.introspect(
      {
        maxTables: LIMITS.maxTables,
        sampleRows: LIMITS.sampleRows,
        maxCellChars: LIMITS.sampleCellChars,
      },
      onProgress,
    );
    const full: SchemaSnapshot = {
      ...snapshot,
      engine: context.stored.engine,
      fetchedAt: new Date().toISOString(),
    };
    const prisma = getPrisma();
    await prisma.dbConnection.update({
      where: { id },
      data: { schemaJson: JSON.stringify(full) },
    });
    return full;
  } finally {
    await adapter.close().catch(() => undefined);
  }
}
