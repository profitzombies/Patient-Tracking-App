/**
 * One provider account, in full — Account metrics and the Roster preview side
 * by side as the two main columns, the Office profile beneath them, and (last,
 * deliberately separated) the danger zone where THINNR locks the account.
 *
 * The drill-in button opens the existing office shell under the canonical
 * provider id. Accounts without linked patients explain why it is unavailable.
 * Account identity, roster, staff, and lock state all come from live rows.
 * HQ keeps full visibility into a locked account — badges here and on the
 * accounts list — because the lock only shuts out the provider side.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { ArrowLeft, ArrowRight, Check, ChevronsUpDown, Copy, Edit2, Lock, MessagesSquare } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY, CHIP_COBALT, INPUT_CLASS, MICRO_LABEL, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { AccountLockedChip, AccountStatusChip, AdminPage, PageHeader, copyText } from '@/components/admin/primitives';
import { StaffAccessCard } from '@/components/admin/StaffAccessCard';
import { LegalHoldControls } from '@/components/admin/LegalHold';
import { OfficeBundleExport } from '@/components/admin/OfficeBundleExport';
import { OfficeOffboarding } from '@/components/admin/OfficeOffboarding';
import { AccountDangerZone } from '@/components/admin/AccountDangerZone';
import { AccountPaymentsCard, useAccountPayments } from '@/components/admin/AccountPaymentsCard';
import { OfficeRangeMetricsGrid } from '@/components/office/OfficeRangeMetricsGrid';
import { Sparkline } from '@/components/admin/Sparkline';
import { DateRangeControl } from '@/components/layout/DateRangeControl';
import { formatRangeLabel, useDateRange } from '@/contexts/date-range';
import { useSession } from '@/contexts/session';
import { formatPercent, hqOfficeRoot, seriesValues } from '@/lib/office-analytics';
import { useGetOfficeAnalytics, getGetOfficeAnalyticsQueryKey } from '@workspace/api-client-react';
import { useAccountLocks } from '@/contexts/account-locks';
import { useHqData } from '@/contexts/hq-data';
import { fetchProviderAccountDetail, ProviderAccountError, type UpdateProviderAccountInput } from '@/lib/provider-accounts';
import { formatDateKey } from '@/data/nutrition-data';
import { US_STATES, normalizeUsState, formatUsPhone, isValidUsPhone, isValidUsPostalCode, usStateName } from '@/lib/us-contact';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type AccountPlan, type ProviderAccount } from '@/data/hq/accounts';
import { useMutation } from '@tanstack/react-query';
import { officeRequest } from '@/lib/office-api';

function RegateAccount({ account }: { account: ProviderAccount }) {
  const { toast } = useToast();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);

  const launchQuery = useQuery({
    queryKey: ['office', 'launch', null, account.id],
    queryFn: () => officeRequest<{ version: number }>(`/api/office/launch?office=${account.id}`, { unconfigured: '', signedOut: '', unreachable: 'Could not load setup version.', failed: '' }),
    enabled: open
  });

  const regate = useMutation({
    mutationFn: (version: number) => officeRequest(`/api/office/launch/regate?office=${account.id}`, { unconfigured: '', signedOut: '', unreachable: 'Could not reach server.', failed: 'Could not require setup.' }, {
      method: 'POST', body: JSON.stringify({ expectedVersion: version })
    }),
    onSuccess: () => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: ['office', 'launch'] });
      toast({ variant: 'success', title: 'Setup required', description: 'The account must reconfirm setup and connect Stripe.' });
    },
    onError: (error) => {
      toast({ variant: 'destructive', title: 'Could not require setup', description: error instanceof Error ? error.message : 'Please try again.' });
    }
  });

  return (
    <div className="border-t border-border pt-4">
      <h4 className="mb-2 text-xs font-semibold text-navy">Require setup again</h4>
      <p className="mb-4 max-w-[68ch] text-xs leading-relaxed text-muted-foreground">
        Invalidates current setup confirmations and forces the office to complete the setup process again. This preserves their account and financial history.
      </p>
      <button
        type="button"
        className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}
        onClick={() => setOpen(true)}
      >
        Require setup again
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Require setup again for {account.officeName}?</DialogTitle>
            <DialogDescription>
              The office will lose access to operational features until they re-complete the setup and ensure Stripe is connected. Their account and financial history are preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <button
              type="button"
              className={`${BTN_SECONDARY} h-9 px-3.5`}
              onClick={() => setOpen(false)}
              disabled={regate.isPending || launchQuery.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${BTN_PRIMARY} h-9 px-4`}
              onClick={() => launchQuery.data && regate.mutate(launchQuery.data.version)}
              disabled={regate.isPending || launchQuery.isPending || launchQuery.isError}
            >
              {regate.isPending ? 'Saving…' : 'Require setup'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const PLANS: AccountPlan[] = ['Core', 'Plus', 'Concierge'];

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

/**
 * Live metrics for this office over the shared date range — the same figures
 * (and the same drill targets) as the HQ comparison table row.
 */
