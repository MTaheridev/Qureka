import path from 'node:path';
import type { CellValue } from '../../shared/ipc';

export function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

export function csvCell(value: CellValue): string {
  let text = cellText(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeFileStem(value: string, fallback = 'report'): string {
  const stem = value
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return stem || fallback;
}

export function defaultFileName(parts: string[], extension: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const stem = parts
    .map((part) => safeFileStem(part, ''))
    .filter(Boolean)
    .join('-');
  return `${stem || 'easyreporter'}-${stamp}.${extension}`;
}

export function resolveSavePath(directory: string, fileName: string): string {
  return path.join(directory, fileName);
}
