/**
 * HQ Customer health — every active practice stack-ranked by a health score,
 * bucketed by how recently it last ordered, and flagged when it is trending
 * toward inactive.
 *
 * The facts come from one service-role RPC (`office_customer_health`, see the
 * migration for the data definitions); the arithmetic — weights, targets,
 * buckets, bands, the New rule, tied ranks and the attention reasons — lives
 * in ../customer-health/scoring so the page and the weekly email agree.
 * Offices that fail the shared `officeIsActive` rule (offboarding /
 * offboarded) are dropped here; the SQL already skips access-disabled ones.
 *
 * Same gate as the Patient retention and App usage pages: HQ analytics readers
 * only, checked before any service-role call. Figures are as of the request;
 * there is no date range.
 */
import { Router, type IRouter } from "express";
import { requireHqPermission, requireStaff, type StaffIdentity } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { officeIsActive } from "../lib/office-status";
import { loadOrgPolicy } from "../lib/org-policy";
import { previousIsoWeek, scoreChangeFrom, weeklyRunMoment } from "../customer-health/weekly";
import {
  ATTENTION_RULES,
  BAND_THRESHOLDS,
  BUCKET_BOUNDS,
  HEALTH_TARGETS,
  HEALTH_WEIGHTS,
  NEW_OFFICE_DAYS,
  RECENCY_FULL_DAYS,
  RECENCY_ZERO_DAYS,
  summarizeCustomerHealth,
  type CustomerHealthSummary,
  type OfficeHealth,
  type OfficeHealthFacts,
} from "../customer-health/scoring";

const router: IRouter = Router();

/** The constants in force, echoed so the page's definitions note has one source. */
export const CUSTOMER_HEALTH_DEFINITIONS = {
  weights: HEALTH_WEIGHTS,
  targets: HEALTH_TARGETS,
  recencyFullDays: RECENCY_FULL_DAYS,
  recencyZeroDays: RECENCY_ZERO_DAYS,
  bucketBounds: BUCKET_BOUNDS,
  bandThresholds: BAND_THRESHOLDS,
  newOfficeDays: NEW_OFFICE_DAYS,
  attentionRules: ATTENTION_RULES,
} as const;

export interface OfficeHealthWithChange extends OfficeHealth {
  /** Score the weekly Monday run recorded for the comparison week; null before a snapshot exists. */
  priorWeekScore: number | null;
  /** score − priorWeekScore; null when no prior snapshot exists. */
  scoreChange: number | null;
}

export interface CustomerHealthResult extends Omit<CustomerHealthSummary, "offices" | "attention"> {
  offices: OfficeHealthWithChange[];
  attention: OfficeHealthWithChange[];
  /** ISO week (`2026-W41`) of the snapshot the "vs last week" change compares against; null before the first weekly run. */
  priorSnapshotWeek: string | null;
  definitions: typeof CUSTOMER_HEALTH_DEFINITIONS;
}

/** The preference kind the Monday summary subscription is stored under. */
export const WEEKLY_HEALTH_EMAIL_PREFERENCE_KIND = "weekly_customer_health_email";

/** One raw RPC row (plus the status columns the active-office rule needs). */
export interface OfficeHealthRow extends OfficeHealthFacts {
  accessDisabled: boolean;
  offboardingStatus: string | null;
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function officeHealthRowDto(raw: Record<string, unknown>): OfficeHealthRow {
  const providerId = String(raw.provider_id);
  return {
    providerId,
    officeName: text(raw.office_name) ?? text(raw.provider_name) ?? "Office",
    providerName: text(raw.provider_name) ?? text(raw.office_name) ?? "",
    accessDisabled: raw.access_disabled === true,
    offboardingStatus: text(raw.offboarding_status),
    createdAt: text(raw.created_at),
    lastPaidOrderAt: text(raw.last_paid_order_at),
    activeSubscribers: num(raw.active_subscribers),
    cancellingSubscriptions: num(raw.cancelling_subscriptions),
    appUsers: num(raw.app_users),
    activeAppUsers30d: num(raw.active_app_users_30d),
    activeAppUsersPrior30d: num(raw.active_app_users_prior_30d),
    staffEnrolled: num(raw.staff_enrolled),
  };
}

/** Drop offices that fail the shared active-office rule, then score and rank the rest. */
export function assembleCustomerHealth(rows: OfficeHealthRow[], asOf: Date): CustomerHealthSummary {
  const customers = rows.filter((row) => officeIsActive({ access_disabled: row.accessDisabled, offboarding_status: row.offboardingStatus }));
  return summarizeCustomerHealth(customers, asOf);
}

export interface PriorWeekScores {
  /** Which ISO week the scores came from, or null when no snapshot exists yet. */
  isoWeek: string | null;
  scores: Map<string, number>;
}

/** Attach each office's prior-week score and the signed change; the page shows "—" where null. */
export function withWeekOverWeek(summary: CustomerHealthSummary, prior: PriorWeekScores): CustomerHealthResult {
  const decorate = (office: OfficeHealth): OfficeHealthWithChange => ({ ...office, ...scoreChangeFrom(prior.scores, office) });
  return {
    ...summary,
    offices: summary.offices.map(decorate),
    attention: summary.attention.map(decorate),
    priorSnapshotWeek: prior.isoWeek,
    definitions: CUSTOMER_HEALTH_DEFINITIONS,
  };
}

async function snapshotScores(isoWeek: string): Promise<Map<string, number>> {
  const result = await supabaseAdmin("GET", `/rest/v1/office_customer_health_weekly_snapshots?iso_week=eq.${encodeURIComponent(isoWeek)}&select=provider_id,score&limit=5000`);
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`weekly health snapshot read failed (${result.status})`);
  return new Map((result.json as Record<string, unknown>[]).map((row) => [String(row.provider_id), Number(row.score)]));
}

