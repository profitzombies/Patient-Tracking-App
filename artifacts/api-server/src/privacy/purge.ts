/**
 * Account deletion lifecycle and the purge that ends it.
 *
 *   request (grace period) ──cancel-on-sign-in──▶ cancelled
 *          │ purge_after passes
 *          ▼
 *   claim (leased) ─▶ purge steps ─▶ purged
 *                          │ any step throws
 *                          ▼
 *                       failed (retry with backoff; HQ can retry by hand)
 *
 * Purge steps, in this order and each idempotent on re-run:
 *   1. tombstone — persist the PII-free purge marker before destructive work.
 *   2. storage  — delete every object under both patient-owned prefixes
 *                 (photos, chat images, food/recipe images, export archives).
 *                 Needs nothing from the rows, so it is safe to run before
 *                 they go — and a re-run after the rows are gone still works.
 *   3. rows     — `patient_purge_rows` RPC: one transaction that writes the
 *                 PII-free tombstone, deletes every row in every public
 *                 table carrying patient_id (enumerated live in SQL), detaches
 *                 append-only analytics rows, and deletes the patient row.
 *                 Push tokens, notifications, consents, and exports are
 *                 patient_id tables, so they go here too.
 *   4. auth     — put the user's live sessions on the server's revocation
 *                 list (locally verified tokens must die with the account),
 *                 then delete the GoTrue user (the auth_user_id was captured
 *                 on the request row at request time). GoTrue cascades
 *                 sessions, refresh tokens, identities, and MFA factors.
 *                 404 = already gone = done.
 *
 * The request row itself has no FK to the patient and survives, carrying
 * per-step counts in `steps` so HQ can see exactly what happened.
 */
import { logger } from "../lib/logger";
import { objectStorage } from "../lib/objectStorage";
import { supabaseAdmin } from "../lib/supabase-admin";
import { revokeUserSessions } from "../auth/session-revocations";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { PATIENT_MEDIA_PREFIX } from "../routes/patient-media";
import { selectMany, selectOne, update } from "../billing/store";
import { connectedOpts, getStripe, isStripeMissing } from "../billing/stripe-client";

const enc = encodeURIComponent;

export const DELETION_SELECT =
  "id,patient_id,provider_id,auth_user_id,status,requested_at,purge_after,cancelled_at,started_at,purged_at,attempts,next_attempt_at,lease_owner,lease_until,last_error,steps,held_at";

export interface DeletionRequestRow {
  id: string;
  patient_id: string;
  provider_id: string | null;
  auth_user_id: string | null;
  /** `held` = a legal hold parked the request; the grace clock resumes when the hold lifts. */
  status: "pending" | "held" | "cancelled" | "purging" | "purged" | "failed";
  requested_at: string;
  purge_after: string;
  cancelled_at: string | null;
  started_at: string | null;
  purged_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  held_at?: string | null;
  last_error: string | null;
  steps: Record<string, unknown>;
}

