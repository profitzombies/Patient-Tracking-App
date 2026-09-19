/**
 * CSV row builders, one per export kind.
 *
 * Every generator receives the job's FROZEN scope and returns a header plus
 * rows. What they deliberately never read: clinical notes, coach or support
 * message text, patient contact details, onboarding codes, or anything
 * financial. Patient-level rows exist only in `patient_activity`, which the
 * authorizer already restricted to office staff / HQ provider managers.
 */
import type { CsvCell } from "./csv";
import type { ExportKind, ExportScope } from "./kinds";
import { loadOfficeRollups, type DateRangeKeys } from "../routes/operational-rollups";
import { supabaseAdmin } from "../lib/supabase-admin";
import { offboardingStatusOf } from "../lib/office-status";

export interface ExportSheet {
  header: string[];
  rows: CsvCell[][];
}

const enc = encodeURIComponent;
const PAGE = 1000;
/** Hard ceiling per export so a runaway query can't build a multi-GB file. */
export const MAX_EXPORT_ROWS = 50_000;

/** Audit actions the HQ audit log itself exposes — exports mirror that list. */
export const AUDIT_EXPORT_ACTIONS = [
  "patient_invitation_created",
  "patient_invitation_resent",
  "patient_follow_up_open",
  "patient_follow_up_resolved",
  "provider_account_created",
  "provider_account_updated",
  "hq_team_invited",
  "hq_team_updated",
  "hq_team_revoked",
  "hq_settings_updated",
  "hq_file_uploaded",
  "hq_file_deleted",
  "conversation_transcript_read",
  "conversation_replied",
  "conversation_assigned",
  "conversation_status_changed",
  "conversation_note_added",
  "conversation_escalated",
  "conversation_escalation_resolved",
  "data_export_requested",
  "data_export_downloaded",
  "patient_record_export_requested",
  "patient_record_export_downloaded",
  "patient_record_viewed",
  "patient_photos_viewed",
  "patient_bloodwork_viewed",
  "bloodwork_report_opened",
  "patient_medications_viewed",
  "conversation_transcript_opened",
  "office_bundle_export_requested",
  "office_bundle_export_downloaded",
] as const;
const AUDIT_METADATA_KEYS = new Set(["reason", "role", "status", "field", "size", "contentType", "thread", "kind", "office", "rows", "exportId", "part", "parts", "reportId", "conversationId", "photos", "includeTombstones", "patients"]);

export async function pageAll(pathWithoutPaging: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; rows.length < MAX_EXPORT_ROWS; offset += PAGE) {
    const res = await supabaseAdmin("GET", `${pathWithoutPaging}&limit=${PAGE}&offset=${offset}`);
    if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`export query failed (${res.status})`);
    rows.push(...(res.json as Record<string, unknown>[]));
    if (res.json.length < PAGE) break;
  }
  return rows.slice(0, MAX_EXPORT_ROWS);
}

