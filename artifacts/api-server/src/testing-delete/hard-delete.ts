/**
 * HQ testing override — permanently erase one office or one patient.
 *
 * This is deliberately NOT the compliant lifecycle (offboarding, deletion
 * requests, legal holds). It exists only while THINNR is being tested and is
 * self-contained so it can be removed in one go: this folder, the
 * `hq-testing-delete` router, the web `TestingHardDelete` section, and the
 * `hq_testing_hard_delete` SQL function.
 *
 * Order of work:
 *   1. Stripe first, while the database still knows every id:
 *      - cancel live patient subscriptions (a failure aborts before anything
 *        is deleted, so nobody keeps being charged for a record that vanished);
 *      - office: delete THINNR-created connected accounts, disconnect
 *        (deauthorize) linked ones, detach the office's THINNR-plan payment
 *        methods and delete its platform customer. Refusals are reported and
 *        do not stop the delete.
 *   2. One SQL transaction removes every row keyed to the target.
 *   3. Login accounts (never HQ members), then stored files.
 * Every outcome is reported back to the caller; nothing fails silently.
 */
import type Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase-admin";
import { objectStorage } from "../lib/objectStorage";
import { revokeUserSessions } from "../auth/session-revocations";
import { PATIENT_MEDIA_PREFIX } from "../routes/patient-media";
import { getStripe, getStripeCredentials, isStripeMissing } from "../billing/stripe-client";
import { runWithBillingIdentity, type BillingIdentity, type StripeMode } from "../billing/stripe-environment";

const enc = encodeURIComponent;

export type TargetKind = "provider" | "patient";

export class HardDeleteError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: Partial<HardDeleteResult>) {
    super(message);
    this.name = "HardDeleteError";
  }
}

type StripeLike = Pick<Stripe, "accounts" | "oauth" | "subscriptions" | "customers" | "paymentMethods">;

export interface HardDeleteDeps {
  rest(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
  /** Runs `fn` with a Stripe client for exactly this persisted identity, or throws if unavailable. */
  withStripe<T>(identity: BillingIdentity, fn: (stripe: StripeLike) => Promise<T>): Promise<T>;
  connectClientId(mode: StripeMode): string | null;
  /** Resolves the platform a legacy row (no persisted identity) belongs to. */
  defaultPlatform(mode: StripeMode): Promise<string>;
  deleteAuthUser(userId: string): Promise<"deleted" | "absent">;
  deletePrefix(prefix: string): Promise<number>;
  deleteObject(path: string): Promise<void>;
}

export const defaultHardDeleteDeps: HardDeleteDeps = {
  async rest(method, path, body) {
    const result = await supabaseAdmin(method, path, body);
    return { status: result.status, json: result.json };
  },
  async withStripe(identity, fn) {
    return runWithBillingIdentity(identity, async () => {
      const credentials = await getStripeCredentials(identity.mode);
      if (credentials.account_id !== identity.platformAccountId) {
        throw new Error("the original Stripe platform credentials are not available here");
      }
      return fn(await getStripe(identity.mode));
    });
  },
  connectClientId(mode) {
    const value = process.env[`STRIPE_${mode.toUpperCase()}_CONNECT_CLIENT_ID`]?.trim();
    return value && /^ca_[A-Za-z0-9]+$/.test(value) ? value : null;
  },
  async defaultPlatform(mode) {
    return (await getStripeCredentials(mode)).account_id;
  },
  async deleteAuthUser(userId) {
    await revokeUserSessions({ userId, reason: "purge" });
    const result = await supabaseAdmin("DELETE", `/auth/v1/admin/users/${enc(userId)}`);
    if (result.status === 404) return "absent";
    if (result.status >= 300) throw new Error(`login delete failed (${result.status})`);
    return "deleted";
  },
  deletePrefix: (prefix) => objectStorage.deletePrefixStrict(prefix),
  deleteObject: (path) => objectStorage.deleteObjectStrict(path),
};

// ── Preview ────────────────────────────────────────────────────────────────

export interface StripeAccountSummary {
  accountId: string;
  origin: "created" | "oauth" | "unknown";
  mode: StripeMode | null;
  archived: boolean;
}

export interface ProviderPreview {
  kind: "provider";
  id: string;
  name: string;
  providerName: string | null;
  staffLogins: number;
  hqMembersKept: number;
  patients: number;
  patientLogins: number;
  stripeAccounts: StripeAccountSummary[];
  accessPlan: { state: string; savedPaymentMethods: number } | null;
}

export interface PatientPreview {
  kind: "patient";
  id: string;
  name: string;
  providerId: string | null;
  officeName: string | null;
  hasLogin: boolean;
  hqMemberKept: boolean;
  activeSubscriptions: number;
}

async function rows<T = Record<string, any>>(deps: HardDeleteDeps, path: string): Promise<T[]> {
  const result = await deps.rest("GET", `/rest/v1/${path}`);
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new HardDeleteError("Could not read the records for this delete. Try again.", 503);
  }
  return result.json as T[];
}