function OfficeRangeMetricsCard({ accountId }: { accountId: string }) {
  const { authUser } = useSession();
  const { range } = useDateRange();
  const params = { office: accountId, start: range.start, end: range.end };
  const analytics = useGetOfficeAnalytics(params, {
    query: { queryKey: [...getGetOfficeAnalyticsQueryKey(params), authUser?.id], retry: 1 },
  });
  const status = analytics.isPending ? 'loading' : analytics.isError ? 'error' : 'ready';
  const result = analytics.data;
  const metrics = result?.available ? result.metrics : null;
  return (
    <SectionCard
      title={`Office metrics · ${formatRangeLabel(range)}`}
      sub="Live figures for the selected range; each one opens the matching list in this office."
      action={<DateRangeControl />}
    >
      <OfficeRangeMetricsGrid
        status={status}
        result={result}
        rangeEnd={range.end}
        officeRoot={hqOfficeRoot(accountId)}
        onRetry={() => analytics.refetch()}
        testIdPrefix="account-range-metric"
      />
      {metrics && result && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-5 py-3 text-[11px] text-muted-foreground">
          <span data-testid="text-account-logging-adherence">
            Logging adherence <b className="font-semibold text-navy">{formatPercent(metrics.loggingAdherencePct)}</b>
          </span>
          <span data-testid="text-account-checkin-adherence">
            Check-in adherence <b className="font-semibold text-navy">{formatPercent(metrics.checkInAdherencePct)}</b>
          </span>
          <span className="inline-flex items-center gap-2">
            <span title="Rolling 7-day engaged patients, day by day across the range">Engaged trend</span>
            <Sparkline values={seriesValues(result.series, "engagedPatients")} label="rolling 7-day engaged patients" width={120} height={22} testId="sparkline-account-engaged" />
          </span>
        </div>
      )}
    </SectionCard>
  );
}

export default function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  // A provider visit owns all drawer, dialog, draft, and mutation UI state.
  return <ProviderAccountDetail key={id} id={id} />;
}

