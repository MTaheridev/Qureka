'use client';

import type { ReadOnlyReport } from '../../shared/ipc';
import { formatWhen } from '@/lib/format';
import { Badge, Icon } from './ui';

export function ReadOnlyPill({ report }: { report: ReadOnlyReport | null }) {
  if (!report) return <Badge tone="warn">Not verified</Badge>;
  return report.verdict === 'read-only' ? (
    <Badge tone="ok">
      <Icon name="lock" size={12} /> Read-only
    </Badge>
  ) : (
    <Badge tone="bad">Writable</Badge>
  );
}

export function ReadOnlyChecks({ report }: { report: ReadOnlyReport }) {
  const readOnly = report.verdict === 'read-only';
  return (
    <div className={`report ${readOnly ? 'report-ok' : 'report-bad'}`}>
      <div className="report-head">
        <span className="report-title">
          <Icon name={readOnly ? 'lock' : 'alert'} size={17} />
          {readOnly
            ? 'These credentials cannot modify the database'
            : 'These credentials can modify the database'}
        </span>
        <span className="muted small">checked {formatWhen(report.checkedAt)}</span>
      </div>
      <ul className="checks">
        {report.checks.map((check, index) => (
          <li key={`${check.label}-${index}`} className={check.ok ? 'check-ok' : 'check-bad'}>
            <Icon name={check.ok ? 'check' : 'alert'} size={14} />
            <div>
              <span className="check-label">{check.label}</span>
              <span className="check-detail">{check.detail}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