const inList = (values: string[]) => `(${values.map((v) => `"${v.replace(/"/g, "")}"`).join(",")})`;

export function patientDisplayName(row: { first_name?: string | null; last_name?: string | null; email?: string | null }): string {
  const name = [row.first_name, row.last_name].map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
  return name || (row.email ?? "").trim() || "Unnamed patient";
}

export function providerDisplayName(row: { office_name?: string | null; provider_name?: string | null; provider_id: string }): string {
  return (row.office_name ?? "").trim() || (row.provider_name ?? "").trim() || row.provider_id;
}

/** Case- and spacing-insensitive, so a typed name matches what the page shows. */
export function namesMatch(typed: unknown, expected: string): boolean {
  if (typeof typed !== "string") return false;
  const norm = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return norm(typed).length > 0 && norm(typed) === norm(expected);
}

async function activeHqUsers(deps: HardDeleteDeps, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const members = await rows<{ auth_user_id: string; status: string | null }>(
    deps, `hq_memberships?auth_user_id=in.${inList(userIds)}&select=auth_user_id,status`);
  return new Set(members.filter((m) => m.status !== "revoked").map((m) => m.auth_user_id));
}

function accountOrigin(value: unknown): StripeAccountSummary["origin"] {
  return value === "created" || value === "oauth" ? value : "unknown";
}
function accountMode(value: unknown): StripeMode | null {
  return value === "test" || value === "live" ? value : null;
}

async function loadProvider(deps: HardDeleteDeps, providerId: string) {
  const [provider] = await rows(deps,
    `providers?provider_id=eq.${enc(providerId)}&select=provider_id,office_name,provider_name,auth_user_id`);
  if (!provider) throw new HardDeleteError("That office no longer exists.", 404);
  return provider as { provider_id: string; office_name: string | null; provider_name: string | null; auth_user_id: string | null };
}

async function loadPatient(deps: HardDeleteDeps, patientId: string) {
  const [patient] = await rows(deps,
    `patients?id=eq.${enc(patientId)}&select=id,first_name,last_name,email,provider_id,auth_user_id,archived_into_patient_id`);
  if (!patient) throw new HardDeleteError("That patient no longer exists.", 404);
  return patient as { id: string; first_name: string | null; last_name: string | null; email: string | null; provider_id: string | null; auth_user_id: string | null };
}

async function connectedAccounts(deps: HardDeleteDeps, providerId: string) {
  const current = await rows(deps,
    `billing_connected_accounts?provider_id=eq.${enc(providerId)}&select=stripe_account_id,origin,stripe_mode,stripe_platform_account_id`);
  const archived = await rows(deps,
    `billing_connect_archive?provider_id=eq.${enc(providerId)}&select=stripe_mode,platform_account_id,account_snapshot`);
  const out: Array<StripeAccountSummary & { platform: string | null }> = [];
  for (const row of current) {
    if (typeof row.stripe_account_id !== "string") continue;
    out.push({ accountId: row.stripe_account_id, origin: accountOrigin(row.origin), mode: accountMode(row.stripe_mode),
      archived: false, platform: row.stripe_platform_account_id ?? null });
  }
  for (const row of archived) {
    const snapshot = (row.account_snapshot ?? {}) as Record<string, unknown>;
    const id = snapshot.stripe_account_id;
    if (typeof id !== "string" || out.some((a) => a.accountId === id)) continue;
    out.push({ accountId: id, origin: accountOrigin(snapshot.origin), mode: accountMode(row.stripe_mode ?? snapshot.stripe_mode),
      archived: true, platform: (row.platform_account_id as string | null) ?? (snapshot.stripe_platform_account_id as string | null) ?? null });
  }
  return out;
}

