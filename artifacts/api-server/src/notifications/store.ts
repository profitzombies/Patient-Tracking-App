/**
 * Persistence seam for the notification outbox.
 *
 * `NotificationStore` is everything the sender, the coach-outreach evaluator
 * and the patient/office routes need from the database. The Supabase-backed
 * implementation below talks PostgREST through the service role; tests use
 * the in-memory implementation in memory-store.ts, which honors the same
 * contracts (lease ownership guards, dedupe keys, status filters).
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import { OFFICE_STATUS_COLUMNS, loadAppReviewOfficeIds, officeIsActive } from "../lib/office-status";
import type { DoseLogRecord, MedicationRecord } from "../medications/schedule";
import { DOSE_LOG_SELECT, MEDICATION_SELECT, doseLogFromRow, medicationFromRow } from "../medications/store";
import type {
  AttemptRow,
  CappedEnqueueResult,
  DailyCap,
  EnqueueInput,
  NotificationRow,
  NotificationStatus,
  OutreachStateRow,
  PolicyContext,
  PushTokenRow,
  TokenDisableReason,
} from "./types";

const enc = encodeURIComponent;

export type NotificationPatch = Partial<
  Pick<
    NotificationRow,
    | "status"
    | "attempts"
    | "next_attempt_at"
    | "lease_owner"
    | "lease_until"
    | "suppression_reason"
    | "last_error"
    | "sent_at"
    | "delivered_at"
    | "opened_at"
    | "engaged_at"
    | "finalized_at"
    | "receipts_checked_at"
  >
>;

export interface UpdateGuard {
  /** Only apply while this owner still holds the lease. */
  leaseOwner?: string;
  /** Only apply while the row is in one of these statuses. */
  statuses?: NotificationStatus[];
}

export type AttemptInsert = Pick<
  AttemptRow,
  "notification_id" | "patient_id" | "token_id" | "attempt" | "ticket_id" | "outcome" | "error_code" | "error_message"
>;

export type AttemptPatch = Partial<Pick<AttemptRow, "receipt_outcome" | "receipt_error_code" | "receipt_checked_at">>;

export interface ReceiptCandidate {
  notification: NotificationRow;
  /** ticket_ok attempts whose receipt has not been resolved yet. */
  attempts: AttemptRow[];
}

/** Everything the server-side stall evaluation reads for one patient. */
export interface OutreachFacts {
  patientId: string;
  providerId: string;
  firstName: string;
  timezone: string | null;
  startingWeight: number | null;
  /** Diary rows in the evaluation window (kind/ref_id/date_key). */
  entries: Array<{ dateKey: string; kind: string; refId: string | undefined }>;
  /** Patient check-in weigh-ins, oldest first, one per day. */
  weighIns: Array<{ dateKey: string; weight: number }>;
  flags: {
    nudgeOptOut: boolean;
    nudgeEngaged: boolean;
    nudgeLastSentKey: string | null;
    nudgeLastCrossingKey: string | null;
  };
}

/** Everything the missed-dose evaluation reads for one patient. */
export interface MedicationDoseFacts {
  patientId: string;
  providerId: string;
  timezone: string | null;
  medications: MedicationRecord[];
  logs: DoseLogRecord[];
}

export interface OutreachCandidate {
  patientId: string;
  providerId: string;
}

export interface CoachSeedMessage {
  clientId: string;
  text: string;
  quickReplies: string[];
}

/** How much work is waiting in the patient push outbox right now. */
export interface OutboxBacklog {
  /** Queued rows whose next attempt is due (claimable on the next tick). */
  due: number;
  /** next_attempt_at of the oldest due row, or null when nothing is due. */
  oldestDueAt: string | null;
  /** Rows a sender currently holds under a live lease. */
  inFlight: number;
}

