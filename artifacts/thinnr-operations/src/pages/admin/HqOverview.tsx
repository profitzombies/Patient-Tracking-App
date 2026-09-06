/**
 * HQ overview — the umbrella's front page.
 *
 * Every number is a rollup of the provider accounts, and the seeded accounts
 * partition the office demo's program totals exactly (patients 142+185+210+95
 * = 632, monthly revenue $41,500+$53,900+$61,300+$27,500 = $184,200), so this
 * page and the office desk can be shown side by side without a discrepancy.
 * Session-added accounts join with zeroes and can't disturb the rollup.
 * Anchored to the fixed demo date — no viewer-clock math.
 *
 * Signed-in HQ gets the live branch instead: a per-office comparison for the
 * shared date range (sortable, ranked, sparklines), aggregate tiles that
 * drill into the account list, and an export shortcut. Financial tiles stay
 * unavailable until a live source exists.
 */
import { useMemo, type ReactNode } from 'react';
import { Link } from 'wouter';
import { AlertCircle, ArrowRight, FileDown } from 'lucide-react';
import { SectionCard } from '@/components/patient/heritage';
import { AccountStatusChip, AdminPage, MetricTile, PageHeader } from '@/components/admin/primitives';
import { OfficeComparisonTable } from '@/components/admin/OfficeComparisonTable';
import { DateRangeControl } from '@/components/layout/DateRangeControl';
import { useHqData } from '@/contexts/hq-data';
import { formatRangeLabel, useDateRange } from '@/contexts/date-range';
import { monthlyRevenueOf } from '@/data/hq/accounts';
import { getConversations } from '@/data/hq/conversations';
import { MOCK_PATIENTS } from '@/data/mock-data';
import { TODAY_KEY, formatDateKey } from '@/data/nutrition-data';
import { useSession } from '@/contexts/session';
import { formatPercent, percentOf, sumComparison } from '@/lib/office-analytics';
import { useGetHqOfficeComparison, getGetHqOfficeComparisonQueryKey } from '@workspace/api-client-react';

const fmt = (value: number) => value.toLocaleString('en-US');

/** A metric tile that is itself the drill-through link (whole card clickable, one accessible name). */
function MetricLinkTile({ label, value, detail, href, testId }: { label: string; value: ReactNode; detail?: ReactNode; href: string; testId: string }) {
  return (
    <Link
      href={href}
      className="block rounded-lg border border-card-border bg-card p-4 shadow-soft transition hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${label}: ${typeof value === 'string' || typeof value === 'number' ? value : ''}. Open the matching list`}
      data-testid={testId}
    >
      <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">{label}</p>
      <p className="mt-2 font-serif text-[26px] font-bold leading-none tracking-[-.01em] text-navy">{value}</p>
      {detail && <p className="mt-2 text-[11px] text-muted-foreground">{detail}</p>}
    </Link>
  );
}