function ProviderAccountDetail({ id }: { id: string }) {
  const { findAccount, accountsStatus, updateAccount, canManageProviderAccounts } = useHqData();
  const { locks, isLocked, setAccountLock } = useAccountLocks();
  const { toast } = useToast();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [stateOpen, setStateOpen] = useState(false);
  const [form, setForm] = useState<UpdateProviderAccountInput>({
    officeName: '', providerName: '', providerRole: '', address1: '', address2: '', city: '', state: '', postalCode: '', plan: null, email: '', phone: ''
  });
  const [formError, setFormError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['provider-account-detail', id],
    queryFn: () => fetchProviderAccountDetail(id),
    enabled: accountsStatus !== 'unauthorized' && Boolean(id),
    retry: 1,
  });
  const account = detailQuery.data?.account ?? findAccount(id);
  const { tiles: payments } = useAccountPayments(account?.id);

  if (accountsStatus === 'unauthorized') {
    return (
      <AdminPage>
        <div className="mx-auto max-w-md rounded-lg border border-card-border bg-card px-6 py-10 text-center shadow-soft">
          <h1 className="font-serif text-lg font-bold text-navy">HQ account required</h1>
          <p className="mt-2 text-xs text-muted-foreground">Sign in with an active THINNR HQ account to view this provider account.</p>
        </div>
      </AdminPage>
    );
  }
  if (!account && (accountsStatus === 'loading' || detailQuery.isPending)) {
    return <AdminPage><p className="py-10 text-center text-xs text-muted-foreground">Loading live provider account…</p></AdminPage>;
  }
  if (detailQuery.isError && !account) {
    return (
      <AdminPage>
        <div className="mx-auto max-w-md rounded-lg border border-card-border bg-card px-6 py-10 text-center shadow-soft">
          <h1 className="font-serif text-lg font-bold text-navy">Account details unavailable</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            The live provider account could not be loaded. Try again before acting on this account.
          </p>
          <button type="button" className={`${BTN_SECONDARY} mt-5 h-9 px-3.5`} onClick={() => detailQuery.refetch()}>
            Try again
          </button>
        </div>
      </AdminPage>
    );
  }
  if (!account) {
    return (
      <AdminPage>
        <div className="mx-auto max-w-md rounded-lg border border-card-border bg-card px-6 py-10 text-center shadow-soft">
          <h1 className="font-serif text-lg font-bold text-navy">Account not found</h1>
          <p className="mt-2 text-xs text-muted-foreground">
             This provider account could not be found in the live directory.
          </p>
          <Link href="/admin/accounts" className={`${BTN_SECONDARY} mt-5 h-9 px-3.5`} data-testid="link-back-to-accounts">
            <ArrowLeft size={14} aria-hidden="true" />
            Back to provider accounts
          </Link>
        </div>
      </AdminPage>
    );
  }
  if (detailQuery.isError) {
    return (
      <AdminPage>
        <div className="mx-auto max-w-md rounded-lg border border-card-border bg-card px-6 py-10 text-center shadow-soft">
          <h1 className="font-serif text-lg font-bold text-navy">Account details unavailable</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            The provider directory loaded, but the live roster and staff details did not. Try again before acting on this account.
          </p>
          <button type="button" className={`${BTN_SECONDARY} mt-5 h-9 px-3.5`} onClick={() => detailQuery.refetch()}>
            Try again
          </button>
        </div>
      </AdminPage>
    );
  }

  const hasPatients = (account.activePatientCount ?? 0) > 0;
  const rosterPreview = detailQuery.data?.roster ?? [];

  const locked = isLocked(account.id);
  const lock = locks.get(account.id);
  const lockedSince = lock?.lockedAt
    ? new Date(lock.lockedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  const copyCode = async () => {
    if (!account.providerCode) return;
    const landed = await copyText(account.providerCode);
    toast(
      landed
        ? { variant: 'success', title: 'Provider code copied', description: `${account.providerCode} — the code patients type during mobile onboarding.` }
        : { variant: 'destructive', title: 'Copy unavailable', description: 'Select the code text and copy it manually.' },
    );
  };

  const confirmLock = async () => {
    setSaving(true);
    const landed = await setAccountLock(account.id, true);
    setSaving(false);
    setConfirmOpen(false);
    if (landed) {
      toast({
        variant: 'success',
        title: `${account.officeName} locked`,
        description: 'Provider and staff access is shut off until THINNR unlocks the account.',
      });
    }
  };

  const unlock = async () => {
    setSaving(true);
    const landed = await setAccountLock(account.id, false);
    setSaving(false);
    if (landed) {
      toast({
        variant: 'success',
        title: `${account.officeName} unlocked`,
        description: 'Office access is restored exactly as it was — nothing needed re-creating.',
      });
    }
  };

  const openEdit = () => {
    setForm({
      officeName: account.officeName,
      providerName: account.providerName,
      providerRole: account.providerRole,
      address1: account.address1 || '',
      address2: account.address2 || '',
      city: account.city,
      state: account.state,
      postalCode: account.postalCode || '',
      plan: account.plan,
      email: account.email,
      phone: account.phone ? formatUsPhone(account.phone) : '',
    });
    setFormError(null);
    setEditOpen(true);
  };

  const setField = (key: keyof UpdateProviderAccountInput) => (event: React.ChangeEvent<HTMLInputElement>) => {
    let value = event.target.value;
    if (key === 'phone') value = formatUsPhone(value);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submitEdit = async () => {
    if (saving) return;
    const officeName = form.officeName.trim();
    const providerName = form.providerName.trim();
    const address1 = form.address1.trim();
    const address2 = form.address2.trim();
    const city = form.city.trim();
    const state = normalizeUsState(form.state);
    const postalCode = form.postalCode.trim();
    const email = form.email.trim().toLowerCase();
    const phone = form.phone.trim();

    if (!officeName || !providerName || !address1 || !city || !state || !postalCode || !email || !phone) {
      setFormError('Office name, provider name, Address 1, City, State, ZIP, email, and phone are required.');
      return;
    }
    if (!isValidUsPostalCode(postalCode)) {
      setFormError('Please enter a valid 5-digit ZIP code.');
      return;
    }
    if (!isValidUsPhone(phone)) {
      setFormError('Please enter a valid 10-digit phone number.');
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      await updateAccount(account.id, {
        officeName, providerName,
        providerRole: form.providerRole.trim() || 'Practitioner',
        address1, address2, city, state, postalCode, plan: form.plan, email, phone,
      });
      toast({
        variant: 'success',
        title: 'Office details updated',
        description: 'Changes have been saved to the live directory.',
      });
      setEditOpen(false);
      detailQuery.refetch();
    } catch (cause) {
      setFormError(cause instanceof ProviderAccountError ? cause.message : 'The office details could not be updated.');
    } finally {
      setSaving(false);
    }
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
             {account.providerName} · {account.providerRole} · {[account.city, account.state ? usStateName(account.state) : ''].filter(Boolean).join(', ') || '—'} · Joined{' '}
            {formatDateKey(account.joinedKey, true)}
          </>
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {locked && <AccountLockedChip testId="chip-account-locked" />}
            <AccountStatusChip status={account.status} />
             <span className={CHIP_COBALT}>{account.plan ? `${account.plan} plan` : 'Plan —'}</span>
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <Link href={`/admin/accounts/${account.id}/office`} className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-open-office">
          Open office dashboard
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
         <Link href={`/admin/conversations?account=${account.id}`} className={`${BTN_SECONDARY} h-9 px-3.5`} data-testid="link-view-conversations">
          <MessagesSquare size={14} aria-hidden="true" />
           Coach conversations
        </Link>
      </div>

      <div className="mb-5">
        <OfficeRangeMetricsCard accountId={account.id} />
      </div>

      {/* The two main columns: metrics beside the roster, equal widths. */}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <SectionCard
          title="Account metrics"
           sub={hasPatients ? 'Live patient count; unsupported analytics remain unavailable' : 'Awaiting first patients'}
        >
          {hasPatients ? (
            // Two-up on phones, three-up from sm — the tiles fill the column
            // instead of leaving the old dead white space.
            <div className="grid grid-cols-2 gap-2.5 px-4 py-4 sm:grid-cols-3">
               <Stat label="Active patients" value={account.activePatientCount == null ? '—' : fmt(account.activePatientCount)} testId="text-account-patients" />
               <Stat label="New enrollments" value="—" />
               <Stat label="Collected · 30d" value={payments?.collected ?? '—'} testId="text-account-revenue" />
               <Stat label="Subscriptions" value={payments?.subscriptions ?? '—'} testId="text-account-subscriptions" />
               <Stat label="Orders · 30d" value={payments?.orders ?? '—'} testId="text-account-orders" />
               <Stat label="Engagement" value="—" />
               <Stat label="Avg pounds lost" value="—" />
               <Stat label="Goal completion" value="—" />
               <Stat label="Retention" value="—" />
            </div>
          ) : (
            <p className="px-5 py-6 text-xs leading-relaxed text-muted-foreground">
               No active patients are linked yet. Unsupported account analytics remain unavailable rather than estimated.
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

      {/* Payments: what this office has collected through Stripe and what THINNR earned. */}
      <div className="mt-5">
        <AccountPaymentsCard providerId={account.id} />
      </div>

      {/* Office profile spans the full measure beneath the two columns. */}
      <div className="mt-5">
        <SectionCard
          title="Office profile"
          sub="Contact and linking details"
          action={canManageProviderAccounts && (
            <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`} onClick={openEdit} data-testid="button-edit-office">
              <Edit2 size={12} aria-hidden="true" />
              Edit details
            </button>
          )}
        >
          <div className="md:grid md:grid-cols-[minmax(0,2fr),minmax(0,3fr)]">
            <div className="border-b border-border px-5 py-4 md:border-b-0 md:border-r">
              <p className={PANEL_LABEL}>Provider code</p>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="font-mono text-xl font-bold tracking-[.18em] text-navy" data-testid="text-account-code">
                   {account.providerCode ?? '—'}
                </span>
                 {account.providerCode && <button
                  type="button"
                  aria-label="Copy provider code"
                  className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                  data-testid="button-copy-code"
                  onClick={copyCode}
                >
                  <Copy size={12} aria-hidden="true" />
                  Copy
                 </button>}
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                Patients type this provider code during mobile onboarding to link their account to this office.
              </p>
            </div>
            <div>
              {[
                { label: 'Email', value: account.email },
                 { label: 'Office phone', value: account.phone ?? '—' },
                 { label: 'Address', value: [account.address1, account.address2].filter(Boolean).join(', ') || '—' },
                  { label: 'Location', value: [account.city, account.state ? usStateName(account.state) : '', account.postalCode].filter(Boolean).join(', ') || '—' },
                { label: 'Joined', value: formatDateKey(account.joinedKey, true) },
                 { label: 'Plan', value: account.plan ?? '—' },
              ].map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-4 border-b border-border px-5 py-3 last:border-b-0">
                  <span className={MICRO_LABEL}>{row.label}</span>
                  <span className="min-w-0 truncate text-xs text-foreground">{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Staff sign-ins — real office logins, provisioned from this page. */}
      <div className="mt-5">
         <StaffAccessCard account={account} staff={detailQuery.data?.staff ?? []} onCreated={() => detailQuery.refetch()} />
      </div>

      {/* Each action retains its own permission and server-availability rules. */}
      <AccountDangerZone status={locked && <AccountLockedChip testId="chip-danger-locked" />}>
        <OfficeOffboarding officeId={account.id} />
        <OfficeBundleExport officeId={account.id} officeName={account.officeName} />
        <LegalHoldControls targetKind="provider" targetId={account.id} providerId={account.id} label={account.officeName} />
        {canManageProviderAccounts && <RegateAccount account={account} />}
        <div className="border-t border-border pt-4">
          <h4 className="mb-2 text-xs font-semibold text-destructive">Account access</h4>
          {locked ? (
            <>
              <p className="mb-4 max-w-[68ch] text-xs leading-relaxed text-muted-foreground">
                THINNR locked this account{lockedSince ? ` on ${lockedSince}` : ''} — {account.providerName} and
                their staff can&rsquo;t use the office side right now, while HQ keeps full visibility. Unlocking
                restores access exactly as it was; nothing needs re-creating.
              </p>
              <button
                type="button"
                className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}
                data-testid="button-unlock-account"
                onClick={unlock}
                disabled={saving}
              >
                Unlock account
              </button>
            </>
          ) : (
            <>
              <p className="mb-4 max-w-[68ch] text-xs leading-relaxed text-muted-foreground">
                Locking this account shuts off the office side for {account.providerName} and every staff member —
                sign-ins land on a locked notice and the office&rsquo;s data stays closed until THINNR unlocks it.
                Nothing is deleted, and unlocking restores access exactly as it was.
              </p>
              <button
                type="button"
                className="h-8 rounded-md border border-destructive bg-card px-3 text-xs font-semibold text-destructive transition-colors hover:bg-destructive hover:text-white"
                data-testid="button-lock-account"
                onClick={() => setConfirmOpen(true)}
              >
                <Lock size={12} aria-hidden="true" className="mr-1.5 inline-block align-[-2px]" />
                Lock this account
              </button>
            </>
          )}
        </div>
      </AccountDangerZone>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-lock-confirm">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Lock {account.officeName}?</DialogTitle>
            <DialogDescription>
              {account.providerName} and all of their staff immediately lose access to the office side of THINNR —
              dashboard, roster, and training. Their data stays intact, and unlocking restores access exactly as it
              was.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <button
              type="button"
              className={`${BTN_SECONDARY} h-9 px-3.5`}
              data-testid="button-cancel-lock"
              onClick={() => setConfirmOpen(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-destructive px-4 text-xs font-semibold text-white transition-colors hover:bg-destructive/90 disabled:opacity-60"
              data-testid="button-confirm-lock"
              onClick={confirmLock}
              disabled={saving}
            >
              <Lock size={12} aria-hidden="true" />
              {saving ? 'Locking…' : 'Lock account'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Edit office profile</DialogTitle>
            <DialogDescription>
              Update contact and location details for {account.officeName}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className={PANEL_LABEL}>Office name *</span>
               <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.officeName} onChange={setField('officeName')} placeholder="e.g. Beacon Hill Aesthetics" data-testid="input-edit-office" />
            </label>
            <label className="block">
              <span className={PANEL_LABEL}>Provider name *</span>
               <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.providerName} onChange={setField('providerName')} placeholder="e.g. Dr. Maya Brooks" data-testid="input-edit-provider" />
            </label>
            <label className="block">
              <span className={PANEL_LABEL}>Provider role</span>
               <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.providerRole} onChange={setField('providerRole')} placeholder="e.g. Medical Director" data-testid="input-edit-role" />
            </label>

            <label className="block sm:col-span-2">
              <span className={PANEL_LABEL}>Address 1 *</span>
               <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.address1} onChange={setField('address1')} placeholder="e.g. 123 Main St" data-testid="input-edit-address1" />
            </label>
            <label className="block sm:col-span-2">
              <span className={PANEL_LABEL}>Address 2</span>
               <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.address2} onChange={setField('address2')} placeholder="e.g. Suite 200" data-testid="input-edit-address2" />
            </label>

            <label className="block sm:col-span-2">
              <span className={PANEL_LABEL}>City *</span>
               <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.city} onChange={setField('city')} placeholder="e.g. Boston" data-testid="input-edit-city" />
            </label>

            <div className="block">
              <span className={PANEL_LABEL}>State *</span>
              <Popover open={stateOpen} onOpenChange={setStateOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    role="combobox"
                    aria-expanded={stateOpen}
                     className={`${INPUT_CLASS} mt-1 flex h-9 w-full items-center justify-between px-3 text-xs ${!form.state && 'text-muted-foreground'}`}
                    data-testid="select-edit-state"
                  >
                    {form.state ? US_STATES.find(s => s.abbr === form.state)?.name || form.state : "Select state..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[200px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search state..." className="h-9 text-xs" />
                    <CommandList>
                      <CommandEmpty>No state found.</CommandEmpty>
                      <CommandGroup>
                        {US_STATES.map((state) => (
                          <CommandItem
                            key={state.abbr}
                            value={`${state.name} ${state.abbr}`}
                            onSelect={() => {
                              setForm(c => ({ ...c, state: state.abbr }));
                              setStateOpen(false);
                            }}
                            className="text-xs"
                          >
                            {state.name}
                            <Check
                              className={`ml-auto h-4 w-4 ${form.state === state.abbr ? "opacity-100" : "opacity-0"}`}
                            />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <label className="block">
              <span className={PANEL_LABEL}>ZIP Code *</span>
               <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.postalCode} onChange={setField('postalCode')} placeholder="e.g. 02108" maxLength={10} data-testid="input-edit-zip" />
            </label>

            <label className="block">
              <span className={PANEL_LABEL}>Email *</span>
               <input type="email" required className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.email} onChange={setField('email')} placeholder="frontdesk@office.example.com" data-testid="input-edit-email" />
            </label>
            <label className="block">
              <span className={PANEL_LABEL}>Office phone *</span>
               <input type="tel" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.phone} onChange={setField('phone')} placeholder="(555) 000-0000" data-testid="input-edit-phone" />
            </label>

            <div className="block sm:col-span-2">
              <span className={PANEL_LABEL}>Plan</span>
              <Select value={form.plan || ''} onValueChange={(value) => setForm(c => ({ ...c, plan: value as AccountPlan }))}>
                <SelectTrigger className="mt-1 h-9 text-xs" data-testid="select-edit-plan">
                  <SelectValue placeholder="No plan selected" />
                </SelectTrigger>
                <SelectContent>
                  {PLANS.map((option) => (
                    <SelectItem key={option} value={option} className="text-xs">{option}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {formError && <p role="alert" className="text-xs font-semibold text-destructive" data-testid="text-edit-form-error">{formError}</p>}
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setEditOpen(false)}>
              Cancel
            </button>
            <button type="button" disabled={saving} className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-edit-save" onClick={submitEdit}>
               {saving ? 'Saving…' : 'Save changes'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}
