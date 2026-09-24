/**
 * HQ office access subscriptions — what an office pays THINNR.
 *
 *  - GET  /hq/office-access                      the board: every office, its access state and dates
 *  - GET  /hq/office-access/:providerId          one office: state, terms, instruments, attempts, history
 *  - POST /hq/office-access/:providerId/included-period   grant / edit / end an included period (or lifetime)
 *  - POST /hq/office-access/:providerId/reset-trial       restart the included period from now
 *  - POST /hq/office-access/:providerId/terms             plan and per-office price override
 *  - POST /hq/office-access/:providerId/paid-through      "already paid through" (migration)
 *  - POST /hq/office-access/:providerId/offline-payment   a payment taken outside Stripe
 *
 * The state machine lives in billing/office-access; nothing here decides what
 * an input means. This router gates on HQ permissions, translates the wire
 * shape, and hands the engine an actor so every change lands in both the
 * access history and the shared admin audit ledger.
 *
 * Reads need `financial_read`; every write needs `provider_manage`. Nothing
 * here can mark an office's payment setup complete — offices still add their
 * own bank account and cards at first sign-in.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  AccessAdminError,
  MAX_INCLUDED_PERIOD_DAYS,
  accessSummary,
  recordOfflinePayment,
  recordPaidThrough,
  resetTrial,
  setAccessTerms,
  setIncludedPeriod,
} from "../billing/office-access/admin";
import { accessSetupStatus, listAccessInstruments } from "../billing/office-access/instruments";
import { loadAccessBillingSettings, type AccessBillingSettings } from "../billing/office-access/settings";
import { accessPriceCents, deriveAccessState } from "../billing/office-access/state";
import { accessHistory, findAccessSubscription, type AccessActor } from "../billing/office-access/subscription";
import {
  selectMany,
  type BillingOfficeAccessAttemptRow,
  type BillingOfficeAccessEventRow,
  type BillingOfficeAccessSubscriptionRow,
} from "../billing/store";
import { requestIdOf } from "../lib/admin-audit";
import { resolveAuditNames, type AuditRow } from "../lib/audit-events";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";

const router: IRouter = Router();
const DAY_MS = 86_400_000;
/** An included period ending within this window is "ending soon" on the board. */
export const TRIAL_ENDING_SOON_DAYS = 30;

function staffOf(res: Response): StaffIdentity {
  return res.locals.staff as StaffIdentity;
}

function actorOf(req: Request, res: Response): AccessActor {
  return { kind: "hq", userId: staffOf(res).userId, requestId: requestIdOf(req) };
}

function fail(req: Request, res: Response, error: unknown): void {
  if (error instanceof AccessAdminError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  req.log?.error({ err: error }, "HQ office access request failed");
  res.status(503).json({ error: "Office access billing is temporarily unavailable." });
}

/** Accepts a calendar day (treated as UTC midnight) or a full ISO instant. */
const IsoDate = z.string().trim().min(8).max(40).transform((value, ctx) => {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a date." });
    return z.NEVER;
  }
  return new Date(ms);
});

const IncludedPeriodInput = z.object({
  lifetime: z.boolean().optional(),
  days: z.number().int().min(0).max(MAX_INCLUDED_PERIOD_DAYS).optional(),
  endsAt: IsoDate.nullable().optional(),
});
const ResetTrialInput = z.object({ days: z.number().int().min(1).max(MAX_INCLUDED_PERIOD_DAYS).optional() });
const TermsInput = z.object({
  plan: z.enum(["monthly", "yearly"]).optional(),
  priceCentsOverride: z.number().int().min(0).max(100_000_000).nullable().optional(),
});
const PaidThroughInput = z.object({
  paidThrough: IsoDate,
  source: z.enum(["stripe", "offline", "hq_migration"]),
  note: z.string().trim().max(400).optional(),
});
const OfflinePaymentInput = z.object({
  paidThrough: IsoDate,
  amountCents: z.number().int().min(0).max(100_000_000).optional(),
  note: z.string().trim().max(400).optional(),
});

interface OfficeRow {
  provider_id: string;
  office_name: string | null;
  provider_name: string | null;
  access_disabled?: boolean | null;
}

/** Live offices (an offboarded office no longer owes for access). */
async function offices(): Promise<OfficeRow[]> {
  const result = await supabaseAdmin(
    "GET",
    "/rest/v1/providers?select=provider_id,office_name,provider_name,access_disabled&offboarding_status=neq.offboarded&limit=2000",
  );
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`office list failed (${result.status})`);
  return result.json as OfficeRow[];
}

function officeLabel(office: OfficeRow): string {
  return office.office_name?.trim() || office.provider_name?.trim() || "Office";
}

function daysLeft(until: string | null, now: Date): number | null {
  if (!until) return null;
  const ms = Date.parse(until);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil((ms - now.getTime()) / DAY_MS));
}

/**
 * When money is next expected: nothing for a lifetime office, otherwise where
 * paid access currently runs out.
 */
function nextChargeAt(row: BillingOfficeAccessSubscriptionRow): string | null {
  if (row.lifetime) return null;
  return row.paid_through ?? row.included_period_ends_at;
}

