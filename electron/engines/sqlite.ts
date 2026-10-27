import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import type { ReadOnlyCheck, ReadOnlyReport } from '../../shared/ipc';
import { LIMITS } from './constants';
import { assertReadOnlySql } from './sql-guard';
import { withTimeout } from './timeout';
import {
  ConnectionProbeError,
  type EngineAdapter,
  type RawColumn,
  type RawSchema,
  type RawTable,
  type RunOptions,
  type RunOutput,
  type SamplingLimits,
  type StoredConnection,
} from './types';
import { normalizeRow, quoteIdent, tableRef } from './values';

function requireFile(connection: StoredConnection): string {
  const file = connection.filePath?.trim();
  if (!file) {
    throw new ConnectionProbeError('No SQLite database file was selected.');
  }
  if (!fs.existsSync(file)) {
    throw new ConnectionProbeError(`The SQLite file was not found: ${file}`);
  }
  if (!fs.statSync(file).isFile()) {
    throw new ConnectionProbeError('The selected SQLite path is not a file.');
  }
  return file;
}

export class SqliteAdapter implements EngineAdapter {
  private client: Client | null = null;

  constructor(private readonly connection: StoredConnection) {}

  private async open(): Promise<Client> {
    if (this.client) return this.client;
    const file = requireFile(this.connection);
    const client = createClient({
      url: pathToFileURL(file).href,
      intMode: 'bigint',
      timeout: LIMITS.connectTimeoutMs,
    });
    await client.execute('PRAGMA query_only = ON');
    this.client = client;
    return client;
  }

  async probeReadOnly(): Promise<ReadOnlyReport> {
    const file = requireFile(this.connection);
    const checks: ReadOnlyCheck[] = [];
    let client: Client;

    try {
      client = await this.open();
    } catch (error) {
      if (error instanceof ConnectionProbeError) throw error;
      throw new ConnectionProbeError(describeError(error, 'Could not open the SQLite database.'));
    }

    checks.push({
      label: 'Database file opened',
      ok: true,
      detail: file,
    });

    try {
      const result = await withTimeout(
        client.execute('PRAGMA query_only'),
        LIMITS.connectTimeoutMs,
        () => this.reset(),
      );
      const enabled = Number(result.rows[0]?.[0] ?? 0) === 1;
      checks.push({
        label: 'Query-only mode enforced',
        ok: enabled,
        detail: enabled
          ? 'SQLite runs with PRAGMA query_only = ON, so every write attempted through EasyReporter is rejected by the engine.'
          : 'SQLite did not accept PRAGMA query_only = ON.',
      });
    } catch (error) {
      checks.push({
        label: 'Query-only mode enforced',
        ok: false,
        detail: describeError(error, 'Could not verify query-only mode.'),
      });
    }

    let fileWritable = false;
    try {
      fs.accessSync(file, fs.constants.W_OK);
      fileWritable = true;
    } catch {
      fileWritable = false;
    }
    checks.push({
      label: 'File permissions',
      ok: true,
      detail: fileWritable
        ? 'The file is writable by this user, but the query-only guard blocks writes made through EasyReporter.'
        : 'The file itself is not writable by this user.',
    });

    return {
      verdict: checks.every((check) => check.ok) ? 'read-only' : 'writable',
      engine: 'sqlite',
      checks,
      checkedAt: new Date().toISOString(),
    };
  }

  async introspect(limits: SamplingLimits, onProgress?: (message: string) => void): Promise<RawSchema> {
    const client = await this.open();
    onProgress?.('Reading the SQLite schema');

    const master = await withTimeout(
      client.execute({
        sql: `SELECT name, type FROM sqlite_master
              WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
              ORDER BY name
              LIMIT ?`,
        args: [limits.maxTables + 1],
      }),
      LIMITS.statementTimeoutMs,
      () => this.reset(),
    );

    const names = master.rows.slice(0, limits.maxTables).map((row) => String(row[0]));
    const truncated = master.rows.length > limits.maxTables;
    const tables: RawTable[] = [];

    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      const type = String(master.rows[index][1] ?? 'table');
      onProgress?.(`Sampling ${name} (${index + 1}/${names.length})`);

      const table: RawTable = {
        schema: 'main',
        name,
        rowCount: null,
        columns: [],
        sampleColumns: [],
        sampleRows: [],
      };

      try {
        const info = await withTimeout(
          client.execute(`PRAGMA table_info(${quoteIdent('sqlite', name)})`),
          LIMITS.sampleTimeoutMs,
          () => this.reset(),
        );

        const columns: RawColumn[] = info.rows.map((row) => ({
          name: String(row[1]),
          dataType: String(row[2] ?? ''),
          nullable: Number(row[3] ?? 0) === 0,
          primaryKey: Number(row[5] ?? 0) > 0,
          references: null,
        }));

        const foreignKeys = await withTimeout(
          client.execute(`PRAGMA foreign_key_list(${quoteIdent('sqlite', name)})`),
          LIMITS.sampleTimeoutMs,
          () => this.reset(),
        );
        const referenceByColumn = new Map<string, { table: string; column: string }>();
        for (const row of foreignKeys.rows) {
          const column = String(row[3] ?? '');
          if (!referenceByColumn.has(column)) {
            referenceByColumn.set(column, {
              table: String(row[2] ?? ''),
              column: String(row[4] ?? ''),
            });
          }
        }
        for (const column of columns) {
          column.references = referenceByColumn.get(column.name) ?? null;
        }

        table.columns = columns;
        table.sampleColumns = columns.map((column) => column.name);

        const reference = tableRef('sqlite', 'main', name);
        if (type === 'table') {
          try {
            const count = await withTimeout(
              client.execute(`SELECT COUNT(*) FROM ${reference}`),
              LIMITS.sampleTimeoutMs,
              () => this.reset(),
            );
            const value = count.rows[0]?.[0];
            table.rowCount = value === null || value === undefined ? null : Number(value);
          } catch {
            table.rowCount = null;
          }
        }

        try {
          const sample = await withTimeout(
            client.execute({ sql: `SELECT * FROM ${reference} LIMIT ?`, args: [limits.sampleRows] }),
            LIMITS.sampleTimeoutMs,
            () => this.reset(),
          );
          table.sampleColumns = sample.columns.length > 0 ? sample.columns : table.sampleColumns;
          table.sampleRows = sample.rows.map((row) => normalizeRow(Array.from(row as ArrayLike<unknown>), limits.maxCellChars));
        } catch {
          table.sampleRows = [];
        }
      } catch {
        // A single unreadable table must not abort the whole snapshot.
      }

      tables.push(table);
    }

    return { tables, truncated };
  }

  async runSelect(sql: string, options: RunOptions): Promise<RunOutput> {
    const statement = assertReadOnlySql(sql);
    const client = await this.open();
    const started = Date.now();

    const result = await withTimeout(
      client.execute(statement),
      options.timeoutMs,
      () => this.reset(),
    );

    const columns = result.columns;
    let rowCount = 0;
    let truncated = false;

    for (const row of result.rows) {
      if (rowCount >= options.maxRows) {
        truncated = true;
        break;
      }
      options.onRow?.(normalizeRow(Array.from(row as ArrayLike<unknown>)));
      rowCount += 1;
    }

    return { columns, rowCount, truncated, durationMs: Date.now() - started };
  }

  async close(): Promise<void> {
    this.reset();
  }

  private reset(): void {
    if (this.client) {
      try {
        this.client.close();
      } catch {
        // Already closed.
      }
      this.client = null;
    }
  }
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
