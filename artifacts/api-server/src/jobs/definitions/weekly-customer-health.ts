/**
 * weekly-customer-health: every Monday once it is 09:00 in the organization's
 * default time zone (Eastern for THINNR), score every active office through
 * the Customer health module, record one snapshot row per office for the ISO
 * week, and queue one summary email per HQ member who subscribed themselves on
 * the Customer health page.
 *
 * The job polls every 15 minutes and is a no-op on every other day and before
 * 09:00. Once per week is enforced twice over: a run row keyed by ISO week
 * short-circuits later ticks, and the email rows carry a per-user-per-week
 * dedupe key so a restart between the snapshot write and the run-row insert
 * still cannot queue a second email. The emails ride the staff alert outbox
 * (kind weekly_customer_health, no office) so delivery shares the leased
 * sender and shows up in HQ's delivery view; the sender re-checks the
 * subscription at send time, so turning the toggle off after enqueue is
 * honoured.
 *
 * The row snapshot and the email contain office names, scores and counts
 * only — nothing about any patient.
 */
import { supabaseAdmin } from "../../lib/supabase-admin";
import { loadOrgPolicy } from "../../lib/org-policy";
import { BAND_LABELS, BUCKET_LABELS, type CustomerHealthSummary, type HealthBucket, type OfficeHealth } from "../../customer-health/scoring";
import {
  nextWeeklyRunInstant,
  previousIsoWeek,
  scoreChangeFrom,
  scoreChangeLabel,
  weekMondayLabel,
  weeklyRunMoment,
} from "../../customer-health/weekly";
import { assembleCustomerHealth, loadOfficeHealthRows, type OfficeHealthRow } from "../../routes/hq-customer-health";
import type { JobContext, JobDefinition } from "../types";

const MINUTE_MS = 60_000;
const enc = encodeURIComponent;

/** The staff_notifications kind and the preference kind this run uses. */
export const WEEKLY_CUSTOMER_HEALTH_KIND = "weekly_customer_health";
export const WEEKLY_CUSTOMER_HEALTH_PREFERENCE_KIND = "weekly_customer_health_email";

export interface WeeklyHealthRecipient {
  auth_user_id: string;
  email: string | null;
  display_name: string | null;
}

/** Everything the run reads and writes, so tests can drive it without Supabase. */
export interface WeeklyHealthStore {
  timeZone(): Promise<string>;
  runExists(isoWeek: string): Promise<boolean>;
  loadRows(asOf: Date): Promise<OfficeHealthRow[]>;
  /** provider_id → score for the snapshots of one ISO week. */
  priorScores(isoWeek: string): Promise<Map<string, number>>;
  /** Active HQ members whose preference row is on, with an email on file. */
  subscribers(): Promise<WeeklyHealthRecipient[]>;
  writeSnapshots(rows: Record<string, unknown>[]): Promise<number>;
  /** Inserts ignoring dedupe-key duplicates; returns how many were new. */
  enqueue(rows: Record<string, unknown>[]): Promise<number>;
  recordRun(row: Record<string, unknown>): Promise<void>;
}

function ok(result: { status: number }, label: string) {
  if (result.status >= 300) throw new Error(`${label} failed (${result.status})`);
}

export async function loadWeeklyHealthSubscribers(): Promise<WeeklyHealthRecipient[]> {
  const prefs = await supabaseAdmin("GET", `/rest/v1/hq_member_notification_preferences?kind=eq.${WEEKLY_CUSTOMER_HEALTH_PREFERENCE_KIND}&enabled=eq.true&select=auth_user_id&limit=1000`);
  ok(prefs, "weekly health subscriber read");
  const ids = (Array.isArray(prefs.json) ? prefs.json as Record<string, unknown>[] : []).map((row) => String(row.auth_user_id));
  if (!ids.length) return [];
  const members = await supabaseAdmin("GET", `/rest/v1/hq_memberships?select=auth_user_id,email,display_name&status=eq.active&email=not.is.null&auth_user_id=in.(${ids.map(enc).join(",")})`);
  ok(members, "weekly health member read");
  return Array.isArray(members.json) ? members.json as WeeklyHealthRecipient[] : [];
}

