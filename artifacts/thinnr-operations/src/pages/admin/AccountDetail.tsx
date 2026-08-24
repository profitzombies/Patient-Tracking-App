/**
 * One provider account, in full — office profile, exact seeded metrics, a
 * roster preview, and the door into that office's own dashboard.
 *
 * The drill-in button is the umbrella's key move: it opens the existing
 * office screens scoped to this provider inside the admin shell. For
 * session-added accounts (zero patients) the button explains itself instead
 * of opening an empty dashboard — patients appear only after they onboard
 * with the office's code, which never happens inside the demo session.
 */
import { Link, useParams } from 'wouter';
import { ArrowLeft, ArrowRight, Copy, MessagesSquare } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { BTN_PRIMARY, BTN_SECONDARY, CHIP_COBALT, MICRO_LABEL, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { AccountStatusChip, AdminPage, PageHeader, copyText } from '@/components/admin/primitives';
import { useHqData } from '@/contexts/hq-data';
import { monthlyRevenueOf } from '@/data/hq/accounts';
import { getConversations } from '@/data/hq/conversations';
import { MOCK_PATIENTS } from '@/data/mock-data';
import { formatDateKey } from '@/data/nutrition-data';

const fmt = (value: number) => value.toLocaleString('en-US');

function Stat({ label, value, testId }: { label: string; value: React.ReactNode; testId?: string }) {
  return (
    <div className="rounded-md border border-border bg-paper-alt px-3.5 py-3">
      <p className={MICRO_LABEL}>{label}</p>
      <p className="mt-1 font-serif text-lg font-bold leading-none tracking-[-.01em] text-navy" data-testid={testId}>
        {value}
      </p>
    </div>
  );
}

export default function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const { findAccount } = useHqData();
  const { toast } = useToast();

  const account = findAccount(id);

  if (!account) {
    return (
      <AdminPage>
        <div className="mx-auto max-w-md rounded-lg border border-card-border bg-card px-6 py-10 text-center shadow-soft">
          <h1 className="font-serif text-lg font-bold text-navy">Account not found</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            This provider account doesn&rsquo;t exist in the demo session — it may have been created in another tab.
          </p>
          <Link href="/admin/accounts" className={`${BTN_SECONDARY} mt-5 h-9 px-3.5`} data-testid="link-back-to-accounts">
            <ArrowLeft size={14} aria-hidden="true" />
            Back to provider accounts
          </Link>
        </div>
      </AdminPage>
    );
  }

  const hasPatients = account.activePatientCount > 0;
  const rosterPreview = account.providerId
    ? MOCK_PATIENTS.filter((patient) => patient.providerId === account.providerId).slice(0, 5)
    : [];
  const conversationCount = getConversations(account.id).length;

  const copyCode = async () => {
    const landed = await copyText(account.providerCode);
    toast(
      landed
        ? { title: 'Provider code copied', description: `${account.providerCode} — the code patients type during mobile onboarding.` }
        : { title: 'Copy unavailable', description: 'Select the code text and copy it manually.' },
    );
  };

  return (
    <AdminPage>
      <Link href="/admin/accounts" className="mb-4 inline-flex items-center gap-1.5 rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="link-back-to-accounts">
        <ArrowLeft size={12} aria-hidden="true" />
        Provider accounts
      </Link>

      <PageHeader
        kicker="Provider account"
        title={account.officeName}
        sub={
          <>
            {account.providerName} · {account.providerRole} · {account.city}, {account.state} · Joined{' '}
            {formatDateKey(account.joinedKey, true)}
          </>
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <AccountStatusChip status={account.status} />
            <span className={CHIP_COBALT}>{account.plan} plan</span>
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        {hasPatients ? (
          <Link href={`/admin/accounts/${account.id}/office`} className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-open-office">
            Open office dashboard
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        ) : (
          // aria-disabled + toast instead of a swallowed click: the tap still
          // answers, it just explains why the door is closed.
          <button
            type="button"
            aria-disabled="true"
            className={`${BTN_PRIMARY} h-9 cursor-not-allowed px-3.5 opacity-50`}
            data-testid="button-open-office"
            onClick={() =>
              toast({
                title: 'No office dashboard yet',
                description: `The dashboard unlocks once patients onboard with code ${account.providerCode}.`,
              })
            }
          >
            Open office dashboard
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
        <Link href={`/admin/conversations?account=${account.id}`} className={`${BTN_SECONDARY} h-9 px-3.5`} data-testid="link-view-conversations">
          <MessagesSquare size={14} aria-hidden="true" />
          Coach conversations{conversationCount > 0 ? ` (${conversationCount})` : ''}
        </Link>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,7fr),minmax(0,5fr)]">
        <div className="space-y-5">
          <SectionCard
            title="Account metrics"
            sub={hasPatients ? 'Exact split of the program totals at the demo anchor' : 'Awaiting first patients'}
          >
            {hasPatients ? (
              <div className="grid gap-3 px-5 py-4 sm:grid-cols-3">
                <Stat label="Active patients" value={fmt(account.activePatientCount)} testId="text-account-patients" />
                <Stat label="New enrollments" value={fmt(account.newEnrollments)} />
                <Stat label="Monthly revenue" value={`$${fmt(monthlyRevenueOf(account))}`} testId="text-account-revenue" />
                <Stat label="Subscriptions" value={fmt(account.activeSubscriptions)} />
                <Stat label="Deliveries · 30d" value={fmt(account.deliveriesInWindow)} />
                <Stat label="Engagement" value={`${account.engagementRate}%`} />
                <Stat label="Avg pounds lost" value={account.avgPoundsLost} />
                <Stat label="Goal completion" value={`${account.goalCompletion}%`} />
                <Stat label="Retention" value={`${account.retention}%`} />
              </div>
            ) : (
              <p className="px-5 py-6 text-xs leading-relaxed text-muted-foreground">
                No metrics yet — this account was created during the demo session. Numbers begin once patients onboard in
                the mobile app with provider code <span className="font-mono tracking-[.08em] text-foreground">{account.providerCode}</span>.
              </p>
            )}
          </SectionCard>

          <SectionCard
            title="Roster preview"
            sub={
              hasPatients
                ? `First ${rosterPreview.length} of the office's tracked patients`
                : 'No patients linked yet'
            }
          >
            {rosterPreview.length > 0 ? (
              <>
                <ul>
                  {rosterPreview.map((patient) => (
                    <li key={patient.id} className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-b-0" data-testid={`row-roster-${patient.id}`}>
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-[10px] font-bold text-primary">
                        {patient.name.split(' ').map((word) => word[0]).slice(0, 2).join('')}
                      </span>
                      <span className="min-w-0 flex-1">
                        <b className="block truncate text-xs font-semibold text-navy">{patient.name}</b>
                        <small className="block truncate text-[10px] text-muted-foreground">{patient.email}</small>
                      </span>
                      <span className="shrink-0 text-[10px] uppercase tracking-[.06em] text-muted-foreground">{patient.status}</span>
                    </li>
                  ))}
                </ul>
                <p className="border-t border-border px-5 py-3 text-[10px] text-muted-foreground">
                  Open the office dashboard to work the full roster as this office sees it.
                </p>
              </>
            ) : (
              <p className="px-5 py-6 text-xs leading-relaxed text-muted-foreground">
                Patients appear here after they enter this office&rsquo;s provider code during mobile onboarding.
              </p>
            )}
          </SectionCard>
        </div>

        <SectionCard title="Office profile" sub="Contact and linking details">
          <div>
            <div className="border-b border-border px-5 py-4">
              <p className={PANEL_LABEL}>Provider code</p>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="font-mono text-xl font-bold tracking-[.18em] text-navy" data-testid="text-account-code">
                  {account.providerCode}
                </span>
                <button
                  type="button"
                  aria-label="Copy provider code"
                  className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                  data-testid="button-copy-code"
                  onClick={copyCode}
                >
                  <Copy size={12} aria-hidden="true" />
                  Copy
                </button>
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                Patients type this six-digit code during mobile onboarding to link their account to this office.
              </p>
            </div>
            {[
              { label: 'Email', value: account.email },
              { label: 'Phone', value: account.phone },
              { label: 'Location', value: `${account.city}, ${account.state}` },
              { label: 'Joined', value: formatDateKey(account.joinedKey, true) },
              { label: 'Plan', value: account.plan },
            ].map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-4 border-b border-border px-5 py-3 last:border-b-0">
                <span className={MICRO_LABEL}>{row.label}</span>
                <span className="min-w-0 truncate text-xs text-foreground">{row.value}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </AdminPage>
  );
}
