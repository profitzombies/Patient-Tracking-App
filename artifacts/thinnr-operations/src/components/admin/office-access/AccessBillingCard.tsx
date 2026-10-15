/**
 * Office access billing on the HQ account page: what this office pays THINNR
 * for the platform itself, as opposed to the Payments card above it, which is
 * the money the office takes from its own patients.
 *
 * The panel holds its frame while the account loads, the way the other HQ
 * drill-in screens do, and an office no subscription work has touched yet
 * says exactly that rather than showing zeros.
 */
import { useState } from 'react';
import { ArrowRight, Clock } from 'lucide-react';
import { Link } from 'wouter';
import { BTN_SECONDARY, INSET, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { StatusPill } from '@/components/billing/primitives';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/contexts/session';
import { canHq } from '@/data/hq/team';
import { useHqBillingScope, useHqOfficeAccess } from '@/hooks/use-billing';
import { formatCents, formatDate, formatDateTime } from '@/lib/billing-format';
import {
  ACCESS_STATE_MEANING,
  PAID_THROUGH_SOURCE_LABELS,
  PLAN_LABELS,
  SLOT_LABELS,
  accessStateLabel,
  accessStateTone,
  boardState,
} from '@/lib/office-access';
import type {
  OfficeAccessAttempt,
  OfficeAccessDetail,
  OfficeAccessHistoryEntry,
  OfficeAccessInstrumentRow,
} from '@/lib/billing-types';
import { AccessActionDialog, type AccessActionKind } from './AccessActions';

/** The history events worth a sentence of their own; anything else reads as itself. */
const EVENT_LABELS: Record<string, string> = {
  created: 'Subscription created',
  setup_completed: 'Payment setup completed',
  included_period_set: 'Included period changed',
  included_period_reset: 'Trial reset',
  terms_changed: 'Plan or price changed',
  paid_through_recorded: 'Paid-through recorded',
  offline_payment: 'Offline payment recorded',
  charge_succeeded: 'Charge succeeded',
  charge_failed: 'Charge failed',
  grace_started: 'Recovery window started',
  dunning_notice: 'Recovery notice',
  restricted: 'Office restricted',
  reinstated: 'Access restored',
  instrument_added: 'Payment method added',
  instrument_removed: 'Payment method removed',
};

const ACTOR_LABELS: Record<string, string> = {
  system: 'Automatic',
  hq: 'HQ',
  provider: 'Office',
  team_member: 'Office teammate',
  stripe: 'Stripe',
};

function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event.replace(/_/g, ' ').replace(/^./, (char) => char.toUpperCase());
}

function DataRow({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border px-5 py-2.5 last:border-b-0">
      <p className={PANEL_LABEL}>{label}</p>
      <div className="text-xs text-foreground" data-testid={testId}>{children}</div>
    </div>
  );
}

function ActionButton({ label, testId, onClick }: { label: string; testId: string; onClick: () => void }) {
  return (
    <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} onClick={onClick} data-testid={testId}>
      {label}
    </button>
  );
}

function Instruments({ instruments, setup }: { instruments: OfficeAccessInstrumentRow[]; setup: OfficeAccessDetail['setup'] }) {
  const live = instruments.filter((instrument) => !instrument.removedAt);
  if (!live.length) {
    return (
      <p className="px-5 py-4 text-xs leading-relaxed text-muted-foreground" data-testid="text-access-no-instruments">
        Nothing on file. The office adds its own bank account and cards at first sign-in — HQ cannot add them for it.
      </p>
    );
  }
  return (
    <div className="space-y-2 px-5 py-4">
      {live.map((instrument) => (
        <div key={instrument.id} className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid={`row-access-instrument-${instrument.slot}`}>
          <span className="text-foreground">
            <b className="font-semibold">{SLOT_LABELS[instrument.slot]}</b>
            {' · '}
            {instrument.kind === 'bank'
              ? `${instrument.bankName ?? 'Bank'} ••${instrument.last4 ?? '••'}`
              : `${instrument.brand ?? 'Card'} ••${instrument.last4 ?? '••'}${instrument.expMonth && instrument.expYear ? ` · ${String(instrument.expMonth).padStart(2, '0')}/${String(instrument.expYear).slice(-2)}` : ''}`}
          </span>
          <StatusPill tone={instrument.verificationStatus === 'verified' ? 'good' : instrument.verificationStatus === 'pending' ? 'warn' : 'bad'}>
            {instrument.verificationStatus}
          </StatusPill>
        </div>
      ))}
      {setup && !setup.complete && (
        <p className="text-[11px] leading-relaxed text-[#b65c22]" data-testid="text-access-setup-missing">
          Still missing: {setup.missing.map((slot) => SLOT_LABELS[slot]).join(', ')}. The office completes this itself at sign-in.
        </p>
      )}
      {setup?.bankVerificationPending && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Bank verification {setup.bankVerificationOverdue ? 'is overdue' : `is due by ${formatDate(setup.bankVerificationDeadline)}`}.
        </p>
      )}
    </div>
  );
}