/** Grace period before a purge runs. Seconds override wins (staging); blank env = default. */
export function deletionGraceSeconds(): number {
  const seconds = process.env.PATIENT_DELETION_GRACE_SECONDS;
  if (seconds !== undefined && seconds.trim() !== "") {
    const value = Number(seconds);
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  const days = process.env.PATIENT_DELETION_GRACE_DAYS;
  if (days !== undefined && days.trim() !== "") {
    const value = Number(days);
    if (Number.isFinite(value) && value >= 0) return Math.floor(value * 86_400);
  }
  return 7 * 86_400;
}

/** Attempts before the worker stops retrying on its own (HQ retry still works). */
export const MAX_AUTOMATIC_ATTEMPTS = 8;

export function retryDelaySeconds(attempt: number): number {
  // 5 min, 10, 20, 40, 80, 160, ... capped at 6 hours.
  return Math.min(6 * 3600, 300 * 2 ** Math.max(0, attempt - 1));
}

export interface PurgeSummary {
  patientRowDeleted: boolean;
  tombstone: boolean;
  analyticsDetached: number;
  tables: Record<string, number>;
  authUserId: string | null;
}

export interface PurgeDeps {
  prepareTombstone: (requestId: string) => Promise<boolean>;
  cancelBillingSubscriptions: (patientId: string) => Promise<number>;
  scrubBillingCustomers: (patientId: string) => Promise<number>;
  deleteStoragePrefix: (prefix: string) => Promise<number>;
  purgeRows: (requestId: string) => Promise<PurgeSummary>;
  deleteAuthUser: (userId: string) => Promise<"deleted" | "absent">;
  finish: (input: {
    requestId: string;
    status: "purged" | "failed";
    error?: string | null;
    steps: Record<string, unknown>;
    retryAfterSeconds?: number | null;
  }) => Promise<void>;
  audit: (input: Parameters<typeof recordAdminAuditEvent>[0]) => Promise<void>;
  now?: () => Date;
}

export const defaultPurgeDeps: PurgeDeps = {
  async prepareTombstone(requestId) {
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_purge_prepare_tombstone", { p_request_id: requestId });
    if (result.status >= 300 || result.json !== true) {
      throw new Error(`purge tombstone failed (${result.status})`);
    }
    return true;
  },
  async cancelBillingSubscriptions(patientId) {
    const subscriptions = await selectMany(
      "billing_subscriptions",
      `patient_id=eq.${enc(patientId)}&status=neq.canceled&stripe_subscription_id=not.is.null&select=id,provider_id,stripe_subscription_id`,
    );
    if (subscriptions.length === 0) return 0;
    let stripe: Awaited<ReturnType<typeof getStripe>> | null = null;
    let canceled = 0;
    for (const subscription of subscriptions) {
      const officeCount = subscriptions.filter((row) => row.provider_id === subscription.provider_id).length;
      const account = await selectOne(
        "billing_connected_accounts",
        `provider_id=eq.${enc(subscription.provider_id)}&select=stripe_account_id,disconnected_at,charges_enabled`,
      );
      if (!account) {
        throw new Error(`Billing purge blocked for office ${subscription.provider_id}: missing Stripe account for ${officeCount} live subscription(s).`);
      }
      if (account.disconnected_at) {
        throw new Error(`Billing purge blocked for office ${subscription.provider_id}: disconnected Stripe account for ${officeCount} live subscription(s).`);
      }
      try {
        stripe ??= await getStripe();
        const value: any = await stripe.subscriptions.cancel(
          subscription.stripe_subscription_id!,
          {},
          connectedOpts(account.stripe_account_id),
        );
        await update("billing_subscriptions", `id=eq.${enc(subscription.id)}`, {
          status: "canceled",
          cancel_at_period_end: Boolean(value.cancel_at_period_end),
          canceled_at: value.canceled_at ? new Date(value.canceled_at * 1000).toISOString() : new Date().toISOString(),
        });
        canceled += 1;
      } catch (error) {
        if (isStripeMissing(error)) {
          await update("billing_subscriptions", `id=eq.${enc(subscription.id)}`, {
            status: "canceled", cancel_at_period_end: false, canceled_at: new Date().toISOString(),
          });
          canceled += 1;
          continue;
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Billing purge blocked for office ${subscription.provider_id}: Stripe failed to cancel ${officeCount} live subscription(s): ${detail}`);
      }
    }
    return canceled;
  },
  async scrubBillingCustomers(patientId) {
    const payers = await selectMany(
      "billing_payers",
      `patient_id=eq.${enc(patientId)}&stripe_customer_id=not.is.null&select=id,provider_id,stripe_customer_id`,
    );
    if (payers.length === 0) return 0;
    let stripe: Awaited<ReturnType<typeof getStripe>> | null = null;
    let scrubbed = 0;
    for (const payer of payers) {
      const officeCount = payers.filter((row) => row.provider_id === payer.provider_id).length;
      if (!payer.stripe_customer_id) {
        throw new Error(`Billing purge blocked for office ${payer.provider_id}: invalid Stripe customer reference.`);
      }
      const account = await selectOne(
        "billing_connected_accounts",
        `provider_id=eq.${enc(payer.provider_id)}&select=stripe_account_id,disconnected_at,charges_enabled`,
      );
      if (!account) {
        throw new Error(`Billing purge blocked for office ${payer.provider_id}: missing Stripe account for ${officeCount} customer(s).`);
      }
      if (account.disconnected_at) {
        throw new Error(`Billing purge blocked for office ${payer.provider_id}: disconnected Stripe account for ${officeCount} customer(s).`);
      }
      try {
        stripe ??= await getStripe();
        await stripe.customers.update(
          payer.stripe_customer_id,
          {
            name: "Deleted patient",
            email: `deleted+${payer.id}@invalid.thinnr`,
            phone: "",
            address: null,
            shipping: null,
          },
          connectedOpts(account.stripe_account_id),
        );
        scrubbed += 1;
      } catch (error) {
        if (isStripeMissing(error)) {
          scrubbed += 1;
          continue;
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Billing purge blocked for office ${payer.provider_id}: Stripe failed to scrub ${officeCount} customer(s): ${detail}`);
      }
    }
    return scrubbed;
  },
  deleteStoragePrefix: (prefix) => objectStorage.deletePrefixStrict(prefix),
  async purgeRows(requestId) {
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_purge_rows", { p_request_id: requestId });
    if (result.status >= 300 || !result.json || typeof result.json !== "object") {
      throw new Error(`row purge failed (${result.status})`);
    }
    const summary = result.json as Record<string, unknown>;
    return {
      patientRowDeleted: summary.patientRowDeleted === true,
      tombstone: summary.tombstone === true,
      analyticsDetached: Number(summary.analyticsDetached ?? 0),
      tables: (summary.tables && typeof summary.tables === "object" ? summary.tables : {}) as Record<string, number>,
      authUserId: typeof summary.authUserId === "string" ? summary.authUserId : null,
    };
  },
  async deleteAuthUser(userId) {
    await revokeUserSessions({ userId, reason: "purge" });
    const result = await supabaseAdmin("DELETE", `/auth/v1/admin/users/${enc(userId)}`);
    if (result.status === 404) return "absent";
    if (result.status >= 300) throw new Error(`auth user delete failed (${result.status})`);
    return "deleted";
  },
  async finish(input) {
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_deletion_finish", {
      p_request_id: input.requestId,
      p_status: input.status,
      p_error: input.error ?? null,
      p_steps: input.steps,
      p_retry_after_seconds: input.retryAfterSeconds ?? null,
    });
    if (result.status >= 300) throw new Error(`deletion finish failed (${result.status})`);
  },
  audit: (input) => recordAdminAuditEvent(input),
};

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300) || "Purge failed.";
}

