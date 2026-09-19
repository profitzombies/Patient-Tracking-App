/**
 * Record-access audit — "who opened which chart, when".
 *
 * Staff and HQ reads of a patient's record (the record page, progress
 * photos, bloodwork, medications, conversation transcripts) each write a
 * `*_viewed` / `*_opened` audit event through here. Repeated reads by the
 * same actor of the same target inside {@link RECORD_ACCESS_WINDOW_SEC}
 * collapse into one event: the decision is made by a single SQL upsert
 * keyed on actor + dedupe key, so it holds across API instances; the
 * process-local cache below only skips round trips for windows this
 * process already knows are open.
 *
 * Writes are best-effort and never block the read: a failed audit write is
 * logged and the caller's response is unaffected. Only staff actors are
 * recorded — a patient reading their own data is not record access.
 */
import type { Request } from "express";
import { supabaseAdmin } from "./supabase-admin";
import type { AuditActorKind, AuditMetadata } from "./admin-audit";

export const RECORD_ACCESS_WINDOW_SEC = 15 * 60;

/** Audit actions that describe reading, not changing, a patient record. */
export const RECORD_ACCESS_ACTIONS = [
  "patient_record_viewed",
  "patient_photos_viewed",
  "patient_bloodwork_viewed",
  "bloodwork_report_opened",
  "patient_medications_viewed",
  "conversation_transcript_opened",
] as const;
export type RecordAccessAction = (typeof RECORD_ACCESS_ACTIONS)[number];
export const recordAccessActions: ReadonlySet<string> = new Set(RECORD_ACCESS_ACTIONS);

export type RecordAccessTargetKind = "patient" | "patient_chat_conversation";
export type RecordAccessActorKind = Extract<AuditActorKind, "provider" | "team_member" | "hq">;

export interface RecordAccessInput {
  action: RecordAccessAction;
  actorUserId: string;
  actorKind: RecordAccessActorKind;
  providerId: string;
  targetKind: RecordAccessTargetKind;
  targetId: string;
  requestId: string | null;
  /**
   * Extra dedupe discriminator when several targets live under one audit
   * target (a bloodwork report under its patient). Also carried in metadata
   * by the caller so the row says which one was opened.
   */
  facet?: string | null;
  /** Small operational facts only (ids, enums) — never content. */
  metadata?: AuditMetadata;
}

/** Local memo of windows known to be open: `${actor}\u0000${key}` → window end (ms). */
const openWindows = new Map<string, number>();
const LOCAL_CACHE_MAX = 5000;

export function recordAccessDedupeKey(input: Pick<RecordAccessInput, "action" | "targetKind" | "targetId" | "facet">): string {
  const base = `${input.action}:${input.targetKind}:${input.targetId}`;
  return input.facet ? `${base}:${input.facet}` : base;
}

function localKey(actorUserId: string, dedupeKey: string): string {
  return `${actorUserId}\u0000${dedupeKey}`;
}

function rememberWindow(key: string, windowStartedAt: string | null, now: number): void {
  const started = windowStartedAt ? Date.parse(windowStartedAt) : Number.NaN;
  const endsAt = (Number.isFinite(started) ? started : now) + RECORD_ACCESS_WINDOW_SEC * 1000;
  if (openWindows.size >= LOCAL_CACHE_MAX) {
    for (const [candidate, until] of openWindows) {
      if (until <= now) openWindows.delete(candidate);
    }
    if (openWindows.size >= LOCAL_CACHE_MAX) openWindows.delete(openWindows.keys().next().value as string);
  }
  openWindows.set(key, endsAt);
}

/** Tests only: forget every locally memoised window. */
export function resetRecordAccessCache(): void {
  openWindows.clear();
}

/**
 * Record one read. Resolves `true` when a new audit event landed, `false`
 * when the read collapsed into an open window. Throws on audit-store
 * failure — callers use {@link auditRecordAccess} to log-and-continue.
 */
export async function recordRecordAccess(input: RecordAccessInput, now: number = Date.now()): Promise<boolean> {
  const dedupeKey = recordAccessDedupeKey(input);
  const key = localKey(input.actorUserId, dedupeKey);
  const knownUntil = openWindows.get(key);
  if (knownUntil !== undefined && knownUntil > now) return false;
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/record_admin_audit_read_event", {
    p_action: input.action,
    p_actor_user_id: input.actorUserId,
    p_actor_kind: input.actorKind,
    p_provider_id: input.providerId,
    p_target_kind: input.targetKind,
    p_target_id: input.targetId,
    p_request_id: input.requestId,
    p_metadata: input.metadata ?? {},
    p_dedupe_key: dedupeKey,
    p_window_seconds: RECORD_ACCESS_WINDOW_SEC,
  });
  if (result.status >= 300) throw new Error(`record access audit write failed (${result.status})`);
  const row = Array.isArray(result.json) ? (result.json[0] as { recorded?: unknown; window_started_at?: unknown } | undefined) : undefined;
  if (!row || typeof row.recorded !== "boolean") throw new Error("record access audit write returned no decision");
  rememberWindow(key, typeof row.window_started_at === "string" ? row.window_started_at : null, now);
  return row.recorded;
}

/**
 * Fire-and-forget wrapper for route handlers: the read has already been
 * authorised and is being answered; an audit outage must not turn it into
 * an error. Request id is read from the request's logger stamp.
 */
export function auditRecordAccess(
  req: Pick<Request, "headers" | "log">,
  input: Omit<RecordAccessInput, "requestId">,
): void {
  const header = req.headers["x-request-id"];
  const requestId = Array.isArray(header) ? header[0] ?? null : typeof header === "string" && header ? header : null;
  void recordRecordAccess({ ...input, requestId }).catch((error) => {
    req.log?.warn({ err: error, action: input.action, targetKind: input.targetKind }, "record access audit write failed");
  });
}
