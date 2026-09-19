import { supabaseAdmin } from "../lib/supabase-admin";
import { OFFICE_STATUS_COLUMNS, officeIsActive } from "../lib/office-status";

const enc = encodeURIComponent;
export type StaffTokenDisableReason = "signed_out" | "account_switch" | "replaced" | "device_not_registered";
export interface StaffPushToken {
  id: string; auth_user_id: string; provider_id: string; token: string; device_id: string;
  platform: "ios" | "android"; disabled_at: string | null;
}
export interface StaffNotificationRow {
  id: string;
  /** Null only for kind system_threshold (HQ-addressed; no office checks apply). */
  provider_id: string | null;
  kind?: "staff_attention_digest" | "system_threshold" | string;
  auth_user_id: string; channel: "push" | "email"; email: string | null;
  status: string; attempts: number; expires_at: string; data: Record<string, unknown>;
  title: string; body: string; suppression_reason: string | null; lease_owner: string | null;
}
export interface StaffNotificationStore {
  registerToken(input: { authUserId: string; providerId: string; token: string; deviceId: string; platform: "ios" | "android" }): Promise<{ token: StaffPushToken; retired: number }>;
  unregisterTokens(authUserId: string, deviceId: string | null, reason: StaffTokenDisableReason): Promise<number>;
  claimDue(owner: string, limit: number, leaseSeconds: number): Promise<StaffNotificationRow[]>;
  activeTokens(authUserId: string): Promise<StaffPushToken[]>;
  preference(providerId: string, authUserId: string): Promise<{ emailEnabled: boolean; pushEnabled: boolean }>;
  officeState(providerId: string): Promise<{ available: boolean; locked: boolean }>;
  update(id: string, patch: Record<string, unknown>, leaseOwner: string): Promise<boolean>;
  insertAttempts(rows: Record<string, unknown>[]): Promise<void>;
  disableToken(id: string, reason: StaffTokenDisableReason): Promise<void>;
}
function rows(result: { status: number; json: unknown }, label: string): StaffPushToken[] {
  if (result.status >= 300) throw new Error(`${label} failed (${result.status})`);
  return Array.isArray(result.json) ? result.json as StaffPushToken[] : [];
}
export const supabaseStaffNotificationStore: StaffNotificationStore = {
  async registerToken(input) {
    const now = new Date().toISOString();
    const retired = rows(await supabaseAdmin("PATCH", `/rest/v1/staff_push_tokens?device_id=eq.${enc(input.deviceId)}&disabled_at=is.null&auth_user_id=neq.${enc(input.authUserId)}`, { disabled_at: now, disabled_reason: "account_switch", updated_at: now }, "return=representation"), "staff token retirement");
    const rotated = rows(await supabaseAdmin("PATCH", `/rest/v1/staff_push_tokens?device_id=eq.${enc(input.deviceId)}&disabled_at=is.null&auth_user_id=eq.${enc(input.authUserId)}&token=neq.${enc(input.token)}`, { disabled_at: now, disabled_reason: "replaced", updated_at: now }, "return=representation"), "staff token rotation");
    const upserted = rows(await supabaseAdmin("POST", "/rest/v1/staff_push_tokens?on_conflict=auth_user_id,token", [{
      auth_user_id: input.authUserId, provider_id: input.providerId, token: input.token,
      device_id: input.deviceId, platform: input.platform, disabled_at: null,
      disabled_reason: null, last_registered_at: now, updated_at: now,
    }], "resolution=merge-duplicates,return=representation"), "staff token registration");
    if (!upserted[0]) throw new Error("staff token registration returned no row");
    return { token: upserted[0], retired: retired.length + rotated.length };
  },
  async unregisterTokens(authUserId, deviceId, reason) {
    const now = new Date().toISOString();
    return rows(await supabaseAdmin("PATCH", `/rest/v1/staff_push_tokens?auth_user_id=eq.${enc(authUserId)}&disabled_at=is.null${deviceId ? `&device_id=eq.${enc(deviceId)}` : ""}`, { disabled_at: now, disabled_reason: reason, updated_at: now }, "return=representation"), "staff token unregister").length;
  },
  async claimDue(owner, limit, leaseSeconds) {
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/claim_staff_notifications", { p_owner: owner, p_limit: limit, p_lease_seconds: leaseSeconds });
    if (result.status >= 300) throw new Error(`staff notification claim failed (${result.status})`);
    return Array.isArray(result.json) ? result.json as StaffNotificationRow[] : [];
  },
  async activeTokens(authUserId) {
    return rows(await supabaseAdmin("GET", `/rest/v1/staff_push_tokens?auth_user_id=eq.${enc(authUserId)}&disabled_at=is.null&order=last_registered_at.desc`), "staff token list");
  },
  async preference(providerId, authUserId) {
    const result = await supabaseAdmin("GET", `/rest/v1/staff_alert_preferences?provider_id=eq.${enc(providerId)}&auth_user_id=eq.${enc(authUserId)}&select=email_enabled,push_enabled&limit=1`);
    if (result.status >= 300) throw new Error(`staff preference failed (${result.status})`);
    const row = Array.isArray(result.json) ? result.json[0] as Record<string, unknown> : null;
    return { emailEnabled: row?.email_enabled !== false, pushEnabled: row?.push_enabled !== false };
  },
  async officeState(providerId) {
    const [provider, lock] = await Promise.all([
      supabaseAdmin("GET", `/rest/v1/providers?provider_id=eq.${enc(providerId)}&select=${OFFICE_STATUS_COLUMNS}&limit=1`),
      supabaseAdmin("GET", `/rest/v1/provider_account_locks?or=(account_id.eq.${enc(providerId)},account_id.eq.${enc(`acct-${providerId}`)})&select=account_id&limit=1`),
    ]);
    if (provider.status >= 300 || lock.status >= 300) throw new Error("staff office state failed");
    const row = Array.isArray(provider.json) ? provider.json[0] as Record<string, unknown> : null;
    return { available: officeIsActive(row), locked: Array.isArray(lock.json) && lock.json.length > 0 };
  },
  async update(id, patch, leaseOwner) {
    const result = await supabaseAdmin("PATCH", `/rest/v1/staff_notifications?id=eq.${enc(id)}&lease_owner=eq.${enc(leaseOwner)}`, { ...patch, updated_at: new Date().toISOString() }, "return=representation");
    if (result.status >= 300) throw new Error(`staff notification update failed (${result.status})`);
    return Array.isArray(result.json) && result.json.length > 0;
  },
  async insertAttempts(attempts) {
    if (!attempts.length) return;
    const result = await supabaseAdmin("POST", "/rest/v1/staff_notification_attempts", attempts, "return=minimal");
    if (result.status >= 300) throw new Error(`staff attempt insert failed (${result.status})`);
  },
  async disableToken(id, reason) {
    const result = await supabaseAdmin("PATCH", `/rest/v1/staff_push_tokens?id=eq.${enc(id)}`, { disabled_at: new Date().toISOString(), disabled_reason: reason }, "return=minimal");
    if (result.status >= 300) throw new Error(`staff token disable failed (${result.status})`);
  },
};