export async function previewProvider(providerId: string, deps: HardDeleteDeps = defaultHardDeleteDeps): Promise<ProviderPreview> {
  const provider = await loadProvider(deps, providerId);
  const team = await rows<{ auth_user_id: string | null }>(deps, `team_members?provider_id=eq.${enc(providerId)}&select=auth_user_id`);
  const profiles = await rows<{ id: string }>(deps, `profiles?provider_account_code=eq.${enc(providerId)}&select=id`);
  const patients = await rows<{ auth_user_id: string | null }>(deps, `patients?provider_id=eq.${enc(providerId)}&select=auth_user_id`);
  const staffUsers = [...new Set([provider.auth_user_id, ...team.map((t) => t.auth_user_id), ...profiles.map((p) => p.id)]
    .filter((id): id is string => typeof id === "string"))];
  const kept = await activeHqUsers(deps, staffUsers);
  const accounts = await connectedAccounts(deps, providerId);
  const [access] = await rows(deps, `billing_office_access_subscriptions?provider_id=eq.${enc(providerId)}&select=id,state`);
  let accessPlan: ProviderPreview["accessPlan"] = null;
  if (access) {
    const instruments = await rows(deps,
      `billing_office_access_instruments?provider_id=eq.${enc(providerId)}&stripe_payment_method_id=not.is.null&detached_at=is.null&select=id`);
    accessPlan = { state: String(access.state ?? "unknown"), savedPaymentMethods: instruments.length };
  }
  return {
    kind: "provider",
    id: provider.provider_id,
    name: providerDisplayName(provider),
    providerName: provider.provider_name,
    staffLogins: staffUsers.filter((id) => !kept.has(id)).length,
    hqMembersKept: kept.size,
    patients: patients.length,
    patientLogins: patients.filter((p) => p.auth_user_id).length,
    stripeAccounts: accounts.map(({ platform: _platform, ...rest }) => rest),
    accessPlan,
  };
}

export async function previewPatient(patientId: string, deps: HardDeleteDeps = defaultHardDeleteDeps): Promise<PatientPreview> {
  const patient = await loadPatient(deps, patientId);
  let officeName: string | null = null;
  if (patient.provider_id) {
    const [office] = await rows(deps, `providers?provider_id=eq.${enc(patient.provider_id)}&select=provider_id,office_name,provider_name`);
    officeName = office ? providerDisplayName(office as any) : null;
  }
  const kept = patient.auth_user_id ? await activeHqUsers(deps, [patient.auth_user_id]) : new Set<string>();
  const subs = await rows(deps,
    `billing_subscriptions?patient_id=eq.${enc(patientId)}&status=neq.canceled&stripe_subscription_id=not.is.null&select=id`);
  return {
    kind: "patient",
    id: patient.id,
    name: patientDisplayName(patient),
    providerId: patient.provider_id,
    officeName,
    hasLogin: Boolean(patient.auth_user_id),
    hqMemberKept: kept.size > 0,
    activeSubscriptions: subs.length,
  };
}

// ── Delete ─────────────────────────────────────────────────────────────────

export type StripeOutcome =
  | { kind: "connected_account"; accountId: string; origin: StripeAccountSummary["origin"]; archived: boolean;
      result: "deleted" | "disconnected" | "already_gone" | "refused"; message?: string }
  | { kind: "access_payment_method"; paymentMethodId: string; result: "removed" | "already_gone" | "failed"; message?: string }
  | { kind: "access_customer"; customerId: string; result: "deleted" | "already_gone" | "failed"; message?: string }
  | { kind: "access_plan"; result: "cancelled"; state: string }
  | { kind: "patient_subscriptions"; result: "cancelled" | "not_reachable"; count: number; message?: string }
  | { kind: "patient_customers"; result: "deleted" | "failed"; count: number; message?: string };

