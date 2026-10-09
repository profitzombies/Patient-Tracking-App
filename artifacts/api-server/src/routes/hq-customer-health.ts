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
import { requireHqPermission } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { officeIsActive } from "../lib/office-status";
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

export interface CustomerHealthResult extends CustomerHealthSummary {
  definitions: typeof CUSTOMER_HEALTH_DEFINITIONS;
}

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
export function assembleCustomerHealth(rows: OfficeHealthRow[], asOf: Date): CustomerHealthResult {
  const customers = rows.filter((row) => officeIsActive({ access_disabled: row.accessDisabled, offboarding_status: row.offboardingStatus }));
  return { ...summarizeCustomerHealth(customers, asOf), definitions: CUSTOMER_HEALTH_DEFINITIONS };
}

async function loadOfficeHealthRows(asOf: Date): Promise<OfficeHealthRow[]> {
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
    const rows = await loadOfficeHealthRows(asOf);
    res.json(assembleCustomerHealth(rows, asOf));
  } catch (error) {
    req.log?.error({ err: error }, "HQ customer health failed");
    res.status(502).json({ error: "Could not load customer health right now." });
  }
});

export default router;
