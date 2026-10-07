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
import { guardPushMessage } from "../notifications/push-guard";
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
      reasonCounts: [{ label: "No meals logged", count: 2 }, { label: "Weight stalled", count: 1 }],
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
  it("emails HQ system threshold alerts without office, preference, or quiet-hours checks", async () => {
    policyState.quietHours = { mode: "custom", start: "00:00", end: "23:59" }; // would defer an office row
    const system: StaffNotificationRow = {
      ...row("email"), provider_id: null, kind: "system_threshold", email: "hq@example.com",
      title: "Amber: Slow route office/roster", body: "office/roster: p95 1840 ms over the last hour (63 requests) is above the 1500 ms amber limit.",
      data: { metric: "p95_latency", level: "amber", family: "office/roster", value: 1840, limit: 1500, day: "2026-10-11", recipientName: "Jordan",
        message: "office/roster: p95 1840 ms over the last hour (63 requests) is above the 1500 ms amber limit." },
    };
    const harness = setup(system);
    const officeState = vi.spyOn(harness.store, "officeState");
    const preference = vi.spyOn(harness.store, "preference");
    const fetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "email-2" }), { status: 200 }));
    const summary = await harness.tick();
    expect(summary).toMatchObject({ sent: 1, deferred: 0, suppressed: 0 });
    expect(officeState).not.toHaveBeenCalled();
    expect(preference).not.toHaveBeenCalled();
    const payload = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as { to: string[]; subject: string; html: string; text: string };
    expect(payload).toMatchObject({ to: ["hq@example.com"], subject: "Amber: Slow route office/roster" });
    expect(payload.html).toContain("Hello Jordan");
    expect(payload.html).toContain("1500 ms amber limit");
    expect(payload.html).toContain("https://portal.example/admin/system-health");
    expect(payload.text).toContain("Observed: p95 1,840 ms");
    expect(payload.text).toContain("Limit: p95 1,500 ms");
    expect(payload.text).toContain("Sunday, October 11, 2026");
    expect(harness.store.notifications[0]?.status).toBe("sent");
  });

  it("suppresses a system threshold row on any channel but email", async () => {
    const harness = setup({ ...row("push"), provider_id: null, kind: "system_threshold" });
    const summary = await harness.tick();
    expect(summary).toMatchObject({ suppressed: 1, sent: 0 });
    expect(harness.store.notifications[0]).toMatchObject({ status: "suppressed", suppression_reason: "channel_unsupported" });
    expect(harness.push.sent).toHaveLength(0);
  });

  it("sends the digest email through the shared seam with counts per reason, a portal link, and no names", async () => {
    const harness = setup(row("email"));
    const fetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    await harness.tick();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.resend.com/emails");
    const payload = JSON.parse(String(init?.body)) as { from: string; to: string[]; subject: string; html: string; text: string };
    expect(payload).toMatchObject({ from: "THINNR Weight Loss <mail@example.com>", to: ["owner@example.com"], subject: "2 patients need attention at Riverside Wellness" });
    expect(payload.html).toContain("<!doctype html>");
    expect(payload.html).toContain("Hello Sarah");
    expect(payload.html).toContain("No meals logged");
    expect(payload.html).toContain("2 patients");
    expect(payload.html).toContain("Saturday, October 10, 2026");
    expect(payload.html).toContain("https://portal.example/alerts");
    expect(payload.html).toContain("https://portal.example/settings");
    expect(payload.text).toContain("No meals logged — 2 patients");
    expect(payload.text).toContain("Weight stalled — 1 patient");
    expect(payload.text).not.toContain("<");
    expect(harness.store.notifications[0]?.status).toBe("sent");
  });
  it("ignores patient names left on older rows: the email never lists a patient", async () => {
    const legacy = row("email");
    legacy.data = { ...legacy.data, patients: [{ name: "Emma Smith", reasons: [{ label: "No meals logged", days: 3 }] }] };
    const harness = setup(legacy);
    const fetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    await harness.tick();
    const payload = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as { html: string; text: string; subject: string };
    expect(`${payload.subject}${payload.html}${payload.text}`).not.toContain("Emma");
    expect(`${payload.subject}${payload.html}${payload.text}`).not.toContain("Smith");
    expect(payload.text).not.toContain("3 days");
  });
  it("emails a coach chat flag with a sign-in link to the flag and nothing about the patient or the words", async () => {
    const flagged: StaffNotificationRow = {
      ...row("email"), kind: "coach_chat_flag", title: "A patient's chat needs review", body: "Open the app.",
      data: { flagId: "flag-1", providerId: "office-1", officeName: "Riverside Wellness", recipientName: "Sarah", day: "2026-10-11" },
    };
    const harness = setup(flagged);
    const fetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    await harness.tick();
    const payload = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as { to: string[]; subject: string; html: string; text: string };
    expect(payload.to).toEqual(["owner@example.com"]);
    expect(payload.subject).toBe("A patient's coach chat needs review at Riverside Wellness");
    expect(payload.html).toContain("Hello Sarah");
    expect(payload.html).toContain("Sunday, October 11, 2026");
    expect(payload.html).toContain("https://portal.example/alerts?chat=flag-1");
    expect(payload.text).toContain("https://portal.example/alerts?chat=flag-1");
    expect(payload.text).toContain("does not say who the patient is or what they wrote");
    for (const fragment of ["severe", "medication", "pregnan", "self-harm", "eating", "Emma"]) {
      expect(`${payload.subject}${payload.html}${payload.text}`.toLowerCase()).not.toContain(fragment);
    }
    expect(harness.store.notifications[0]?.status).toBe("sent");
  });
  it("pushes a coach chat flag with ids and a route only", async () => {
    const flagged: StaffNotificationRow = {
      ...row(), kind: "coach_chat_flag", title: "A patient's chat needs review", body: "A patient said something in their coach chat that needs your attention today. Open the app.",
      data: { flagId: "flag-1", providerId: "office-1", officeName: "Riverside Wellness", recipientName: "Sarah", day: "2026-10-11", category: "self_harm", reason: "leaked" },
    };
    const harness = setup(flagged);
    await harness.store.registerToken({ authUserId: flagged.auth_user_id, providerId: "office-1", token: "ExponentPushToken[staff]", deviceId: "device-123", platform: "ios" });
    await harness.tick();
    const message = harness.push.sent[0]?.[0]!;
    expect(message.title).toBe("A patient's chat needs review");
    expect(message.data).toEqual({
      route: "/(tabs)/patients", kind: "coach_chat_flag", category: "staff_alerts",
      notificationId: harness.store.notifications[0]!.id, providerId: "office-1", flagId: "flag-1",
    });
    for (const fragment of ["Riverside", "Sarah", "self_harm", "leaked"]) expect(JSON.stringify(message)).not.toContain(fragment);
    expect(guardPushMessage(message)).toEqual({ ok: true });
  });
  it("sends push and persists an accepted ticket", async () => {
    const harness = setup(); await harness.store.registerToken({ authUserId: row().auth_user_id, providerId: "office-1", token: "ExponentPushToken[staff]", deviceId: "device-123", platform: "ios" });
    await harness.tick();
    expect(harness.store.notifications[0]?.status).toBe("sent");
    const message = harness.push.sent[0]?.[0]!;
    expect(message.title).toBe("Patients need attention");
    expect(message.body).toBe("2 patients need attention. Open the app.");
    expect(message.data).toEqual({
      route: "/(tabs)/patients", kind: "staff_attention_digest", category: "staff_alerts",
      notificationId: harness.store.notifications[0]!.id, providerId: "office-1", digestDate: "2026-10-10", flaggedCount: 2,
    });
    expect(harness.store.attempts[0]).toMatchObject({ outcome: "ticket_ok" });
  });
  it("never lets the row snapshot ride the push: names, office, and reasons stay server-side", async () => {
    const legacy = row();
    legacy.data = { ...legacy.data, patients: [{ name: "Emma Smith", reasons: [{ label: "No meals logged", days: 3 }] }] };
    const harness = setup(legacy);
    await harness.store.registerToken({ authUserId: legacy.auth_user_id, providerId: "office-1", token: "ExponentPushToken[staff]", deviceId: "device-123", platform: "ios" });
    await harness.tick();
    const serialized = JSON.stringify(harness.push.sent[0]?.[0]);
    for (const fragment of ["Emma", "Smith", "Riverside", "Sarah", "No meals", "Weight stalled", "patients\":"]) expect(serialized).not.toContain(fragment);
    expect(guardPushMessage(harness.push.sent[0]![0]!)).toEqual({ ok: true });
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