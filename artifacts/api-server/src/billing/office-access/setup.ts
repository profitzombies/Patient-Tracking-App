/**
 * The office's own payment setup with THINNR, as the setup gate sees it.
 *
 * The engine (state/instruments/charge) decides what an office is charged and
 * when. This module answers a narrower question that the gate asks on every
 * request: has this office finished putting its money arrangements in place?
 *
 * Deliberately knows nothing about the office's CONNECTED Stripe account —
 * that is the other direction of money (patients paying the office) and the
 * practice-launch gate already owns it. Keeping the two apart also keeps this
 * module free of a cycle with `practice-launch/state`.
 */
import { loadOrgPolicy } from "../../lib/org-policy";
import { accessPriceCents, periodEnd } from "./state";
import {
  accessSetupStatus,
  listAccessInstruments,
  recordBankVerification,
  WATERFALL_SLOTS,
  type AccessSetupStatus,
} from "./instruments";
import { getStripe } from "../stripe-client";
import { loadAccessBillingSettings, BANK_VERIFICATION_WINDOW_HOURS } from "./settings";
import { ensureAccessSubscription, recordAccessEvent, refreshAccessState, type AccessActor } from "./subscription";
import { update, type BillingOfficeAccessInstrumentRow as Instrument, type BillingOfficeAccessSubscriptionRow as Row, type OfficeAccessPlan, type OfficeAccessSlot } from "../store";

export class AccessSetupError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) { super(message); }
}

function q(value: string): string { return encodeURIComponent(value); }
function iso(value: Date | null): string | null { return value ? value.toISOString() : null; }

/** Everything the gate needs about one office, derived fresh. */
export interface AccessGateFacts {
  row: Row;
  instruments: Instrument[];
  status: AccessSetupStatus;
  /** The office actively chose monthly or yearly (the column has a default). */
  planSelected: boolean;
  disclosureAcknowledged: boolean;
  /** True when every requirement the gate owns is satisfied. */
  satisfied: boolean;
}

export async function accessGateFacts(providerId: string, now = new Date()): Promise<AccessGateFacts> {
  const row = await ensureAccessSubscription(providerId);
  const instruments = await listAccessInstruments(row.id);
  const status = accessSetupStatus(instruments, now);
  const planSelected = Boolean(row.plan_selected_at);
  const disclosureAcknowledged = Boolean(row.disclosure_acknowledged_at);
  return {
    row, instruments, status, planSelected, disclosureAcknowledged,
    // A bank account awaiting microdeposits does NOT block the office — until
    // its 48-hour window runs out, at which point the block returns.
    satisfied: status.complete && !status.bankVerificationOverdue && planSelected && disclosureAcknowledged,
  };
}

/**
 * The one predicate the launch gate consumes. Fails closed: if the
 * subscription cannot be read, the caller's error path keeps the office out.
 */
export async function accessGateSatisfied(providerId: string, now = new Date()): Promise<boolean> {
  return (await accessGateFacts(providerId, now)).satisfied;
}

export interface AccessInstrumentView {
  slot: OfficeAccessSlot;
  kind: "bank" | "card";
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  bankName: string | null;
  verificationStatus: Instrument["verification_status"];
  verificationDeadline: string | null;
  addedAt: string;
}

function instrumentView(row: Instrument): AccessInstrumentView {
  return {
    slot: row.slot, kind: row.kind, brand: row.brand, last4: row.last4,
    expMonth: row.exp_month, expYear: row.exp_year, bankName: row.bank_name,
    verificationStatus: row.verification_status, verificationDeadline: row.verification_deadline,
    addedAt: row.created_at,
  };
}

export type AccessStepId = "connect" | "bank" | "card_primary" | "card_backup" | "plan" | "disclosure";
export type AccessStepStatus = "done" | "pending" | "todo" | "blocked";

export interface AccessSetupStep {
  id: AccessStepId;
  status: AccessStepStatus;
  /** Short, plain reason a step is not done yet; null once it is. */
  detail: string | null;
}

/** What the connected-account side of setup looks like to this surface. */
export type ConnectState = "not_started" | "action_required" | "pending" | "ready";