export interface HardDeleteResult {
  kind: TargetKind;
  id: string;
  name: string;
  stripe: StripeOutcome[];
  logins: { deleted: number; alreadyGone: number; keptHqMembers: number; failed: string[] };
  files: { deleted: number; failed: string[] };
  rows: Record<string, number>;
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/https?:\/\/\S+/g, "[url]").slice(0, 240);
}

async function identityFor(deps: HardDeleteDeps, mode: StripeMode | null, platform: string | null): Promise<BillingIdentity> {
  const resolved = mode ?? "test";
  return { mode: resolved, platformAccountId: platform ?? (await deps.defaultPlatform(resolved)) };
}

async function stripeAccountsForProvider(deps: HardDeleteDeps, providerId: string) {
  const map = new Map<string, { accountId: string; identity: BillingIdentity; disconnected: boolean }>();
  const current = await rows(deps,
    `billing_connected_accounts?provider_id=eq.${enc(providerId)}&select=stripe_account_id,stripe_mode,stripe_platform_account_id,disconnected_at`);
  for (const row of current) {
    map.set(`${row.stripe_mode ?? "test"}:${row.stripe_platform_account_id ?? ""}`, {
      accountId: row.stripe_account_id,
      identity: await identityFor(deps, accountMode(row.stripe_mode), row.stripe_platform_account_id ?? null),
      disconnected: Boolean(row.disconnected_at),
    });
  }
  return [...map.values()];
}

/** Cancels live patient subscriptions on the office's connected account. Throws on a real Stripe failure. */
async function cancelPatientSubscriptions(
  deps: HardDeleteDeps, filter: string, outcomes: StripeOutcome[],
): Promise<void> {
  const subs = await rows(deps,
    `billing_subscriptions?${filter}&status=neq.canceled&stripe_subscription_id=not.is.null&select=id,provider_id,stripe_subscription_id,stripe_mode,stripe_platform_account_id`);
  if (subs.length === 0) return;
  let cancelled = 0;
  let unreachable = 0;
  for (const sub of subs) {
    const identity = await identityFor(deps, accountMode(sub.stripe_mode), sub.stripe_platform_account_id ?? null);
    const accounts = await stripeAccountsForProvider(deps, sub.provider_id);
    const account = accounts.find((a) => a.identity.mode === identity.mode && a.identity.platformAccountId === identity.platformAccountId)
      ?? accounts[0];
    if (!account || account.disconnected) { unreachable += 1; continue; }
    try {
      await deps.withStripe(identity, (stripe) =>
        stripe.subscriptions.cancel(sub.stripe_subscription_id, {}, { stripeAccount: account.accountId }));
      cancelled += 1;
    } catch (error) {
      if (isStripeMissing(error)) { cancelled += 1; continue; }
      throw new HardDeleteError(
        `Nothing was deleted: Stripe could not cancel a patient subscription (${message(error)}). Try again.`, 502,
        { stripe: outcomes });
    }
  }
  if (cancelled > 0) outcomes.push({ kind: "patient_subscriptions", result: "cancelled", count: cancelled });
  if (unreachable > 0) {
    outcomes.push({ kind: "patient_subscriptions", result: "not_reachable", count: unreachable,
      message: "The office's Stripe account is missing or disconnected, so Stripe can no longer charge these." });
  }
}

/** Deletes a patient's Stripe customers on the office account (removes name/email there). Never blocks. */
async function deletePatientCustomers(deps: HardDeleteDeps, patientId: string, outcomes: StripeOutcome[]): Promise<void> {
  const payers = await rows(deps,
    `billing_payers?patient_id=eq.${enc(patientId)}&stripe_customer_id=not.is.null&select=provider_id,stripe_customer_id,stripe_mode,stripe_platform_account_id`);
  let deleted = 0;
  const failures: string[] = [];
  for (const payer of payers) {
    try {
      const identity = await identityFor(deps, accountMode(payer.stripe_mode), payer.stripe_platform_account_id ?? null);
      const accounts = await stripeAccountsForProvider(deps, payer.provider_id);
      const account = accounts.find((a) => a.identity.mode === identity.mode) ?? accounts[0];
      if (!account || account.disconnected) continue;
      await deps.withStripe(identity, (stripe) =>
        stripe.customers.del(payer.stripe_customer_id, {}, { stripeAccount: account.accountId }));
      deleted += 1;
    } catch (error) {
      if (isStripeMissing(error)) { deleted += 1; continue; }
      failures.push(message(error));
    }
  }
  if (deleted > 0) outcomes.push({ kind: "patient_customers", result: "deleted", count: deleted });
  if (failures.length > 0) outcomes.push({ kind: "patient_customers", result: "failed", count: failures.length, message: failures[0] });
}

