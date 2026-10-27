export const LIMITS = {
  maxTables: 250,
  sampleRows: 10,
  sampleCellChars: 240,
  displayRows: 500,
  exportRows: 200_000,
  statementTimeoutMs: 30_000,
  sampleTimeoutMs: 15_000,
  connectTimeoutMs: 15_000,
  maxSqlLength: 20_000,
} as const;