function LiveHqOverview({ firstName }: { firstName: string | null }) {
  const { authUser } = useSession();
  const { range } = useDateRange();
  const rangeLabel = formatRangeLabel(range);

  const comparison = useGetHqOfficeComparison(
    { start: range.start, end: range.end },
    {
      query: {
        queryKey: [...getGetHqOfficeComparisonQueryKey({ start: range.start, end: range.end }), authUser?.id],
        retry: 1,
      },
    },
  );

  const rows = comparison.data?.offices ?? [];
  const totals = useMemo(() => sumComparison(rows), [rows]);
  const loading = comparison.isPending;
  const failed = comparison.isError;
  const noData = !loading && !failed && totals.availableOffices === 0;

  const tileValue = (value: number) => (loading ? '—' : failed ? 'Error' : noData ? 'Unavailable' : fmt(value));
  const tileDetail = (ready: string) =>
    loading ? 'Loading live data…' : failed ? 'Failed to load' : noData ? 'No office has data for this range' : ready;

  const asOfDate = comparison.data?.asOf ? formatDateKey(comparison.data.asOf.split('T')[0], true) : null;
  const engagementPct = noData || loading || failed ? null : percentOf(totals.engaged, totals.activePatients);

  return (
    <AdminPage>
      <PageHeader
        kicker="THINNR HQ"
        title={firstName ? `Good morning, ${firstName}.` : 'Good morning.'}
        sub={
          <>
            <span data-testid="text-hq-demo-date">{asOfDate ?? 'Live'}</span> · Operations rollup for{' '}
            <span className="font-semibold text-navy" data-testid="text-hq-range">{rangeLabel}</span>
          </>
        }
        action={<DateRangeControl />}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricLinkTile
          label="Patients across offices"
          value={tileValue(totals.totalPatients)}
          detail={tileDetail(`${fmt(totals.enrollments)} enrolled in this range`)}
          href="/admin/accounts"
          testId="text-hq-patients"
        />
        <MetricLinkTile
          label="Active patients"
          value={tileValue(totals.activePatients)}
          detail={tileDetail('Active as of the range end')}
          href="/admin/accounts"
          testId="text-hq-active"
        />
        <MetricLinkTile
          label="Avg engagement"
          value={loading ? '—' : failed ? 'Error' : noData ? 'Unavailable' : formatPercent(engagementPct)}
          detail={tileDetail('Active patients engaging in the last 7 days of the range')}
          href="/admin/accounts"
          testId="text-hq-engagement"
        />
        <MetricLinkTile
          label="Needs attention"
          value={tileValue(totals.needsAttention)}
          detail={tileDetail(`${fmt(totals.loggingLapsed)} lapsed · ${fmt(totals.checkInsOverdue)} overdue`)}
          href="/admin/accounts"
          testId="text-hq-attention"
        />
      </div>

      <div className="mt-5">
        <SectionCard
          title="Office comparison"
          sub={`Live figures per office for ${rangeLabel}. Sort any column; rank follows the sorted metric.`}
          action={
            <Link href="/admin/exports" className="inline-flex items-center gap-1 rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="link-hq-export-comparison">
              <FileDown size={12} aria-hidden="true" />
              Export CSV
            </Link>
          }
        >
          {loading ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-office-comparison-loading">Loading office comparison…</p>
          ) : failed ? (
            <div className="m-5 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert" data-testid="text-office-comparison-error">
              <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>
                The office comparison could not be loaded.{' '}
                <button type="button" className="underline" onClick={() => comparison.refetch()}>Try again</button>
              </span>
            </div>
          ) : (
            <>
              {totals.unavailableOffices > 0 && (
                <p className="border-b border-border bg-secondary px-5 py-2 text-[11px] text-muted-foreground" data-testid="text-office-comparison-unavailable-note">
                  {totals.unavailableOffices === rows.length
                    ? 'No office has recorded data in this range — figures are unavailable, not zero. Try a later range.'
                    : `${totals.unavailableOffices} of ${rows.length} offices have no data in this range and are shown as unavailable.`}
                </p>
              )}
              <OfficeComparisonTable rows={rows} rangeEnd={range.end} />
            </>
          )}
        </SectionCard>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <MetricTile label="Active subscriptions" value="—" detail="No confirmed live subscription source" testId="text-hq-subscriptions" />
        <MetricTile label="Deliveries" value="—" detail="No confirmed live delivery source" testId="text-hq-deliveries" />
      </div>
    </AdminPage>
  );
}

/** Stacked-bar palette — the cobalt ramp the office charts already use. */
const BAR_CLASSES = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4'];

export default function HqOverview() {
  const { authStatus, authUser } = useSession();
  if (authStatus === 'signed-in') {
    return <LiveHqOverview firstName={authUser?.displayName?.trim().split(/\s+/)[0] ?? null} />;
  }
  return <DemoHqOverview />;
}

