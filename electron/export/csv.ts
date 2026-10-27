import fs from 'node:fs';
import type { CellValue } from '../../shared/ipc';
import { csvCell } from './format';

export async function writeCsv(
  filePath: string,
  columns: string[],
  rows: AsyncIterable<CellValue[]>,
  onProgress?: (message: string) => void,
): Promise<number> {
  const handle = await fs.promises.open(filePath, 'w');
  let count = 0;
  let buffer = '';

  try {
    const header = columns.map((column, index) => csvCell(column || `Column ${index + 1}`)).join(',');
    await handle.write(`\uFEFF${header}\r\n`);

    for await (const row of rows) {
      buffer += `${row.map(csvCell).join(',')}\r\n`;
      count += 1;
      if (buffer.length > 1_000_000) {
        await handle.write(buffer);
        buffer = '';
      }
      if (count % 1_000 === 0) {
        onProgress?.(`Writing ${count.toLocaleString()} rows`);
      }
    }

    if (buffer) {
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }

  return count;
}