export const supabaseWeeklyHealthStore: WeeklyHealthStore = {
  async timeZone() { return (await loadOrgPolicy({ fresh: true })).defaultTimezone; },
  async runExists(isoWeek) {
    const result = await supabaseAdmin("GET", `/rest/v1/customer_health_weekly_runs?iso_week=eq.${enc(isoWeek)}&select=iso_week&limit=1`);
    ok(result, "weekly health run read");
    return Array.isArray(result.json) && result.json.length > 0;
  },
  loadRows: loadOfficeHealthRows,
  async priorScores(isoWeek) {
    const result = await supabaseAdmin("GET", `/rest/v1/office_customer_health_weekly_snapshots?iso_week=eq.${enc(isoWeek)}&select=provider_id,score&limit=5000`);
    ok(result, "weekly health prior snapshot read");
    return new Map((Array.isArray(result.json) ? result.json as Record<string, unknown>[] : []).map((row) => [String(row.provider_id), Number(row.score)]));
  },
  subscribers: loadWeeklyHealthSubscribers,
  async writeSnapshots(rows) {
    if (!rows.length) return 0;
    const result = await supabaseAdmin("POST", "/rest/v1/office_customer_health_weekly_snapshots?on_conflict=iso_week,provider_id", rows, "resolution=merge-duplicates,return=representation");
    ok(result, "weekly health snapshot write");
    return Array.isArray(result.json) ? result.json.length : 0;
  },
  async enqueue(rows) {
    if (!rows.length) return 0;
    const result = await supabaseAdmin("POST", "/rest/v1/staff_notifications?on_conflict=dedupe_key", rows, "resolution=ignore-duplicates,return=representation");
    ok(result, "weekly health enqueue");
    return Array.isArray(result.json) ? result.json.length : 0;
  },
  async recordRun(row) {
    const result = await supabaseAdmin("POST", "/rest/v1/customer_health_weekly_runs?on_conflict=iso_week", [row], "resolution=ignore-duplicates,return=minimal");
    ok(result, "weekly health run record");
  },
};

export function weeklyHealthDedupeKey(isoWeek: string, authUserId: string): string {
  return `${WEEKLY_CUSTOMER_HEALTH_KIND}:${isoWeek}:${authUserId}:email`;
}

/** One office to watch as the email row stores it: name, numbers and the page's own reasons. */
export interface WeeklyAttentionItem {
  providerId: string;
  officeName: string;
  score: number;
  band: string;
  change: number | null;
  reasons: string[];
}

export interface WeeklyHealthEmailData {
  isoWeek: string;
  weekLabel: string;
  officeCount: number;
  bucketCounts: Array<{ label: string; count: number }>;
  attentionCount: number;
  attention: WeeklyAttentionItem[];
  recipientName: string | null;
}

export function snapshotRow(office: OfficeHealth, isoWeek: string, asOfDate: string, capturedAt: string): Record<string, unknown> {
  return {
    iso_week: isoWeek,
    provider_id: office.providerId,
    as_of_date: asOfDate,
    office_name: office.officeName,
    rank: office.rank,
    score: office.score,
    band: office.band,
    bucket: office.bucket,
    is_new: office.isNew,
    last_paid_order_at: office.lastOrderAt,
    active_subscribers: office.activeSubscribers,
    cancelling_subscriptions: office.cancellingSubscriptions,
    app_users: office.appUsers,
    active_app_users_30d: office.activeAppUsers30d,
    active_app_users_prior_30d: office.activeAppUsersPrior30d,
    staff_enrolled: office.staffEnrolled,
    flags: office.flags,
    captured_at: capturedAt,
  };
}

export function weeklyEmailData(summary: CustomerHealthSummary, isoWeek: string, prior: Map<string, number>): Omit<WeeklyHealthEmailData, "recipientName"> {
  return {
    isoWeek,
    weekLabel: weekMondayLabel(isoWeek),
    officeCount: summary.offices.length,
    bucketCounts: (Object.keys(BUCKET_LABELS) as HealthBucket[]).map((bucket) => ({ label: BUCKET_LABELS[bucket], count: summary.bucketCounts[bucket] })),
    attentionCount: summary.attention.length,
    attention: summary.attention.map((office) => ({
      providerId: office.providerId,
      officeName: office.officeName,
      score: office.score,
      band: BAND_LABELS[office.band],
      change: scoreChangeFrom(prior, office).scoreChange,
      reasons: office.flags.map((flag) => flag.reason),
    })),
  };
}