export interface NotificationStore {
  // ── Outbox ────────────────────────────────────────────────────────────
  enqueue(input: EnqueueInput): Promise<{ row: NotificationRow; created: boolean }>;
  /**
   * Deduped enqueue that also reserves a slot in an organization-wide daily
   * cap, atomically: implementations must make the cap count and the insert
   * one serialized unit so concurrent workers cannot overshoot the cap.
   */
  enqueueCapped(input: EnqueueInput & { dedupeKey: string }, cap: DailyCap): Promise<CappedEnqueueResult>;
  claimDue(owner: string, limit: number, leaseSeconds: number): Promise<NotificationRow[]>;
  /**
   * Extends the lease on rows `owner` still holds (status sending). Rows
   * another process re-claimed in the meantime are left alone; returns how
   * many leases moved.
   */
  renewLeases(owner: string, ids: string[], leaseSeconds: number): Promise<number>;
  /** Due/in-flight counts and the oldest due row, for the System Health page. */
  outboxBacklog(now: Date): Promise<OutboxBacklog>;
  /** Returns the updated row, or null when the guard no longer matched. */
  updateNotification(id: string, patch: NotificationPatch, guard?: UpdateGuard): Promise<NotificationRow | null>;
  getNotification(id: string): Promise<NotificationRow | null>;
  listPatientNotifications(patientId: string, limit: number): Promise<NotificationRow[]>;
  listAttempts(notificationIds: string[]): Promise<AttemptRow[]>;
  insertAttempts(rows: AttemptInsert[]): Promise<AttemptRow[]>;
  updateAttempt(id: string, patch: AttemptPatch): Promise<void>;
  receiptCandidates(sentBefore: Date, limit: number): Promise<ReceiptCandidate[]>;
  /** Latest coach-outreach row not yet engaged gets engaged_at stamped. */
  markLatestEngaged(patientId: string, kind: string, at: Date): Promise<NotificationRow | null>;

  // ── Tokens ────────────────────────────────────────────────────────────
  activeTokens(patientId: string): Promise<PushTokenRow[]>;
  /**
   * Active (not retired) tokens for many patients in one read; patients with
   * no device are absent from the map. The sender uses this per claimed batch.
   */
  activeTokensFor(patientIds: string[]): Promise<Map<string, PushTokenRow[]>>;
  /**
   * Upserts (patient, token); re-enables a previously disabled row; retires
   * other patients' active rows on the same device (account switch) and the
   * same patient's other tokens on the same device (token rotation).
   */
  registerToken(input: {
    patientId: string;
    token: string;
    deviceId: string;
    platform: "ios" | "android";
  }): Promise<{ token: PushTokenRow; retired: number }>;
  /** Disables the patient's rows for a device (or all of them when no device). */
  unregisterTokens(patientId: string, deviceId: string | null, reason: TokenDisableReason): Promise<number>;
  disableToken(id: string, reason: TokenDisableReason): Promise<void>;

  // ── Policy ────────────────────────────────────────────────────────────
  policyContext(patientId: string): Promise<PolicyContext>;
  /** Policy contexts for many patients in a few reads (one entry per requested id). */
  policyContexts(patientIds: string[]): Promise<Map<string, PolicyContext>>;
  /** Coach outreach rows enqueued at or after `since` (the daily send cap). */
  countOutreachSince(since: Date): Promise<number>;

  // ── Coach outreach ────────────────────────────────────────────────────
  outreachCandidates(evaluatedBefore: Date, limit: number): Promise<OutreachCandidate[]>;
  outreachFacts(patientId: string, fromDateKey: string): Promise<OutreachFacts | null>;
  saveOutreachState(row: Omit<OutreachStateRow, "updated_at">): Promise<void>;
  stampNudgeFlags(
    patientId: string,
    flags: { nudgeLastSentKey: string; nudgeLastCrossingKey: string; nudgeEngaged: boolean },
  ): Promise<void>;
  seedCoachMessage(patientId: string, message: CoachSeedMessage): Promise<void>;

  // ── Medication backup reminders ───────────────────────────────────────
  /**
   * Activated, unarchived patients with at least one medication that is not
   * stopped before `fromDateKey`, each with their dose logs due on or after
   * that date. The evaluation derives the occurrences itself.
   */
  medicationDoseFacts(fromDateKey: string): Promise<MedicationDoseFacts[]>;
}