export interface AccessSetupSnapshot {
  office: { providerId: string; officeName: string | null };
  /** Everything the office must do before the dashboard opens. */
  complete: boolean;
  /** The Stripe connection was already in place before this gate shipped. */
  connectAlreadyDone: boolean;
  steps: AccessSetupStep[];
  connect: { state: ConnectState; sandbox: boolean };
  instruments: AccessInstrumentView[];
  plan: {
    selected: OfficeAccessPlan | null;
    monthlyPriceCents: number;
    yearlyPriceCents: number;
    /** What this office will actually be charged (an HQ override wins). */
    priceCents: number;
    /** When the included period ends and the first access charge lands. */
    firstChargeAt: string | null;
    includedPeriodDays: number;
    /** The period the first charge buys, so the screen can say what follows. */
    nextPeriodEndsAt: string | null;
  };
  disclosure: { text: string; version: number; acknowledgedAt: string | null };
  bank: {
    verificationPending: boolean;
    deadline: string | null;
    overdue: boolean;
    windowHours: number;
    /** Stripe's own hosted microdeposit page: the amounts never reach us. */
    verificationUrl: string | null;
  };
  balance: {
    state: Row["state"];
    /** Set while the office owes an access payment it can settle now. */
    outstanding: boolean;
    amountCents: number;
    graceEndsAt: string | null;
  };
  /** Any office staff member may manage instruments; only the owner may
   *  choose the plan and accept the disclosure. */
  canManage: boolean;
  canChoosePlan: boolean;
}

function stepFor(id: AccessStepId, done: boolean, detail: string | null, status?: AccessStepStatus): AccessSetupStep {
  return { id, status: status ?? (done ? "done" : "todo"), detail: done ? null : detail };
}

export interface SnapshotInput {
  providerId: string;
  officeName?: string | null;
  connect: ConnectState;
  sandbox: boolean;
  canManage: boolean;
  canChoosePlan: boolean;
  now?: Date;
}

export async function accessSetupSnapshot(input: SnapshotInput): Promise<AccessSetupSnapshot> {
  const now = input.now ?? new Date();
  const facts = await accessGateFacts(input.providerId, now);
  const row = await refreshAccessState(facts.row, now);
  const [policy, settings] = await Promise.all([loadOrgPolicy(), loadAccessBillingSettings()]);
  const bySlot = new Map(facts.instruments.map((item) => [item.slot, item]));
  const bank = bySlot.get("bank");

  const firstChargeAt = row.paid_through ?? row.included_period_ends_at ?? null;
  const priceCents = accessPriceCents(row, settings);
  const connectDone = input.connect === "ready";

  const steps: AccessSetupStep[] = [
    stepFor("connect", connectDone, input.connect === "pending"
      ? "Stripe is still verifying your account."
      : "Connect Stripe so your patients can pay you.",
      connectDone ? "done" : input.connect === "pending" ? "pending" : "todo"),
    stepFor("bank",
      Boolean(bank) && !facts.status.bankVerificationOverdue,
      facts.status.bankVerificationOverdue
        ? "Your bank account was not verified in time. Verify it or add a different account."
        : "Add the bank account THINNR debits for your access fee.",
      bank
        ? facts.status.bankVerificationOverdue ? "blocked" : bank.verification_status === "pending" ? "pending" : "done"
        : "todo"),
    stepFor("card_primary", bySlot.has("card_primary"), "Add the first backup credit card."),
    stepFor("card_backup", bySlot.has("card_backup"), "Add a second, different credit card."),
    stepFor("plan", facts.planSelected, "Choose monthly or yearly billing."),
    stepFor("disclosure", facts.disclosureAcknowledged, "Read and accept the access fee terms."),
  ];

  return {
    office: { providerId: input.providerId, officeName: input.officeName ?? null },
    complete: facts.satisfied && connectDone,
    connectAlreadyDone: connectDone,
    steps,
    connect: { state: input.connect, sandbox: input.sandbox },
    instruments: WATERFALL_SLOTS.flatMap((slot) => {
      const item = bySlot.get(slot);
      return item ? [instrumentView(item)] : [];
    }),
    plan: {
      selected: facts.planSelected ? row.plan : null,
      monthlyPriceCents: settings.monthlyPriceCents,
      yearlyPriceCents: settings.yearlyPriceCents,
      priceCents,
      firstChargeAt,
      includedPeriodDays: settings.includedPeriodDays,
      nextPeriodEndsAt: firstChargeAt ? iso(periodEnd(row.plan, new Date(firstChargeAt))) : null,
    },
    disclosure: {
      text: policy.accessBilling.disclosureText,
      version: policy.version,
      acknowledgedAt: row.disclosure_acknowledged_at,
    },
    bank: {
      verificationPending: facts.status.bankVerificationPending,
      deadline: facts.status.bankVerificationDeadline ?? row.bank_verification_deadline,
      overdue: facts.status.bankVerificationOverdue,
      windowHours: BANK_VERIFICATION_WINDOW_HOURS,
      verificationUrl: facts.status.bankVerificationPending ? await bankVerificationUrl(bank) : null,
    },
    balance: {
      state: row.state,
      outstanding: row.state === "past_due" || row.state === "restricted",
      amountCents: priceCents,
      graceEndsAt: row.grace_ends_at,
    },
    canManage: input.canManage,
    canChoosePlan: input.canChoosePlan,
  };
}

