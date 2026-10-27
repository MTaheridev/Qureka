import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { CellValue, RunView } from '../../shared/ipc';
import { runsDirectory } from '../db/paths';
import { LIMITS } from '../engines/constants';
import { loadEngineContext } from './connections';

export interface CapturedRun {
  columns: string[];
  displayRows: CellValue[][];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
  resultPath: string;
}

export async function captureRun(
  connectionId: string,
  sql: string,
  options: { maxRows?: number; timeoutMs?: number } = {},
): Promise<CapturedRun> {
  const { adapter } = await loadEngineContext(connectionId);
  const directory = runsDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  const resultPath = path.join(directory, `${randomUUID()}.jsonl`);

  let fd: number | null = null;
  const displayRows: CellValue[][] = [];

  try {
    fd = fs.openSync(resultPath, 'w');
    const result = await adapter.runSelect(sql, {
      maxRows: options.maxRows ?? LIMITS.exportRows,
      timeoutMs: options.timeoutMs ?? LIMITS.statementTimeoutMs,
      onRow: (row) => {
        if (fd !== null) {
          fs.writeSync(fd, `${JSON.stringify(row)}\n`);
        }
        if (displayRows.length < LIMITS.displayRows) {
          displayRows.push(row);
        }
      },
    });

    return {
      columns: result.columns,
      displayRows,
      rowCount: result.rowCount,
      durationMs: result.durationMs,
      truncated: result.truncated,
      resultPath,
    };
  } catch (error) {
    await fs.promises.rm(resultPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failures; the run outcome is already known.
      }
    }
    await adapter.close().catch(() => undefined);
  }
}

export function toRunView(row: {
  id: string;
  columnsJson: string;
  displayRowsJson: string;
  rowCount: number;
  durationMs: number;
  truncated: boolean;
  resultPath: string | null;
}): RunView {
  let columns: string[] = [];
  let rows: CellValue[][] = [];
  try {
    columns = JSON.parse(row.columnsJson) as string[];
  } catch {
    columns = [];
  }
  try {
    rows = JSON.parse(row.displayRowsJson) as CellValue[][];
  } catch {
    rows = [];
  }

  return {
    id: row.id,
    columns,
    rows,
    rowCount: row.rowCount,
    durationMs: row.durationMs,
    truncated: row.truncated,
    canExport: Boolean(row.resultPath) && columns.length > 0,
  };
}

export async function* readRunRows(resultPath: string): AsyncGenerator<CellValue[]> {
  const stream = fs.createReadStream(resultPath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      yield JSON.parse(line) as CellValue[];
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function removeRunFile(resultPath: string | null): Promise<void> {
  if (!resultPath) return;
  await fs.promises.rm(resultPath, { force: true }).catch(() => undefined);
}