function terms(row: BillingOfficeAccessSubscriptionRow, settings: AccessBillingSettings, now: Date) {
  return {
    state: deriveAccessState(row, now),
    plan: row.plan,
    priceCents: accessPriceCents(row, settings),
    priceCentsOverride: row.price_cents_override,
    lifetime: row.lifetime,
    includedPeriodStartedAt: row.included_period_started_at,
    includedPeriodEndsAt: row.included_period_ends_at,
    paidThrough: row.paid_through,
    paidThroughSource: row.paid_through_source,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    graceEndsAt: row.grace_ends_at,
    graceDaysLeft: daysLeft(row.grace_ends_at, now),
    restrictedAt: row.restricted_at,
    setupCompletedAt: row.setup_completed_at,
    bankVerificationDeadline: row.bank_verification_deadline,
    lastAttemptAt: row.last_attempt_at,
    nextChargeAt: nextChargeAt(row),
    version: row.version,
  };
}

function policyDto(settings: AccessBillingSettings) {
  return {
    monthlyPriceCents: settings.monthlyPriceCents,
    yearlyPriceCents: settings.yearlyPriceCents,
    includedPeriodDays: settings.includedPeriodDays,
    gracePeriodDays: settings.gracePeriodDays,
    normalSharePercent: settings.normalSharePercent,
    restrictedSharePercent: settings.restrictedSharePercent,
    maxIncludedPeriodDays: MAX_INCLUDED_PERIOD_DAYS,
  };
}

/**
 * The board. Offices with no subscription row yet report `state: null` — no
 * subscription work has happened for them, which is not the same as zero.
 */
router.get("/hq/office-access", requireHqPermission("financial_read"), async (req, res) => {
  const now = new Date();
  try {
    const [list, rows, settings] = await Promise.all([
      offices(),
      selectMany("billing_office_access_subscriptions", "limit=5000"),
      loadAccessBillingSettings(),
    ]);
    const byProvider = new Map(rows.map((row) => [row.provider_id, row]));
    const items = list.map((office) => {
      const row = byProvider.get(office.provider_id);
      return {
        providerId: office.provider_id,
        officeName: officeLabel(office),
        locked: office.access_disabled === true,
        ...(row
          ? terms(row, settings, now)
          : {
              state: null, plan: null, priceCents: null, priceCentsOverride: null, lifetime: false,
              includedPeriodStartedAt: null, includedPeriodEndsAt: null, paidThrough: null, paidThroughSource: null,
              currentPeriodStart: null, currentPeriodEnd: null, graceEndsAt: null, graceDaysLeft: null,
              restrictedAt: null, setupCompletedAt: null, bankVerificationDeadline: null, lastAttemptAt: null,
              nextChargeAt: null, version: null,
            }),
      };
    });
    const soonMs = now.getTime() + TRIAL_ENDING_SOON_DAYS * DAY_MS;
    res.json({
      offices: items,
      counts: {
        total: items.length,
        notStarted: items.filter((item) => item.state === null).length,
        setupIncomplete: items.filter((item) => item.state === "setup_incomplete").length,
        includedPeriod: items.filter((item) => item.state === "included_period").length,
        paidCurrent: items.filter((item) => item.state === "paid_current").length,
        pastDue: items.filter((item) => item.state === "past_due").length,
        restricted: items.filter((item) => item.state === "restricted").length,
        trialsEndingSoon: items.filter((item) => {
          if (item.lifetime || !item.includedPeriodEndsAt) return false;
          const ms = Date.parse(item.includedPeriodEndsAt);
          return Number.isFinite(ms) && ms >= now.getTime() && ms <= soonMs;
        }).length,
      },
      policy: policyDto(settings),
      trialEndingSoonDays: TRIAL_ENDING_SOON_DAYS,
    });
  } catch (error) { fail(req, res, error); }
});

function attemptDto(row: BillingOfficeAccessAttemptRow) {
  return {
    id: row.id, periodStart: row.period_start, periodEnd: row.period_end, cycle: row.cycle, slot: row.slot,
    plan: row.plan, amountCents: row.amount_cents, status: row.status, failureCode: row.failure_code,
    failureMessage: row.failure_message, settledAt: row.settled_at, failedAt: row.failed_at, createdAt: row.created_at,
  };
}

/** Only small scalars from an event's detail reach the screen. */
function eventDetail(detail: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

/** Names for the history's actors, through the shared audit name resolver. */
async function historyDtos(rows: BillingOfficeAccessEventRow[]) {
  const pseudo: AuditRow[] = rows.map((row) => ({
    id: row.id, occurred_at: row.created_at, action: row.event, actor_user_id: row.actor_user_id,
    actor_kind: row.actor_kind, provider_id: row.provider_id, target_kind: "office_access_subscription",
    target_id: row.subscription_id, request_id: null, metadata: {},
  }));
  const names = await resolveAuditNames(pseudo);
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    fromState: row.from_state,
    toState: row.to_state,
    actorKind: row.actor_kind,
    actorUserId: row.actor_user_id,
    actorName: row.actor_user_id ? names.actors.get(row.actor_user_id) || null : null,
    detail: eventDetail(row.detail),
    createdAt: row.created_at,
  }));
}

