import mysql, {
  type Connection as RawConnection,
  type ConnectionOptions,
  type FieldPacket,
  type RowDataPacket,
} from 'mysql2';
import {
  createConnection as createPromiseConnection,
  type Connection as PromiseConnection,
} from 'mysql2/promise';
import type { ReadOnlyCheck, ReadOnlyReport } from '../../shared/ipc';
import { LIMITS } from './constants';
import { assertReadOnlySql } from './sql-guard';
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
import { normalizeRow, tableRef } from './values';

const ALLOWED_PRIVILEGES = new Set(['SELECT', 'SHOW VIEW', 'USAGE']);

interface GrantAnalysis {
  ok: boolean;
  offending: string[];
}

function analyzeGrants(lines: string[]): GrantAnalysis {
  const offending: string[] = [];

  for (const line of lines) {
    const text = line.trim();
    if (!/^GRANT\s/i.test(text)) {
      offending.push(text.slice(0, 60));
      continue;
    }

    const upper = text.toUpperCase();
    const onIndex = upper.indexOf(' ON ');
    if (onIndex === -1) {
      offending.push('role grant');
      continue;
    }

    const privilegesText = text.slice('GRANT'.length, onIndex).trim();
    if (/^ALL PRIVILEGES$/i.test(privilegesText)) {
      offending.push('ALL PRIVILEGES');
      continue;
    }

    for (const privilege of privilegesText.split(',')) {
      const name = privilege.replace(/\(.*\)/g, '').trim().toUpperCase();
      if (name && !ALLOWED_PRIVILEGES.has(name)) {
        offending.push(name);
      }
    }
  }

  return { ok: offending.length === 0, offending: Array.from(new Set(offending)) };
}

function tableKey(schema: string, name: string): string {
  return `${schema}\u0000${name}`;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rawQuery(connection: RawConnection, sql: string, values?: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.query(sql, values, (error) => (error ? reject(error) : resolve()));
  });
}

export class MysqlAdapter implements EngineAdapter {
  private metadata: PromiseConnection | null = null;
  private streaming: RawConnection | null = null;

  constructor(private readonly connection: StoredConnection) {}

  private options(): ConnectionOptions {
    return {
      host: this.connection.host ?? 'localhost',
      port: this.connection.port ?? 3306,
      user: this.connection.username ?? undefined,
      password: this.connection.password ?? undefined,
      database: this.connection.database ?? undefined,
      ssl: this.connection.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: LIMITS.connectTimeoutMs,
      multipleStatements: false,
      dateStrings: true,
    };
  }

  private async openMetadata(): Promise<PromiseConnection> {
    if (this.metadata) return this.metadata;
    if (!this.connection.host) {
      throw new ConnectionProbeError('No MySQL host was provided.');
    }

    let connection: PromiseConnection;
    try {
      connection = await createPromiseConnection(this.options());
      await connection.query('SET SESSION TRANSACTION READ ONLY');
      await setStatementTimeout(connection, LIMITS.statementTimeoutMs);
    } catch (error) {
      throw new ConnectionProbeError(describeError(error, 'Could not connect to MySQL.'));
    }

    this.metadata = connection;
    return connection;
  }

