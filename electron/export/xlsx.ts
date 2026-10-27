import ExcelJS from 'exceljs';
import type { CellValue } from '../../shared/ipc';

const SAMPLE_ROWS = 200;

function columnWidth(name: string, sampleRows: CellValue[][], index: number): number {
  let width = Math.max(10, name.length + 2);
  for (const row of sampleRows) {
    const value = row[index];
    if (value === null || value === undefined) continue;
    width = Math.max(width, String(value).length + 2);
  }
  return Math.min(50, width);
}

function toExcelValue(value: CellValue | undefined): CellValue {
  return value === undefined ? null : value;
}

export async function writeXlsx(
  filePath: string,
  columns: string[],
  rows: AsyncIterable<CellValue[]>,
  onProgress?: (message: string) => void,
): Promise<number> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: true,
    useSharedStrings: false,
  });

  const sheet = workbook.addWorksheet('Report', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const iterator = rows[Symbol.asyncIterator]();
  const buffered: CellValue[][] = [];
  while (buffered.length < SAMPLE_ROWS) {
    const next = await iterator.next();
    if (next.done) break;
    buffered.push(next.value);
  }

  const headers = columns.map((column, index) => column || `Column ${index + 1}`);
  sheet.columns = headers.map((name, index) => ({
    key: `c${index}`,
    width: columnWidth(name, buffered, index),
  }));

  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.commit();

  let count = 0;
  const addRow = (row: CellValue[]) => {
    sheet.addRow(row.map(toExcelValue)).commit();
    count += 1;
    if (count % 1_000 === 0) {
      onProgress?.(`Writing ${count.toLocaleString()} rows`);
    }
  };

  for (const row of buffered) addRow(row);

  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    addRow(next.value);
  }

  sheet.commit();
  await workbook.commit();
  return count;
}
