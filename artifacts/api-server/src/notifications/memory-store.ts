/**
 * In-memory NotificationStore for tests.
 *
 * Mirrors the database semantics that matter to the state machine: leases
 * (claim skips rows another owner still holds; guarded updates no-op once the
 * lease moved), dedupe keys, status filters, and per-device token retirement.
 * Also a fake Expo push client whose tickets/receipts are scripted per token.
 */
import { randomUUID } from "crypto";
import type { ExpoPushClient, PushMessage, PushReceipt, PushTicket } from "./expo-push";
import { PushTransportError } from "./expo-push";
import type {
  AttemptInsert,
  AttemptPatch,
  CoachSeedMessage,
  NotificationPatch,
  NotificationStore,
  OutreachFacts,
  ReceiptCandidate,
  UpdateGuard,
} from "./store";
import type { AttemptRow, NotificationRow, OutreachStateRow, PolicyContext, PushTokenRow } from "./types";

export interface MemoryPatient {
  patientId: string;
  providerId: string;
  firstName?: string;
  timezone?: string | null;
  startingWeight?: number | null;
  activated?: boolean;
  prefs?: Record<string, unknown> | null;
  flags?: Partial<OutreachFacts["flags"]>;
  entries?: OutreachFacts["entries"];
  weighIns?: OutreachFacts["weighIns"];
}

export class MemoryNotificationStore implements NotificationStore {
  now: () => Date;
  notifications = new Map<string, NotificationRow>();
  attempts = new Map<string, AttemptRow>();
  tokens = new Map<string, PushTokenRow>();
  patients = new Map<string, MemoryPatient>();
  outreachStates = new Map<string, OutreachStateRow>();
  seededMessages: Array<{ patientId: string; message: CoachSeedMessage }> = [];
  private seq = 0;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Empty every table (test isolation between cases sharing one router). */
  reset(): void {
    this.notifications.clear();
    this.attempts.clear();
    this.tokens.clear();
    this.patients.clear();
    this.outreachStates.clear();
    this.seededMessages = [];
  }

  private iso(): string {
    return this.now().toISOString();
  }

  addPatient(patient: MemoryPatient): void {
    this.patients.set(patient.patientId, { activated: true, ...patient });
  }

  addToken(patientId: string, token: string, deviceId = `device-${token}`, platform: "ios" | "android" = "ios"): PushTokenRow {
    const row: PushTokenRow = {
      id: randomUUID(),
      patient_id: patientId,
      token,
      device_id: deviceId,
      platform,
      disabled_at: null,
      disabled_reason: null,
      last_registered_at: this.iso(),
      created_at: this.iso(),
      updated_at: this.iso(),
    };
    this.tokens.set(row.id, row);
    return row;
  }

  async enqueue(input: Parameters<NotificationStore["enqueue"]>[0]) {
    if (input.dedupeKey) {
      for (const row of this.notifications.values()) {
        if (row.dedupe_key === input.dedupeKey) return { row, created: false };
      }
    }
    const scheduled = (input.scheduledAt ?? this.now()).toISOString();
    const row: NotificationRow = {
      id: randomUUID(),
      patient_id: input.patientId,
      kind: input.kind,
      category: input.category,
      title: input.title,
      body: input.body,
      data: input.data ?? {},
      dedupe_key: input.dedupeKey ?? null,
      scheduled_at: scheduled,
      expires_at: (input.expiresAt ?? new Date(this.now().getTime() + 3 * 24 * 3600_000)).toISOString(),
      status: "queued",
      attempts: 0,
      next_attempt_at: scheduled,
      lease_owner: null,
      lease_until: null,
      suppression_reason: null,
      last_error: null,
      sent_at: null,
      delivered_at: null,
      opened_at: null,
      engaged_at: null,
      finalized_at: null,
      receipts_checked_at: null,
      created_at: new Date(this.now().getTime() + this.seq++).toISOString(),
      updated_at: this.iso(),
    };
    this.notifications.set(row.id, row);
    return { row, created: true };
  }