function dateOnly(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function daysBetween(earlier: string | null, later: string): number | null {
  if (!earlier) return null;
  return Math.floor((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

function requireRange(scope: ExportScope): DateRangeKeys {
  if (!scope.range) throw new Error("export scope is missing its date range");
  return scope.range;
}

export function dollars(value: unknown): string {
  const cents = numberOrNull(value);
  return cents === null ? "" : (cents / 100).toFixed(2);
}

function rangeFilters(scope: ExportScope): string[] {
  const range = requireRange(scope);
  const endExclusive = new Date(Date.parse(`${range.end}T00:00:00Z`) + 86_400_000).toISOString();
  return [
    `created_at=gte.${enc(`${range.start}T00:00:00Z`)}`,
    `created_at=lt.${enc(endExclusive)}`,
  ];
}

/* ------------------------------------------------- office comparison */

async function officeComparison(scope: ExportScope): Promise<ExportSheet> {
  const range = requireRange(scope);
  const offices = await loadOfficeRollups(scope.providerId, range);
  const header = [
    "Office", "Provider", "Range start", "Range end", "First patient date", "Data available",
    "Total patients", "Active patients", "Enrollments in range", "Engaged (7 days to range end)",
    "Needs attention", "Inactive", "Invited", "Logging lapsed", "Check-ins overdue",
    "Logging adherence % (7 days to range end)", "Check-in adherence % (7 days to range end)", "Avg pounds lost (active patients)",
  ];
  const rows = offices.map((office): CsvCell[] => {
    const m = office.metrics;
    const cell = (value: CsvCell) => (m ? value : "unavailable");
    return [
      office.officeName, office.providerName, range.start, range.end, office.firstPatientDate, m ? "yes" : "no",
      cell(m?.totalPatients), cell(m?.activePatients), cell(m?.enrollments), cell(m?.engaged),
      cell(m?.needsAttention), cell(m?.inactive), cell(m?.invited), cell(m?.loggingLapsed), cell(m?.checkInsOverdue),
      cell(m?.loggingAdherencePct ?? ""), cell(m?.checkInAdherencePct ?? ""), cell(m?.avgPoundsLost ?? ""),
    ];
  });
  return { header, rows };
}

/* ------------------------------------------------- patient activity */

async function patientActivity(scope: ExportScope): Promise<ExportSheet> {
  const range = requireRange(scope);
  if (!scope.providerId) throw new Error("patient activity export needs an office scope");
  const [patients, facts] = await Promise.all([
    pageAll(
      `/rest/v1/patients?provider_id=eq.${enc(scope.providerId)}&created_at=lte.${enc(`${range.end}T23:59:59.999Z`)}` +
        "&select=id,first_name,last_name,name,activation_status,created_at,program_start_date,starting_weight,current_weight,last_log_date,last_login_at&order=created_at.asc",
    ),
    supabaseAdmin("POST", "/rest/v1/rpc/provider_patient_operational_summary", {
      p_provider_id: scope.providerId,
      p_as_of: range.end,
    }),
  ]);
  if (facts.status >= 300 || !Array.isArray(facts.json)) throw new Error(`operational summary failed (${facts.status})`);
  const factById = new Map(
    (facts.json as Record<string, unknown>[]).map((fact) => [String(fact.patient_id), fact]),
  );
  const header = [
    "Patient ID", "Name", "Status", "Enrolled", "Program start", "Latest activity", "Latest meal log",
    "Latest check-in", "Latest weight", "Logged days (last 7)", "Check-ins (last 7)",
    "Days since activity", "Flags", "Pounds lost", "As of",
  ];
  const rows = patients.map((p): CsvCell[] => {
    const fact = factById.get(String(p.id));
    const activation = String(p.activation_status ?? "");
    const active = activation === "activated" || activation === "active";
    const createdDate = dateOnly(p.created_at);
    const latestActivity = dateOnly(fact?.latest_activity_date) ?? dateOnly(p.last_log_date);
    const latestDiary = dateOnly(fact?.latest_diary_date);
    const latestCheck = dateOnly(fact?.latest_check_in_date);
    const age = daysBetween(createdDate, range.end) ?? 0;
    const activityAge = daysBetween(latestActivity, range.end);
    const flags: string[] = [];
    if (active && ((activityAge === null && age >= 14) || (activityAge !== null && activityAge >= 14))) flags.push("no_activity_14d");
    if (active && age >= 3 && (latestDiary === null || (daysBetween(latestDiary, range.end) ?? 99) >= 3)) flags.push("logging_lapsed");
    if (active && age >= 7 && (latestCheck === null || (daysBetween(latestCheck, range.end) ?? 99) >= 7)) flags.push("check_in_overdue");
    const name =
      [p.first_name, p.last_name].filter((part) => typeof part === "string" && part.trim()).join(" ") ||
      (typeof p.name === "string" ? p.name : "");
    const start = numberOrNull(p.starting_weight);
    const current = numberOrNull(p.current_weight);
    return [
      String(p.id), name, active ? "active" : activation || "invited", createdDate, dateOnly(p.program_start_date),
      latestActivity, latestDiary, latestCheck, dateOnly(fact?.latest_weight_date),
      numberOrNull(fact?.logged_days_7) ?? 0, numberOrNull(fact?.check_ins_7) ?? 0,
      activityAge, flags.join(" "), start !== null && current !== null ? Math.round((start - current) * 10) / 10 : "",
      range.end,
    ];
  });
  return { header, rows };
}

/* ------------------------------------------------------ audit events */

async function auditEvents(scope: ExportScope): Promise<ExportSheet> {
  const range = requireRange(scope);
  const endExclusive = new Date(Date.parse(`${range.end}T00:00:00Z`) + 86_400_000).toISOString();
  const filters = [
    "select=id,occurred_at,action,actor_user_id,actor_kind,provider_id,target_kind,target_id,request_id,metadata",
    `action=in.(${AUDIT_EXPORT_ACTIONS.join(",")})`,
    `occurred_at=gte.${enc(`${range.start}T00:00:00Z`)}`,
    `occurred_at=lt.${enc(endExclusive)}`,
    "order=occurred_at.asc,id.asc",
  ];
  if (scope.providerId) filters.push(`provider_id=eq.${enc(scope.providerId)}`);
  const events = await pageAll(`/rest/v1/admin_audit_events?${filters.join("&")}`);
  const hq = scope.requesterKind === "hq";
  const header = [
    "Event ID", "Occurred at", "Action", "Actor kind", ...(hq ? ["Actor user ID"] : []),
    "Office", "Target kind", "Target ID", "Request ID", "Metadata",
  ];
  const rows = events.map((event): CsvCell[] => {
    const source = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
      ? (event.metadata as Record<string, unknown>)
      : {};
    const metadata = Object.entries(source)
      .filter(([key, value]) => AUDIT_METADATA_KEYS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null))
      .map(([key, value]) => `${key}=${value === null ? "" : String(value)}`)
      .join("; ");
    return [
      String(event.id), String(event.occurred_at), String(event.action), String(event.actor_kind),
      ...(hq ? [event.actor_user_id ? String(event.actor_user_id) : ""] : []),
      event.provider_id ? String(event.provider_id) : "", event.target_kind ? String(event.target_kind) : "",
      event.target_id ? String(event.target_id) : "", event.request_id ? String(event.request_id) : "", metadata,
    ];
  });
  return { header, rows };
}

/* ------------------------------------------------ training completion */

async function trainingCompletion(scope: ExportScope): Promise<ExportSheet> {
  const range = requireRange(scope);
  const endExclusive = new Date(Date.parse(`${range.end}T00:00:00Z`) + 86_400_000).toISOString();
  const filters = [
    "select=viewer_id,video_id,watch_seconds,first_watched_at,completed_at," +
      "training_viewers!inner(id,name,email,account_id,is_demo)," +
      "training_videos!inner(id,title,duration_seconds,training_modules!inner(id,title,training_courses!inner(id,title)))",
    "training_viewers.is_demo=eq.false",
    `first_watched_at=gte.${enc(`${range.start}T00:00:00Z`)}`,
    `first_watched_at=lt.${enc(endExclusive)}`,
    "order=first_watched_at.asc",
  ];
  if (scope.providerId) filters.push(`training_viewers.account_id=eq.${enc(scope.providerId)}`);
  const rows = await pageAll(`/rest/v1/training_completions?${filters.join("&")}`);
  const header = [
    "Learner", "Email", "Account", "Course", "Module", "Video", "Video length (s)",
    "Watch seconds", "First watched", "Completed at", "Completed",
  ];
  const out = rows.map((row): CsvCell[] => {
    const viewer = (row.training_viewers ?? {}) as Record<string, unknown>;
    const video = (row.training_videos ?? {}) as Record<string, unknown>;
    const module = (video.training_modules ?? {}) as Record<string, unknown>;
    const course = (module.training_courses ?? {}) as Record<string, unknown>;
    return [
      viewer.name ? String(viewer.name) : "", viewer.email ? String(viewer.email) : "",
      viewer.account_id ? String(viewer.account_id) : "", course.title ? String(course.title) : "",
      module.title ? String(module.title) : "", video.title ? String(video.title) : "",
      numberOrNull(video.duration_seconds), numberOrNull(row.watch_seconds) ?? 0,
      row.first_watched_at ? String(row.first_watched_at) : "", row.completed_at ? String(row.completed_at) : "",
      row.completed_at ? "yes" : "no",
    ];
  });
  return { header, rows: out };
}

/* ---------------------------------------------- provider directory */

async function providerDirectory(scope: ExportScope): Promise<ExportSheet> {
  const [providers, locks, activeCounts] = await Promise.all([
    pageAll(
      "/rest/v1/providers?select=provider_id,provider_name,office_name,email,phone,city,state,postal_code,plan,provider_role,access_disabled,offboarding_status,claimed_at,created_at&order=office_name.asc.nullslast,provider_id.asc",
    ),
    pageAll("/rest/v1/provider_account_locks?select=account_id,locked_at&order=locked_at.asc"),
    pageAll("/rest/v1/patients?select=provider_id&activation_status=in.(activated,active)&order=provider_id.asc"),
  ]);
  const lockMap = new Map<string, string>();
  for (const row of locks) {
    const raw = String(row.account_id ?? "");
    lockMap.set(raw.startsWith("acct-") ? raw.slice(5) : raw, String(row.locked_at ?? ""));
  }
  const activeByOffice = new Map<string, number>();
  for (const row of activeCounts) {
    const id = String(row.provider_id ?? "");
    activeByOffice.set(id, (activeByOffice.get(id) ?? 0) + 1);
  }
  // Contact columns ride on provider_contact_read — every HQ role that can
  // request this export holds it, so the directory is the same sheet the
  // accounts page already shows.
  const header = [
    "Account ID", "Office", "Provider", "Role", "Plan", "Status", "Locked at", "Email", "Phone",
    "City", "State", "Postal code", "Active patients", "Claimed at", "Created at",
  ];
  const rows = providers.map((p): CsvCell[] => {
    const id = String(p.provider_id);
    const offboarding = offboardingStatusOf(p.offboarding_status);
    const status = offboarding !== "active" ? offboarding : p.access_disabled === true ? "disabled" : lockMap.has(id) ? "locked" : "active";
    return [
      id, p.office_name ? String(p.office_name) : "", p.provider_name ? String(p.provider_name) : "",
      p.provider_role ? String(p.provider_role) : "", p.plan ? String(p.plan) : "", status, lockMap.get(id) ?? "",
      p.email ? String(p.email) : "", p.phone ? String(p.phone) : "", p.city ? String(p.city) : "",
      p.state ? String(p.state) : "", p.postal_code ? String(p.postal_code) : "", activeByOffice.get(id) ?? 0,
      p.claimed_at ? String(p.claimed_at) : "", p.created_at ? String(p.created_at) : "",
    ];
  });
  return { header, rows };
}

/* ------------------------------------------------ billing transactions */

async function billingTransactions(scope: ExportScope): Promise<ExportSheet> {
  const filters = [
    "select=id,order_number,created_at,provider_id,patient_id,kind,status,subtotal_cents,shipping_charge_cents,tax_cents,total_cents,application_fee_collected_cents,stripe_fee_cents,office_net_cents,stripe_invoice_id,stripe_payment_intent_id,stripe_charge_id,stripe_balance_transaction_id," +
      "billing_payers(name),billing_order_items(product_name_snapshot,quantity),billing_refunds(amount_cents),providers(office_name,provider_name)",
    ...rangeFilters(scope), "order=created_at.asc,id.asc",
  ];
  if (scope.providerId) filters.push(`provider_id=eq.${enc(scope.providerId)}`);
  const orders = await pageAll(`/rest/v1/billing_orders?${filters.join("&")}`);
  const providerIds = [...new Set(orders.map((order) => String(order.provider_id ?? "")).filter(Boolean))];
  const accounts = providerIds.length ? await pageAll(
    `/rest/v1/billing_connected_accounts?select=provider_id,stripe_account_id&disconnected_at=is.null&provider_id=in.(${providerIds.map(enc).join(",")})`,
  ) : [];
  const accountByProvider = new Map(accounts.map((account) => [String(account.provider_id), account]));
  const header = [
    "Order number", "Date", "Office", "Patient / payer", "Items", "Kind", "Status",
    "Subtotal (USD)", "Shipping (USD)", "Tax (USD)", "Total (USD)", "Application fee collected (USD)",
    "Stripe fee (USD)", "Office net (USD)", "Refunded amount (USD)", "Stripe account ID",
    "Stripe invoice ID", "Stripe payment intent ID", "Stripe charge ID", "Stripe balance transaction ID",
  ];
  const rows = orders.map((order): CsvCell[] => {
    const payer = (order.billing_payers ?? {}) as Record<string, unknown>;
    const provider = (order.providers ?? {}) as Record<string, unknown>;
    const account = accountByProvider.get(String(order.provider_id ?? "")) ?? {};
    const items = Array.isArray(order.billing_order_items) ? order.billing_order_items as Record<string, unknown>[] : [];
    const refunds = Array.isArray(order.billing_refunds) ? order.billing_refunds as Record<string, unknown>[] : [];
    return [
      String(order.order_number ?? ""), String(order.created_at ?? ""),
      String(provider.office_name ?? provider.provider_name ?? order.provider_id ?? ""),
      String(payer.name ?? order.patient_id ?? ""), items.map((item) =>
        `${String(item.product_name_snapshot ?? "")} × ${numberOrNull(item.quantity) ?? 0}`).join("; "),
      String(order.kind ?? ""), String(order.status ?? ""), dollars(order.subtotal_cents),
      dollars(order.shipping_charge_cents), dollars(order.tax_cents), dollars(order.total_cents),
      dollars(order.application_fee_collected_cents), dollars(order.stripe_fee_cents), dollars(order.office_net_cents),
      dollars(refunds.reduce((sum, refund) => sum + (numberOrNull(refund.amount_cents) ?? 0), 0)),
      String(account.stripe_account_id ?? ""), String(order.stripe_invoice_id ?? ""),
      String(order.stripe_payment_intent_id ?? ""), String(order.stripe_charge_id ?? ""),
      String(order.stripe_balance_transaction_id ?? ""),
    ];
  });
  return { header, rows };
}

/* ----------------------------------------------- billing subscriptions */

async function billingSubscriptions(scope: ExportScope): Promise<ExportSheet> {
  const filters = [
    "select=id,created_at,provider_id,status,unit_price_cents,current_period_end,payment_failure_count,paused_at,pending_product_id,pending_unit_price_cents,pending_effective_at," +
      "billing_payers(name),billing_products!billing_subscriptions_product_id_fkey(name),pending_product:billing_products!billing_subscriptions_pending_product_id_fkey(name),providers(office_name,provider_name)",
    ...rangeFilters(scope), "order=created_at.asc,id.asc",
  ];
  if (scope.providerId) filters.push(`provider_id=eq.${enc(scope.providerId)}`);
  const subscriptions = await pageAll(`/rest/v1/billing_subscriptions?${filters.join("&")}`);
  const header = [
    "Patient / payer", "Office", "Product", "Status", "Price (USD)", "Renewal date",
    "Payment failures", "Paused at", "Pending change", "Created at",
  ];
  const rows = subscriptions.map((subscription): CsvCell[] => {
    const payer = (subscription.billing_payers ?? {}) as Record<string, unknown>;
    const product = (subscription.billing_products ?? {}) as Record<string, unknown>;
    const provider = (subscription.providers ?? {}) as Record<string, unknown>;
    const pendingProduct = (subscription.pending_product ?? {}) as Record<string, unknown>;
    const pending = subscription.pending_product_id
      ? `${String(pendingProduct.name ?? subscription.pending_product_id)} ($${dollars(subscription.pending_unit_price_cents)}) from ${dateOnly(subscription.pending_effective_at) ?? String(subscription.pending_effective_at ?? "")}`
      : "";
    return [
      String(payer.name ?? ""), String(provider.office_name ?? provider.provider_name ?? subscription.provider_id ?? ""),
      String(product.name ?? ""), String(subscription.status ?? ""), dollars(subscription.unit_price_cents),
      String(subscription.current_period_end ?? ""), numberOrNull(subscription.payment_failure_count) ?? 0,
      String(subscription.paused_at ?? ""), pending,
      String(subscription.created_at ?? ""),
    ];
  });
  return { header, rows };
}

/* ------------------------------------------------------ billing payouts */

async function billingPayouts(scope: ExportScope): Promise<ExportSheet> {
  const filters = [
    "select=id,provider_id,stripe_payout_id,amount_cents,status,arrival_date,method,created_at,providers(office_name,provider_name)",
    ...rangeFilters(scope), "order=created_at.asc,id.asc",
  ];
  if (scope.providerId) filters.push(`provider_id=eq.${enc(scope.providerId)}`);
  const payouts = await pageAll(`/rest/v1/billing_payouts?${filters.join("&")}`);
  const header = ["Payout ID", "Office", "Stripe payout ID", "Amount (USD)", "Status", "Arrival date", "Method", "Created at"];
  const rows = payouts.map((payout): CsvCell[] => {
    const provider = (payout.providers ?? {}) as Record<string, unknown>;
    return [
      String(payout.id ?? ""), String(provider.office_name ?? provider.provider_name ?? payout.provider_id ?? ""),
      String(payout.stripe_payout_id ?? ""), dollars(payout.amount_cents), String(payout.status ?? ""),
      String(payout.arrival_date ?? ""), String(payout.method ?? ""), String(payout.created_at ?? ""),
    ];
  });
  return { header, rows };
}

export const GENERATORS: Record<ExportKind, (scope: ExportScope) => Promise<ExportSheet>> = {
  office_comparison: officeComparison,
  patient_activity: patientActivity,
  audit_events: auditEvents,
  training_completion: trainingCompletion,
  provider_directory: providerDirectory,
  billing_transactions: billingTransactions,
  billing_subscriptions: billingSubscriptions,
  billing_payouts: billingPayouts,
  // Patient records are multi-part ZIPs built by exports/patient-record.ts;
  // the worker branches before reaching this table.
  patient_record: async () => {
    throw new Error("patient_record is not a CSV export");
  },
  // Office bundles are built by jobs/definitions/office-bundle-export.ts.
  office_bundle: async () => {
    throw new Error("office_bundle is not a CSV export");
  },
};
