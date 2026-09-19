/**
 * HQ email alerts raised by the warehouse pipeline (rejected submissions,
 * back orders, warehouse-side cancellations). Rows ride the staff alert
 * outbox with kind system_threshold and no office, exactly like the System
 * health threshold job, so delivery shares the leased sender and the
 * deliveries table. The dedupe key makes every alert fire once per subject
 * and recipient.
 */
import { supabaseAdmin } from "../lib/supabase-admin";

export interface WarehouseAlert {
  /** Alert subject id (an order id, or the poll family) — part of the dedupe key. */
  key: string;
  metric: "warehouse_submission" | "warehouse_back_order" | "warehouse_canceled";
  level: "amber" | "red";
  title: string;
  body: string;
  /** Free-form context copied into the notification row. */
  data?: Record<string, unknown>;
  /** Human label (order number) shown as the finding family. */
  family: string | null;
}

export async function raiseWarehouseHqAlert(alert: WarehouseAlert, now: Date): Promise<number> {
  const recipients = await supabaseAdmin("GET", "/rest/v1/hq_memberships?select=auth_user_id,email,display_name&status=eq.active&department_role=in.(super_admin,admin)&email=not.is.null");
  if (recipients.status >= 300) throw new Error(`hq recipients read failed (${recipients.status})`);
  const rows = (Array.isArray(recipients.json) ? recipients.json as Array<{ auth_user_id: string; email: string | null; display_name: string | null }> : [])
    .filter((row) => row.email).map((row) => ({
      provider_id: null, auth_user_id: row.auth_user_id, channel: "email", email: row.email, kind: "system_threshold", category: "staff_alerts",
      title: alert.title,
      body: alert.body,
      data: { metric: alert.metric, level: alert.level, family: alert.family, value: null, limit: null, message: alert.body, recipientName: row.display_name?.trim() || null, ...(alert.data ?? {}) },
      dedupe_key: `${alert.metric}:${alert.key}:${row.auth_user_id}:email`,
      scheduled_at: now.toISOString(), next_attempt_at: now.toISOString(), expires_at: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    }));
  if (!rows.length) return 0;
  const queued = await supabaseAdmin("POST", "/rest/v1/staff_notifications?on_conflict=dedupe_key", rows, "resolution=ignore-duplicates,return=minimal");
  if (queued.status >= 300) throw new Error(`warehouse alert enqueue failed (${queued.status})`);
  return rows.length;
}
