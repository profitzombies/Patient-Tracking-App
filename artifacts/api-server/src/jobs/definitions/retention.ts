/**
 * Retention enforcement driven by organization policy. Each job reads the
 * policy fresh (an unreadable policy fails the run — never a silent default
 * that could trim too eagerly), derives its cutoff from the run's `now`, and
 * calls a batched SQL function that honours dry runs itself.
 *
 *   retention-chat            patient chat messages (+ emptied conversations
 *                             and unreferenced chat photos)
 *   retention-notifications   terminal notification rows
 *   retention-audit           audit events → compact monthly summaries, then
 *                             deleted (the only delete path the append-only
 *                             trigger admits)
 *   retention-exports         expired export archives (office + patient)
 *   retention-session-revocations
 *                             session revocation rows past their token
 *                             horizon (reads already ignore them)
 *
 * Progress photos are deliberately NOT trimmed here: the photo retention
 * period is policy-defined but the patient-visible deletion flow that would
 * honour it is out of this job's scope.
 */
import { sweepExpiredRevocations } from "../../auth/session-revocations";
import { sweepExpiredExports } from "../../exports/worker";
import { sweepExpiredPatientExports } from "../../privacy/exports";
import { loadOrgPolicy } from "../../lib/org-policy";
import { deletePhotoWithVariants } from "../../lib/photo-variants";
import { supabaseAdmin } from "../../lib/supabase-admin";
import type { JobContext, JobDefinition } from "../types";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const BATCH = 500;
const MAX_BATCHES = 20;
const enc = encodeURIComponent;

/** Days must be a sane positive integer or the job refuses to trim. */
function retentionDays(value: unknown, label: string): number {
  const days = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(days) || !Number.isInteger(days) || days < 1) {
    throw new Error(`${label} retention period is not a positive whole number of days`);
  }
  return days;
}

export function cutoffFor(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

async function policy() {
  return loadOrgPolicy({ fresh: true });
}

function rpcRow<T>(result: { status: number; json: unknown }, label: string): T {
  if (result.status >= 300) throw new Error(`${label} failed (${result.status})`);
  const row = Array.isArray(result.json) ? result.json[0] : result.json;
  if (row === null || row === undefined) throw new Error(`${label} returned nothing`);
  return row as T;
}

export async function trimChatTranscripts(ctx: JobContext): Promise<void> {
  const days = retentionDays((await policy()).retention.chatTranscriptDays, "chat transcript");
  const cutoff = cutoffFor(ctx.now, days);
  ctx.log("retention_cutoff", { days, cutoff });
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    ctx.checkpoint();
    const row = rpcRow<{ messages_deleted: number; conversations_deleted: number; media_paths: string[] | null }>(
      await supabaseAdmin("POST", "/rest/v1/rpc/retention_trim_chat_transcripts", { p_cutoff: cutoff, p_limit: BATCH, p_dry_run: ctx.dryRun }),
      "chat transcript trim",
    );
    ctx.tally(ctx.dryRun ? "messagesDue" : "messagesDeleted", row.messages_deleted);
    ctx.tally(ctx.dryRun ? "conversationsDue" : "conversationsDeleted", row.conversations_deleted);
    for (const path of row.media_paths ?? []) {
      ctx.checkpoint();
      if (ctx.dryRun) {
        ctx.tally("mediaObjectsDue");
        continue;
      }
      try {
        await deletePhotoWithVariants(path);
        ctx.tally("mediaObjectsDeleted");
      } catch (error) {
        ctx.failItem(path, error);
      }
    }
    if (ctx.dryRun || row.messages_deleted < BATCH) break;
  }
}

export async function trimNotificationHistory(ctx: JobContext): Promise<void> {
  const days = retentionDays((await policy()).retention.notificationHistoryDays, "notification history");
  const cutoff = cutoffFor(ctx.now, days);
  ctx.log("retention_cutoff", { days, cutoff });
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    ctx.checkpoint();
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/retention_trim_notifications", { p_cutoff: cutoff, p_limit: BATCH, p_dry_run: ctx.dryRun });
    if (result.status >= 300) throw new Error(`notification trim failed (${result.status})`);
    const n = typeof result.json === "number" ? result.json : Number(result.json) || 0;
    ctx.tally(ctx.dryRun ? "notificationsDue" : "notificationsDeleted", n);
    if (ctx.dryRun || n < BATCH) break;
  }
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    ctx.checkpoint();
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/retention_trim_staff_alerts", { p_cutoff: cutoff, p_limit: BATCH, p_dry_run: ctx.dryRun });
    if (result.status >= 300) throw new Error(`staff alert trim failed (${result.status})`);
    const n = typeof result.json === "number" ? result.json : Number(result.json) || 0;
    ctx.tally(ctx.dryRun ? "staffAlertRowsDue" : "staffAlertRowsDeleted", n);
    if (ctx.dryRun || n < BATCH) break;
  }
}

export async function archiveAuditEvents(ctx: JobContext): Promise<void> {
  const days = retentionDays((await policy()).retention.auditEventDays, "audit event");
  const cutoff = cutoffFor(ctx.now, days);
  ctx.log("retention_cutoff", { days, cutoff });
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    ctx.checkpoint();
    const row = rpcRow<{ events_archived: number; summaries_touched: number }>(
      await supabaseAdmin("POST", "/rest/v1/rpc/retention_archive_audit_events", { p_cutoff: cutoff, p_limit: BATCH, p_dry_run: ctx.dryRun }),
      "audit event archive",
    );
    ctx.tally(ctx.dryRun ? "eventsDue" : "eventsArchived", row.events_archived);
    ctx.tally("summariesTouched", row.summaries_touched);
    if (ctx.dryRun || row.events_archived < BATCH) break;
  }
}