  async probeReadOnly(): Promise<ReadOnlyReport> {
    const connection = await this.openMetadata();
    const checks: ReadOnlyCheck[] = [];

    try {
      const [identityRows] = await connection.query<RowDataPacket[]>(
        'SELECT CURRENT_USER() AS user, VERSION() AS version',
      );
      const identity = identityRows[0] ?? {};
      checks.push({
        label: 'Authenticated',
        ok: true,
        detail: `${String(identity.user ?? 'unknown user')} — ${String(identity.version ?? 'MySQL')}`,
      });
    } catch (error) {
      checks.push({
        label: 'Authenticated',
        ok: false,
        detail: describeError(error, 'Could not read the current MySQL user.'),
      });
    }

    try {
      const [grantRows] = await connection.query<RowDataPacket[]>('SHOW GRANTS');
      const lines = grantRows
        .map((row) => Object.values(row)[0])
        .filter((value): value is string => typeof value === 'string');
      if (lines.length === 0) {
        checks.push({
          label: 'Only read privileges are granted',
          ok: false,
          detail: 'MySQL did not return any grant information, so write access cannot be ruled out.',
        });
      } else {
        const analysis = analyzeGrants(lines);
        checks.push({
          label: 'Only read privileges are granted',
          ok: analysis.ok,
          detail: analysis.ok
            ? 'SHOW GRANTS lists only SELECT / SHOW VIEW / USAGE privileges.'
            : `SHOW GRANTS lists privileges that can modify data or structure: ${analysis.offending.join(', ')}.`,
        });
      }
    } catch (error) {
      checks.push({
        label: 'Only read privileges are granted',
        ok: false,
        detail: describeError(error, 'Could not read MySQL grants.'),
      });
    }

    const readOnly = await readTransactionReadOnly(connection);
    checks.push({
      label: 'Read-only session enforced',
      ok: readOnly === true,
      detail: readOnly === true
        ? 'Every transaction on this session is READ ONLY, so the server rejects writes.'
        : 'MySQL did not confirm that the session is read-only.',
    });

    return {
      verdict: checks.every((check) => check.ok) ? 'read-only' : 'writable',
      engine: 'mysql',
      checks,
      checkedAt: new Date().toISOString(),
    };
  }

  async introspect(limits: SamplingLimits, onProgress?: (message: string) => void): Promise<RawSchema> {
    const connection = await this.openMetadata();
    onProgress?.('Reading the MySQL catalog');

    const [tableRows] = await connection.query<RowDataPacket[]>(
      `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, TABLE_TYPE AS tableType, TABLE_ROWS AS rowEstimate
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
       ORDER BY TABLE_NAME
       LIMIT ?`,
      [limits.maxTables + 1],
    );

    const truncated = tableRows.length > limits.maxTables;
    const selected = tableRows.slice(0, limits.maxTables);
    const selectedKeys = new Set(selected.map((row) => tableKey(String(row.schema), String(row.name))));

    const [columnRows] = await connection.query<RowDataPacket[]>(
      `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, COLUMN_NAME AS columnName,
              COLUMN_TYPE AS dataType, IS_NULLABLE AS isNullable, COLUMN_KEY AS columnKey
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    );

    const columnsByTable = new Map<string, RawColumn[]>();
    for (const row of columnRows) {
      const key = tableKey(String(row.schema), String(row.name));
      if (!selectedKeys.has(key)) continue;
      const list = columnsByTable.get(key) ?? [];
      list.push({
        name: String(row.columnName),
        dataType: String(row.dataType),
        nullable: String(row.isNullable).toUpperCase() === 'YES',
        primaryKey: String(row.columnKey).toUpperCase() === 'PRI',
        references: null,
      });
      columnsByTable.set(key, list);
    }

    const [foreignRows] = await connection.query<RowDataPacket[]>(
      `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, COLUMN_NAME AS columnName,
              REFERENCED_TABLE_NAME AS foreignTable, REFERENCED_COLUMN_NAME AS foreignColumn
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );

    const references = new Map<string, Map<string, { table: string; column: string }>>();
    for (const row of foreignRows) {
      const key = tableKey(String(row.schema), String(row.name));
      if (!selectedKeys.has(key)) continue;
      const map = references.get(key) ?? new Map();
      if (!map.has(String(row.columnName))) {
        map.set(String(row.columnName), {
          table: String(row.foreignTable),
          column: String(row.foreignColumn),
        });
      }
      references.set(key, map);
    }

    for (const [key, list] of columnsByTable) {
      const map = references.get(key);
      if (!map) continue;
      for (const column of list) {
        column.references = map.get(column.name) ?? null;
      }
    }

    const tables: RawTable[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const relation = selected[index];
      const schema = String(relation.schema);
      const name = String(relation.name);
      onProgress?.(`Sampling ${name} (${index + 1}/${selected.length})`);

      const key = tableKey(schema, name);
      const table: RawTable = {
        schema,
        name,
        rowCount: toNumber(relation.rowEstimate),
        columns: columnsByTable.get(key) ?? [],
        sampleColumns: (columnsByTable.get(key) ?? []).map((column) => column.name),
        sampleRows: [],
      };

      try {
        const [sampleRows, fields] = await connection.query<RowDataPacket[]>({
          sql: `SELECT * FROM ${tableRef('mysql', schema, name)} LIMIT ?`,
          values: [limits.sampleRows],
          timeout: LIMITS.sampleTimeoutMs,
        });
        table.sampleColumns = fields.map((field) => field.name);
        table.sampleRows = sampleRows.map((row) =>
          normalizeRow(fields.map((field) => row[field.name]), limits.maxCellChars),
        );
      } catch {
        // Skip tables the role cannot read; the schema and columns remain.
      }

      tables.push(table);
    }

    return { tables, truncated };
  }