async function removeOfficeStripe(deps: HardDeleteDeps, providerId: string, outcomes: StripeOutcome[]): Promise<void> {
  for (const account of await connectedAccounts(deps, providerId)) {
    const base = { kind: "connected_account" as const, accountId: account.accountId, origin: account.origin, archived: account.archived };
    try {
      const identity = await identityFor(deps, account.mode, account.platform);
      if (account.origin === "created") {
        await deps.withStripe(identity, (stripe) => stripe.accounts.del(account.accountId));
        outcomes.push({ ...base, result: "deleted" });
      } else {
        const clientId = deps.connectClientId(identity.mode);
        if (!clientId) throw new Error("no Stripe Connect client ID is configured for this mode");
        await deps.withStripe(identity, (stripe) =>
          stripe.oauth.deauthorize({ client_id: clientId, stripe_user_id: account.accountId }));
        outcomes.push({ ...base, result: "disconnected" });
      }
    } catch (error) {
      if (isStripeMissing(error)) { outcomes.push({ ...base, result: "already_gone" }); continue; }
      outcomes.push({ ...base, result: "refused",
        message: `${message(error)} — THINNR's link to it was still removed.` });
    }
  }

  const plans = await rows(deps,
    `billing_office_access_subscriptions?provider_id=eq.${enc(providerId)}&select=id,state,stripe_customer_id,stripe_mode,stripe_platform_account_id`);
  for (const plan of plans) {
    const identity = await identityFor(deps, accountMode(plan.stripe_mode), plan.stripe_platform_account_id ?? null).catch(() => null);
    const instruments = await rows(deps,
      `billing_office_access_instruments?subscription_id=eq.${enc(plan.id)}&stripe_payment_method_id=not.is.null&detached_at=is.null&select=stripe_payment_method_id,stripe_mode,stripe_platform_account_id`);
    for (const instrument of instruments) {
      const pm = instrument.stripe_payment_method_id as string;
      try {
        const own = await identityFor(deps, accountMode(instrument.stripe_mode), instrument.stripe_platform_account_id ?? null);
        await deps.withStripe(own, (stripe) => stripe.paymentMethods.detach(pm));
        outcomes.push({ kind: "access_payment_method", paymentMethodId: pm, result: "removed" });
      } catch (error) {
        outcomes.push({ kind: "access_payment_method", paymentMethodId: pm,
          result: isStripeMissing(error) ? "already_gone" : "failed",
          ...(isStripeMissing(error) ? {} : { message: message(error) }) });
      }
    }
    if (typeof plan.stripe_customer_id === "string" && plan.stripe_customer_id) {
      try {
        if (!identity) throw new Error("the plan's Stripe identity is unavailable");
        await deps.withStripe(identity, (stripe) => stripe.customers.del(plan.stripe_customer_id));
        outcomes.push({ kind: "access_customer", customerId: plan.stripe_customer_id, result: "deleted" });
      } catch (error) {
        outcomes.push({ kind: "access_customer", customerId: plan.stripe_customer_id,
          result: isStripeMissing(error) ? "already_gone" : "failed",
          ...(isStripeMissing(error) ? {} : { message: message(error) }) });
      }
    }
    // THINNR plan charges are job-driven payments, not a Stripe subscription:
    // removing the plan row (in the SQL step) is what stops every future charge.
    outcomes.push({ kind: "access_plan", result: "cancelled", state: String(plan.state ?? "unknown") });
  }
}