  async claimDue(owner: string, limit: number, leaseSeconds: number) {
    const now = this.now().getTime();
    const due = [...this.notifications.values()]
      .filter((row) => {
        if (new Date(row.next_attempt_at).getTime() > now) return false;
        if (row.status === "queued") return true;
        if (row.status === "sending") {
          return row.lease_until === null || new Date(row.lease_until).getTime() < now;
        }
        return false;
      })
      .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at) || a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
    return due.map((row) => {
      const next: NotificationRow = {
        ...row,
        status: "sending",
        lease_owner: owner,
        lease_until: new Date(now + leaseSeconds * 1000).toISOString(),
        updated_at: this.iso(),
      };
      this.notifications.set(row.id, next);
      return next;
    });
  }

  async updateNotification(id: string, patch: NotificationPatch, guard?: UpdateGuard) {
    const row = this.notifications.get(id);
    if (!row) return null;
    if (guard?.leaseOwner && row.lease_owner !== guard.leaseOwner) return null;
    if (guard?.statuses && !guard.statuses.includes(row.status)) return null;
    const next = { ...row, ...patch, updated_at: this.iso() };
    this.notifications.set(id, next);
    return next;
  }

  async getNotification(id: string) {
    return this.notifications.get(id) ?? null;
  }

  async listPatientNotifications(patientId: string, limit: number) {
    return [...this.notifications.values()]
      .filter((row) => row.patient_id === patientId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  async listAttempts(notificationIds: string[]) {
    const ids = new Set(notificationIds);
    return [...this.attempts.values()]
      .filter((row) => ids.has(row.notification_id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async insertAttempts(rows: AttemptInsert[]) {
    return rows.map((input) => {
      const row: AttemptRow = {
        id: randomUUID(),
        ...input,
        receipt_outcome: null,
        receipt_error_code: null,
        receipt_checked_at: null,
        created_at: new Date(this.now().getTime() + this.seq++).toISOString(),
      };
      this.attempts.set(row.id, row);
      return row;
    });
  }

  async updateAttempt(id: string, patch: AttemptPatch) {
    const row = this.attempts.get(id);
    if (row) this.attempts.set(id, { ...row, ...patch });
  }

  async receiptCandidates(sentBefore: Date, limit: number): Promise<ReceiptCandidate[]> {
    const cutoff = sentBefore.getTime();
    return [...this.notifications.values()]
      .filter(
        (row) =>
          row.status === "sent" &&
          row.receipts_checked_at === null &&
          row.sent_at !== null &&
          new Date(row.sent_at).getTime() <= cutoff,
      )
      .sort((a, b) => (a.sent_at ?? "").localeCompare(b.sent_at ?? ""))
      .slice(0, limit)
      .map((notification) => ({
        notification,
        attempts: [...this.attempts.values()].filter(
          (a) => a.notification_id === notification.id && a.outcome === "ticket_ok" && a.receipt_checked_at === null,
        ),
      }));
  }

  async markLatestEngaged(patientId: string, kind: string, at: Date) {
    const latest = [...this.notifications.values()]
      .filter((row) => row.patient_id === patientId && row.kind === kind && row.engaged_at === null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!latest) return null;
    return this.updateNotification(latest.id, { engaged_at: at.toISOString() });
  }

  async activeTokens(patientId: string) {
    return [...this.tokens.values()].filter((row) => row.patient_id === patientId && row.disabled_at === null);
  }

  async registerToken(input: { patientId: string; token: string; deviceId: string; platform: "ios" | "android" }) {
    let retired = 0;
    const now = this.iso();
    for (const row of this.tokens.values()) {
      if (row.device_id !== input.deviceId || row.disabled_at !== null) continue;
      if (row.patient_id !== input.patientId) {
        this.tokens.set(row.id, { ...row, disabled_at: now, disabled_reason: "account_switch", updated_at: now });
        retired += 1;
      } else if (row.token !== input.token) {
        this.tokens.set(row.id, { ...row, disabled_at: now, disabled_reason: "replaced", updated_at: now });
        retired += 1;
      }
    }
    const existing = [...this.tokens.values()].find(
      (row) => row.patient_id === input.patientId && row.token === input.token,
    );
    if (existing) {
      const next: PushTokenRow = {
        ...existing,
        device_id: input.deviceId,
        platform: input.platform,
        disabled_at: null,
        disabled_reason: null,
        last_registered_at: now,
        updated_at: now,
      };
      this.tokens.set(existing.id, next);
      return { token: next, retired };
    }
    const token = this.addToken(input.patientId, input.token, input.deviceId, input.platform);
    return { token, retired };
  }

  async unregisterTokens(patientId: string, deviceId: string | null, reason: PushTokenRow["disabled_reason"] & string) {
    let count = 0;
    const now = this.iso();
    for (const row of this.tokens.values()) {
      if (row.patient_id !== patientId || row.disabled_at !== null) continue;
      if (deviceId && row.device_id !== deviceId) continue;
      this.tokens.set(row.id, { ...row, disabled_at: now, disabled_reason: reason, updated_at: now });
      count += 1;
    }
    return count;
  }

  async disableToken(id: string, reason: PushTokenRow["disabled_reason"] & string) {
    const row = this.tokens.get(id);
    if (row && row.disabled_at === null) {
      this.tokens.set(id, { ...row, disabled_at: this.iso(), disabled_reason: reason, updated_at: this.iso() });
    }
  }

  async policyContext(patientId: string): Promise<PolicyContext> {
    const patient = this.patients.get(patientId);
    return {
      prefs: patient?.prefs ?? null,
      timezone: patient?.timezone ?? null,
      nudgeOptOut: patient?.flags?.nudgeOptOut === true,
    };
  }

  async outreachCandidates(evaluatedBefore: Date, limit: number) {
    const cutoff = evaluatedBefore.getTime();
    return [...this.patients.values()]
      .filter((patient) => {
        if (patient.activated === false) return false;
        const state = this.outreachStates.get(patient.patientId);
        return !state || new Date(state.evaluated_at).getTime() <= cutoff;
      })
      .slice(0, limit)
      .map((patient) => ({ patientId: patient.patientId, providerId: patient.providerId }));
  }

  async outreachFacts(patientId: string, fromDateKey: string): Promise<OutreachFacts | null> {
    const patient = this.patients.get(patientId);
    if (!patient || patient.activated === false) return null;
    return {
      patientId,
      providerId: patient.providerId,
      firstName: patient.firstName ?? "",
      timezone: patient.timezone ?? null,
      startingWeight: patient.startingWeight ?? null,
      entries: (patient.entries ?? []).filter((entry) => entry.dateKey >= fromDateKey),
      weighIns: patient.weighIns ?? [],
      flags: {
        nudgeOptOut: patient.flags?.nudgeOptOut === true,
        nudgeEngaged: patient.flags?.nudgeEngaged === true,
        nudgeLastSentKey: patient.flags?.nudgeLastSentKey ?? null,
        nudgeLastCrossingKey: patient.flags?.nudgeLastCrossingKey ?? null,
      },
    };
  }

  async saveOutreachState(row: Omit<OutreachStateRow, "updated_at">) {
    this.outreachStates.set(row.patient_id, { ...row, updated_at: this.iso() });
  }

  async stampNudgeFlags(
    patientId: string,
    flags: { nudgeLastSentKey: string; nudgeLastCrossingKey: string; nudgeEngaged: boolean },
  ) {
    const patient = this.patients.get(patientId);
    if (!patient) throw new Error(`unknown patient ${patientId}`);
    patient.flags = { ...patient.flags, ...flags };
  }

  async seedCoachMessage(patientId: string, message: CoachSeedMessage) {
    this.seededMessages.push({ patientId, message });
  }
}

// ── Fake Expo push service ─────────────────────────────────────────────────

export type ScriptedTicket =
  | { kind: "ok" }
  | { kind: "error"; error: string; message?: string }
  | { kind: "transport"; status?: number | null };

export class FakePushClient implements ExpoPushClient {
  sent: PushMessage[][] = [];
  receiptQueries: string[][] = [];
  /** Per token: what the next send returns (default: ok ticket). */
  ticketScript = new Map<string, ScriptedTicket[]>();
  /** Per ticket id: the receipt to hand back (absent = not resolved yet). */
  receipts = new Map<string, PushReceipt>();
  /** Throw a transport error on the next N send calls. */
  failNextSends = 0;
  failNextReceipts = 0;
  private ticketSeq = 0;
  /** ticket id -> token it was issued for. */
  ticketTokens = new Map<string, string>();

  script(token: string, ...tickets: ScriptedTicket[]): void {
    this.ticketScript.set(token, [...(this.ticketScript.get(token) ?? []), ...tickets]);
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    if (this.failNextSends > 0) {
      this.failNextSends -= 1;
      throw new PushTransportError("scripted push outage", 503);
    }
    this.sent.push(messages);
    return messages.map((message) => {
      const queue = this.ticketScript.get(message.to);
      const scripted = queue?.shift() ?? { kind: "ok" as const };
      if (scripted.kind === "transport") throw new PushTransportError("scripted push outage", scripted.status ?? 503);
      if (scripted.kind === "error") {
        return {
          status: "error",
          message: scripted.message ?? scripted.error,
          details: { error: scripted.error, expoPushToken: message.to },
        };
      }
      const id = `ticket-${++this.ticketSeq}`;
      this.ticketTokens.set(id, message.to);
      return { status: "ok", id };
    });
  }

  async getReceipts(ticketIds: string[]): Promise<Record<string, PushReceipt>> {
    if (this.failNextReceipts > 0) {
      this.failNextReceipts -= 1;
      throw new PushTransportError("scripted receipt outage", 503);
    }
    this.receiptQueries.push(ticketIds);
    const out: Record<string, PushReceipt> = {};
    for (const id of ticketIds) {
      const receipt = this.receipts.get(id);
      if (receipt) out[id] = receipt;
    }
    return out;
  }
}