router.get("/hq/office-access/:providerId", requireHqPermission("financial_read"), async (req, res) => {
  const providerId = String(req.params.providerId);
  const now = new Date();
  try {
    const office = (await offices()).find((row) => row.provider_id === providerId);
    if (!office) { res.status(404).json({ error: "Office not found." }); return; }
    const [row, settings] = await Promise.all([findAccessSubscription(providerId), loadAccessBillingSettings()]);
    if (!row) {
      res.json({
        office: { providerId, officeName: officeLabel(office) },
        subscription: null, setup: null, instruments: [], attempts: [], history: [],
        policy: policyDto(settings),
      });
      return;
    }
    const [instruments, attempts, events] = await Promise.all([
      listAccessInstruments(row.id),
      selectMany("billing_office_access_attempts", `provider_id=eq.${encodeURIComponent(providerId)}&order=created_at.desc&limit=20`),
      accessHistory(providerId, 50),
    ]);
    res.json({
      office: { providerId, officeName: officeLabel(office) },
      subscription: terms(row, settings, now),
      setup: accessSetupStatus(instruments, now),
      instruments: instruments.map((instrument) => ({
        id: instrument.id, slot: instrument.slot, kind: instrument.kind, brand: instrument.brand,
        last4: instrument.last4, bankName: instrument.bank_name, expMonth: instrument.exp_month,
        expYear: instrument.exp_year, verificationStatus: instrument.verification_status,
        verificationDeadline: instrument.verification_deadline, removedAt: instrument.removed_at,
      })),
      attempts: attempts.map(attemptDto),
      history: await historyDtos(events),
      policy: policyDto(settings),
    });
  } catch (error) { fail(req, res, error); }
});

/** Reply shape shared by every write: the office's terms as they now stand. */
async function respondWithTerms(res: Response, providerId: string): Promise<void> {
  const [summary, settings] = await Promise.all([accessSummary(providerId), loadAccessBillingSettings()]);
  const row = await findAccessSubscription(providerId);
  res.json({
    subscription: row ? terms(row, settings, new Date()) : null,
    summary,
  });
}

router.post("/hq/office-access/:providerId/included-period", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = IncludedPeriodInput.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the included period." }); return; }
  const providerId = String(req.params.providerId);
  try {
    await setIncludedPeriod({
      providerId, actor: actorOf(req, res),
      ...(parsed.data.lifetime === undefined ? {} : { lifetime: parsed.data.lifetime }),
      ...(parsed.data.days === undefined ? {} : { days: parsed.data.days }),
      ...(parsed.data.endsAt === undefined ? {} : { endsAt: parsed.data.endsAt }),
    });
    await respondWithTerms(res, providerId);
  } catch (error) { fail(req, res, error); }
});

router.post("/hq/office-access/:providerId/reset-trial", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = ResetTrialInput.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Check the trial length." }); return; }
  const providerId = String(req.params.providerId);
  try {
    await resetTrial({ providerId, actor: actorOf(req, res), ...(parsed.data.days === undefined ? {} : { days: parsed.data.days }) });
    await respondWithTerms(res, providerId);
  } catch (error) { fail(req, res, error); }
});

router.post("/hq/office-access/:providerId/terms", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = TermsInput.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Check the plan and price." }); return; }
  if (parsed.data.plan === undefined && parsed.data.priceCentsOverride === undefined) {
    res.status(400).json({ error: "Choose a plan or a price to change." }); return;
  }
  const providerId = String(req.params.providerId);
  try {
    await setAccessTerms({
      providerId, actor: actorOf(req, res),
      ...(parsed.data.plan === undefined ? {} : { plan: parsed.data.plan }),
      ...(parsed.data.priceCentsOverride === undefined ? {} : { priceCentsOverride: parsed.data.priceCentsOverride }),
    });
    await respondWithTerms(res, providerId);
  } catch (error) { fail(req, res, error); }
});

router.post("/hq/office-access/:providerId/paid-through", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = PaidThroughInput.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the paid-through date." }); return; }
  const providerId = String(req.params.providerId);
  try {
    await recordPaidThrough({
      providerId, actor: actorOf(req, res), paidThrough: parsed.data.paidThrough, source: parsed.data.source,
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
    });
    await respondWithTerms(res, providerId);
  } catch (error) { fail(req, res, error); }
});

router.post("/hq/office-access/:providerId/offline-payment", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = OfflinePaymentInput.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the payment details." }); return; }
  const providerId = String(req.params.providerId);
  try {
    await recordOfflinePayment({
      providerId, actor: actorOf(req, res), paidThrough: parsed.data.paidThrough,
      ...(parsed.data.amountCents === undefined ? {} : { amountCents: parsed.data.amountCents }),
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
    });
    await respondWithTerms(res, providerId);
  } catch (error) { fail(req, res, error); }
});

export default router;
