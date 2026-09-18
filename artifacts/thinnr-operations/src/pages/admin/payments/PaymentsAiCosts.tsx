import { AdminPage, MetricTile } from '@/components/admin/primitives';
import { AreaChart, CHART_COLORS, shortDay } from '@/components/billing/hq/RevenueCharts';
import { DateRangeControl } from '@/components/layout/DateRangeControl';
import { SectionCard } from '@/components/patient/heritage';
import { Skeleton } from '@/components/ui/skeleton';
import { useDateRange } from '@/contexts/date-range';
import { useHqAiCosts } from '@/hooks/use-billing';
import type { AiCostSummary } from '@/lib/billing-types';
import { DEMO_AI_COSTS } from './demo-data';
import { ErrorBox, Gate, Header, Preview } from './shared';
import { useBillingSandbox } from './use-billing-sandbox';

const SURFACE_LABELS: Record<string, string> = {
  'coach.chat': 'Coach chat',
  'coach.meal_photo': 'Meal photo reads',
  'coach.menu_scan': 'Menu scans',
  'coach.label_scan': 'Label scans',
  'coach.recipe': 'Recipes',
  'coach.meal_makeover': 'Meal makeovers',
  'coach.back_on_track': 'Back on track',
  'coach.title': 'Conversation titles',
  'coach.photo_classify': 'Photo triage',
  'coach.recipe_image': 'Recipe images',
  'support.chat': 'AI support chat',
  'knowledge.summary': 'Knowledge summaries',
};

function formatUsd(value: number): string {
  if (Math.abs(value) < 0.01 && value !== 0) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatPercent(value: number): string {
  return value.toLocaleString('en-US', { style: 'percent', maximumFractionDigits: 1 });
}

export function PaymentsAiCosts() {
  return <Gate>{(demo) => <AiCostsBody demo={demo} />}</Gate>;
}

function AiCostsBody({ demo }: { demo: boolean }) {
  const { range } = useDateRange();
  const query = useHqAiCosts(demo ? {} : { from: range.start, to: range.end });
  const sandbox = useBillingSandbox();
  const data = demo ? DEMO_AI_COSTS : query.data;
  return (
    <AdminPage>
      <Header
        title="AI costs"
        sub="What the coach, photo reads, menu and label scans, and support chat cost per day, per office, per surface, and per active patient."
        sandbox={sandbox.data?.sandbox}
        action={<DateRangeControl />}
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-44 w-full" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : data ? (
        <AiCostsContent data={data} />
      ) : null}
    </AdminPage>
  );
}

