import type { StaffNotificationRow, StaffNotificationStore, StaffPushToken, StaffTokenDisableReason } from "./store";

export class MemoryStaffNotificationStore implements StaffNotificationStore {
  tokens: StaffPushToken[] = [];
  notifications: StaffNotificationRow[] = [];
  preferences = new Map<string, { emailEnabled: boolean; pushEnabled: boolean }>();
  office = new Map<string, { available: boolean; locked: boolean }>();
  attempts: Record<string, unknown>[] = [];
  async registerToken(input: { authUserId: string; providerId: string; token: string; deviceId: string; platform: "ios" | "android" }) {
    let retired = 0;
    for (const row of this.tokens) {
      if (!row.disabled_at && row.device_id === input.deviceId && (row.auth_user_id !== input.authUserId || row.token !== input.token)) {
        row.disabled_at = new Date().toISOString(); retired += 1;
      }
    }
    let token = this.tokens.find((row) => row.auth_user_id === input.authUserId && row.token === input.token);
    if (!token) {
      token = { id: `staff-token-${this.tokens.length + 1}`, auth_user_id: input.authUserId, provider_id: input.providerId, token: input.token, device_id: input.deviceId, platform: input.platform, disabled_at: null };
      this.tokens.push(token);
    } else Object.assign(token, { provider_id: input.providerId, device_id: input.deviceId, platform: input.platform, disabled_at: null });
    return { token, retired };
  }
  async unregisterTokens(authUserId: string, deviceId: string | null, _reason: StaffTokenDisableReason) {
    let retired = 0;
    for (const row of this.tokens) if (!row.disabled_at && row.auth_user_id === authUserId && (!deviceId || row.device_id === deviceId)) {
      row.disabled_at = new Date().toISOString(); retired += 1;
    }
    return retired;
  }
  async claimDue(owner: string, limit: number, _leaseSeconds: number) {
    return this.notifications.filter((row) => row.status === "queued").slice(0, limit).map((row) => (Object.assign(row, { status: "sending", lease_owner: owner }), row));
  }
  async activeTokens(authUserId: string) { return this.tokens.filter((row) => row.auth_user_id === authUserId && !row.disabled_at); }
  async preference(providerId: string, authUserId: string) { return this.preferences.get(`${providerId}:${authUserId}`) ?? { emailEnabled: true, pushEnabled: true }; }
  async officeState(providerId: string) { return this.office.get(providerId) ?? { available: true, locked: false }; }
  async update(id: string, patch: Record<string, unknown>, leaseOwner: string) {
    const row = this.notifications.find((item) => item.id === id && item.lease_owner === leaseOwner);
    if (!row) return false; Object.assign(row, patch); return true;
  }
  async insertAttempts(rows: Record<string, unknown>[]) { this.attempts.push(...rows); }
  async disableToken(id: string, _reason: StaffTokenDisableReason) { const token = this.tokens.find((row) => row.id === id); if (token) token.disabled_at = new Date().toISOString(); }
}