async function countDue(table: string, nowIso: string): Promise<number> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/${table}?select=id&status=in.(queued,running,ready,failed)&expires_at=lt.${enc(nowIso)}&limit=1000`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`${table} expiry scan failed (${result.status})`);
  return result.json.length;
}

export async function sweepExportArchives(ctx: JobContext): Promise<void> {
  if (ctx.dryRun) {
    const nowIso = ctx.now.toISOString();
    ctx.tally("officeExportsDue", await countDue("data_exports", nowIso));
    ctx.tally("patientExportsDue", await countDue("patient_data_exports", nowIso));
    return;
  }
  const office = await sweepExpiredExports(ctx.now);
  ctx.tally("officeExpired", office.expired);
  ctx.tally("officePruned", office.pruned);
  ctx.checkpoint();
  const patient = await sweepExpiredPatientExports(ctx.now);
  ctx.tally("patientExpired", patient.expired);
  ctx.tally("patientPruned", patient.pruned);
}

/** Processed webhook bodies are useful briefly for diagnosis, but can contain payer PII. */
export async function pruneBillingWebhookPayloads(ctx: JobContext): Promise<void> {
  const raw = process.env.BILLING_WEBHOOK_PAYLOAD_RETENTION_DAYS;
  const days = raw === undefined || raw.trim() === "" ? 90 : retentionDays(raw, "billing webhook payload");
  const cutoff = cutoffFor(ctx.now, days);
  const filter = `processed_at=not.is.null&processed_at=lt.${enc(cutoff)}&payload=not.is.null`;
  const due = await supabaseAdmin("GET", `/rest/v1/billing_webhook_events?${filter}&select=stripe_event_id&limit=1000`);
  if (due.status >= 300 || !Array.isArray(due.json)) throw new Error(`billing webhook retention scan failed (${due.status})`);
  ctx.tally(ctx.dryRun ? "payloadsDue" : "payloadsPruned", due.json.length);
  if (ctx.dryRun || due.json.length === 0) return;
  const result = await supabaseAdmin(
    "PATCH",
    `/rest/v1/billing_webhook_events?${filter}`,
    { payload: null, payload_pruned_at: ctx.now.toISOString() },
  );
  if (result.status >= 300) throw new Error(`billing webhook payload prune failed (${result.status})`);
}

export async function sweepSessionRevocations(ctx: JobContext): Promise<void> {
  const cutoff = ctx.now.toISOString();
  const due = await supabaseAdmin(
    "GET",
    `/rest/v1/auth_session_revocations?expires_at=lt.${enc(cutoff)}&select=session_id&limit=1000`,
  );
  if (due.status >= 300 || !Array.isArray(due.json)) throw new Error(`session revocation retention scan failed (${due.status})`);
  if (ctx.dryRun) {
    ctx.tally("rowsDue", due.json.length);
    return;
  }
  if (due.json.length === 0) return;
  await sweepExpiredRevocations(ctx.now);
  ctx.tally("rowsDeleted", due.json.length);
}
export const retentionChatJob: JobDefinition = {
  name: "retention-chat",
  title: "Chat transcript retention",
  description: "Removes patient coach-chat messages older than the organization's chat transcript retention period, along with emptied conversations and their unreferenced photos.",
  intervalMs: 24 * HOUR_MS,
  leaseSeconds: 30 * 60,
  run: trimChatTranscripts,
};

export const retentionNotificationsJob: JobDefinition = {
  name: "retention-notifications",
  title: "Notification history retention",
  description: "Removes delivered, failed, and suppressed notification records older than the notification history retention period.",
  intervalMs: 24 * HOUR_MS,
  leaseSeconds: 30 * 60,
  run: trimNotificationHistory,
};

export const retentionAuditJob: JobDefinition = {
  name: "retention-audit",
  title: "Audit event archiving",
  description: "Rolls audit events older than the audit retention period into compact monthly summaries, then deletes the detailed rows.",
  intervalMs: 24 * HOUR_MS,
  leaseSeconds: 30 * 60,
  run: archiveAuditEvents,
};

export const retentionExportsJob: JobDefinition = {
  name: "retention-exports",
  title: "Expired export archives",
  description: "Deletes office and patient export archives past their link expiry and prunes long-expired export records.",
  intervalMs: 15 * 60_000,
  leaseSeconds: 15 * 60,
  run: sweepExportArchives,
};

export const retentionBillingWebhooksJob: JobDefinition = {
  name: "retention-billing-webhooks",
  title: "Billing webhook payload retention",
  description: "Prunes old processed Stripe webhook payloads while retaining event processing records.",
  intervalMs: 24 * HOUR_MS,
  leaseSeconds: 15 * 60,
  run: pruneBillingWebhookPayloads,
};

export const retentionSessionRevocationsJob: JobDefinition = {
  name: "retention-session-revocations",
  title: "Session revocation list clean-up",
  description: "Deletes revoked-session rows whose access tokens can no longer be valid; requests already ignore expired rows.",
  intervalMs: 6 * HOUR_MS,
  leaseSeconds: 5 * 60,
  run: sweepSessionRevocations,
};
