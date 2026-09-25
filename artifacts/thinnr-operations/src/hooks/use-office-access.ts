/**
 * The office's own THINNR access: what it owes, whether the workspace is
 * narrowed for nonpayment, and the action that pays it.
 *
 * Only the office's own staff read this. An HQ drill-in is never narrowed by
 * the office's billing state (HQ must still see and help the account), so the
 * query stays off whenever an office id is named explicitly.
 */
import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { officeRequest } from '@/lib/office-api';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import { officeBilling } from '@/lib/billing-api';
import type { OfficeAccessSlot, OfficeAccessSnapshot } from '@/lib/billing-types';
import { launchKey, type LaunchAccessSetup, type LaunchState } from '@/hooks/use-launch';

export interface OfficeAccessState {
  restricted: boolean;
  message: string | null;
  allowed_capabilities: string[] | null;
  share_percent: number;
  state: string | null;
  plan: string | null;
  price_cents: number | null;
  lifetime: boolean;
  included_period_ends_at: string | null;
  paid_through: string | null;
  grace_ends_at: string | null;
  restricted_at: string | null;
  setup_completed_at: string | null;
}

export interface OfficeAccessPayment extends OfficeAccessState {
  paid: boolean;
  pending: boolean;
}

const messages = {
  unconfigured: 'Account billing is not configured.',
  signedOut: 'Sign in to see your account status.',
  unreachable: 'Account status could not be reached. Try again.',
  failed: 'Account status could not be loaded',
};

export function officeAccessKey(user: string | null) {
  return ['office', 'access', user] as const;
}

/**
 * The setup snapshot is a different question from the narrowed state: what the
 * office still owes THINNR before it may use the workspace at all. HQ drill-ins
 * name an office, so the key carries it.
 */
export function officeAccessSetupKey(user: string | null, office: string | null) {
  return ['billing', 'office', 'access', 'setup', user, office] as const;
}

export function useOfficeAccess() {
  const scope = useLiveOfficeScope();
  return useQuery({
    queryKey: officeAccessKey(scope.authUserId),
    queryFn: () => officeRequest<OfficeAccessState>('/api/office/access', messages),
    // Own-office staff only: an HQ drill-in names an office and is not narrowed.
    enabled: scope.liveEnabled && scope.liveOffice === null,
    staleTime: 0,
    refetchInterval: 60_000,
  });
}

export function usePayOfficeAccess() {
  const scope = useLiveOfficeScope();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => officeRequest<OfficeAccessPayment>('/api/office/access/pay', {
      ...messages,
      failed: 'That payment could not be started',
    }, { method: 'POST' }),
    onSuccess: (data) => {
      client.setQueryData(officeAccessKey(scope.authUserId), data);
      // Recovery restores the whole workspace, so everything cached under the
      // narrowed surface must be asked again.
      if (!data.restricted) void client.invalidateQueries();
    },
  });
}

/** What the office still has to put in place before the workspace opens. */
export function useOfficeAccessSetup() {
  const scope = useLiveOfficeScope();
  return useQuery({
    queryKey: officeAccessSetupKey(scope.authUserId, scope.liveOffice),
    queryFn: () => officeBilling.access(scope.liveOffice),
    enabled: scope.liveEnabled,
    staleTime: 0,
    // Stripe reports onboarding progress by webhook; while the connection is
    // submitted but not ready, re-read so the status moves on its own.
    refetchInterval: (query) => {
      const state = query.state.data?.connect.state;
      return state === 'pending' || state === 'action_required' ? 20_000 : false;
    },
  });
}

type AccessPlan = 'monthly' | 'yearly';

/** The access snapshot a write answered with (some wrap it as `setup`). */
function snapshotOf(data: unknown): OfficeAccessSnapshot | null {
  if (!data || typeof data !== 'object') return null;
  if ('setup' in data) return (data as { setup: OfficeAccessSnapshot | null }).setup ?? null;
  return 'steps' in data ? data as OfficeAccessSnapshot : null;
}

/** Whether every step is far enough along (Stripe or bank still verifying counts). */
function allStepsSatisfied(steps: OfficeAccessSnapshot['steps']) {
  return steps.every((step) => step.status === 'done' || step.status === 'pending');
}

function withStepDone(snapshot: OfficeAccessSnapshot, id: OfficeAccessSnapshot['steps'][number]['id']): OfficeAccessSnapshot {
  const steps = snapshot.steps.map((step) => step.id === id ? { ...step, status: 'done' as const, detail: null } : step);
  return { ...snapshot, steps, complete: allStepsSatisfied(steps) };
}

/**
 * The plan as it will look once the server agrees. The office price follows
 * the list price of the new plan unless the office had a negotiated price
 * (its current price is not the list price of its current plan); that case is
 * left for the server's answer to settle.
 */
export function optimisticPlan(snapshot: OfficeAccessSnapshot, plan: AccessPlan): OfficeAccessSnapshot {
  const list = (choice: AccessPlan) => choice === 'monthly' ? snapshot.plan.monthlyPriceCents : snapshot.plan.yearlyPriceCents;
  const listPriced = snapshot.plan.priceCents === list(snapshot.plan.selected ?? 'monthly');
  const next = withStepDone(snapshot, 'plan');
  return { ...next, plan: { ...snapshot.plan, selected: plan, priceCents: listPriced ? list(plan) : snapshot.plan.priceCents } };
}