export function patientStoragePrefix(patientId: string): string {
  return `${PATIENT_MEDIA_PREFIX}${patientId}/`;
}

export function patientBloodworkStoragePrefix(patientId: string): string {
  return `/objects/patients/${patientId}/bloodwork/`;
}

/**
 * Run every purge step for one claimed request. Never throws: the outcome
 * lands on the request row (purged, or failed with the step that broke and
 * when to retry) and in the audit log.
 */
export async function runPurge(request: DeletionRequestRow, deps: PurgeDeps = defaultPurgeDeps): Promise<"purged" | "failed"> {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const steps: Record<string, unknown> = { ...(request.steps ?? {}) };
  let step = "tombstone";
  try {
    const tombstone = await deps.prepareTombstone(request.id);
    if (!tombstone) throw new Error("tombstone missing before storage purge");
    steps.tombstone = { ok: true, at: now() };

    step = "billingSubscriptions";
    const subscriptionsCanceled = await deps.cancelBillingSubscriptions(request.patient_id);
    steps.billingSubscriptions = { ok: true, canceled: subscriptionsCanceled, at: now() };

    step = "billingCustomers";
    const customersScrubbed = await deps.scrubBillingCustomers(request.patient_id);
    steps.billingCustomers = { ok: true, scrubbed: customersScrubbed, at: now() };

    step = "storage";
    const mediaObjects = await deps.deleteStoragePrefix(patientStoragePrefix(request.patient_id));
    const bloodworkObjects = await deps.deleteStoragePrefix(patientBloodworkStoragePrefix(request.patient_id));
    const objects = mediaObjects + bloodworkObjects;
    steps.storage = { ok: true, objects, prefixes: 2, at: now() };

    step = "rows";
    const summary = await deps.purgeRows(request.id);
    const tableCount = Object.keys(summary.tables).length;
    const rowCount = Object.values(summary.tables).reduce((sum, n) => sum + Number(n || 0), 0);
    steps.rows = {
      ok: true,
      tables: tableCount,
      rows: rowCount,
      tombstone: summary.tombstone,
      patientRowDeleted: summary.patientRowDeleted,
      analyticsDetached: summary.analyticsDetached,
      at: now(),
    };
    if (!summary.tombstone) throw new Error("tombstone missing after row purge");

    step = "auth";
    const authUserId = request.auth_user_id ?? summary.authUserId;
    if (authUserId) {
      const outcome = await deps.deleteAuthUser(authUserId);
      steps.auth = { ok: true, outcome, at: now() };
    } else {
      steps.auth = { ok: true, outcome: "none", at: now() };
    }

    await deps.finish({ requestId: request.id, status: "purged", steps });
    await deps
      .audit({
        action: "patient_deletion_purged",
        actorUserId: null,
        actorKind: "system",
        providerId: request.provider_id,
        targetKind: "patient",
        targetId: request.patient_id,
        requestId: null,
        metadata: { requestId: request.id, attempt: request.attempts, objects: Number((steps.storage as { objects: number }).objects), tables: tableCount, rows: rowCount },
      })
      .catch((error) => logger.error({ err: error }, "deletion purge audit failed"));
    return "purged";
  } catch (error) {
    logger.error({ err: error, requestId: request.id, step }, "patient purge step failed");
    steps[step] = { ok: false, error: shortError(error), at: now() };
    const retryAfterSeconds = request.attempts < MAX_AUTOMATIC_ATTEMPTS ? retryDelaySeconds(request.attempts) : null;
    try {
      await deps.finish({ requestId: request.id, status: "failed", error: `${step}: ${shortError(error)}`, steps, retryAfterSeconds });
    } catch (finishError) {
      logger.error({ err: finishError, requestId: request.id }, "patient purge failure not recorded");
    }
    await deps
      .audit({
        action: "patient_deletion_failed",
        actorUserId: null,
        actorKind: "system",
        providerId: request.provider_id,
        targetKind: "patient",
        targetId: request.patient_id,
        requestId: null,
        metadata: { requestId: request.id, attempt: request.attempts, step },
      })
      .catch((auditError) => logger.error({ err: auditError }, "deletion failure audit failed"));
    return "failed";
  }
}

const LEASE_OWNER = `api-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

let draining: Promise<number> | null = null;

/** Claim every due deletion (pending past its grace, failed past its retry, or stale lease) and purge it. */
export function drainDuePurges(maxRequests = 5, deps: PurgeDeps = defaultPurgeDeps): Promise<number> {
  if (draining) return draining;
  draining = (async () => {
    let ran = 0;
    try {
      const claimed = await supabaseAdmin("POST", "/rest/v1/rpc/claim_due_patient_deletions", {
        p_owner: LEASE_OWNER,
        p_limit: maxRequests,
        p_lease_seconds: 600,
      });
      if (claimed.status >= 300 || !Array.isArray(claimed.json)) {
        throw new Error(`deletion claim failed (${claimed.status})`);
      }
      for (const request of claimed.json as DeletionRequestRow[]) {
        await runPurge(request, deps);
        ran += 1;
      }
    } catch (error) {
      logger.error({ err: error }, "deletion drain stopped");
    } finally {
      draining = null;
    }
    return ran;
  })();
  return draining;
}
