import type { CellValue, ReportQuery } from './ipc';

export type { ReportQuery };

export function emptyReportQuery(columnCount: number): ReportQuery {
  return {
    search: '',
    filters: Array.from({ length: columnCount }, () => ''),
    sortColumn: null,
    sortDirection: 'asc',
  };
}

export function cleanReportQuery(input: Partial<ReportQuery> | null | undefined, columnCount: number): ReportQuery {
  const filters = Array.from({ length: columnCount }, (_, index) =>
    String(input?.filters?.[index] ?? '').slice(0, 200),
  );
  const sortColumn =
    typeof input?.sortColumn === 'number' &&
    Number.isInteger(input.sortColumn) &&
    input.sortColumn >= 0 &&
    input.sortColumn < columnCount
      ? input.sortColumn
      : null;
  return {
    search: String(input?.search ?? '').slice(0, 200),
    filters,
    sortColumn,
    sortDirection: input?.sortDirection === 'desc' ? 'desc' : 'asc',
  };
}

function cellString(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function compareCells(left: CellValue | undefined, right: CellValue | undefined): number {
  const aEmpty = left === null || left === undefined || left === '';
  const bEmpty = right === null || right === undefined || right === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return cellString(left).localeCompare(cellString(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/** Keeps rows that match the supersearch and every column filter, then sorts them. */
export function applyReportQuery(rows: CellValue[][], query: ReportQuery): CellValue[][] {
  const search = query.search.trim().toLowerCase();
  const filters = query.filters.map((filter) => filter.trim().toLowerCase());
  const matched = rows.filter((row) => {
    if (search && !row.some((cell) => cellString(cell).toLowerCase().includes(search))) return false;
    for (let index = 0; index < filters.length; index += 1) {
      const filter = filters[index];
      if (!filter) continue;
      if (!cellString(row[index]).toLowerCase().includes(filter)) return false;
    }
    return true;
  });
  if (query.sortColumn === null) return matched;
  const index = query.sortColumn;
  const direction = query.sortDirection === 'desc' ? -1 : 1;
  return [...matched].sort((left, right) => direction * compareCells(left[index], right[index]));
}
