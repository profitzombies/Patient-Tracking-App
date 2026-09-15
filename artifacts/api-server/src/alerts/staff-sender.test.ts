import { beforeEach, describe, expect, it, vi } from "vitest";

const policyState = vi.hoisted(() => ({
  quietHours: null as null | { mode: "custom"; start: string; end: string },
  timeZone: "UTC",
}));
vi.mock("../lib/org-policy", async (original) => {
  const actual = await original<typeof import("../lib/org-policy")>();
  return {
    ...actual,
    loadOrgPolicy: vi.fn(async () => ({ ...actual.DEFAULT_ORG_POLICY, defaultTimezone: policyState.timeZone })),
    loadOfficeOverrides: vi.fn(async (providerId: string) => ({
      ...actual.NO_OVERRIDES(providerId),
      quietHours: policyState.quietHours ?? { mode: "inherit" },
      alertTimeZone: policyState.timeZone,
    })),
  };
});

import { FakePushClient } from "../notifications/memory-store";
import { MemoryStaffNotificationStore } from "./memory-store";
import type { StaffNotificationRow } from "./store";
import { runStaffNotificationTick } from "./staff-sender";

const NOW = new Date("2026-10-11T12:00:00.000Z");
function row(channel: "push" | "email" = "push"): StaffNotificationRow {
  return {
    id: crypto.randomUUID(), provider_id: "office-1", auth_user_id: "11111111-1111-4111-8111-111111111111",
    channel, email: channel === "email" ? "owner@example.com" : null, status: "queued", attempts: 0,
    expires_at: "2026-10-12T12:00:00.000Z", data: {
      providerId: "office-1", digestDate: "2026-10-10", flaggedCount: 2, officeName: "Riverside Wellness", recipientName: "Sarah",
      patients: [{ name: "Emma Smith", reasons: [{ label: "No meals logged", days: 3 }, { label: "Weight stalled", days: 5 }] }],
    },
    title: "Patients need attention", body: "2 patients need attention today.", suppression_reason: null, lease_owner: null,
  };
}
function setup(notification = row()) {
  const store = new MemoryStaffNotificationStore(); store.notifications.push(notification);
  const push = new FakePushClient();
  return { store, push, tick: () => runStaffNotificationTick({ store, push, owner: "worker", now: () => NOW, maxAttempts: 2, baseBackoffMs: 1 }) };
}
beforeEach(() => {
  policyState.quietHours = null; policyState.timeZone = "UTC";
  process.env.RESEND_API_KEY = "resend"; process.env.CLAIM_EMAIL_FROM = "mail@example.com";
  process.env.BILLING_PUBLIC_ORIGIN = "https://portal.example";
  vi.restoreAllMocks();
});

describe("staff notification sender", () => {
  it("sends email through Resend with recipient, subject, and portal link", async () => {
    const harness = setup(row("email"));
    const fetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    await harness.tick();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.resend.com/emails");
    const payload = JSON.parse(String(init?.body)) as { to: string[]; subject: string; html: string; text: string };
    expect(payload).toMatchObject({ to: ["owner@example.com"], subject: "2 patients need attention at Riverside Wellness" });
    expect(payload.html).toContain("<!doctype html>");
    expect(payload.html).toContain("Hello Sarah");
    expect(payload.html).toContain("Emma Smith");
    expect(payload.html).toContain("No meals logged (3 days)");
    expect(payload.html).toContain("Saturday, October 10, 2026");
    expect(payload.html).toContain("https://portal.example/alerts");
    expect(payload.html).toContain("https://portal.example/settings");
    expect(payload.text).toContain("Emma Smith — No meals logged (3 days), Weight stalled (5 days)");
    expect(payload.text).not.toContain("<");
    expect(harness.store.notifications[0]?.status).toBe("sent");
  });
  it("sends push and persists an accepted ticket", async () => {
    const harness = setup(); await harness.store.registerToken({ authUserId: row().auth_user_id, providerId: "office-1", token: "ExponentPushToken[staff]", deviceId: "device-123", platform: "ios" });
    await harness.tick();
    expect(harness.store.notifications[0]?.status).toBe("sent");
    expect(harness.push.sent[0]?.[0]?.data).toMatchObject({ route: "/(tabs)/patients", kind: "staff_attention_digest" });
    expect(harness.store.attempts[0]).toMatchObject({ outcome: "ticket_ok" });
  });
  it("disables a dead token", async () => {
    const harness = setup(); const registered = await harness.store.registerToken({ authUserId: harness.store.notifications[0]!.auth_user_id, providerId: "office-1", token: "ExponentPushToken[dead]", deviceId: "device-123", platform: "ios" });
    harness.push.script(registered.token.token, { kind: "error", error: "DeviceNotRegistered" });
    await harness.tick();
    expect(registered.token.disabled_at).not.toBeNull(); expect(harness.store.notifications[0]?.status).toBe("failed");
  });
  it("retries transport failure then fails at max attempts", async () => {
    const harness = setup(); await harness.store.registerToken({ authUserId: harness.store.notifications[0]!.auth_user_id, providerId: "office-1", token: "ExponentPushToken[retry]", deviceId: "device-123", platform: "ios" });
    harness.push.failNextSends = 2; await harness.tick();
    expect(harness.store.notifications[0]).toMatchObject({ status: "queued", attempts: 1 });
    await harness.tick(); expect(harness.store.notifications[0]).toMatchObject({ status: "failed", attempts: 2 });
  });
  it("honors channel opt-out", async () => {
    const harness = setup(); harness.store.preferences.set(`office-1:${harness.store.notifications[0]!.auth_user_id}`, { emailEnabled: true, pushEnabled: false });
    await harness.tick(); expect(harness.store.notifications[0]).toMatchObject({ status: "opted_out", suppression_reason: "channel_off" });
  });
  it("defers in quiet hours, or suppresses when the end is past expiry", async () => {
    policyState.quietHours = { mode: "custom", start: "11:00", end: "13:00" };
    const deferred = setup(); await deferred.tick();
    expect(deferred.store.notifications[0]).toMatchObject({ status: "queued", suppression_reason: "quiet_hours_deferred" });
    const expiring = row(); expiring.expires_at = "2026-10-11T12:30:00.000Z";
    const suppressed = setup(expiring); await suppressed.tick();
    expect(suppressed.store.notifications[0]).toMatchObject({ status: "suppressed", suppression_reason: "quiet_hours" });
  });
  it("suppresses no-device, locked office, and expired rows", async () => {
    const noDevice = setup(); await noDevice.tick(); expect(noDevice.store.notifications[0]?.suppression_reason).toBe("no_device");
    const locked = setup(); locked.store.office.set("office-1", { available: true, locked: true }); await locked.tick(); expect(locked.store.notifications[0]?.suppression_reason).toBe("office_locked");
    const expiredRow = row(); expiredRow.expires_at = "2026-10-11T11:00:00.000Z"; const expired = setup(expiredRow); await expired.tick(); expect(expired.store.notifications[0]?.status).toBe("expired");
  });
  it("drops a final update after the lease is lost", async () => {
    const harness = setup(row("email")); vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    harness.store.update = vi.fn(async () => false);
    const result = await harness.tick(); expect(result.leaseLost).toBe(1); expect(harness.store.notifications[0]?.status).toBe("sending");
  });
});