// ── Supabase-backed implementation ─────────────────────────────────────────

function expectOk(res: { status: number; json: unknown }, what: string): void {
  if (res.status >= 300) throw new Error(`${what} failed (${res.status})`);
}

function rowsOf<T>(res: { status: number; json: unknown }, what: string): T[] {
  expectOk(res, what);
  return Array.isArray(res.json) ? (res.json as T[]) : [];
}

function guardQuery(guard?: UpdateGuard): string {
  let q = "";
  if (guard?.leaseOwner) q += `&lease_owner=eq.${enc(guard.leaseOwner)}`;
  if (guard?.statuses?.length) q += `&status=in.(${guard.statuses.join(",")})`;
  return q;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Total from a `Prefer: count=exact` response (`0-0/1234`), falling back to the rows returned. */
function exactCount(res: { json: unknown; contentRange: string | null }): number {
  const total = res.contentRange?.match(/\/(\d+)$/)?.[1];
  if (total !== undefined) return Number(total);
  return Array.isArray(res.json) ? res.json.length : 0;
}

/**
 * PostgREST `in.(...)` filters ride the URL, so batched reads go out in
 * chunks that keep every request well under proxy URL limits.
 */
const IN_FILTER_CHUNK = 50;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function inList(ids: string[]): string {
  return `in.(${ids.map(enc).join(",")})`;
}

export const supabaseNotificationStore: NotificationStore = {
  async enqueue(input) {
    const body = {
      patient_id: input.patientId,
      kind: input.kind,
      category: input.category,
      title: input.title,
      body: input.body,
      data: input.data ?? {},
      dedupe_key: input.dedupeKey ?? null,
      scheduled_at: (input.scheduledAt ?? new Date()).toISOString(),
      next_attempt_at: (input.scheduledAt ?? new Date()).toISOString(),
      ...(input.expiresAt ? { expires_at: input.expiresAt.toISOString() } : {}),
    };
    if (input.dedupeKey) {
      const inserted = rowsOf<NotificationRow>(
        await supabaseAdmin(
          "POST",
          "/rest/v1/patient_notifications?on_conflict=dedupe_key",
          [body],
          "resolution=ignore-duplicates,return=representation",
        ),
        "notification enqueue",
      );
      if (inserted[0]) return { row: inserted[0], created: true };
      const existing = rowsOf<NotificationRow>(
        await supabaseAdmin("GET", `/rest/v1/patient_notifications?dedupe_key=eq.${enc(input.dedupeKey)}&limit=1`),
        "notification lookup",
      );
      if (!existing[0]) throw new Error("notification enqueue lost its row");
      return { row: existing[0], created: false };
    }
    const inserted = rowsOf<NotificationRow>(
      await supabaseAdmin("POST", "/rest/v1/patient_notifications", [body], "return=representation"),
      "notification enqueue",
    );
    if (!inserted[0]) throw new Error("notification enqueue returned no row");
    return { row: inserted[0], created: true };
  },

  async enqueueCapped(input, cap) {
    // One RPC = one transaction under an advisory lock (see the
    // enqueue_outreach_capped migration): the count and the insert cannot
    // interleave with another worker's.
    const res = await supabaseAdmin("POST", "/rest/v1/rpc/enqueue_outreach_capped", {
      p_patient_id: input.patientId,
      p_kind: input.kind,
      p_category: input.category,
      p_title: input.title,
      p_body: input.body,
      p_data: input.data ?? {},
      p_dedupe_key: input.dedupeKey,
      p_scheduled_at: (input.scheduledAt ?? new Date()).toISOString(),
      p_expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
      p_cap: cap.limit,
      p_since: cap.since.toISOString(),
    });
    expectOk(res, "capped notification enqueue");
    const payload = res.json as { outcome?: string; row?: NotificationRow | null } | null;
    if (payload?.outcome === "capped") return { outcome: "capped", row: null };
    if ((payload?.outcome === "created" || payload?.outcome === "existing") && payload.row) {
      return { outcome: payload.outcome, row: payload.row };
    }
    throw new Error("capped notification enqueue returned an unexpected shape");
  },

  async claimDue(owner, limit, leaseSeconds) {
    return rowsOf<NotificationRow>(
      await supabaseAdmin("POST", "/rest/v1/rpc/claim_patient_notifications", {
        p_owner: owner,
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      }),
      "notification claim",
    );
  },

  async renewLeases(owner, ids, leaseSeconds) {
    if (!ids.length) return 0;
    const now = new Date();
    const lease_until = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    let renewed = 0;
    for (const chunk of chunked(ids, IN_FILTER_CHUNK)) {
      renewed += rowsOf<NotificationRow>(
        await supabaseAdmin(
          "PATCH",
          `/rest/v1/patient_notifications?id=${inList(chunk)}&lease_owner=eq.${enc(owner)}&status=eq.sending`,
          { lease_until, updated_at: now.toISOString() },
          "return=representation",
        ),
        "lease renew",
      ).length;
    }
    return renewed;
  },

  async outboxBacklog(now) {
    const at = enc(now.toISOString());
    const [due, inFlight] = await Promise.all([
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_notifications?status=eq.queued&next_attempt_at=lte.${at}&select=next_attempt_at&order=next_attempt_at.asc&limit=1`,
        undefined,
        "count=exact",
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_notifications?status=eq.sending&lease_until=gt.${at}&select=id&limit=1`,
        undefined,
        "count=exact",
      ),
    ]);
    const oldest = rowsOf<Pick<NotificationRow, "next_attempt_at">>(due, "outbox backlog")[0];
    expectOk(inFlight, "outbox in-flight count");
    return {
      due: exactCount(due),
      oldestDueAt: oldest?.next_attempt_at ?? null,
      inFlight: exactCount(inFlight),
    };
  },

  async updateNotification(id, patch, guard) {
    const rows = rowsOf<NotificationRow>(
      await supabaseAdmin(
        "PATCH",
        `/rest/v1/patient_notifications?id=eq.${enc(id)}${guardQuery(guard)}`,
        { ...patch, updated_at: new Date().toISOString() },
        "return=representation",
      ),
      "notification update",
    );
    return rows[0] ?? null;
  },

  async getNotification(id) {
    const rows = rowsOf<NotificationRow>(
      await supabaseAdmin("GET", `/rest/v1/patient_notifications?id=eq.${enc(id)}&limit=1`),
      "notification read",
    );
    return rows[0] ?? null;
  },

  async listPatientNotifications(patientId, limit) {
    return rowsOf<NotificationRow>(
      await supabaseAdmin(
        "GET",
        `/rest/v1/patient_notifications?patient_id=eq.${enc(patientId)}&order=created_at.desc&limit=${limit}`,
      ),
      "notification list",
    );
  },

  async listAttempts(notificationIds) {
    if (!notificationIds.length) return [];
    return rowsOf<AttemptRow>(
      await supabaseAdmin(
        "GET",
        `/rest/v1/patient_notification_attempts?notification_id=in.(${notificationIds.map(enc).join(",")})&order=created_at.asc`,
      ),
      "attempt list",
    );
  },

  async insertAttempts(rows) {
    if (!rows.length) return [];
    return rowsOf<AttemptRow>(
      await supabaseAdmin("POST", "/rest/v1/patient_notification_attempts", rows, "return=representation"),
      "attempt insert",
    );
  },

  async updateAttempt(id, patch) {
    expectOk(
      await supabaseAdmin("PATCH", `/rest/v1/patient_notification_attempts?id=eq.${enc(id)}`, patch, "return=minimal"),
      "attempt update",
    );
  },

  async receiptCandidates(sentBefore, limit) {
    const notifications = rowsOf<NotificationRow>(
      await supabaseAdmin(
        "GET",
        `/rest/v1/patient_notifications?status=eq.sent&receipts_checked_at=is.null&sent_at=lte.${enc(sentBefore.toISOString())}&order=sent_at.asc&limit=${limit}`,
      ),
      "receipt candidates",
    );
    if (!notifications.length) return [];
    const attempts = rowsOf<AttemptRow>(
      await supabaseAdmin(
        "GET",
        `/rest/v1/patient_notification_attempts?notification_id=in.(${notifications.map((n) => enc(n.id)).join(",")})&outcome=eq.ticket_ok&receipt_checked_at=is.null&order=created_at.asc`,
      ),
      "receipt attempts",
    );
    const byNotification = new Map<string, AttemptRow[]>();
    for (const attempt of attempts) {
      const list = byNotification.get(attempt.notification_id) ?? [];
      list.push(attempt);
      byNotification.set(attempt.notification_id, list);
    }
    return notifications.map((notification) => ({
      notification,
      attempts: byNotification.get(notification.id) ?? [],
    }));
  },

  async markLatestEngaged(patientId, kind, at) {
    const latest = rowsOf<NotificationRow>(
      await supabaseAdmin(
        "GET",
        `/rest/v1/patient_notifications?patient_id=eq.${enc(patientId)}&kind=eq.${enc(kind)}&engaged_at=is.null&order=created_at.desc&limit=1`,
      ),
      "engagement lookup",
    );
    if (!latest[0]) return null;
    return this.updateNotification(latest[0].id, { engaged_at: at.toISOString() });
  },

  async activeTokens(patientId) {
    return rowsOf<PushTokenRow>(
      await supabaseAdmin(
        "GET",
        `/rest/v1/patient_push_tokens?patient_id=eq.${enc(patientId)}&disabled_at=is.null&order=last_registered_at.desc`,
      ),
      "token list",
    );
  },

  async activeTokensFor(patientIds) {
    const out = new Map<string, PushTokenRow[]>();
    const unique = [...new Set(patientIds)];
    for (const chunk of chunked(unique, IN_FILTER_CHUNK)) {
      const rows = rowsOf<PushTokenRow>(
        await supabaseAdmin(
          "GET",
          `/rest/v1/patient_push_tokens?patient_id=${inList(chunk)}&disabled_at=is.null&order=last_registered_at.desc`,
        ),
        "token batch list",
      );
      for (const row of rows) {
        const list = out.get(row.patient_id) ?? [];
        list.push(row);
        out.set(row.patient_id, list);
      }
    }
    return out;
  },

  async registerToken(input) {
    const now = new Date().toISOString();
    // Retire other accounts' rows on this device (account switch) and this
    // account's other tokens on this device (rotation): one active
    // (device, token) per patient.
    const others = rowsOf<PushTokenRow>(
      await supabaseAdmin(
        "PATCH",
        `/rest/v1/patient_push_tokens?device_id=eq.${enc(input.deviceId)}&disabled_at=is.null&patient_id=neq.${enc(input.patientId)}`,
        { disabled_at: now, disabled_reason: "account_switch", updated_at: now },
        "return=representation",
      ),
      "token account-switch retire",
    );
    const rotated = rowsOf<PushTokenRow>(
      await supabaseAdmin(
        "PATCH",
        `/rest/v1/patient_push_tokens?device_id=eq.${enc(input.deviceId)}&disabled_at=is.null&patient_id=eq.${enc(input.patientId)}&token=neq.${enc(input.token)}`,
        { disabled_at: now, disabled_reason: "replaced", updated_at: now },
        "return=representation",
      ),
      "token rotation retire",
    );
    const upserted = rowsOf<PushTokenRow>(
      await supabaseAdmin(
        "POST",
        "/rest/v1/patient_push_tokens?on_conflict=patient_id,token",
        [
          {
            patient_id: input.patientId,
            token: input.token,
            device_id: input.deviceId,
            platform: input.platform,
            disabled_at: null,
            disabled_reason: null,
            last_registered_at: now,
            updated_at: now,
          },
        ],
        "resolution=merge-duplicates,return=representation",
      ),
      "token upsert",
    );
    if (!upserted[0]) throw new Error("token upsert returned no row");
    return { token: upserted[0], retired: others.length + rotated.length };
  },

  async unregisterTokens(patientId, deviceId, reason) {
    const now = new Date().toISOString();
    const rows = rowsOf<PushTokenRow>(
      await supabaseAdmin(
        "PATCH",
        `/rest/v1/patient_push_tokens?patient_id=eq.${enc(patientId)}&disabled_at=is.null${deviceId ? `&device_id=eq.${enc(deviceId)}` : ""}`,
        { disabled_at: now, disabled_reason: reason, updated_at: now },
        "return=representation",
      ),
      "token unregister",
    );
    return rows.length;
  },

  async disableToken(id, reason) {
    const now = new Date().toISOString();
    expectOk(
      await supabaseAdmin(
        "PATCH",
        `/rest/v1/patient_push_tokens?id=eq.${enc(id)}&disabled_at=is.null`,
        { disabled_at: now, disabled_reason: reason, updated_at: now },
        "return=minimal",
      ),
      "token disable",
    );
  },

  async policyContext(patientId) {
    const contexts = await this.policyContexts([patientId]);
    const context = contexts.get(patientId);
    if (!context) throw new Error("policy context lookup returned no entry");
    return context;
  },

  async policyContexts(patientIds) {
    const unique = [...new Set(patientIds)];
    const flagsById = new Map<string, Record<string, unknown>>();
    const patientsById = new Map<string, Record<string, unknown>>();
    for (const chunk of chunked(unique, IN_FILTER_CHUNK)) {
      const [flags, patients] = await Promise.all([
        supabaseAdmin(
          "GET",
          `/rest/v1/patient_flags?patient_id=${inList(chunk)}&select=patient_id,notification_prefs,nudge_opt_out`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/patients?id=${inList(chunk)}&select=id,timezone,provider_id,activation_status,archived_at,deletion_requested_at`,
        ),
      ]);
      for (const flag of rowsOf<Record<string, unknown>>(flags, "policy flags")) flagsById.set(String(flag.patient_id), flag);
      for (const row of rowsOf<Record<string, unknown>>(patients, "policy patient")) patientsById.set(String(row.id), row);
    }
    const providerIds = [
      ...new Set(
        [...patientsById.values()]
          .map((row) => (typeof row.provider_id === "string" && row.provider_id ? row.provider_id : null))
          .filter((id): id is string => id !== null),
      ),
    ];
    const availableOffices = new Set<string>();
    const lockedOffices = new Set<string>();
    for (const chunk of chunked(providerIds, IN_FILTER_CHUNK)) {
      const lockIds = chunk.flatMap((id) => [id, `acct-${id}`]);
      const [providers, locks] = await Promise.all([
        supabaseAdmin("GET", `/rest/v1/providers?provider_id=${inList(chunk)}&select=provider_id,${OFFICE_STATUS_COLUMNS}`),
        supabaseAdmin("GET", `/rest/v1/provider_account_locks?account_id=${inList(lockIds)}&select=account_id`),
      ]);
      for (const providerRow of rowsOf<Record<string, unknown>>(providers, "policy office")) {
        if (officeIsActive(providerRow)) availableOffices.add(String(providerRow.provider_id));
      }
      for (const lock of rowsOf<Record<string, unknown>>(locks, "policy office lock")) {
        lockedOffices.add(String(lock.account_id).replace(/^acct-/, ""));
      }
    }
    const out = new Map<string, PolicyContext>();
    for (const patientId of unique) {
      const flag = flagsById.get(patientId);
      const row = patientsById.get(patientId);
      const providerId = typeof row?.provider_id === "string" && row.provider_id ? row.provider_id : null;
      out.set(patientId, {
        prefs:
          flag?.notification_prefs && typeof flag.notification_prefs === "object"
            ? (flag.notification_prefs as Record<string, unknown>)
            : null,
        timezone: typeof row?.timezone === "string" && row.timezone ? row.timezone : null,
        nudgeOptOut: flag?.nudge_opt_out === true,
        providerId,
        patientAvailable:
          !!row &&
          row.archived_at == null &&
          row.deletion_requested_at == null &&
          row.activation_status !== "disabled",
        officeAvailable: providerId !== null && availableOffices.has(providerId),
        officeLocked: providerId !== null && lockedOffices.has(providerId),
      });
    }
    return out;
  },

  async countOutreachSince(since) {
    const res = await supabaseAdmin(
      "GET",
      `/rest/v1/patient_notifications?kind=eq.coach_outreach&created_at=gte.${enc(since.toISOString())}&select=id&limit=1`,
      undefined,
      "count=exact",
    );
    expectOk(res, "outreach count");
    const total = res.contentRange?.match(/\/(\d+)$/)?.[1];
    return total === undefined ? (Array.isArray(res.json) ? res.json.length : 0) : Number(total);
  },

  async outreachCandidates(evaluatedBefore, limit) {
    // Activated, unarchived patients whose evaluation is missing or stale.
    // Two reads (PostgREST cannot anti-join): the stale/missing set is built
    // client-side from the office's activated ids and the state rows.
    const patients = rowsOf<Record<string, unknown>>(
      await supabaseAdmin(
        "GET",
        `/rest/v1/patients?activation_status=eq.activated&archived_at=is.null&select=id,provider_id&order=created_at.asc&limit=5000`,
      ),
      "outreach patients",
    );
    if (!patients.length) return [];
    const fresh = rowsOf<Record<string, unknown>>(
      await supabaseAdmin(
        "GET",
        `/rest/v1/patient_outreach_state?evaluated_at=gt.${enc(evaluatedBefore.toISOString())}&select=patient_id&limit=5000`,
      ),
      "outreach fresh states",
    );
    const freshIds = new Set(fresh.map((row) => String(row.patient_id)));
    // The App Review office's sample patients are never outreach candidates:
    // reviewers must not receive stall nudges meant for real patients.
    const reviewOffices = await loadAppReviewOfficeIds();
    return patients
      .filter((row) => !freshIds.has(String(row.id)) && !reviewOffices.has(String(row.provider_id)))
      .slice(0, limit)
      .map((row) => ({ patientId: String(row.id), providerId: String(row.provider_id) }));
  },

  async outreachFacts(patientId, fromDateKey) {
    const pid = enc(patientId);
    const [patient, entries, checkIns, flags] = await Promise.all([
      supabaseAdmin(
        "GET",
        `/rest/v1/patients?id=eq.${pid}&select=id,provider_id,first_name,name,timezone,starting_weight,activation_status,archived_at&limit=1`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_diary_entries?patient_id=eq.${pid}&date_key=gte.${enc(fromDateKey)}&select=date_key,kind,ref_id&order=date_key.asc&limit=5000`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_check_ins?patient_id=eq.${pid}&select=date_key,weight&order=date_key.asc&limit=2000`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_flags?patient_id=eq.${pid}&select=nudge_opt_out,nudge_engaged,nudge_last_sent_key,nudge_last_crossing_key&limit=1`,
      ),
    ]);
    const row = rowsOf<Record<string, unknown>>(patient, "outreach patient")[0];
    if (!row || row.archived_at || row.activation_status !== "activated") return null;
    const flag = rowsOf<Record<string, unknown>>(flags, "outreach flags")[0];
    const storedFirst = typeof row.first_name === "string" ? row.first_name.trim() : "";
    const firstName = storedFirst || String(row.name ?? "").trim().split(/\s+/)[0] || "";
    return {
      patientId,
      providerId: String(row.provider_id),
      firstName,
      timezone: typeof row.timezone === "string" && row.timezone ? row.timezone : null,
      startingWeight: numeric(row.starting_weight),
      entries: rowsOf<Record<string, unknown>>(entries, "outreach entries").map((e) => ({
        dateKey: String(e.date_key),
        kind: String(e.kind),
        refId: typeof e.ref_id === "string" && e.ref_id ? e.ref_id : undefined,
      })),
      weighIns: rowsOf<Record<string, unknown>>(checkIns, "outreach check-ins")
        .map((c) => ({ dateKey: String(c.date_key), weight: numeric(c.weight) }))
        .filter((c): c is { dateKey: string; weight: number } => c.weight !== null),
      flags: {
        nudgeOptOut: flag?.nudge_opt_out === true,
        nudgeEngaged: flag?.nudge_engaged === true,
        nudgeLastSentKey: typeof flag?.nudge_last_sent_key === "string" ? flag.nudge_last_sent_key : null,
        nudgeLastCrossingKey:
          typeof flag?.nudge_last_crossing_key === "string" ? flag.nudge_last_crossing_key : null,
      },
    };
  },

  async saveOutreachState(row) {
    expectOk(
      await supabaseAdmin(
        "POST",
        "/rest/v1/patient_outreach_state?on_conflict=patient_id",
        [{ ...row, updated_at: new Date().toISOString() }],
        "resolution=merge-duplicates,return=minimal",
      ),
      "outreach state save",
    );
  },

  async stampNudgeFlags(patientId, flags) {
    expectOk(
      await supabaseAdmin(
        "POST",
        "/rest/v1/patient_flags?on_conflict=patient_id",
        [
          {
            patient_id: patientId,
            nudge_last_sent_key: flags.nudgeLastSentKey,
            nudge_last_crossing_key: flags.nudgeLastCrossingKey,
            nudge_engaged: flags.nudgeEngaged,
            updated_at: new Date().toISOString(),
          },
        ],
        "resolution=merge-duplicates,return=minimal",
      ),
      "nudge flags stamp",
    );
  },

  async medicationDoseFacts(fromDateKey) {
    const medications = rowsOf<Record<string, unknown>>(
      await supabaseAdmin(
        "GET",
        `/rest/v1/patient_medications?select=${MEDICATION_SELECT},patients!inner(provider_id,timezone,activation_status,archived_at)` +
          `&or=(stop_date.is.null,stop_date.gte.${enc(fromDateKey)})` +
          `&patients.activation_status=eq.activated&patients.archived_at=is.null&order=patient_id.asc,created_at.asc&limit=5000`,
      ),
      "medication facts",
    );
    if (!medications.length) return [];
    const logs = rowsOf<Record<string, unknown>>(
      await supabaseAdmin(
        "GET",
        `/rest/v1/patient_medication_dose_logs?due_date=gte.${enc(fromDateKey)}&select=${DOSE_LOG_SELECT}&limit=20000`,
      ),
      "medication dose logs",
    );
    const byPatient = new Map<string, MedicationDoseFacts>();
    for (const row of medications) {
      const patient = row.patients as Record<string, unknown> | null;
      if (!patient) continue;
      const patientId = String(row.patient_id);
      let facts = byPatient.get(patientId);
      if (!facts) {
        facts = {
          patientId,
          providerId: String(patient.provider_id),
          timezone: typeof patient.timezone === "string" && patient.timezone ? patient.timezone : null,
          medications: [],
          logs: [],
        };
        byPatient.set(patientId, facts);
      }
      facts.medications.push(medicationFromRow(row));
    }
    for (const row of logs) {
      const facts = byPatient.get(String(row.patient_id));
      if (facts) facts.logs.push(doseLogFromRow(row));
    }
    return [...byPatient.values()];
  },

  async seedCoachMessage(patientId, message) {
    expectOk(
      await supabaseAdmin("POST", "/rest/v1/rpc/patient_chat_apply", {
        p_patient_id: patientId,
        p_thread: "coach",
        p_messages: [
          {
            client_id: message.clientId,
            role: "assistant",
            text: message.text,
            stopped: false,
            hidden: false,
            card: null,
            quick_replies: message.quickReplies,
            reply_to_client_id: null,
            photo: null,
          },
        ],
      }),
      "coach outreach seed",
    );
  },
};
