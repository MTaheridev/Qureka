import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import type { CellValue } from '../../shared/ipc';
import { exportsDirectory } from '../db/paths';
import { cellText, escapeHtml } from './format';

export const PDF_ROW_CAP = 5_000;

function htmlDocument(input: {
  title: string;
  subtitle: string;
  columns: string[];
  rows: string[];
  note: string | null;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(input.title)}</title>
<style>
  :root { color-scheme: light; }
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
    color: #111827;
    font-size: 9px;
  }
  header { margin-bottom: 10px; }
  h1 { font-size: 16px; margin: 0 0 3px; font-weight: 600; }
  .meta { color: #6b7280; font-size: 9px; }
  .note { margin-top: 4px; color: #92400e; font-size: 9px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead { display: table-header-group; }
  th, td {
    border: 1px solid #d1d5db;
    padding: 4px 6px;
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  th { background: #f3f4f6; font-weight: 600; }
  tbody tr:nth-child(even) td { background: #fafafa; }
  tr { page-break-inside: avoid; }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(input.title)}</h1>
    <div class="meta">${escapeHtml(input.subtitle)}</div>
    ${input.note ? `<div class="note">${escapeHtml(input.note)}</div>` : ''}
  </header>
  <table>
    <thead>
      <tr>${input.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr>
    </thead>
    <tbody>
      ${input.rows.join('')}
    </tbody>
  </table>
</body>
</html>`;
}

export async function writePdf(input: {
  filePath: string;
  title: string;
  columns: string[];
  rows: AsyncIterable<CellValue[]>;
  totalRows: number;
  alreadyTruncated: boolean;
  onProgress?: (message: string) => void;
}): Promise<{ rows: number; truncated: boolean }> {
  const rowMarkup: string[] = [];
  let count = 0;
  let capped = false;

  for await (const row of input.rows) {
    if (count >= PDF_ROW_CAP) {
      capped = true;
      break;
    }
    rowMarkup.push(
      `<tr>${input.columns
        .map((_, index) => `<td>${escapeHtml(cellText(row[index]))}</td>`)
        .join('')}</tr>`,
    );
    count += 1;
    if (count % 500 === 0) {
      input.onProgress?.(`Preparing ${count.toLocaleString()} rows for the PDF`);
    }
  }

  input.onProgress?.('Rendering the PDF');
  const truncated = input.alreadyTruncated || capped;
  const note = capped
    ? `Only the first ${PDF_ROW_CAP.toLocaleString()} rows are included in this PDF. Use Excel or CSV for the full result.`
    : input.alreadyTruncated
      ? 'The query exceeded the capture limit; this file contains the captured rows only.'
      : null;

  const html = htmlDocument({
    title: input.title,
    subtitle: `${input.totalRows.toLocaleString()} row${input.totalRows === 1 ? '' : 's'} · generated ${new Date().toLocaleString()}`,
    columns: input.columns,
    rows: rowMarkup,
    note,
  });

  const directory = exportsDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  const htmlPath = path.join(directory, `.pdf-${randomUUID()}.html`);
  await fs.promises.writeFile(htmlPath, html, 'utf8');

  const window = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    },
  });

  try {
    await window.loadFile(htmlPath);
    const pdf = await window.webContents.printToPDF({
      printBackground: true,
      landscape: true,
      pageSize: 'A4',
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    await fs.promises.writeFile(input.filePath, pdf);
  } finally {
    window.destroy();
    await fs.promises.rm(htmlPath, { force: true }).catch(() => undefined);
  }

  return { rows: count, truncated };
}
