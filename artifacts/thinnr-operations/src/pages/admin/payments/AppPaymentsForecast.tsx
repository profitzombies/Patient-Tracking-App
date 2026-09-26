/**
 * The forward-looking half of App payments: every access charge expected in a
 * window, the revenue that adds up to (clearly an estimate), what is at risk,
 * what is already owed, and a month-by-month look at forecast against what
 * was actually collected.
 *
 * The window, bucket and history range live in the query string with the
 * office filters, so a link to "next 12 months by month" is shareable.
 */
import { MetricTile } from '@/components/admin/primitives';
import { StatusPill } from '@/components/billing/primitives';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatCents } from '@/lib/billing-format';
import { PLAN_LABELS } from '@/lib/office-access';
import {
  CHARGE_TYPE_LABELS,
  HISTORY_CHOICES,
  MAX_WINDOW_DAYS,
  RISK_LABELS,
  WINDOW_CHOICES,
  chargeDay,
  compareMonths,
  periodLabel,
  type DayWindow,
  type HistoryChoice,
  type WindowChoice,
} from '@/lib/app-payments';
import type { AppForecastPeriod, AppPaymentsCollected, AppPaymentsForecast, AppScheduledCharge } from '@/lib/billing-types';
import { ErrorBox } from './shared';

/** A query result, or demo data dressed as one. */
export interface Loadable<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

export const loaded = <T,>(data: T): Loadable<T> => ({ data, isPending: false, isError: false, error: null, refetch: () => undefined });

/** Longer windows list hundreds of charges; the CSV has them all. */
const TIMELINE_LIMIT = 150;

const COLORS = { renewal: 'hsl(var(--chart-1))', trial: 'hsl(var(--chart-3))', risk: '#b65c22' };

function SectionTitle({ title, sub, action }: { title: string; sub: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 mt-8 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="font-serif text-[17px] font-bold text-navy">{title}</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
      </div>
      {action}
    </div>
  );
}

