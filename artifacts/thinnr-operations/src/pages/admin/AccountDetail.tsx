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
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { ArrowLeft, ArrowRight, Copy, Lock, MessagesSquare } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY, CHIP_COBALT, MICRO_LABEL, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { AccountLockedChip, AccountStatusChip, AdminPage, PageHeader, copyText } from '@/components/admin/primitives';
import { StaffAccessCard } from '@/components/admin/StaffAccessCard';
import { useAccountLocks } from '@/contexts/account-locks';
import { useHqData } from '@/contexts/hq-data';
import { fetchProviderAccountDetail } from '@/lib/provider-accounts';
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
  const { findAccount, accountsStatus } = useHqData();
  const { locks, isLocked, setAccountLock } = useAccountLocks();
  const { toast } = useToast();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const detailQuery = useQuery({
    queryKey: ['provider-account-detail', id],
    queryFn: () => fetchProviderAccountDetail(id),
    enabled: accountsStatus === 'ready' && Boolean(id),
  });
  const account = detailQuery.data?.account ?? findAccount(id);

  if (!account && (accountsStatus === 'loading' || detailQuery.isPending)) {
    return <AdminPage><p className="py-10 text-center text-xs text-muted-foreground">Loading live provider account…</p></AdminPage>;
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

  const lockable = true;
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
             {account.providerName} · {account.providerRole} · {[account.city, account.state].filter(Boolean).join(', ') || '—'} · Joined{' '}
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
                 description: account.providerCode ? `The dashboard unlocks once patients onboard with code ${account.providerCode}.` : 'This account does not have an onboarding code yet.',
              })
            }
          >
            Open office dashboard
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
         <Link href={`/admin/conversations?account=${account.id}`} className={`${BTN_SECONDARY} h-9 px-3.5`} data-testid="link-view-conversations">
          <MessagesSquare size={14} aria-hidden="true" />
           Coach conversations
        </Link>
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
               <Stat label="Monthly revenue" value="—" testId="text-account-revenue" />
               <Stat label="Subscriptions" value="—" />
               <Stat label="Deliveries · 30d" value="—" />
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

      {/* Office profile spans the full measure beneath the two columns. */}
      <div className="mt-5">
        <SectionCard title="Office profile" sub="Contact and linking details">
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
                 { label: 'Location', value: [account.city, account.state].filter(Boolean).join(', ') || '—' },
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

      {/* Danger zone — the page's very last section, clearly separated.
          Styled to match the training video editor's danger zone. */}
      {lockable && (
        <section
          className="mt-6 rounded-lg border border-destructive/30 bg-[#fff0f0]/30 p-5 shadow-sm"
          data-testid="section-danger-zone"
        >
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-destructive">Danger zone</h3>
            {locked && <AccountLockedChip testId="chip-danger-locked" />}
          </div>
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
        </section>
      )}

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
    </AdminPage>
  );
}
