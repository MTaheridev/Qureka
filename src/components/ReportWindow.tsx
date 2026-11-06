'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CellValue, ReportData, ReportQuery } from '../../shared/ipc';
import { applyReportQuery, emptyReportQuery } from '../../shared/report-query';
import { errorMessage, getApi } from '@/lib/api';
import { hasPersian, resultDir } from '@/lib/script';
import { useSettings } from '@/lib/settings';
import { ErrorBanner, Icon, Spinner } from './ui';

const PAGE_SIZE = 80;

function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return String(value);
}

export function ReportWindow() {
  const { dir, tr } = useSettings();
  const [runId, setRunId] = useState<string | null>(null);
  const [data, setData] = useState<ReportData | null>(null);
  const [query, setQuery] = useState<ReportQuery | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'xlsx' | 'pdf' | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('runId');
    setRunId(id);
    if (!id) {
      setLoading(false);
      setError(tr('reportMissing'));
    }
  }, [tr]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const next = await getApi().chat.reportData(runId);
        if (cancelled) return;
        setData(next);
        setQuery(next ? emptyReportQuery(next.columns.length) : null);
        setError(next ? null : tr('reportMissing'));
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, tr]);

  const filtered = useMemo(() => {
    if (!data || !query) return [];
    return applyReportQuery(data.rows, query);
  }, [data, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const tableDirection = resultDir(data?.columns ?? [], dir);

  function updateQuery(patch: Partial<ReportQuery>) {
    setQuery((current) => (current ? { ...current, ...patch } : current));
    setPage(0);
  }

  function toggleSort(index: number) {
    setQuery((current) => {
      if (!current) return current;
      const same = current.sortColumn === index;
      return {
        ...current,
        sortColumn: index,
        sortDirection: same && current.sortDirection === 'asc' ? 'desc' : 'asc',
      };
    });
    setPage(0);
  }

  async function exportFiltered(format: 'xlsx' | 'pdf') {
    if (!runId || !query) return;
    setExporting(format);
    setExportNote(null);
    try {
      const result = await getApi().exports.filtered(runId, format, query);
      if (result) setExportNote(result.path);
    } catch (exportError) {
      setError(errorMessage(exportError));
    } finally {
      setExporting(null);
    }
  }

  const title = data?.title || tr('viewReport');

  return (
    <main className="report-app" dir={dir}>
      <header className="report-toolbar">
        <div>
          <h1 className={hasPersian(title) ? 'cell-fa' : undefined}>{title}</h1>
          {data ? (
            <p className="muted small">
              {tr('filteredCount', {
                shown: filtered.length.toLocaleString(),
                total: data.rows.length.toLocaleString(),
              })}
            </p>
          ) : null}
        </div>
        <input
          className="report-search"
          value={query?.search ?? ''}
          onChange={(event) => updateQuery({ search: event.target.value })}
          placeholder={tr('searchAll')}
          disabled={!data}
        />
        <div className="export-actions">
          <button
            type="button"
            className="button small"
            onClick={() => void exportFiltered('xlsx')}
            disabled={!data || exporting !== null}
          >
            {exporting === 'xlsx' ? <Spinner /> : <Icon name="download" size={14} />} {tr('exportExcel')}
          </button>
          <button
            type="button"
            className="button small"
            onClick={() => void exportFiltered('pdf')}
            disabled={!data || exporting !== null}
          >
            {exporting === 'pdf' ? <Spinner /> : <Icon name="download" size={14} />} {tr('exportPdf')}
          </button>
        </div>
      </header>

      {error ? <ErrorBanner message={error} /> : null}
      {exportNote ? (
        <div className="banner banner-ok">
          <Icon name="check" size={15} />
          <span>{exportNote}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="loading-row">
          <Spinner label={tr('loading')} />
        </div>
      ) : data && data.columns.length > 0 ? (
        <div className="report-sheet result">
          <div className="grid-scroll">
            <table className={`data-grid ${tableDirection === 'rtl' ? 'rtl-grid' : ''}`} dir={tableDirection}>
              <thead>
                <tr>
                  {data.columns.map((column, index) => {
                    const active = query?.sortColumn === index;
                    const mark = active ? (query?.sortDirection === 'desc' ? ' ↓' : ' ↑') : '';
                    return (
                      <th key={`${column}-${index}`} className={hasPersian(column) ? 'cell-fa' : undefined}>
                        <button type="button" className="sort-button" onClick={() => toggleSort(index)}>
                          {column}
                          {mark}
                        </button>
                        <input
                          value={query?.filters[index] ?? ''}
                          onChange={(event) => {
                            const filters = [...(query?.filters ?? [])];
                            filters[index] = event.target.value;
                            updateQuery({ filters });
                          }}
                          placeholder={tr('columnFilter')}
                          aria-label={`${tr('columnFilter')} ${column}`}
                        />
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visible.map((row, rowIndex) => (
                  <tr key={`${safePage}-${rowIndex}`}>
                    {data.columns.map((column, columnIndex) => {
                      const value = row[columnIndex];
                      const text = cellText(value);
                      return (
                        <td
                          key={`${column}-${columnIndex}`}
                          className={value === null || value === undefined ? 'cell-null' : hasPersian(text) ? 'cell-fa' : ''}
                        >
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 ? <p className="muted result-note">{tr('noMatches')}</p> : null}
        </div>
      ) : null}

      {data && filtered.length > PAGE_SIZE ? (
        <div className="report-pager">
          <span className="muted small">
            {tr('reportRange', {
              from: (safePage * PAGE_SIZE + 1).toLocaleString(),
              to: Math.min(filtered.length, (safePage + 1) * PAGE_SIZE).toLocaleString(),
              count: filtered.length.toLocaleString(),
            })}
          </span>
          <div className="export-actions">
            <button
              type="button"
              className="button small"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={safePage === 0}
            >
              {tr('prevPage')}
            </button>
            <button
              type="button"
              className="button small"
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={safePage >= pageCount - 1}
            >
              {tr('nextPage')}
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