export function weeklyEmailBody(data: Pick<WeeklyHealthEmailData, "officeCount" | "attentionCount" | "attention">): string {
  const lead = data.attentionCount === 0 ? "No offices need attention this week" : data.attentionCount === 1 ? "1 office needs attention this week" : `${data.attentionCount} offices need attention this week`;
  const names = data.attention.slice(0, 5).map((item) => `${item.officeName} (${item.score}, ${scoreChangeLabel(item.change)})`).join("; ");
  return `${lead}; ${data.officeCount} active ${data.officeCount === 1 ? "office" : "offices"} scored.${names ? ` ${names}.` : ""}`.slice(0, 2000);
}

export function buildWeeklyNotifications(input: {
  data: Omit<WeeklyHealthEmailData, "recipientName">; recipients: WeeklyHealthRecipient[]; now: Date; expiresAt: Date;
}): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const recipient of input.recipients) {
    if (!recipient.email) continue;
    rows.push({
      provider_id: null,
      auth_user_id: recipient.auth_user_id,
      channel: "email",
      email: recipient.email,
      kind: WEEKLY_CUSTOMER_HEALTH_KIND,
      category: "staff_alerts",
      title: `Customer health · ${input.data.weekLabel}`,
      body: weeklyEmailBody(input.data),
      data: { ...input.data, recipientName: recipient.display_name?.trim() || null } satisfies WeeklyHealthEmailData,
      dedupe_key: weeklyHealthDedupeKey(input.data.isoWeek, recipient.auth_user_id),
      scheduled_at: input.now.toISOString(),
      next_attempt_at: input.now.toISOString(),
      expires_at: input.expiresAt.toISOString(),
    });
  }
  return rows;
}

export async function runWeeklyCustomerHealth(ctx: JobContext, store: WeeklyHealthStore = supabaseWeeklyHealthStore): Promise<void> {
  const timeZone = await store.timeZone();
  const moment = weeklyRunMoment(ctx.now, timeZone);
  ctx.log("weekly_customer_health_moment", { timeZone, localDate: moment.localDate, isoWeek: moment.isoWeek, weekday: moment.weekday, minutes: moment.minutes, due: moment.due });
  if (!moment.due) { ctx.tally("notDue"); return; }
  if (await store.runExists(moment.isoWeek)) { ctx.tally("alreadyRan"); return; }
  const rows = await store.loadRows(ctx.now);
  const summary = assembleCustomerHealth(rows, ctx.now);
  const prior = await store.priorScores(previousIsoWeek(moment.isoWeek));
  const recipients = await store.subscribers();
  ctx.tally("officesScored", summary.offices.length);
  ctx.tally("attention", summary.attention.length);
  ctx.tally("subscribers", recipients.length);
  ctx.tally("priorWeekSnapshots", prior.size);
  const capturedAt = ctx.now.toISOString();
  const snapshots = summary.offices.map((office) => snapshotRow(office, moment.isoWeek, moment.localDate, capturedAt));
  const data = weeklyEmailData(summary, moment.isoWeek, prior);
  const notifications = buildWeeklyNotifications({ data, recipients, now: ctx.now, expiresAt: nextWeeklyRunInstant(ctx.now, timeZone) });
  if (ctx.dryRun) {
    ctx.tally("snapshotsWouldWrite", snapshots.length);
    ctx.tally("emailsWouldQueue", notifications.length);
    return;
  }
  ctx.tally("snapshotsWritten", await store.writeSnapshots(snapshots));
  ctx.checkpoint();
  ctx.tally("emailsQueued", await store.enqueue(notifications));
  await store.recordRun({
    iso_week: moment.isoWeek, generated_at: capturedAt, time_zone: timeZone,
    office_count: summary.offices.length, attention_count: summary.attention.length, recipients_queued: notifications.length,
  });
  ctx.tally("runsRecorded");
}

export const weeklyCustomerHealthJob: JobDefinition = {
  name: "weekly-customer-health",
  title: "Weekly Customer health summary",
  description: "Every Monday at 9:00 am in the organization's time zone: snapshots each office's Customer health score for the week and queues the summary email to HQ members who subscribed.",
  intervalMs: 15 * MINUTE_MS,
  leaseSeconds: 5 * 60,
  run: (ctx) => runWeeklyCustomerHealth(ctx),
};