function Attempts({ attempts }: { attempts: OfficeAccessAttempt[] }) {
  if (!attempts.length) {
    return <p className="px-5 py-4 text-xs text-muted-foreground" data-testid="text-access-no-attempts">No access charge has been attempted yet.</p>;
  }
  return (
    <ul className="px-5 py-2">
      {attempts.slice(0, 6).map((attempt) => (
        <li key={attempt.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border py-2 last:border-b-0" data-testid={`row-access-attempt-${attempt.id}`}>
          <span className="text-xs text-foreground">
            {formatCents(attempt.amountCents)} · {SLOT_LABELS[attempt.slot]} · attempt {attempt.cycle}
          </span>
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {formatDateTime(attempt.failedAt ?? attempt.settledAt ?? attempt.createdAt)}
            <StatusPill tone={attempt.status === 'succeeded' ? 'good' : attempt.status === 'failed' ? 'bad' : 'info'}>{attempt.status}</StatusPill>
          </span>
          {attempt.status === 'failed' && (attempt.failureMessage || attempt.failureCode) && (
            <span className="w-full text-[11px] text-destructive" data-testid={`text-access-attempt-failure-${attempt.id}`}>
              {attempt.failureMessage || attempt.failureCode}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function History({ history }: { history: OfficeAccessHistoryEntry[] }) {
  if (!history.length) {
    return <p className="px-5 py-4 text-xs text-muted-foreground" data-testid="text-access-no-history">Nothing has changed on this office's access yet.</p>;
  }
  return (
    <ul className="px-5 py-2">
      {history.slice(0, 12).map((entry) => (
        <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border py-2 last:border-b-0" data-testid={`row-access-history-${entry.id}`}>
          <span className="text-xs text-foreground">{eventLabel(entry.event)}</span>
          <span className="text-[11px] text-muted-foreground">
            {entry.actorName ?? ACTOR_LABELS[entry.actorKind] ?? entry.actorKind} · {formatDateTime(entry.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AccountAccessBillingCard({ providerId }: { providerId: string }) {
  const { hqRole } = useSession();
  const scope = useHqBillingScope();
  const allowed = scope.liveEnabled && canHq(hqRole, 'payments');
  const query = useHqOfficeAccess(allowed ? providerId : null);
  const [action, setAction] = useState<AccessActionKind | null>(null);

  if (!allowed) return null;

  const data = query.data;
  const terms = data?.subscription ?? null;
  const state = boardState({ state: terms?.state ?? null });

  return (
    <SectionCard
      title="Office access"
      sub="What this office pays THINNR for the platform, and the dates that decide its access"
      action={
        <Link href="/admin/payments/office-access" className={`${BTN_SECONDARY} h-8 px-3`} data-testid="link-access-board">
          Billing board
          <ArrowRight size={13} aria-hidden="true" />
        </Link>
      }
    >
      {query.isPending ? (
        <div className="space-y-3 p-4" role="status" aria-label="Loading office access">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : query.isError ? (
        <div role="alert" className="m-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive">
          {query.error instanceof Error ? query.error.message : 'Office access could not be loaded.'}{' '}
          <button type="button" className="ml-1 underline" onClick={() => void query.refetch()}>
            Try again
          </button>
        </div>
      ) : data ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <StatusPill tone={accessStateTone(terms?.state ?? null)} testId="chip-access-state">
                  {accessStateLabel(terms?.state ?? null)}
                </StatusPill>
                {terms?.lifetime && <StatusPill tone="info" testId="chip-access-lifetime">Lifetime</StatusPill>}
              </div>
              <p className="mt-1.5 max-w-[60ch] text-[11px] leading-relaxed text-muted-foreground" data-testid="text-access-state-meaning">
                {ACCESS_STATE_MEANING[state]}
              </p>
              <p className="mt-1 max-w-[60ch] text-[11px] leading-relaxed text-muted-foreground" data-testid="text-access-kind-window">
                {data.office.officeKind === 'software'
                  ? `Software-only office: ${data.policy.includedPeriodDays} days free from the owner's first sign-in, then the standard price.`
                  : `THINNR reseller: ${data.policy.includedPeriodDays} days free from the owner's first sign-in, then the standard price.`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ActionButton label="Included period" testId="button-access-included" onClick={() => setAction('included-period')} />
              <ActionButton label="Reset trial" testId="button-access-reset" onClick={() => setAction('reset-trial')} />
              <ActionButton label="Price" testId="button-access-price" onClick={() => setAction('price')} />
              <ActionButton label="Paid through" testId="button-access-paid-through" onClick={() => setAction('paid-through')} />
              <ActionButton label="Offline payment" testId="button-access-offline" onClick={() => setAction('offline-payment')} />
            </div>
          </div>

          <div>
            <DataRow label="Plan & price" testId="text-access-price">
              {terms?.plan ? (
                <>
                  {PLAN_LABELS[terms.plan]} · {formatCents(terms.priceCents)}
                  {terms.priceCentsOverride !== null && <span className="ml-2 text-[11px] text-muted-foreground">own price</span>}
                </>
              ) : (
                <span className="text-muted-foreground">Not set</span>
              )}
            </DataRow>
            <DataRow label="Included period ends" testId="text-access-included-ends">
              {terms?.lifetime ? 'Never — lifetime access' : terms?.includedPeriodEndsAt ? formatDate(terms.includedPeriodEndsAt) : <span className="text-muted-foreground">—</span>}
            </DataRow>
            <DataRow label="Paid through" testId="text-access-paid-through">
              {terms?.paidThrough ? (
                <>
                  {formatDate(terms.paidThrough)}
                  {terms.paidThroughSource && (
                    <span className="ml-2 text-[11px] text-muted-foreground" data-testid="text-access-paid-source">
                      {PAID_THROUGH_SOURCE_LABELS[terms.paidThroughSource]}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </DataRow>
            <DataRow label="Next charge" testId="text-access-next-charge">
              {terms?.lifetime ? 'None' : terms?.nextChargeAt ? formatDate(terms.nextChargeAt) : <span className="text-muted-foreground">—</span>}
            </DataRow>
            {terms?.graceEndsAt && (
              <DataRow label="Recovery window ends" testId="text-access-grace">
                <span className="inline-flex items-center gap-1.5">
                  <Clock size={12} aria-hidden="true" />
                  {formatDate(terms.graceEndsAt)}
                  {terms.graceDaysLeft !== null && <span className="text-[11px] text-muted-foreground">{terms.graceDaysLeft} days left</span>}
                </span>
              </DataRow>
            )}
            {terms?.restrictedAt && (
              <DataRow label="Restricted since" testId="text-access-restricted-since">{formatDate(terms.restrictedAt)}</DataRow>
            )}
          </div>

          {!terms && (
            <p className="px-5 py-4 text-xs leading-relaxed text-muted-foreground" data-testid="text-access-not-started">
              No access subscription exists for this office yet. Grant an included period or record what it has already paid to start one — its own bank account and cards are still added by the office at first sign-in.
            </p>
          )}

          <div className={`${INSET} mx-5 my-4 overflow-hidden`}>
            <p className={`${PANEL_LABEL} border-b border-border px-5 py-2.5`}>Payment methods on file</p>
            <Instruments instruments={data.instruments} setup={data.setup} />
          </div>

          <div className={`${INSET} mx-5 mb-4 overflow-hidden`}>
            <p className={`${PANEL_LABEL} border-b border-border px-5 py-2.5`}>Recent billing attempts</p>
            <Attempts attempts={data.attempts} />
          </div>

          <div className={`${INSET} mx-5 mb-5 overflow-hidden`}>
            <p className={`${PANEL_LABEL} border-b border-border px-5 py-2.5`}>Access change history</p>
            <History history={data.history} />
          </div>

          <AccessActionDialog
            providerId={providerId}
            officeName={data.office.officeName}
            action={action}
            terms={terms}
            policy={data.policy}
            onClose={() => setAction(null)}
          />
        </>
      ) : null}
    </SectionCard>
  );
}