interface SqlSummary {
  patientIds: string[];
  authUserIds: string[];
  preservedUserIds: string[];
  objectPaths: string[];
  exportIds: string[];
  tables: Record<string, number>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

async function deleteRows(deps: HardDeleteDeps, kind: TargetKind, id: string): Promise<SqlSummary> {
  const result = await deps.rest("POST", "/rest/v1/rpc/hq_testing_hard_delete",
    kind === "provider" ? { p_provider_id: id, p_patient_id: null } : { p_provider_id: null, p_patient_id: id });
  if (result.status >= 300 || !result.json || typeof result.json !== "object") {
    const detail = (result.json as { message?: string } | null)?.message;
    throw new HardDeleteError(`The database delete failed${detail ? `: ${String(detail).slice(0, 200)}` : ""}. Nothing was removed from the database.`, 500);
  }
  const json = result.json as Record<string, unknown>;
  return {
    patientIds: strings(json.patientIds),
    authUserIds: strings(json.authUserIds),
    preservedUserIds: strings(json.preservedUserIds),
    objectPaths: strings(json.objectPaths),
    exportIds: strings(json.exportIds),
    tables: (json.tables && typeof json.tables === "object" ? json.tables : {}) as Record<string, number>,
  };
}

async function finishOutside(deps: HardDeleteDeps, summary: SqlSummary) {
  const logins = { deleted: 0, alreadyGone: 0, keptHqMembers: summary.preservedUserIds.length, failed: [] as string[] };
  for (const userId of summary.authUserIds) {
    try {
      (await deps.deleteAuthUser(userId)) === "deleted" ? logins.deleted += 1 : logins.alreadyGone += 1;
    } catch (error) {
      logins.failed.push(`${userId}: ${message(error)}`);
    }
  }
  const files = { deleted: 0, failed: [] as string[] };
  const prefixes = [
    ...summary.patientIds.flatMap((pid) => [`${PATIENT_MEDIA_PREFIX}${pid}/`, `/objects/patients/${pid}/`]),
    ...summary.exportIds.map((id) => `/objects/exports/${id}/`),
  ];
  for (const prefix of prefixes) {
    try { files.deleted += await deps.deletePrefix(prefix); } catch (error) { files.failed.push(`${prefix}: ${message(error)}`); }
  }
  const covered = (path: string) => prefixes.some((prefix) => path.startsWith(prefix));
  for (const path of summary.objectPaths.filter((p) => !covered(p))) {
    try { await deps.deleteObject(path); files.deleted += 1; } catch (error) { files.failed.push(`${path}: ${message(error)}`); }
  }
  return { logins, files };
}

export async function hardDeleteProvider(providerId: string, deps: HardDeleteDeps = defaultHardDeleteDeps): Promise<HardDeleteResult> {
  const provider = await loadProvider(deps, providerId);
  const stripe: StripeOutcome[] = [];
  await cancelPatientSubscriptions(deps, `provider_id=eq.${enc(providerId)}`, stripe);
  await removeOfficeStripe(deps, providerId, stripe);
  const summary = await deleteRows(deps, "provider", providerId).catch((error) => {
    if (error instanceof HardDeleteError) throw new HardDeleteError(error.message, error.status, { stripe });
    throw error;
  });
  const { logins, files } = await finishOutside(deps, summary);
  return { kind: "provider", id: providerId, name: providerDisplayName(provider), stripe, logins, files, rows: summary.tables };
}

export async function hardDeletePatient(patientId: string, deps: HardDeleteDeps = defaultHardDeleteDeps): Promise<HardDeleteResult> {
  const patient = await loadPatient(deps, patientId);
  const stripe: StripeOutcome[] = [];
  await cancelPatientSubscriptions(deps, `patient_id=eq.${enc(patientId)}`, stripe);
  await deletePatientCustomers(deps, patientId, stripe);
  const summary = await deleteRows(deps, "patient", patientId).catch((error) => {
    if (error instanceof HardDeleteError) throw new HardDeleteError(error.message, error.status, { stripe });
    throw error;
  });
  const { logins, files } = await finishOutside(deps, summary);
  return { kind: "patient", id: patientId, name: patientDisplayName(patient), stripe, logins, files, rows: summary.tables };
}