export function optimisticDisclosure(snapshot: OfficeAccessSnapshot, now = new Date()): OfficeAccessSnapshot {
  const next = withStepDone(snapshot, 'disclosure');
  return { ...next, disclosure: { ...snapshot.disclosure, acknowledgedAt: now.toISOString() } };
}

/** The launch snapshot's summary of the office's own payment setup, from an access snapshot. */
export function launchAccessSummary(snapshot: OfficeAccessSnapshot): LaunchAccessSetup {
  const held = new Set(snapshot.instruments.map((item) => item.slot));
  const missing = (['bank', 'card_primary', 'card_backup'] as const).filter((slot) => !held.has(slot));
  const planSelected = snapshot.plan.selected !== null;
  const disclosureAcknowledged = snapshot.disclosure.acknowledgedAt !== null;
  return {
    complete: missing.length === 0 && !snapshot.bank.overdue && planSelected && disclosureAcknowledged,
    missing, planSelected, disclosureAcknowledged,
    bankVerificationPending: snapshot.bank.verificationPending,
    bankVerificationDeadline: snapshot.bank.deadline,
    bankVerificationOverdue: snapshot.bank.overdue,
  };
}

/**
 * One click, one lock: a second press before the first write settles is
 * dropped, even inside the same frame (before `isPending` re-renders).
 */
function useGuarded<TVars>(mutation: { mutate: (vars: TVars, options?: { onSettled?: () => void }) => void }) {
  const lock = useRef(false);
  return (vars: TVars) => {
    if (lock.current) return;
    lock.current = true;
    mutation.mutate(vars, { onSettled: () => { lock.current = false; } });
  };
}

export function useOfficeAccessMutations() {
  const scope = useLiveOfficeScope();
  const client = useQueryClient();
  const key = officeAccessSetupKey(scope.authUserId, scope.liveOffice);
  const launch = launchKey(scope.authUserId, scope.liveOffice);
  /**
   * Every write answers with the fresh setup snapshot, so the page shows it at
   * once rather than re-reading. The practice-setup page's own copy of these
   * facts is patched in place; only a change that opens or closes the gate
   * re-reads it (its completion date is the server's to decide).
   */
  const apply = (data: unknown) => {
    const snapshot = snapshotOf(data);
    if (snapshot) {
      client.setQueryData(key, snapshot);
      let gateChanged = false;
      client.setQueryData<LaunchState>(launch, (current) => {
        if (!current) return current;
        const accessSetup = launchAccessSummary(snapshot);
        gateChanged = current.accessSetup?.complete !== accessSetup.complete;
        return { ...current, accessSetup };
      });
      if (gateChanged) void client.invalidateQueries({ queryKey: launch });
    } else {
      void client.invalidateQueries({ queryKey: key });
    }
    // The office payment status (narrowed workspace, balance) moves with these
    // writes too; it is one small read and only runs where it is shown.
    void client.invalidateQueries({ queryKey: officeAccessKey(scope.authUserId) });
  };
  /** Show the choice at once; put the old snapshot back if the server refuses it. */
  const optimistic = <TVars,>(change: (snapshot: OfficeAccessSnapshot, vars: TVars) => OfficeAccessSnapshot) => ({
    onMutate: async (vars: TVars) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<OfficeAccessSnapshot>(key);
      if (previous) client.setQueryData(key, change(previous, vars));
      return { previous };
    },
    onError: (_error: unknown, _vars: TVars, context: { previous?: OfficeAccessSnapshot } | undefined) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
  });
  const setupIntent = useMutation({ mutationFn: (slot: OfficeAccessSlot) => officeBilling.accessSetupIntent(slot, scope.liveOffice) });
  const instrument = useMutation({ mutationFn: (body: { slot: OfficeAccessSlot; paymentMethodId: string; setupIntentId?: string }) => officeBilling.accessInstrument(body, scope.liveOffice), onSuccess: apply });
  const plan = useMutation({
    mutationFn: (choice: AccessPlan) => officeBilling.accessPlan(choice, scope.liveOffice),
    ...optimistic<AccessPlan>((snapshot, choice) => optimisticPlan(snapshot, choice)),
    onSuccess: apply,
  });
  const disclosure = useMutation({
    mutationFn: (version: number) => officeBilling.accessDisclosure(version, scope.liveOffice),
    ...optimistic<number>((snapshot) => optimisticDisclosure(snapshot)),
    onSuccess: apply,
  });
  const bankVerify = useMutation({ mutationFn: () => officeBilling.accessBankVerify(scope.liveOffice), onSuccess: apply });
  const pay = useMutation({ mutationFn: () => officeBilling.accessPay(scope.liveOffice), onSuccess: apply });
  const choosePlan = useGuarded<AccessPlan>(plan);
  const acknowledge = useGuarded<number>(disclosure);
  const verifyBank = useGuarded<void>(bankVerify);
  const payBalance = useGuarded<void>(pay);
  return {
    setupIntent, instrument, plan, disclosure, bankVerify, pay,
    /** Guarded single-press entry points for buttons. */
    choosePlan, acknowledge, verifyBank, payBalance,
  };
}
