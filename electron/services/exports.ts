import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import type { CellValue, ExportFormat, ExportResult } from '../../shared/ipc';
import { getPrisma } from '../db/client';
import { writeCsv } from '../export/csv';
import { defaultFileName } from '../export/format';
import { writePdf } from '../export/pdf';
import { writeXlsx } from '../export/xlsx';
import { readRunRows } from './runs';
import { getConnectionView, getSchemaSnapshot } from './connections';

const FORMAT_INFO: Record<ExportFormat, { extension: string; label: string }> = {
  csv: { extension: 'csv', label: 'CSV file' },
  xlsx: { extension: 'xlsx', label: 'Excel workbook' },
  pdf: { extension: 'pdf', label: 'PDF document' },
};

async function saveDialog(defaultName: string, format: ExportFormat): Promise<string | null> {
  const info = FORMAT_INFO[format];
  const directory = app.getPath('downloads');
  await fs.promises.mkdir(directory, { recursive: true }).catch(() => undefined);

  const options = {
    title: 'Export report',
    defaultPath: path.join(directory, defaultName),
    filters: [{ name: info.label, extensions: [info.extension] }],
    properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const],
  };

  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;

  const extension = `.${info.extension}`;
  return result.filePath.toLowerCase().endsWith(extension)
    ? result.filePath
    : `${result.filePath}${extension}`;
}

function parseColumns(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

export async function exportRun(
  runId: string,
  format: ExportFormat,
  onProgress?: (message: string) => void,
): Promise<ExportResult | null> {
  if (!FORMAT_INFO[format]) throw new Error('Unsupported export format.');

  const prisma = getPrisma();
  const run = await prisma.queryRun.findUnique({
    where: { id: runId },
    include: {
      message: {
        include: {
          conversation: {
            include: { connection: { select: { name: true } } },
          },
        },
      },
    },
  });

  if (!run) throw new Error('This result no longer exists.');
  if (!run.resultPath || !fs.existsSync(run.resultPath)) {
    throw new Error('The result data for this query is no longer available. Run the query again.');
  }

  const columns = parseColumns(run.columnsJson);
  if (columns.length === 0) {
    throw new Error('This result has no columns to export.');
  }

  const connectionName = run.message.conversation.connection.name;
  const title = run.message.conversation.title || 'Report';
  const info = FORMAT_INFO[format];

  onProgress?.('Choosing where to save the file');
  const filePath = await saveDialog(defaultFileName([connectionName, title], info.extension), format);
  if (!filePath) return null;

  const existed = fs.existsSync(filePath);

  try {
    if (format === 'csv') {
      onProgress?.('Writing CSV rows');
      const rows = await writeCsv(filePath, columns, readRunRows(run.resultPath), onProgress);
      return { path: filePath, format, rows, truncated: run.truncated };
    }

    if (format === 'xlsx') {
      onProgress?.('Writing Excel rows');
      const rows = await writeXlsx(filePath, columns, readRunRows(run.resultPath), onProgress);
      return { path: filePath, format, rows, truncated: run.truncated };
    }

    const result = await writePdf({
      filePath,
      title: `${connectionName} — ${title}`,
      columns,
      rows: readRunRows(run.resultPath),
      totalRows: run.rowCount,
      alreadyTruncated: run.truncated,
      onProgress,
    });
    return { path: filePath, format, rows: result.rows, truncated: result.truncated };
  } catch (error) {
    if (!existed) {
      await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export async function exportSchema(
  connectionId: string,
  onProgress?: (message: string) => void,
): Promise<ExportResult | null> {
  const [connection, snapshot] = await Promise.all([
    getConnectionView(connectionId),
    getSchemaSnapshot(connectionId),
  ]);
  if (!connection) throw new Error('This connection no longer exists.');
  if (!snapshot) throw new Error('The schema snapshot is missing. Reproof the connection first.');

  onProgress?.('Choosing where to save the schema');
  const filePath = await saveDialog(
    defaultFileName([connection.name, 'schema'], 'csv'),
    'csv',
  );
  if (!filePath) return null;

  const columns = [
    'schema',
    'table',
    'column',
    'data_type',
    'nullable',
    'primary_key',
    'references',
    'table_rows',
  ];

  async function* rows(): AsyncGenerator<CellValue[]> {
    for (const table of snapshot!.tables) {
      for (const column of table.columns) {
        yield [
          table.schema,
          table.name,
          column.name,
          column.dataType,
          column.nullable,
          column.primaryKey,
          column.references ? `${column.references.table}.${column.references.column}` : null,
          table.rowCount,
        ];
      }
    }
  }

  onProgress?.('Writing the schema');
  const rowCount = await writeCsv(filePath, columns, rows(), onProgress);
  return { path: filePath, format: 'csv', rows: rowCount, truncated: snapshot.truncated };
}
