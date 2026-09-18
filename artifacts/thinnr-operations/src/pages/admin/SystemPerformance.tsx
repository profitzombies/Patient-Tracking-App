/**
 * HQ System health → performance panels: how fast requests are answered per
 * route family (p50/p95 for the last hour and day), which database
 * statements cost the most (pg_stat_statements), and how fast tables and
 * object storage are growing (daily size snapshots with the day's delta).
 *
 * The same thresholds the server evaluates for the HQ email alert colour the
 * rows here: amber is "worth a look", red is "people are waiting" or "we are
 * growing faster than planned". Each section reads on its own; one that
 * could not be read says so instead of showing zeros.
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, Gauge, HardDrive } from 'lucide-react';
import {
  getGetHqSystemPerformanceQueryKey,
  useGetHqSystemPerformance,
  type LatencyFamily,
  type SlowStatement,
  type SystemGrowth,
  type SystemPerformanceResult,
  type ThresholdLevel,
} from '@workspace/api-client-react';
import { MetricTile } from '@/components/admin/primitives';

export const LEVEL_LABEL: Record<ThresholdLevel, string> = { ok: 'OK', amber: 'Amber', red: 'Red' };

export function levelClass(level: ThresholdLevel): string {
  if (level === 'red') return 'border-[#d5a7a7] bg-[#fff0f0] text-destructive';
  if (level === 'amber') return 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]';
  return 'border-[#b9d8c5] bg-[#eef8f1] text-[#1f6b3e]';
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (abs >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${Math.round(bytes)} B`;
}

/** Signed delta: "+12.3 MB", "−4.0 MB", "no change", or "—" without a previous day. */
export function formatDelta(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return 'no change';
  return `${bytes > 0 ? '+' : '−'}${formatBytes(Math.abs(bytes))}`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function dateLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function LevelChip({ level, testId }: { level: ThresholdLevel; testId?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[.08em] ${levelClass(level)}`} data-testid={testId}>
      {level === 'ok' ? <CheckCircle2 size={11} aria-hidden="true" /> : <AlertTriangle size={11} aria-hidden="true" />}
      {LEVEL_LABEL[level]}
    </span>
  );
}

type LatencyWindow = 'lastHour' | 'lastDay';
type StatementOrder = 'byTotal' | 'byMean';
const LATENCY_WINDOWS: ReadonlyArray<{ value: LatencyWindow; label: string }> = [{ value: 'lastHour', label: 'Last hour' }, { value: 'lastDay', label: 'Last 24 h' }];
const STATEMENT_ORDERS: ReadonlyArray<{ value: StatementOrder; label: string }> = [{ value: 'byTotal', label: 'By total time' }, { value: 'byMean', label: 'By mean time' }];

function Toggle<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (next: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-border bg-card p-0.5 text-[11px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded px-2.5 py-1 font-semibold transition ${value === option.value ? 'bg-navy text-white' : 'text-muted-foreground hover:text-foreground'}`}
          data-testid={`toggle-${label.toLowerCase().replace(/\s+/g, '-')}-${option.value}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Unavailable({ children, testId }: { children: string; testId: string }) {
  return (
    <p role="alert" className="px-4 py-5 text-xs text-destructive" data-testid={testId}>{children}</p>
  );
}

function PanelShell({ id, title, intro, icon, right, testId, children }: { id: string; title: string; intro: string; icon: React.ReactNode; right?: React.ReactNode; testId: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 overflow-hidden rounded-lg border border-border bg-card shadow-soft" aria-labelledby={`${id}-title`} data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-paper-alt px-4 py-3">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="flex items-center gap-2 font-serif text-base font-bold text-navy">
            <span className="text-muted-foreground" aria-hidden="true">{icon}</span>
            {title}
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{intro}</p>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function ThresholdBanner({ thresholds }: { thresholds: SystemPerformanceResult['thresholds'] }) {
  const { level, findings, config } = thresholds;
  return (
    <div className={`mt-6 rounded-md border px-4 py-3 text-xs ${levelClass(level)}`} role={level === 'ok' ? 'status' : 'alert'} data-testid="performance-thresholds">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold" data-testid="text-performance-level">
          {level === 'ok' ? 'All performance thresholds are within limits.' : `${findings.length} threshold${findings.length === 1 ? '' : 's'} crossed — HQ administrators were emailed once for each.`}
        </p>
        <p className="text-[11px] opacity-80">
          p95 amber {formatMs(config.latency.defaultAmberMs)} / red {formatMs(config.latency.defaultRedMs)} (streams {formatMs(config.latency.streamingAmberMs)} / {formatMs(config.latency.streamingRedMs)}) ·
          DB growth {formatBytes(config.dbGrowth.amberBytesPerDay)} / {formatBytes(config.dbGrowth.redBytesPerDay)} per day ·
          storage growth {formatBytes(config.storageGrowth.amberBytesPerDay)} / {formatBytes(config.storageGrowth.redBytesPerDay)} per day
        </p>
      </div>
      {findings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {findings.map((finding) => (
            <li key={`${finding.metric}:${finding.family ?? ''}:${finding.level}`} className="flex items-start gap-2" data-testid={`finding-${finding.metric}${finding.family ? `-${finding.family.replace('/', '-')}` : ''}`}>
              <LevelChip level={finding.level} />
              <span>{finding.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LatencyTable({ families, minRequests }: { families: LatencyFamily[]; minRequests: number }) {
  if (!families.length) {
    return <p className="px-4 py-5 text-xs text-muted-foreground" data-testid="text-latency-empty">No requests were recorded in this window yet.</p>;
  }
  const sorted = [...families].sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="table-latency">
        <thead>
          <tr className="border-b border-border text-left text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">
            <th className="px-4 py-2.5">Route family</th>
            <th className="px-4 py-2.5 text-right">Requests</th>
            <th className="px-4 py-2.5 text-right">p50</th>
            <th className="px-4 py-2.5 text-right">p95</th>
            <th className="px-4 py-2.5 text-right">Max</th>
            <th className="px-4 py-2.5 text-right">5xx</th>
            <th className="px-4 py-2.5 text-right">Used DB</th>
            <th className="px-4 py-2.5 text-right">Used AI</th>
            <th className="px-4 py-2.5">Level</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const thin = row.requests < minRequests;
            return (
              <tr key={row.family} className="border-b border-border last:border-0" data-testid={`row-latency-${row.family.replace('/', '-')}`}>
                <td className="whitespace-nowrap px-4 py-2.5 font-medium text-foreground">
                  {row.family}
                  {row.streaming && <span className="ml-1.5 rounded bg-secondary px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.08em] text-muted-foreground">stream</span>}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{row.requests.toLocaleString()}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{formatMs(row.p50Ms)}</td>
                <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${row.level === 'red' ? 'text-destructive' : row.level === 'amber' ? 'text-[#b65c22]' : 'text-navy'}`} data-testid={`text-p95-${row.family.replace('/', '-')}`}>{formatMs(row.p95Ms)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{formatMs(row.maxMs)}</td>
                <td className={`px-4 py-2.5 text-right tabular-nums ${row.errors > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{row.errors}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{percent(row.dbShare)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{percent(row.aiShare)}</td>
                <td className="px-4 py-2.5">{thin ? <span className="text-[10px] text-muted-foreground" title={`Fewer than ${minRequests} requests; not levelled`}>too few</span> : <LevelChip level={row.level} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function LatencyPanel({ latency, minRequests, loaded }: { latency: SystemPerformanceResult['latency'] | undefined; minRequests: number; loaded: boolean }) {
  const [window, setWindow] = useState<LatencyWindow>('lastHour');
  return (
    <PanelShell
      id="latency"
      title="Request speed by route family"
      intro="p50 is the typical answer; p95 is what the slowest one in twenty waits. Rows turn amber or red against the family's budget once it has enough requests in the hour."
      icon={<Gauge size={15} />}
      testId="section-latency"
      right={<Toggle label="Latency window" value={window} onChange={(next) => setWindow(next)} options={LATENCY_WINDOWS} />}
    >
      {loaded && latency === null && <Unavailable testId="text-latency-unavailable">Request metrics unavailable — the latency table could not be read.</Unavailable>}
      {latency && <LatencyTable families={latency[window].families} minRequests={window === 'lastHour' ? minRequests : 0} />}
    </PanelShell>
  );
}

function StatementRows({ statements }: { statements: SlowStatement[] }) {
  if (!statements.length) return <p className="px-4 py-5 text-xs text-muted-foreground" data-testid="text-statements-empty">No statement statistics yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-xs" data-testid="table-slow-statements">
        <thead>
          <tr className="border-b border-border text-left text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">
            <th className="px-4 py-2.5">Statement</th>
            <th className="w-20 px-2 py-2.5 text-right">Calls</th>
            <th className="w-24 px-2 py-2.5 text-right">Total</th>
            <th className="w-24 px-2 py-2.5 text-right">Mean</th>
            <th className="w-24 px-2 py-2.5 text-right">Max</th>
            <th className="w-24 px-4 py-2.5 text-right">Rows</th>
          </tr>
        </thead>
        <tbody>
          {statements.map((statement) => (
            <tr key={statement.queryId} className="border-b border-border align-top last:border-0" data-testid={`row-statement-${statement.queryId}`}>
              <td className="px-4 py-2.5">
                <code className="block max-h-16 overflow-hidden whitespace-pre-wrap break-all font-mono text-[10.5px] leading-snug text-foreground" title={statement.query}>{statement.query.replace(/\s+/g, ' ').slice(0, 320)}</code>
                <span className="mt-1 block text-[10px] text-muted-foreground">{statement.role ?? 'unknown role'} · id {statement.queryId}</span>
              </td>
              <td className="px-2 py-2.5 text-right tabular-nums">{statement.calls.toLocaleString()}</td>
              <td className="px-2 py-2.5 text-right font-semibold tabular-nums text-navy">{formatMs(statement.totalMs)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{formatMs(statement.meanMs)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">{formatMs(statement.maxMs)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{statement.rows.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SlowStatementsPanel({ statements, loaded }: { statements: SystemPerformanceResult['slowStatements'] | undefined; loaded: boolean }) {
  const [order, setOrder] = useState<StatementOrder>('byTotal');
  return (
    <PanelShell
      id="slow-statements"
      title="Heaviest database statements"
      intro={`From pg_stat_statements since ${statements?.statsResetAt ? new Date(statements.statsResetAt).toLocaleString() : 'the last statistics reset'}. Total time finds the statements that cost the most overall; mean time finds the ones that are slow every time.`}
      icon={<Database size={15} />}
      testId="section-slow-statements"
      right={<Toggle label="Statement order" value={order} onChange={(next) => setOrder(next)} options={STATEMENT_ORDERS} />}
    >
      {loaded && statements === null && <Unavailable testId="text-statements-unavailable">Statement statistics unavailable — pg_stat_statements could not be read.</Unavailable>}
      {statements && <StatementRows statements={statements[order]} />}
    </PanelShell>
  );
}

function GrowthHistory({ growth }: { growth: SystemGrowth }) {
  const points = growth.history.filter((point) => point.databaseBytes !== null || point.storageBytes !== null);
  if (points.length < 2) return null;
  const width = 600;
  const height = 80;
  const line = (pick: (point: SystemGrowth['history'][number]) => number | null, testId: string) => {
    const values = points.map(pick);
    const max = Math.max(...values.map((value) => value ?? 0), 1);
    const path = values
      .map((value, index) => (value === null ? null : `${index === 0 ? 'M' : 'L'}${((index / Math.max(points.length - 1, 1)) * width).toFixed(1)},${(height - (value / max) * (height - 6) - 3).toFixed(1)}`))
      .filter(Boolean)
      .join(' ');
    return <path d={path} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" data-testid={testId} />;
  };
  return (
    <figure className="border-t border-border px-4 py-3" data-testid="growth-history">
      <figcaption className="text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">
        Size over the last {points.length} snapshots ({dateLabel(points[0]!.date)} – {dateLabel(points[points.length - 1]!.date)}); each line is scaled to its own peak
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 h-20 w-full" role="img" aria-label={`Database and storage size trend across ${points.length} daily snapshots`}>
        <g className="stroke-navy">{line((point) => point.databaseBytes, 'line-database')}</g>
        <g className="stroke-[#b65c22]">{line((point) => point.storageBytes, 'line-storage')}</g>
      </svg>
      <p className="mt-1 text-[10px] text-muted-foreground"><span className="font-semibold text-navy">Database</span> · <span className="font-semibold text-[#b65c22]">Object storage</span></p>
    </figure>
  );
}

export function GrowthPanel({ growth, loaded }: { growth: SystemPerformanceResult['growth'] | undefined; loaded: boolean }) {
  return (
    <PanelShell
      id="growth"
      title="Table and storage growth"
      intro="A daily snapshot of every table, the whole database, and object storage. The delta is against the previous snapshot; the level compares growth per day with the limits above."
      icon={<HardDrive size={15} />}
      testId="section-growth"
    >
      {loaded && growth === null && (
        <p className="px-4 py-5 text-xs text-muted-foreground" data-testid="text-growth-unavailable">
          No size snapshot yet. The data-growth-snapshot job records one each day; run it now from the jobs list below to take the first.
        </p>
      )}
      {growth && (
        <>
          <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4" data-testid="growth-summary">
            <MetricTile label="Database" value={formatBytes(growth.database.bytes)} detail={`${formatDelta(growth.database.deltaBytes)} since ${growth.previousDate ? dateLabel(growth.previousDate) : 'no earlier snapshot'}`} testId="metric-db-size" />
            <MetricTile label="Database growth / day" value={growth.database.bytesPerDay === null ? '—' : formatDelta(growth.database.bytesPerDay)} detail={growth.database.deltaPercent === null ? 'Needs two snapshots' : `${growth.database.deltaPercent > 0 ? '+' : ''}${growth.database.deltaPercent}% · ${LEVEL_LABEL[growth.database.level]}`} testId="metric-db-growth" />
            <MetricTile label="Object storage" value={formatBytes(growth.storage.bytes)} detail={`${formatDelta(growth.storage.deltaBytes)} since ${growth.previousDate ? dateLabel(growth.previousDate) : 'no earlier snapshot'}`} testId="metric-storage-size" />
            <MetricTile label="Storage growth / day" value={growth.storage.bytesPerDay === null ? '—' : formatDelta(growth.storage.bytesPerDay)} detail={growth.storage.deltaPercent === null ? 'Needs two snapshots' : `${growth.storage.deltaPercent > 0 ? '+' : ''}${growth.storage.deltaPercent}% · ${LEVEL_LABEL[growth.storage.level]}`} testId="metric-storage-growth" />
          </div>
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-[11px] text-muted-foreground">
            <span>Snapshot {dateLabel(growth.latestDate)}</span>
            <LevelChip level={growth.database.level} testId="chip-db-growth-level" />
            <LevelChip level={growth.storage.level} testId="chip-storage-growth-level" />
          </div>
          <GrowthHistory growth={growth} />
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full text-xs" data-testid="table-growth">
              <thead>
                <tr className="border-b border-border text-left text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">
                  <th className="px-4 py-2.5">Table</th>
                  <th className="px-4 py-2.5 text-right">Total</th>
                  <th className="px-4 py-2.5 text-right">Heap</th>
                  <th className="px-4 py-2.5 text-right">Indexes</th>
                  <th className="px-4 py-2.5 text-right">Rows (est.)</th>
                  <th className="px-4 py-2.5 text-right">Daily delta</th>
                </tr>
              </thead>
              <tbody>
                {growth.tables.map((table) => (
                  <tr key={table.name} className="border-b border-border last:border-0" data-testid={`row-table-${table.name.replace(/\./g, '-')}`}>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-foreground">{table.name}</td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-navy">{formatBytes(table.totalBytes)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{formatBytes(table.tableBytes)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{formatBytes(table.indexBytes)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{table.rowEstimate === null ? '—' : table.rowEstimate.toLocaleString()}</td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${table.deltaBytes && table.deltaBytes > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>{formatDelta(table.deltaBytes)}</td>
                  </tr>
                ))}
                {growth.storagePrefixes.map((prefix) => (
                  <tr key={prefix.name} className="border-b border-border bg-paper-alt/40 last:border-0" data-testid={`row-storage-${prefix.name.replace(/[^a-z0-9]+/gi, '-')}`}>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-foreground">storage {prefix.name}</td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-navy">{formatBytes(prefix.bytes)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground" colSpan={2}>{prefix.objectCount === null ? '—' : `${prefix.objectCount.toLocaleString()} objects`}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">—</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatDelta(prefix.deltaBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </PanelShell>
  );
}

export function SystemPerformancePanels({ enabled, keySuffix }: { enabled: boolean; keySuffix: unknown[] }) {
  const { data, isError, error } = useGetHqSystemPerformance({
    query: { enabled, queryKey: [...getGetHqSystemPerformanceQueryKey(), ...keySuffix], refetchInterval: 60_000 },
  });
  const loaded = Boolean(data);
  return (
    <div data-testid="system-performance">
      {isError && (
        <div role="alert" className="mt-6 rounded-md border border-[#d5a7a7] bg-[#fff0f0] px-4 py-3 text-xs text-destructive" data-testid="text-performance-error">
          {(error as { data?: { error?: string } })?.data?.error ?? 'Performance could not be loaded.'}
        </div>
      )}
      {data && <ThresholdBanner thresholds={data.thresholds} />}
      <LatencyPanel latency={data?.latency} minRequests={data?.thresholds.config.latency.minRequests ?? 20} loaded={loaded} />
      <SlowStatementsPanel statements={data?.slowStatements} loaded={loaded} />
      <GrowthPanel growth={data?.growth} loaded={loaded} />
    </div>
  );
}
