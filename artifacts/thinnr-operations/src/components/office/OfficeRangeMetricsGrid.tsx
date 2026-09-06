/**
 * Live office metrics for a date range as a grid of drill-through stats.
 *
 * Shared by the HQ account detail (office root = the drill-in) and the office
 * Analytics page (office root = "/"). Renders explicit loading, error, and
 * unavailable states — a range that predates the office's first patient says
 * so instead of showing zeroes.
 */
import { Link } from 'wouter';
import { AlertCircle } from 'lucide-react';
import type { OfficeAnalyticsResult } from '@workspace/api-client-react';
import { MICRO_LABEL } from '@/components/patient/heritage';
import {
  OFFICE_METRIC_COLUMNS,
  drillHref,
  formatMetric,
  metricValue,
  unavailableReason,
} from '@/lib/office-analytics';

export type OfficeMetricsStatus = 'loading' | 'error' | 'ready';

interface OfficeRangeMetricsGridProps {
  status: OfficeMetricsStatus;
  result: OfficeAnalyticsResult | null | undefined;
  rangeEnd: string;
  /** '' for the office's own app, or /admin/accounts/:id/office for the HQ drill-in. */
  officeRoot: string;
  onRetry?: () => void;
  testIdPrefix?: string;
  className?: string;
}

export function OfficeRangeMetricsGrid({
  status,
  result,
  rangeEnd,
  officeRoot,
  onRetry,
  testIdPrefix = 'office-metric',
  className,
}: OfficeRangeMetricsGridProps) {
  if (status === 'loading') {
    return (
      <p className={`px-5 py-6 text-xs text-muted-foreground ${className ?? ''}`} data-testid={`${testIdPrefix}-loading`} aria-live="polite">
        Loading live office metrics…
      </p>
    );
  }
  if (status === 'error' || !result) {
    return (
      <div className={`m-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive ${className ?? ''}`} role="alert" data-testid={`${testIdPrefix}-error`}>
        <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>
          Live office metrics could not be loaded.{' '}
          {onRetry && <button type="button" className="underline" onClick={onRetry}>Try again</button>}
        </span>
      </div>
    );
  }
  if (!result.available || !result.metrics) {
    return (
      <div className={`px-5 py-6 ${className ?? ''}`} data-testid={`${testIdPrefix}-unavailable`}>
        <p className="inline-block rounded border border-border bg-secondary px-2 py-1 text-[10px] font-bold uppercase tracking-[.08em] text-muted-foreground">
          Unavailable for this range
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{unavailableReason(result.firstPatientDate, rangeEnd)}</p>
      </div>
    );
  }

  const metrics = result.metrics;
  return (
    <div className={`grid grid-cols-2 gap-2.5 px-4 py-4 sm:grid-cols-4 ${className ?? ''}`} data-testid={`${testIdPrefix}-grid`}>
      {OFFICE_METRIC_COLUMNS.map((column) => {
        const value = metricValue(metrics, column.key);
        const text = formatMetric(column.key, value);
        const href = drillHref(officeRoot, column.drill);
        return (
          <Link
            key={column.key}
            href={href}
            title={column.help}
            aria-label={`${column.label}: ${text}. ${column.help}. Open the matching list`}
            className="block rounded-md border border-border bg-paper-alt px-3.5 py-3 transition hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`${testIdPrefix}-${column.key}`}
          >
            <p className={MICRO_LABEL}>{column.label}</p>
            <p className="mt-1 font-serif text-lg font-bold leading-none tracking-[-.01em] text-navy tabular-nums">{text}</p>
          </Link>
        );
      })}
    </div>
  );
}
