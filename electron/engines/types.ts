import type { CellValue, EngineId, ReadOnlyReport } from '../../shared/ipc';

export interface StoredConnection {
  id: string;
  engine: EngineId;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  password: string | null;
  filePath: string | null;
  ssl: boolean;
}

export interface RawColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  references: { table: string; column: string } | null;
}

export interface RawTable {
  schema: string;
  name: string;
  rowCount: number | null;
  columns: RawColumn[];
  sampleColumns: string[];
  sampleRows: CellValue[][];
}

export interface RawSchema {
  tables: RawTable[];
  truncated: boolean;
}

export interface RunOptions {
  maxRows: number;
  timeoutMs: number;
  onRow?: (row: CellValue[]) => void;
}

export interface RunOutput {
  columns: string[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

export interface SamplingLimits {
  maxTables: number;
  sampleRows: number;
  maxCellChars: number;
}

export interface EngineAdapter {
  probeReadOnly(): Promise<ReadOnlyReport>;
  introspect(limits: SamplingLimits, onProgress?: (message: string) => void): Promise<RawSchema>;
  runSelect(sql: string, options: RunOptions): Promise<RunOutput>;
  close(): Promise<void>;
}

export class SqlGuardError extends Error {}
export class ReadOnlyViolation extends Error {}
export class ConnectionProbeError extends Error {}
