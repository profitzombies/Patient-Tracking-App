/**
 * HQ overview — the umbrella's front page.
 *
 * Every number is a rollup of the provider accounts, and the seeded accounts
 * partition the office demo's program totals exactly (patients 142+185+210+95
 * = 632, monthly revenue $41,500+$53,900+$61,300+$27,500 = $184,200), so this
 * page and the office desk can be shown side by side without a discrepancy.
 * Session-added accounts join with zeroes and can't disturb the rollup.
 * Anchored to the fixed demo date — no viewer-clock math.
 */
import { Link } from 'wouter';
import { ArrowRight } from 'lucide-react';
import { SectionCard } from '@/components/patient/heritage';
import { AccountStatusChip, AdminPage, MetricTile, PageHeader } from '@/components/admin/primitives';
import { useHqData } from '@/contexts/hq-data';
import { monthlyRevenueOf } from '@/data/hq/accounts';
import { getConversations } from '@/data/hq/conversations';
import { MOCK_PATIENTS } from '@/data/mock-data';
import { TODAY_KEY, formatDateKey } from '@/data/nutrition-data';
import { HQ_ADMIN_IDENTITY } from '@/data/hq/team';

const fmt = (value: number) => value.toLocaleString('en-US');
const round1 = (value: number) => Math.round(value * 10) / 10;

/** Stacked-bar palette — the cobalt ramp the office charts already use. */
const BAR_CLASSES = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4'];

export default function HqOverview() {
  const { accounts } = useHqData();

  const totalPatients = accounts.reduce((sum, account) => sum + account.activePatientCount, 0);
  const totalEnrollments = accounts.reduce((sum, account) => sum + account.newEnrollments, 0);
  const totalSubscriptions = accounts.reduce((sum, account) => sum + account.activeSubscriptions, 0);
  const totalDeliveries = accounts.reduce((sum, account) => sum + account.deliveriesInWindow, 0);
  const totalRecurring = accounts.reduce((sum, account) => sum + account.recurringRevenue, 0);
  const totalEnrollmentRevenue = accounts.reduce((sum, account) => sum + account.enrollmentRevenue, 0);
  const totalMonthly = totalRecurring + totalEnrollmentRevenue;
  // Weighted by patients so the rollup reproduces the program's 89.5%.
  const weightedEngagement =
    totalPatients > 0
      ? round1(accounts.reduce((sum, account) => sum + account.engagementRate * account.activePatientCount, 0) / totalPatients)
      : 0;

  const activeAccounts = accounts.filter((account) => account.status === 'active');
  const revenueAccounts = accounts.filter((account) => monthlyRevenueOf(account) > 0);

  const latestConversations = getConversations().slice(0, 3);

  return (
    <AdminPage>
      <PageHeader
        kicker="THINNR HQ"
        title={`Good morning, ${HQ_ADMIN_IDENTITY.name.split(' ')[0]}.`}
        sub={
          <>
            <span data-testid="text-hq-demo-date">{formatDateKey(TODAY_KEY, true)}</span> · Rollup across{' '}
            {accounts.length} provider accounts ({activeAccounts.length} active).
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Patients across accounts"
          value={fmt(totalPatients)}
          detail={`${fmt(totalEnrollments)} new enrollments this month`}
          testId="text-hq-patients"
        />
        <MetricTile
          label="Active subscriptions"
          value={fmt(totalSubscriptions)}
          detail="Recurring product deliveries in force"
          testId="text-hq-subscriptions"
        />
        <MetricTile
          label="Deliveries · demo window"
          value={fmt(totalDeliveries)}
          detail="Shipments across all offices, last 30 days"
          testId="text-hq-deliveries"
        />
        <MetricTile
          label="Avg engagement"
          value={`${weightedEngagement}%`}
          detail="Weekly app engagement, weighted by patients"
          testId="text-hq-engagement"
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,7fr),minmax(0,5fr)]">
        <SectionCard
          title="Monthly program revenue"
          sub="Across every provider account — reconciles with the office demo's headline."
        >
          <div className="px-5 py-4">
            <p className="font-serif text-[30px] font-bold leading-none tracking-[-.01em] text-navy" data-testid="text-hq-revenue">
              ${fmt(totalMonthly)}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              ${fmt(totalRecurring)} recurring subscriptions · ${fmt(totalEnrollmentRevenue)} new-enrollment revenue
            </p>

            {/* Share-of-revenue stacked bar: one segment per revenue-bearing account. */}
            <div className="mt-4 flex h-3 w-full overflow-hidden rounded-sm" role="img" aria-label="Monthly revenue share by provider account">
              {revenueAccounts.map((account, index) => (
                <span
                  key={account.id}
                  className={BAR_CLASSES[index % BAR_CLASSES.length]}
                  style={{ width: `${(monthlyRevenueOf(account) / totalMonthly) * 100}%` }}
                />
              ))}
            </div>
            <ul className="mt-3 space-y-1.5">
              {revenueAccounts.map((account, index) => (
                <li key={account.id} className="flex items-center gap-2 text-[11px]">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${BAR_CLASSES[index % BAR_CLASSES.length]}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{account.officeName}</span>
                  <span className="shrink-0 font-semibold text-navy">${fmt(monthlyRevenueOf(account))}</span>
                  <span className="w-10 shrink-0 text-right text-muted-foreground">
                    {Math.round((monthlyRevenueOf(account) / totalMonthly) * 100)}%
                  </span>
                </li>
              ))}
            </ul>

            <p className="mt-4 border-t border-border pt-3 text-[10px] leading-relaxed text-muted-foreground">
              The seeded accounts partition the program totals — the same {fmt(totalPatients)} patients and ${fmt(totalMonthly)}
              /month the office desk reports at the {formatDateKey(TODAY_KEY, true)} anchor.
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
                    <td className="px-3 py-3 text-right font-semibold text-navy">{fmt(account.activePatientCount)}</td>
                    <td className="px-3 py-3 text-right text-foreground">${fmt(monthlyRevenueOf(account))}</td>
                    <td className="px-5 py-3 text-right text-foreground">
                      {account.activePatientCount > 0 ? `${account.engagementRate}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>
    </AdminPage>
  );
}