function AiCostsContent({ data }: { data: AiCostSummary }) {
  const totalTokens = data.totals.prompt_tokens + data.totals.completion_tokens;
  const offices = [...data.by_office].sort((a, b) => b.cost_usd - a.cost_usd);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Total spend"
          value={formatUsd(data.totals.cost_usd)}
          detail={`${formatCount(data.totals.calls)} model calls, ${formatCount(data.totals.error_calls)} failed`}
        />
        <MetricTile
          label="Per active patient"
          value={data.totals.cost_per_active_patient_usd === null ? '—' : formatUsd(data.totals.cost_per_active_patient_usd)}
          detail={`${formatCount(data.totals.active_patients)} active patients, ${formatCount(data.totals.ai_patients)} used AI`}
        />
        <MetricTile
          label="Prompt cache share"
          value={formatPercent(data.totals.cached_share)}
          detail={`${formatCount(data.totals.cached_tokens)} of ${formatCount(data.totals.prompt_tokens)} prompt tokens served from cache`}
        />
        <MetricTile
          label="Tokens"
          value={formatCount(totalTokens)}
          detail={`${formatCount(data.totals.completion_tokens)} completion, ${formatCount(data.totals.reasoning_tokens)} reasoning`}
        />
      </div>
      {data.totals.unpriced_calls > 0 && (
        <p className="mt-3 text-xs font-medium text-amber-700">
          {formatCount(data.totals.unpriced_calls)} calls used a model with no price on file; their spend is not included.
        </p>
      )}
      {data.unattributed.calls > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {formatCount(data.unattributed.calls)} calls ({formatUsd(data.unattributed.cost_usd)}) were not attributed to an office
          {' (demo and signed-out use).'}
        </p>
      )}
      <SectionCard title="Spend per day" sub="Daily model spend across every AI surface" className="mt-5">
        <div className="p-5">
          <AreaChart
            title="Spend per day"
            dates={data.by_day.map((row) => row.day)}
            unit="money"
            testId="chart-ai-spend"
            formatLabelLong={(key) => `${shortDay(key)}, ${key.slice(0, 4)}`}
            series={[
              {
                key: 'cost',
                label: 'AI spend',
                color: CHART_COLORS.fees,
                // RevenueCharts' money unit accepts integer cents.
                values: data.by_day.map((row) => Math.round(row.cost_usd * 100)),
              },
            ]}
          />
        </div>
      </SectionCard>
      <SectionCard title="By office" sub="Spend and adoption by payment provider" className="mt-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] table-fixed text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase text-muted-foreground">
                <th className="w-[240px] p-4">Office</th>
                <th className="w-[100px]">Calls</th>
                <th className="w-[110px]">Cost</th>
                <th className="w-[170px]">Per active patient</th>
                <th className="w-[120px]">Cache share</th>
                <th className="w-[160px] pr-4">Patients using AI</th>
              </tr>
            </thead>
            <tbody>
              {offices.map((row) => (
                <tr key={row.provider_id} className="border-b border-border">
                  <td className="p-4">
                    <div className="truncate font-semibold text-navy">
                      {row.office_name ?? row.provider_name ?? row.provider_id}
                    </div>
                  </td>
                  <td>{formatCount(row.calls)}</td>
                  <td>{formatUsd(row.cost_usd)}</td>
                  <td>{row.cost_per_active_patient_usd === null ? '—' : formatUsd(row.cost_per_active_patient_usd)}</td>
                  <td>{formatPercent(row.cached_share)}</td>
                  <td className="pr-4">{formatCount(row.ai_patients)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
      <SectionCard title="By surface" sub="Cost and performance for each AI experience" className="mt-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1140px] table-fixed text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase text-muted-foreground">
                <th className="w-[190px] p-4">Surface</th>
                <th className="w-[170px]">Model</th>
                <th className="w-[85px]">Calls</th>
                <th className="w-[80px]">Failed</th>
                <th className="w-[100px]">Cost</th>
                <th className="w-[110px]">Cache share</th>
                <th className="w-[140px]">Avg latency (ms)</th>
                <th className="w-[130px] pr-4">p95 latency</th>
              </tr>
            </thead>
            <tbody>
              {data.by_surface.map((row) => (
                <tr key={row.surface} className="border-b border-border">
                  <td className="p-4"><div className="truncate font-semibold text-navy">{SURFACE_LABELS[row.surface] ?? row.surface}</div></td>
                  <td><div className="truncate">{row.model ?? '—'}</div></td>
                  <td>{formatCount(row.calls)}</td>
                  <td>{formatCount(row.error_calls)}</td>
                  <td>{formatUsd(row.cost_usd)}</td>
                  <td>{formatPercent(row.cached_share)}</td>
                  <td>{formatCount(Math.round(row.avg_latency_ms))}</td>
                  <td className="pr-4">{formatCount(Math.round(row.p95_latency_ms))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
      <SectionCard title="By model" className="mt-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] table-fixed text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase text-muted-foreground">
                <th className="w-[210px] p-4">Model</th>
                <th className="w-[100px]">Calls</th>
                <th className="w-[110px]">Cost</th>
                <th className="w-[120px]">Cache share</th>
                <th className="w-[260px] pr-4">Rate per 1M tokens (in / cached / out)</th>
              </tr>
            </thead>
            <tbody>
              {data.by_model.map((row) => (
                <tr key={row.model} className="border-b border-border">
                  <td className="p-4"><div className="truncate font-semibold text-navy">{row.model}</div></td>
                  <td>{formatCount(row.calls)}</td>
                  <td>{formatUsd(row.cost_usd)}</td>
                  <td>{formatPercent(row.cached_share)}</td>
                  <td className="pr-4">
                    {row.unpriced || !row.rate
                      ? 'No price on file'
                      : `${formatUsd(row.rate.input)} / ${formatUsd(row.rate.cached)} / ${formatUsd(row.rate.output)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border p-4 text-xs text-muted-foreground">
          Prices per pricing table {data.pricing_version}.
        </p>
      </SectionCard>
    </>
  );
}