  async runSelect(sql: string, options: RunOptions): Promise<RunOutput> {
    const statement = assertReadOnlySql(sql);
    const started = Date.now();
    const connection = await this.openStreaming(options.timeoutMs);

    let columns: string[] = [];
    let rowCount = 0;
    let truncated = false;

    try {
      await rawQuery(connection, 'START TRANSACTION READ ONLY');

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            connection.destroy();
            reject(error);
          } else {
            resolve();
          }
        };

        const timer = setTimeout(() => {
          connection.destroy();
          finish(new Error(`The query timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`));
        }, options.timeoutMs);

        const query = connection.query({ sql: statement, timeout: options.timeoutMs, rowsAsArray: true });

        query.on('fields', (fields: FieldPacket[] | FieldPacket) => {
          const list = Array.isArray(fields) ? fields : [fields];
          columns = list.map((field) => field.name);
        });
        query.on('result', (row: unknown) => {
          if (rowCount >= options.maxRows) {
            truncated = true;
            connection.destroy();
            finish();
            return;
          }
          options.onRow?.(normalizeRow(Array.isArray(row) ? row : [row]));
          rowCount += 1;
        });
        query.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
        query.on('end', () => finish());
      });
    } finally {
      try {
        await rawQuery(connection, 'ROLLBACK');
      } catch {
        // The connection may already be destroyed after a timeout or truncation.
      }
      try {
        connection.end();
      } catch {
        // Already closed.
      }
      this.streaming = null;
    }

    return { columns, rowCount, truncated, durationMs: Date.now() - started };
  }

  async close(): Promise<void> {
    if (this.metadata) {
      const connection = this.metadata;
      this.metadata = null;
      await connection.end().catch(() => undefined);
    }
    if (this.streaming) {
      this.streaming.destroy();
      this.streaming = null;
    }
  }

  private async openStreaming(timeoutMs: number): Promise<RawConnection> {
    if (this.streaming) return this.streaming;
    if (!this.connection.host) {
      throw new ConnectionProbeError('No MySQL host was provided.');
    }

    const connection = mysql.createConnection({ ...this.options(), rowsAsArray: true });
    try {
      await new Promise<void>((resolve, reject) => {
        connection.connect((error) => (error ? reject(error) : resolve()));
      });
      await rawQuery(connection, 'SET SESSION TRANSACTION READ ONLY');
      await setRawStatementTimeout(connection, timeoutMs);
    } catch (error) {
      connection.destroy();
      throw new ConnectionProbeError(describeError(error, 'Could not connect to MySQL.'));
    }

    this.streaming = connection;
    return connection;
  }
}

async function setStatementTimeout(connection: PromiseConnection, ms: number): Promise<void> {
  try {
    await connection.query('SET SESSION max_execution_time = ?', [ms]);
    return;
  } catch {
    // MariaDB uses max_statement_time in seconds.
  }
  try {
    await connection.query('SET SESSION max_statement_time = ?', [ms / 1000]);
  } catch {
    // Driver-level timeouts still apply.
  }
}

async function setRawStatementTimeout(connection: RawConnection, ms: number): Promise<void> {
  try {
    await rawQuery(connection, `SET SESSION max_execution_time = ${Math.floor(ms)}`);
    return;
  } catch {
    // MariaDB uses max_statement_time in seconds.
  }
  try {
    await rawQuery(connection, `SET SESSION max_statement_time = ${Math.floor(ms / 1000)}`);
  } catch {
    // Driver-level timeouts still apply.
  }
}

async function readTransactionReadOnly(connection: PromiseConnection): Promise<boolean | null> {
  for (const variable of ['@@session.transaction_read_only', '@@session.tx_read_only']) {
    try {
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT ${variable} AS ro`);
      const value = rows[0]?.ro;
      return Number(value) === 1;
    } catch {
      // Try the next variable name.
    }
  }
  return null;
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
