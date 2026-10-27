import { LIMITS } from './constants';
import { SqlGuardError } from './types';

/**
 * Words that can never appear unquoted in a statement we are willing to run.
 * Blocking them everywhere (not just at the start) also blocks writable CTEs,
 * `SELECT ... INTO`, `FOR UPDATE` and stacked statements hidden in subqueries.
 */
const FORBIDDEN_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'CALL',
  'EXEC',
  'EXECUTE',
  'COPY',
  'LOAD',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'VACUUM',
  'REINDEX',
  'ANALYZE',
  'SET',
  'RESET',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'LOCK',
  'UNLOCK',
  'INTO',
  'OUTFILE',
  'DUMPFILE',
  'SHUTDOWN',
  'KILL',
  'DISCARD',
  'LISTEN',
  'NOTIFY',
  'PREPARE',
  'DEALLOCATE',
  'DECLARE',
  'OPENROWSET',
  'OPENQUERY',
  'OPENDATASOURCE',
]);

interface ScanToken {
  kind: 'word' | 'semicolon';
  value?: string;
}

function skipQuoted(text: string, start: number, quote: string, doubledEscape: boolean): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === quote) {
      if (doubledEscape && text[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    if (text[index] === '\\' && quote === "'") {
      index += 2;
      continue;
    }
    index += 1;
  }
  return text.length;
}

function skipBracketQuote(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === ']') {
      if (text[index + 1] === ']') {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function skipBlockComment(text: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < text.length && depth > 0) {
    if (text[index] === '/' && text[index + 1] === '*') {
      depth += 1;
      index += 2;
    } else if (text[index] === '*' && text[index + 1] === '/') {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

function dollarQuoteTag(text: string, start: number): string | null {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(start));
  return match ? match[0] : null;
}

function findDollarQuoteEnd(text: string, start: number, tag: string): number {
  const end = text.indexOf(tag, start + tag.length);
  return end === -1 ? text.length : end + tag.length;
}

function scan(sql: string): ScanToken[] {
  const tokens: ScanToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && sql[index + 1] === '*') {
      index = skipBlockComment(sql, index);
      continue;
    }

    if (char === "'") {
      index = skipQuoted(sql, index, "'", true);
      continue;
    }

    if (char === '"') {
      index = skipQuoted(sql, index, '"', true);
      continue;
    }

    if (char === '`') {
      index = skipQuoted(sql, index, '`', true);
      continue;
    }

    if (char === '[') {
      index = skipBracketQuote(sql, index);
      continue;
    }

    if (char === '$') {
      const tag = dollarQuoteTag(sql, index);
      if (tag) {
        index = findDollarQuoteEnd(sql, index, tag);
        continue;
      }
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      tokens.push({ kind: 'word', value: sql.slice(index, end).toUpperCase() });
      index = end;
      continue;
    }

    if (char === ';') {
      tokens.push({ kind: 'semicolon' });
      index += 1;
      continue;
    }

    index += 1;
  }

  return tokens;
}

/**
 * Validates that `sql` is a single SELECT/WITH statement and returns it without
 * a trailing semicolon. Every user or AI generated statement must pass through
 * here before it reaches a database driver.
 */
export function assertReadOnlySql(sql: string): string {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new SqlGuardError('The SQL statement is empty.');
  }

  const text = sql.trim();
  if (text.length > LIMITS.maxSqlLength) {
    throw new SqlGuardError('The SQL statement is too long.');
  }

  const tokens = scan(text);
  if (tokens.length === 0) {
    throw new SqlGuardError('The SQL statement is empty.');
  }

  const semicolons = tokens.filter((token) => token.kind === 'semicolon').length;
  const endsWithSemicolon = tokens[tokens.length - 1]?.kind === 'semicolon';
  if (semicolons > (endsWithSemicolon ? 1 : 0)) {
    throw new SqlGuardError('Only one SQL statement can be executed at a time.');
  }

  const words = tokens.filter((token): token is ScanToken & { value: string } => token.kind === 'word');
  if (words.length === 0) {
    throw new SqlGuardError('The SQL statement is empty.');
  }

  const first = words[0].value;
  if (first !== 'SELECT' && first !== 'WITH') {
    throw new SqlGuardError('Only SELECT queries are allowed.');
  }

  const hasSelect = words.some((token) => token.value === 'SELECT');
  if (!hasSelect) {
    throw new SqlGuardError('Only SELECT queries are allowed.');
  }

  for (const token of words) {
    if (FORBIDDEN_KEYWORDS.has(token.value)) {
      throw new SqlGuardError(`"${token.value}" is not allowed because queries must be read-only.`);
    }
  }

  const cleaned = endsWithSemicolon ? text.slice(0, -1).trimEnd() : text;
  assertNoSensitiveProjection(cleaned);
  return cleaned;
}

/**
 * Column / alias names that usually hold secrets or high-risk PII. Matching is
 * conservative: we only block when the selected expression looks like that field.
 */
const SENSITIVE_NAME =
  /^(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|ssh[_-]?key|ssn|social[_-]?security|credit[_-]?card|card[_-]?number|cvv|cvc|iban|routing[_-]?number|session[_-]?id|cookie)$/i;

function assertNoSensitiveProjection(sql: string): void {
  // Strip string literals so values like 'password' in WHERE don't trip the check.
  const withoutStrings = sql.replace(/'(?:''|[^'])*'/g, "''").replace(/"(?:""|[^"])*"/g, '""');
  const selectMatch = /\bSELECT\b([\s\S]*?)\bFROM\b/i.exec(withoutStrings);
  const projection = selectMatch?.[1] ?? withoutStrings;
  const identifiers = projection.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  for (const name of identifiers) {
    const upper = name.toUpperCase();
    if (
      upper === 'SELECT' ||
      upper === 'AS' ||
      upper === 'DISTINCT' ||
      upper === 'CASE' ||
      upper === 'WHEN' ||
      upper === 'THEN' ||
      upper === 'ELSE' ||
      upper === 'END' ||
      upper === 'NULL' ||
      upper === 'TRUE' ||
      upper === 'FALSE' ||
      upper === 'AND' ||
      upper === 'OR' ||
      upper === 'NOT'
    ) {
      continue;
    }
    if (SENSITIVE_NAME.test(name)) {
      throw new SqlGuardError(
        `"${name}" looks like sensitive data and cannot be selected. Ask for counts or non-secret attributes instead.`,
      );
    }
  }
}