/**
 * Stripe's hosted page for entering the two microdeposit amounts. It hangs off
 * the SetupIntent that collected the account, which is why the intent id is
 * stored alongside the instrument — verification happens days later, long
 * after the browser that started it has gone.
 */
export async function bankVerificationUrl(bank: Instrument | undefined): Promise<string | null> {
  if (!bank?.setup_intent_id) return null;
  try {
    const stripe = await getStripe();
    const intent = await stripe.setupIntents.retrieve(bank.setup_intent_id);
    return intent.next_action?.verify_with_microdeposits?.hosted_verification_url ?? null;
  } catch {
    // A Stripe hiccup must not take the setup screen down with it.
    return null;
  }
}

/**
 * Re-read the SetupIntent behind the stored bank account and record the
 * outcome. Called when the office says it has entered the amounts, so the
 * screen does not have to wait for the webhook.
 */
export async function refreshBankVerification(input: {
  providerId: string;
  actor: AccessActor;
}): Promise<{ verified: boolean }> {
  const row = await ensureAccessSubscription(input.providerId);
  const bank = (await listAccessInstruments(row.id)).find((item) => item.kind === "bank");
  if (!bank) throw new AccessSetupError("There is no bank account on file to verify.", 404);
  if (bank.verification_status === "verified") return { verified: true };
  if (!bank.setup_intent_id) throw new AccessSetupError("This bank account cannot be verified here. Add it again to restart verification.", 409);
  const stripe = await getStripe();
  const intent = await stripe.setupIntents.retrieve(bank.setup_intent_id);
  if (intent.status !== "succeeded") return { verified: false };
  await recordBankVerification({ providerId: input.providerId, verified: true, actor: input.actor });
  return { verified: true };
}

/**
 * Record the office's plan choice. The `plan` column has always had a default,
 * so the choice is proven by `plan_selected_at`, not by the column's value.
 */
export async function selectAccessPlan(input: {
  providerId: string;
  plan: OfficeAccessPlan;
  actor: AccessActor;
  now?: Date;
}): Promise<Row> {
  const now = input.now ?? new Date();
  const row = await ensureAccessSubscription(input.providerId);
  // A plan change after the office is already billing would move money; that
  // belongs to the subscription engine's own controls, not to setup.
  if (row.plan_selected_at && row.plan !== input.plan && row.paid_through) {
    throw new AccessSetupError("Contact THINNR support to change your billing plan.", 409, "plan_locked");
  }
  // The plan is not part of the state derivation (it only picks the price and
  // the period length), so it is written directly rather than through the
  // state machine — with its own history row.
  const updated = await update("billing_office_access_subscriptions", `id=eq.${q(row.id)}`, {
    plan: input.plan,
    plan_selected_at: now.toISOString(),
  });
  await recordAccessEvent({ row, event: "plan_selected", actor: input.actor, detail: { plan: input.plan } });
  return updated ?? row;
}

/** Record acceptance of the HQ-authored access-fee disclosure. */
export async function acknowledgeAccessDisclosure(input: {
  providerId: string;
  version: number;
  actor: AccessActor;
  now?: Date;
}): Promise<Row> {
  const now = input.now ?? new Date();
  const row = await ensureAccessSubscription(input.providerId);
  const updated = await update("billing_office_access_subscriptions", `id=eq.${q(row.id)}`, {
    disclosure_acknowledged_at: now.toISOString(),
    disclosure_acknowledged_by: input.actor.userId ?? null,
    disclosure_version: input.version,
  });
  await recordAccessEvent({
    row, event: "disclosure_acknowledged", actor: input.actor, detail: { version: input.version },
  });
  return updated ?? row;
}
