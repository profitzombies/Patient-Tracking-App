/**
 * system-thresholds: every 15 minutes, evaluate the System health thresholds
 * (p95 latency per route family over the last hour, database growth per
 * day, object-storage growth per day) and queue an email to each active HQ
 * administrator for every amber or red finding.
 *
 * The rows ride the staff alert outbox (kind system_threshold, no office) so
 * delivery shares the leased sender, retries, and the deliveries table on
 * System health. One email per metric, per family, per level, per UTC day
 * and recipient: a slow route that stays slow all day sends once at amber
 * and once more only if it turns red. Dry runs evaluate and log but queue
 * nothing.
 */
import { supabaseAdmin } from "../../lib/supabase-admin";
import { readPerformance, type PerformanceReaders } from "../../system/performance";
import type { ThresholdFinding } from "../../system/thresholds";
import type { JobContext, JobDefinition } from "../types";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface HqAlertRecipient {
  auth_user_id: string;
  email: string | null;
  display_name: string | null;
}

export interface SystemThresholdDeps {
  readers?: PerformanceReaders;
  recipients?: () => Promise<HqAlertRecipient[]>;
}

async function defaultRecipients(): Promise<HqAlertRecipient[]> {
  const result = await supabaseAdmin(
    "GET",
    "/rest/v1/hq_memberships?select=auth_user_id,email,display_name&status=eq.active&department_role=in.(super_admin,admin)&email=not.is.null",
  );
  if (result.status >= 300) throw new Error(`hq recipients read failed (${result.status})`);
  return Array.isArray(result.json) ? (result.json as HqAlertRecipient[]) : [];
}

export function thresholdDedupeKey(finding: ThresholdFinding, day: string, authUserId: string): string {
  return `system_threshold:${finding.metric}:${finding.family ?? "-"}:${finding.level}:${day}:${authUserId}:email`;
}

export function thresholdTitle(finding: ThresholdFinding): string {
  const label = finding.metric === "p95_latency" ? `Slow route ${finding.family}` : finding.metric === "db_growth" ? "Database growing fast" : "Storage growing fast";
  return `${finding.level === "red" ? "Red" : "Amber"}: ${label}`;
}

export function buildThresholdNotifications(input: { findings: ThresholdFinding[]; recipients: HqAlertRecipient[]; now: Date }): Record<string, unknown>[] {
  const day = input.now.toISOString().slice(0, 10);
  const expires = new Date(input.now.getTime() + DAY_MS).toISOString();
  const rows: Record<string, unknown>[] = [];
  for (const finding of input.findings) {
    for (const recipient of input.recipients) {
      if (!recipient.email) continue;
      rows.push({
        provider_id: null,
        auth_user_id: recipient.auth_user_id,
        channel: "email",
        email: recipient.email,
        kind: "system_threshold",
        category: "staff_alerts",
        title: thresholdTitle(finding),
        body: finding.message,
        data: {
          metric: finding.metric,
          level: finding.level,
          family: finding.family,
          value: finding.value,
          limit: finding.limit,
          message: finding.message,
          day,
          recipientName: recipient.display_name?.trim() || null,
        },
        dedupe_key: thresholdDedupeKey(finding, day, recipient.auth_user_id),
        scheduled_at: input.now.toISOString(),
        next_attempt_at: input.now.toISOString(),
        expires_at: expires,
      });
    }
  }
  return rows;
}

export async function runSystemThresholds(ctx: JobContext, deps: SystemThresholdDeps = {}): Promise<void> {
  const sections: string[] = [];
  const performance = await readPerformance(ctx.now, {
    ...deps.readers,
    onError: (section, error) => {
      sections.push(section);
      deps.readers?.onError?.(section, error);
      ctx.failItem(section, error);
    },
  });
  const findings = performance.thresholds.findings;
  ctx.log("system_thresholds", {
    level: performance.thresholds.level,
    findings: findings.map((finding) => ({ metric: finding.metric, family: finding.family, level: finding.level, value: finding.value, limit: finding.limit })),
    unavailable: sections,
  });
  ctx.tally("findings", findings.length);
  ctx.tally("redFindings", findings.filter((finding) => finding.level === "red").length);
  if (!findings.length) return;
  const recipients = await (deps.recipients ?? defaultRecipients)();
  const rows = buildThresholdNotifications({ findings, recipients, now: ctx.now });
  if (ctx.dryRun) {
    ctx.tally("alertsWouldQueue", rows.length);
    return;
  }
  if (!rows.length) return;
  const queued = await supabaseAdmin("POST", "/rest/v1/staff_notifications?on_conflict=dedupe_key", rows, "resolution=ignore-duplicates,return=representation");
  if (queued.status >= 300) throw new Error(`system threshold enqueue failed (${queued.status})`);
  ctx.tally("alertsQueued", Array.isArray(queued.json) ? queued.json.length : 0);
}

export const systemThresholdsJob: JobDefinition = {
  name: "system-thresholds",
  title: "System health thresholds",
  description: "Checks p95 latency per route family, database growth, and storage growth against the System health limits and emails HQ administrators once per metric, level, and day when one is crossed.",
  intervalMs: 15 * MINUTE_MS,
  leaseSeconds: 5 * 60,
  run: runSystemThresholds,
};