export function WindowPicker({
  choice, window, bucket, from, to, onChoice, onCustom, onBucket,
}: {
  choice: WindowChoice;
  window: DayWindow | null;
  bucket: 'week' | 'month';
  from: string;
  to: string;
  onChoice: (choice: WindowChoice) => void;
  onCustom: (key: 'from' | 'to', value: string) => void;
  onBucket: (bucket: 'week' | 'month') => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={`win-${choice}`} onValueChange={(value) => onChoice(value.replace('win-', '') as WindowChoice)}>
        <SelectTrigger className="h-9 w-44 text-xs" aria-label="Forecast window" data-testid="select-forecast-window">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WINDOW_CHOICES.map((option) => (
            <SelectItem key={option.value} value={`win-${option.value}`} className="text-xs">{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {choice === 'custom' && (
        <>
          <input
            type="date"
            value={from}
            onChange={(event) => onCustom('from', event.target.value)}
            aria-label="Forecast from"
            className="h-9 rounded-md border border-border bg-card px-2 text-xs text-navy"
            data-testid="input-forecast-from"
          />
          <input
            type="date"
            value={to}
            onChange={(event) => onCustom('to', event.target.value)}
            aria-label="Forecast to"
            className="h-9 rounded-md border border-border bg-card px-2 text-xs text-navy"
            data-testid="input-forecast-to"
          />
        </>
      )}
      <div className="inline-flex rounded-md border border-border bg-card p-0.5" role="group" aria-label="Chart by">
        {(['week', 'month'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={bucket === value}
            onClick={() => onBucket(value)}
            className={`h-8 rounded px-3 text-[11px] font-semibold ${bucket === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-navy'}`}
            data-testid={`button-bucket-${value}`}
          >
            By {value}
          </button>
        ))}
      </div>
      {window && (
        <span className="text-[11px] text-muted-foreground" data-testid="text-forecast-window">
          {chargeDay(`${window.start}T00:00:00Z`)} – {chargeDay(`${window.end}T00:00:00Z`)}
        </span>
      )}
    </div>
  );
}

export function ForecastSection({
  forecast, windowPicker, windowError,
}: {
  forecast: Loadable<AppPaymentsForecast> | null;
  windowPicker: React.ReactNode;
  windowError: boolean;
}) {
  return (
    <section aria-labelledby="forecast-title">
      <SectionTitle
        title="Scheduled charges and forecast"
        sub="Estimated from each office's current plan, price and dates. Not a guarantee: charges can fail, plans can change."
        action={windowPicker}
      />
      {windowError || !forecast ? (
        <p className="rounded-md border border-border bg-paper-alt px-5 py-6 text-center text-xs text-muted-foreground" data-testid="text-forecast-window-invalid">
          Choose a start and an end date, no more than {MAX_WINDOW_DAYS} days apart.
        </p>
      ) : forecast.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : forecast.isError ? (
        <ErrorBox error={forecast.error} retry={() => void forecast.refetch()} />
      ) : forecast.data ? (
        <ForecastView forecast={forecast.data} />
      ) : null}
    </section>
  );
}

function ForecastView({ forecast }: { forecast: AppPaymentsForecast }) {
  const { totals, outstanding } = forecast;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricTile label="Estimated revenue" value={formatCents(totals.totalCents)} detail={`${totals.count} scheduled charges · estimate`} testId="tile-forecast-total" />
        <MetricTile label="Renewals" value={formatCents(totals.renewalCents)} detail="Paid offices renewing" testId="tile-forecast-renewals" />
        <MetricTile label="Trial conversions" value={formatCents(totals.trialConversionCents)} detail="First charge after an included period" testId="tile-forecast-trials" />
        <MetricTile label="At risk" value={formatCents(totals.atRiskCents)} detail="Payment problem or office past due" testId="tile-forecast-at-risk" />
        <MetricTile label="Outstanding now" value={formatCents(outstanding.totalCents)} detail="Already owed, not future revenue" testId="tile-forecast-outstanding" />
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground" data-testid="text-forecast-mix">
        <b className="font-semibold text-navy">Estimate</b> at current plans and prices · Monthly plans {formatCents(totals.monthlyCents)} · Yearly plans {formatCents(totals.yearlyCents)}
      </p>
      <div className="mt-4 rounded-md border border-border bg-paper p-4">
        <ForecastChart periods={forecast.periods} bucket={forecast.bucket} />
      </div>
      {outstanding.offices.length > 0 && <Outstanding forecast={forecast} />}
      <Timeline charges={forecast.charges} />
    </>
  );
}

/** Stacked bars per period: renewals under trial conversions, at-risk hatched along the base. */
export function ForecastChart({ periods, bucket }: { periods: AppForecastPeriod[]; bucket: 'week' | 'month' }) {
  const width = 720;
  const height = 220;
  const pad = { top: 12, right: 8, bottom: 28, left: 56 };
  const max = Math.max(1, ...periods.map((period) => period.totalCents));
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const slot = innerW / Math.max(1, periods.length);
  const barW = Math.max(3, Math.min(40, slot * 0.7));
  const y = (cents: number) => (cents / max) * innerH;
  const labelEvery = Math.max(1, Math.ceil(periods.length / 12));
  const total = periods.reduce((sum, period) => sum + period.totalCents, 0);
  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-56 w-full"
        role="img"
        aria-label={`Estimated app revenue by ${bucket}: ${formatCents(total)} across ${periods.length} ${bucket}s`}
        data-testid="chart-forecast"
      >
        <defs>
          <pattern id="forecast-risk" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="2" height="5" fill={COLORS.risk} opacity="0.8" />
          </pattern>
        </defs>
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerH - tick * innerH} y2={pad.top + innerH - tick * innerH} stroke="hsl(var(--border))" />
            <text x={pad.left - 6} y={pad.top + innerH - tick * innerH + 3} textAnchor="end" fontSize="10" fill="hsl(var(--muted-foreground))">
              {formatCents(Math.round(max * tick))}
            </text>
          </g>
        ))}
        {periods.map((period, index) => {
          const x = pad.left + index * slot + (slot - barW) / 2;
          const base = pad.top + innerH;
          const renewalH = y(period.renewalCents);
          const trialH = y(period.trialConversionCents);
          const riskH = y(period.atRiskCents);
          return (
            <g key={period.key} data-testid={`bar-forecast-${period.key}`}>
              <title>{`${periodLabel(period.key)}: ${formatCents(period.totalCents)} (${formatCents(period.renewalCents)} renewals, ${formatCents(period.trialConversionCents)} trial conversions, ${formatCents(period.atRiskCents)} at risk)`}</title>
              <rect x={x} y={base - renewalH} width={barW} height={renewalH} fill={COLORS.renewal} rx="1.5" />
              <rect x={x} y={base - renewalH - trialH} width={barW} height={trialH} fill={COLORS.trial} rx="1.5" />
              {riskH > 0 && <rect x={x} y={base - riskH} width={barW} height={riskH} fill="url(#forecast-risk)" />}
              {index % labelEvery === 0 && (
                <text x={x + barW / 2} y={height - 10} textAnchor="middle" fontSize="10" fill="hsl(var(--muted-foreground))">
                  {periodLabel(period.key)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        <Legend color={COLORS.renewal} label="Renewals" />
        <Legend color={COLORS.trial} label="Trial conversions" />
        <Legend color={COLORS.risk} label="At risk (hatched)" />
        <span>Estimate at current plans and prices</span>
      </figcaption>
    </figure>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

function Outstanding({ forecast }: { forecast: AppPaymentsForecast }) {
  return (
    <div className="mt-4 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-3" data-testid="panel-outstanding">
      <p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#b65c22]">Outstanding balances</p>
      <ul className="mt-1.5 space-y-1 text-xs text-foreground">
        {forecast.outstanding.offices.map((office) => (
          <li key={office.providerId} data-testid={`row-outstanding-${office.providerId}`}>
            <b className="font-semibold text-navy">{office.officeName}</b> owes {formatCents(office.amountCents)} since {chargeDay(office.since)}
            {office.inFlight ? ' — a payment is clearing' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Timeline({ charges }: { charges: AppScheduledCharge[] }) {
  if (!charges.length) {
    return (
      <p className="mt-4 rounded-md border border-border bg-paper-alt px-5 py-6 text-center text-xs text-muted-foreground" data-testid="text-timeline-empty">
        No charges are expected in this window.
      </p>
    );
  }
  const shown = charges.slice(0, TIMELINE_LIMIT);
  return (
    <div className="mt-4 overflow-x-auto rounded-md border border-border bg-paper">
      <table className="w-full min-w-[44rem] text-left text-xs" data-testid="table-timeline">
        <caption className="sr-only">Scheduled access charges</caption>
        <thead className="border-b border-border text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-2.5">Date</th>
            <th scope="col" className="px-4 py-2.5">Office</th>
            <th scope="col" className="px-4 py-2.5">Charge</th>
            <th scope="col" className="px-4 py-2.5">Plan</th>
            <th scope="col" className="px-4 py-2.5 text-right">Amount</th>
            <th scope="col" className="px-4 py-2.5">Outlook</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((charge) => (
            <tr key={`${charge.providerId}-${charge.date}`} className="border-b border-border last:border-b-0" data-testid={`row-charge-${charge.providerId}-${charge.date.slice(0, 10)}`}>
              <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{chargeDay(charge.date)}</td>
              <td className="px-4 py-2.5 font-semibold text-navy">{charge.officeName}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{CHARGE_TYPE_LABELS[charge.type]}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{PLAN_LABELS[charge.plan]}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-navy">{formatCents(charge.amountCents)}</td>
              <td className="px-4 py-2.5">
                {charge.atRisk ? (
                  <StatusPill tone="warn">{charge.riskReasons.map((reason) => RISK_LABELS[reason]).join(' · ')}</StatusPill>
                ) : (
                  <span className="text-muted-foreground">On track</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {charges.length > shown.length && (
        <p className="border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground" data-testid="text-timeline-more">
          Showing the first {shown.length} of {charges.length} charges. Download the forecast report for every line.
        </p>
      )}
    </div>
  );
}

export function CollectedSection({
  collected, charges, history, onHistory,
}: {
  collected: Loadable<AppPaymentsCollected>;
  charges: AppScheduledCharge[];
  history: HistoryChoice;
  onHistory: (choice: HistoryChoice) => void;
}) {
  return (
    <section aria-labelledby="collected-title">
      <SectionTitle
        title="Collected and forecast"
        sub="App revenue that actually came in, month by month, next to the forecast for the months ahead."
        action={
          <Select value={`hist-${history}`} onValueChange={(value) => onHistory(value.replace('hist-', '') as HistoryChoice)}>
            <SelectTrigger className="h-9 w-44 text-xs" aria-label="Collected history range" data-testid="select-collected-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HISTORY_CHOICES.map((option) => (
                <SelectItem key={option.value} value={`hist-${option.value}`} className="text-xs">{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {collected.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : collected.isError ? (
        <ErrorBox error={collected.error} retry={() => void collected.refetch()} />
      ) : collected.data ? (
        <CollectedView collected={collected.data} charges={charges} />
      ) : null}
    </section>
  );
}

function CollectedView({ collected, charges }: { collected: AppPaymentsCollected; charges: AppScheduledCharge[] }) {
  const { totals } = collected;
  const months = compareMonths(collected.months, charges);
  const cell = (cents: number | null) => (cents === null ? '—' : formatCents(cents));
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Collected" value={formatCents(totals.netCents)} detail={`${totals.succeededCount} successful charges, net of refunds`} testId="tile-collected-net" />
        <MetricTile label="Failed attempts" value={totals.failedCount.toLocaleString('en-US')} detail={`${formatCents(totals.failedCents)} attempted`} testId="tile-collected-failed" />
        <MetricTile label="Paid offline" value={formatCents(totals.offlineCents)} detail="Recorded by HQ outside Stripe" testId="tile-collected-offline" />
        <MetricTile label="Refunded" value={formatCents(totals.reversedCents)} detail="Charges returned or reversed" testId="tile-collected-refunded" />
      </div>
      <div className="mt-4 overflow-x-auto rounded-md border border-border bg-paper">
        <table className="w-full min-w-[36rem] text-left text-xs" data-testid="table-collected">
          <caption className="sr-only">Collected and forecast app revenue by month</caption>
          <thead className="border-b border-border text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2.5">Month</th>
              <th scope="col" className="px-4 py-2.5 text-right">Collected</th>
              <th scope="col" className="px-4 py-2.5 text-right">Failed attempts</th>
              <th scope="col" className="px-4 py-2.5 text-right">Forecast (estimate)</th>
              <th scope="col" className="px-4 py-2.5 text-right">At risk</th>
            </tr>
          </thead>
          <tbody>
            {months.map((month) => (
              <tr key={month.key} className="border-b border-border last:border-b-0" data-testid={`row-compare-${month.key}`}>
                <td className="px-4 py-2.5 font-semibold text-navy">{periodLabel(month.key)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{cell(month.collectedCents)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{month.failedCount === null ? '—' : month.failedCount}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{cell(month.forecastCents)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{cell(month.atRiskCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