/**
 * "vs last week" compares against the previous ISO week's Monday snapshot.
 * During the very first week after the job starts only the current week's
 * snapshot exists, so that one is used; before any run there is nothing.
 */
export async function loadPriorWeekScores(now: Date): Promise<PriorWeekScores> {
  const timeZone = (await loadOrgPolicy()).defaultTimezone;
  const thisWeek = weeklyRunMoment(now, timeZone).isoWeek;
  const lastWeek = previousIsoWeek(thisWeek);
  const previous = await snapshotScores(lastWeek);
  if (previous.size) return { isoWeek: lastWeek, scores: previous };
  const current = await snapshotScores(thisWeek);
  if (current.size) return { isoWeek: thisWeek, scores: current };
  return { isoWeek: null, scores: new Map() };
}

/** The raw facts for every office as of a date (shared with the weekly run). */
export async function loadOfficeHealthRows(asOf: Date): Promise<OfficeHealthRow[]> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/office_customer_health", {
    p_as_of: asOf.toISOString().slice(0, 10),
  });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`office customer health failed (${result.status})`);
  }
  return (result.json as Record<string, unknown>[]).map(officeHealthRowDto);
}

router.get("/hq/customer-health", requireHqPermission("analytics_read"), async (req, res) => {
  try {
    const asOf = new Date();
    const [rows, prior] = await Promise.all([loadOfficeHealthRows(asOf), loadPriorWeekScores(asOf)]);
    res.json(withWeekOverWeek(assembleCustomerHealth(rows, asOf), prior));
  } catch (error) {
    req.log?.error({ err: error }, "HQ customer health failed");
    res.status(502).json({ error: "Could not load customer health right now." });
  }
});

// ── Personal weekly email subscription ──────────────────────────────────────
// Per HQ member, never per organization: any active HQ membership may read
// and set its own row. The Monday job and the sender both read this table.

const PREFERENCE_PATH = "/hq/notification-preferences/weekly-customer-health";

async function readWeeklyPreference(authUserId: string): Promise<boolean> {
  const result = await supabaseAdmin("GET", `/rest/v1/hq_member_notification_preferences?auth_user_id=eq.${encodeURIComponent(authUserId)}&kind=eq.${WEEKLY_HEALTH_EMAIL_PREFERENCE_KIND}&select=enabled&limit=1`);
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`weekly health preference read failed (${result.status})`);
  const row = result.json[0] as Record<string, unknown> | undefined;
  return row?.enabled === true;
}

router.get(PREFERENCE_PATH, requireStaff(["hq_admin"]), async (req, res) => {
  const staff = res.locals.staff as StaffIdentity;
  try {
    res.json({ enabled: await readWeeklyPreference(staff.userId) });
  } catch (error) {
    req.log?.error({ err: error }, "HQ weekly health preference read failed");
    res.status(502).json({ error: "Could not load your email preference right now." });
  }
});

router.put(PREFERENCE_PATH, requireStaff(["hq_admin"]), async (req, res) => {
  const staff = res.locals.staff as StaffIdentity;
  const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be true or false." });
    return;
  }
  try {
    const result = await supabaseAdmin(
      "POST",
      "/rest/v1/hq_member_notification_preferences?on_conflict=auth_user_id,kind",
      [{ auth_user_id: staff.userId, kind: WEEKLY_HEALTH_EMAIL_PREFERENCE_KIND, enabled, updated_at: new Date().toISOString() }],
      "resolution=merge-duplicates,return=representation",
    );
    if (result.status >= 300 || !Array.isArray(result.json) || !result.json.length) throw new Error(`weekly health preference write failed (${result.status})`);
    res.json({ enabled: (result.json[0] as Record<string, unknown>).enabled === true });
  } catch (error) {
    req.log?.error({ err: error }, "HQ weekly health preference write failed");
    res.status(502).json({ error: "Could not save your email preference right now." });
  }
});

export default router;