/** The guided-demo overview — seeded rollup, byte-for-byte as before. */
function DemoHqOverview() {
  const { accounts } = useHqData();
  const firstName = 'HQ guest';

  const activeAccounts = accounts.filter((account) => account.status === 'active');
  const revenueAccounts = accounts.filter((account) => monthlyRevenueOf(account) != null);

  const totalPatientsValue = fmt(accounts.reduce((sum, account) => sum + (account.activePatientCount ?? 0), 0));
  const totalPatientsDetail = 'Active patients from live provider-linked rows';
  const engagementValue = '—';
  const engagementDetail = 'No confirmed live engagement source';
  const pulseDate = formatDateKey(TODAY_KEY, true);

  const latestConversations = getConversations().slice(0, 3);

  return (
    <AdminPage>
      <PageHeader
        kicker="THINNR HQ"
        title={`Good morning, ${firstName}.`}
        sub={
          <>
            <span data-testid="text-hq-demo-date">{pulseDate}</span> · Rollup across{' '}
            {accounts.length} provider accounts ({activeAccounts.length} active).
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Patients across accounts"
          value={totalPatientsValue}
          detail={totalPatientsDetail}
          testId="text-hq-patients"
        />
        <MetricTile
          label="Active subscriptions"
          value="—"
          detail="No confirmed live subscription source"
          testId="text-hq-subscriptions"
        />
        <MetricTile
          label="Deliveries · demo window"
          value="—"
          detail="No confirmed live delivery source"
          testId="text-hq-deliveries"
        />
        <MetricTile
          label="Avg engagement"
          value={engagementValue}
          detail={engagementDetail}
          testId="text-hq-engagement"
        />
      </div>

      {(
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,7fr),minmax(0,5fr)]">
          <SectionCard
            title="Monthly program revenue"
            sub="Across every provider account"
          >
            <div className="px-5 py-4">
              <p className="font-serif text-[30px] font-bold leading-none tracking-[-.01em] text-navy" data-testid="text-hq-revenue">
                ${fmt(184200)} <span className="ml-2 rounded border border-accent-border bg-accent px-2 py-1 text-xs font-semibold tracking-normal text-primary align-middle">Demo projection</span>
              </p>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Revenue is isolated to the guided demo. Live revenue integration is pending.
              </p>

              {/* Share-of-revenue stacked bar: one segment per revenue-bearing account. */}
              <div className="mt-4 flex h-3 w-full overflow-hidden rounded-sm" role="img" aria-label="Monthly revenue share by provider account">
                {revenueAccounts.map((account, index) => (
                  <span
                    key={account.id}
                    className={BAR_CLASSES[index % BAR_CLASSES.length]}
                    style={{ width: `${100 / Math.max(1, revenueAccounts.length)}%` }}
                  />
                ))}
              </div>
              <ul className="mt-3 space-y-1.5">
                {revenueAccounts.map((account, index) => (
                  <li key={account.id} className="flex items-center gap-2 text-[11px]">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${BAR_CLASSES[index % BAR_CLASSES.length]}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-foreground">{account.officeName}</span>
                    <span className="shrink-0 font-semibold text-navy">${fmt(monthlyRevenueOf(account) ?? 0)}</span>
                    <span className="w-10 shrink-0 text-right text-muted-foreground">
                      {Math.round(((monthlyRevenueOf(account) ?? 0) / 184200) * 100)}%
                    </span>
                  </li>
                ))}
              </ul>

              <p className="mt-4 border-t border-border pt-3 text-[10px] leading-relaxed text-muted-foreground">
                Unavailable values stay unavailable until an authoritative live source is connected.
              </p>
            </div>
          </SectionCard>

          <SectionCard
            title="Latest coach conversations"
            sub="Across all accounts"
            action={
              <Link href="/admin/conversations" className="inline-flex items-center gap-1 rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Open conversations
                <ArrowRight size={12} aria-hidden="true" />
              </Link>
            }
          >
            <ul>
              {latestConversations.map((conv) => {
                const patient = MOCK_PATIENTS.find((entry) => entry.id === conv.patientId);
                const account = accounts.find((entry) => entry.id === conv.accountId);
                return (
                  <li key={conv.id} className="border-b border-border last:border-b-0">
                    <Link
                      href={`/admin/conversations?c=${conv.id}`}
                      className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      data-testid={`link-hq-conversation-${conv.id}`}
                    >
                      <span className="min-w-0 flex-1">
                        <b className="block truncate text-xs font-semibold text-navy">{patient?.name ?? 'Patient'}</b>
                        <span className="block truncate text-[11px] text-muted-foreground">{conv.topic}</span>
                        <span className="mt-0.5 block text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground/80">
                          {account?.officeName}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{conv.startedLabel}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        </div>
      )}

      {(
        <div className="mt-5">
          <SectionCard
            title="Provider accounts"
            sub="Each office under the umbrella, linked by its onboarding code"
            action={
              <Link href="/admin/accounts" className="inline-flex items-center gap-1 rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Manage accounts
                <ArrowRight size={12} aria-hidden="true" />
              </Link>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                    <th className="px-5 py-3 font-bold">Office</th>
                    <th className="px-3 py-3 font-bold">Provider</th>
                    <th className="px-3 py-3 font-bold">Status</th>
                    <th className="px-3 py-3 text-right font-bold">Patients</th>
                    <th className="px-3 py-3 text-right font-bold">Monthly revenue</th>
                    <th className="px-5 py-3 text-right font-bold">Engagement</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => (
                    <tr key={account.id} className="border-b border-border transition hover:bg-accent/40 last:border-b-0">
                      <td className="px-5 py-3">
                        <Link href={`/admin/accounts/${account.id}`} className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid={`row-hq-account-${account.id}`}>
                          <b className="block text-xs font-semibold text-navy">{account.officeName}</b>
                          <small className="text-[10px] text-muted-foreground">{account.city}, {account.state}</small>
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-foreground">{account.providerName}</td>
                      <td className="px-3 py-3"><AccountStatusChip status={account.status} /></td>
                      <td className="px-3 py-3 text-right font-semibold text-navy">
                        {fmt(account.activePatientCount ?? 0)}
                      </td>
                      <td className="px-3 py-3 text-right text-foreground">
                        {monthlyRevenueOf(account) == null ? '—' : `$${fmt(monthlyRevenueOf(account)!)}`}
                      </td>
                      <td className="px-5 py-3 text-right text-foreground">
                        {account.engagementRate == null ? '—' : `${account.engagementRate}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      )}
    </AdminPage>
  );
}
