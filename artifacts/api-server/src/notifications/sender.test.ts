/**
 * The outbox state machine against a fake Expo push service and the
 * in-memory store: tickets, receipts, retries with backoff, dead tokens,
 * preferences, quiet hours, expiry, lease safety across two owners.
 */
import { describe, expect, it } from "vitest";
import { FakePushClient, MemoryNotificationStore } from "./memory-store";
import { backoffMs, DEFAULT_SENDER_CONFIG, PUSH_CHANNEL_ID, runNotificationTick } from "./sender";
import type { NotificationRow } from "./types";
import { DEFAULT_ORG_POLICY, NO_OVERRIDES, type OfficeOverrides } from "../lib/org-policy";
import type { TickPolicy } from "./tick-policy";

const P1 = "11111111-1111-4111-8111-111111111111";
const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

function harness(start = "2026-07-01T16:00:00Z") {
  let now = new Date(start);
  const clock = () => new Date(now);
  const store = new MemoryNotificationStore(clock);
  const push = new FakePushClient();
  store.addPatient({ patientId: P1, providerId: "prov-1", timezone: "America/New_York" });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const tick = (owner = "worker-a", policy?: TickPolicy) =>
    runNotificationTick({ store, push, now: clock, config: { owner }, policy });
  const enqueue = (overrides: Partial<Parameters<MemoryNotificationStore["enqueue"]>[0]> = {}) =>
    store.enqueue({
      patientId: P1,
      kind: "coach_outreach",
      category: "coach_outreach",
      title: "A note from your coach",
      body: "Open the chat when you have a minute.",
      data: { route: "/coach-chat" },
      ...overrides,
    });
  const row = (id: string) => store.notifications.get(id) as NotificationRow;
  return { store, push, clock, advance, tick, enqueue, row };
}

describe("outbox sender", () => {
  it("sends to every active device, records ticket attempts, and marks the row sent", async () => {
    const h = harness();
    h.store.addToken(P1, TOKEN_A, "device-1");
    h.store.addToken(P1, TOKEN_B, "device-2", "android");
    const { row } = await h.enqueue();
    const summary = await h.tick();
    expect(summary).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    const after = h.row(row.id);
    expect(after.status).toBe("sent");
    expect(after.attempts).toBe(1);
    expect(after.sent_at).toBe(h.clock().toISOString());
    expect(after.lease_owner).toBeNull();
    expect(h.push.sent).toHaveLength(1);
    expect(h.push.sent[0].map((m) => m.to).sort()).toEqual([TOKEN_A, TOKEN_B].sort());
    expect(h.push.sent[0][0]).toMatchObject({
      channelId: PUSH_CHANNEL_ID,
      sound: "default",
      data: { route: "/coach-chat", notificationId: row.id, kind: "coach_outreach", category: "coach_outreach" },
    });
    const attempts = await h.store.listAttempts([row.id]);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.outcome === "ticket_ok" && a.ticket_id)).toBe(true);
    // Nothing left to claim.
    expect((await h.tick()).claimed).toBe(0);
  });

  it("suppresses with no_device when the patient has no active token", async () => {
    const h = harness();
    const { row } = await h.enqueue();
    const summary = await h.tick();
    expect(summary.suppressed).toBe(1);
    expect(h.row(row.id)).toMatchObject({ status: "suppressed", suppression_reason: "no_device" });
    expect(h.row(row.id).finalized_at).not.toBeNull();
    expect(h.push.sent).toHaveLength(0);
  });

  it("records opt-outs: category switch and nudge opt-out", async () => {
    const h = harness();
    h.store.addToken(P1, TOKEN_A);
    h.store.patients.get(P1)!.prefs = { categories: { coachOutreach: false } };
    const { row: a } = await h.enqueue({ dedupeKey: "a" });
    const { row: b } = await h.enqueue({ dedupeKey: "b", category: "office_reminders", kind: "office_reminder" });
    let summary = await h.tick();
    expect(summary).toMatchObject({ optedOut: 1, sent: 1 });
    expect(h.row(a.id)).toMatchObject({ status: "opted_out", suppression_reason: "category_off" });
    expect(h.row(b.id).status).toBe("sent");

    h.store.patients.get(P1)!.prefs = null;
    h.store.patients.get(P1)!.flags = { nudgeOptOut: true };
    const { row: c } = await h.enqueue({ dedupeKey: "c" });
    summary = await h.tick();
    expect(summary.optedOut).toBe(1);
    expect(h.row(c.id)).toMatchObject({ status: "opted_out", suppression_reason: "nudge_opt_out" });
  });

  it("defers inside quiet hours and sends once the window ends", async () => {
    // 23:30 New York (EDT) = 03:30Z.
    const h = harness("2026-07-01T03:30:00Z");
    h.store.addToken(P1, TOKEN_A);
    h.store.patients.get(P1)!.prefs = { quietHours: { start: "22:00", end: "07:00" } };
    const { row } = await h.enqueue();
    let summary = await h.tick();
    expect(summary.deferred).toBe(1);
    expect(h.row(row.id)).toMatchObject({
      status: "queued",
      suppression_reason: "quiet_hours_deferred",
      next_attempt_at: "2026-07-01T11:00:00.000Z",
      lease_owner: null,
    });
    expect(h.push.sent).toHaveLength(0);
    // Still quiet at 06:00 local: not due yet, nothing claimed.
    h.advance(6.5 * 3600_000);
    expect((await h.tick()).claimed).toBe(0);
    // 07:00 local: due, sends.
    h.advance(1 * 3600_000);
    summary = await h.tick();
    expect(summary.sent).toBe(1);
    expect(h.row(row.id).status).toBe("sent");
  });

  describe("organization policy defaults", () => {
    const hqQuiet: TickPolicy = {
      org: { ...DEFAULT_ORG_POLICY, defaultQuietHours: { start: "22:00", end: "07:00" } },
      overrides: new Map(),
    };
    const withOverride = (quietHours: OfficeOverrides["quietHours"]): TickPolicy => ({
      ...hqQuiet,
      overrides: new Map([[
        "prov-1",
        { ...NO_OVERRIDES("prov-1"), quietHours },
      ]]),
    });

    it("applies HQ default quiet hours to a patient who never set their own", async () => {
      const h = harness("2026-07-01T03:30:00Z"); // 23:30 New York
      h.store.addToken(P1, TOKEN_A);
      const { row } = await h.enqueue();
      const summary = await h.tick("worker-a", hqQuiet);
      expect(summary.deferred).toBe(1);
      expect(h.row(row.id)).toMatchObject({ status: "queued", suppression_reason: "quiet_hours_deferred" });
    });

    it("applies HQ default categories (a category HQ defaults off is opted out until the patient turns it on)", async () => {
      const h = harness();
      h.store.addToken(P1, TOKEN_A);
      const policy: TickPolicy = {
        org: { ...DEFAULT_ORG_POLICY, defaultCategories: { coachOutreach: true, checkInReminders: false, officeReminders: true } },
        overrides: new Map(),
      };
      const { row } = await h.enqueue({ kind: "check_in_reminder", category: "check_in_reminders", dedupeKey: "cr-1" });
      await h.tick("worker-a", policy);
      expect(h.row(row.id)).toMatchObject({ status: "opted_out", suppression_reason: "category_off" });
      h.store.patients.get(P1)!.prefs = { categories: { checkInReminders: true } };
      const { row: second } = await h.enqueue({ kind: "check_in_reminder", category: "check_in_reminders", dedupeKey: "cr-2" });
      await h.tick("worker-a", policy);
      expect(h.row(second.id).status).toBe("sent");
    });

    it("lets an office override beat the HQ default, and the patient's own setting beat both", async () => {
      const h = harness("2026-07-01T03:30:00Z");
      h.store.addToken(P1, TOKEN_A);
      // Office says "no quiet hours": HQ's window no longer applies.
      const { row: a } = await h.enqueue({ dedupeKey: "a" });
      await h.tick("worker-a", withOverride({ mode: "none" }));
      expect(h.row(a.id).status).toBe("sent");
      // Office custom window that does not cover 23:30 local: sends.
      const { row: b } = await h.enqueue({ dedupeKey: "b" });
      await h.tick("worker-a", withOverride({ mode: "custom", start: "01:00", end: "02:00" }));
      expect(h.row(b.id).status).toBe("sent");
      // Office inherits HQ: deferred.
      const { row: c } = await h.enqueue({ dedupeKey: "c" });
      await h.tick("worker-a", withOverride({ mode: "inherit" }));
      expect(h.row(c.id)).toMatchObject({ status: "queued", suppression_reason: "quiet_hours_deferred" });
      // Patient explicitly chose no quiet hours: beats HQ and office.
      h.store.patients.get(P1)!.prefs = { quietHours: null };
      const { row: d } = await h.enqueue({ dedupeKey: "d" });
      await h.tick("worker-a", withOverride({ mode: "custom", start: "22:00", end: "07:00" }));
      expect(h.row(d.id).status).toBe("sent");
    });
  });

  it("suppresses outright when quiet hours run past the expiry", async () => {
    const h = harness("2026-07-01T03:30:00Z");
    h.store.addToken(P1, TOKEN_A);
    h.store.patients.get(P1)!.prefs = { quietHours: { start: "22:00", end: "07:00" } };
    const { row } = await h.enqueue({ expiresAt: new Date("2026-07-01T09:00:00Z") });
    await h.tick();
    expect(h.row(row.id)).toMatchObject({ status: "suppressed", suppression_reason: "quiet_hours" });
  });

  it("expires rows claimed after their expiry", async () => {
    const h = harness();
    h.store.addToken(P1, TOKEN_A);
    const { row } = await h.enqueue({ expiresAt: new Date("2026-07-01T17:00:00Z") });
    h.advance(2 * 3600_000);
    const summary = await h.tick();
    expect(summary.expired).toBe(1);
    expect(h.row(row.id).status).toBe("expired");
  });

  it("retries transport failures with exponential backoff, then fails after the attempt cap", async () => {
    const h = harness();
    h.store.addToken(P1, TOKEN_A);
    const { row } = await h.enqueue();
    h.push.failNextSends = 99;
    for (let attempt = 1; attempt < DEFAULT_SENDER_CONFIG.maxAttempts; attempt++) {
      const summary = await h.tick();
      expect(summary.retried).toBe(1);
      const after = h.row(row.id);
      expect(after.status).toBe("queued");
      expect(after.attempts).toBe(attempt);
      expect(after.last_error).toMatch(/outage/);
      const expected = h.clock().getTime() + backoffMs(attempt, DEFAULT_SENDER_CONFIG);
      expect(new Date(after.next_attempt_at).getTime()).toBe(expected);
      // Not due before the backoff elapses.
      h.advance(backoffMs(attempt, DEFAULT_SENDER_CONFIG) - 1000);
      expect((await h.tick()).claimed).toBe(0);
      h.advance(1000);
    }
    const summary = await h.tick();
    expect(summary.failed).toBe(1);
    expect(h.row(row.id)).toMatchObject({ status: "failed", attempts: DEFAULT_SENDER_CONFIG.maxAttempts });
    const attempts = await h.store.listAttempts([row.id]);
    expect(attempts).toHaveLength(DEFAULT_SENDER_CONFIG.maxAttempts);
    expect(attempts.every((a) => a.outcome === "request_failed" && a.error_code === "HTTP_503")).toBe(true);
    expect(backoffMs(1, DEFAULT_SENDER_CONFIG)).toBe(30_000);
    expect(backoffMs(2, DEFAULT_SENDER_CONFIG)).toBe(60_000);
    expect(backoffMs(20, DEFAULT_SENDER_CONFIG)).toBe(DEFAULT_SENDER_CONFIG.maxBackoffMs);
  });

  it("disables tokens the service reports as unregistered and fails when none remain", async () => {
    const h = harness();
    const tokenA = h.store.addToken(P1, TOKEN_A, "device-1");
    const tokenB = h.store.addToken(P1, TOKEN_B, "device-2");
    h.push.script(TOKEN_A, { kind: "error", error: "DeviceNotRegistered" });
    const { row } = await h.enqueue();
    let summary = await h.tick();
    expect(summary).toMatchObject({ sent: 1, tokensDisabled: 1 });
    expect(h.row(row.id).status).toBe("sent");
    expect(h.store.tokens.get(tokenA.id)).toMatchObject({ disabled_reason: "device_not_registered" });
    expect(h.store.tokens.get(tokenB.id)!.disabled_at).toBeNull();

    // Next notification: only B is active; B dies too -> failed, no retry.
    h.push.script(TOKEN_B, { kind: "error", error: "DeviceNotRegistered" });
    const { row: second } = await h.enqueue({ dedupeKey: "second" });
    summary = await h.tick();
    expect(summary).toMatchObject({ failed: 1, tokensDisabled: 1 });
    expect(h.row(second.id)).toMatchObject({ status: "failed", last_error: "DeviceNotRegistered" });
    expect(await h.store.activeTokens(P1)).toHaveLength(0);
    // And a third is suppressed for lack of devices.
    const { row: third } = await h.enqueue({ dedupeKey: "third" });
    await h.tick();
    expect(h.row(third.id)).toMatchObject({ status: "suppressed", suppression_reason: "no_device" });
  });

  it("retries transient per-message ticket errors", async () => {
    const h = harness();
    h.store.addToken(P1, TOKEN_A);
    h.push.script(TOKEN_A, { kind: "error", error: "MessageRateExceeded" });
    const { row } = await h.enqueue();
    expect((await h.tick()).retried).toBe(1);
    expect(h.row(row.id)).toMatchObject({ status: "queued", attempts: 1, last_error: "MessageRateExceeded" });
    h.advance(backoffMs(1, DEFAULT_SENDER_CONFIG));
    expect((await h.tick()).sent).toBe(1);
  });

  it("resolves receipts after the delay: ok -> delivered, error -> failed (+dead token), missing -> waits then gives up", async () => {
    const h = harness();
    const tokenA = h.store.addToken(P1, TOKEN_A);
    const { row: ok } = await h.enqueue({ dedupeKey: "ok" });
    const { row: bad } = await h.enqueue({ dedupeKey: "bad" });
    const { row: lost } = await h.enqueue({ dedupeKey: "lost" });
    await h.tick();
    expect([ok, bad, lost].map((r) => h.row(r.id).status)).toEqual(["sent", "sent", "sent"]);
    // Too early for receipts.
    h.advance(5 * 60_000);
    expect((await h.tick()).receiptsChecked).toBe(0);
    expect(h.push.receiptQueries).toHaveLength(0);

    const attempts = await h.store.listAttempts([ok.id, bad.id, lost.id]);
    const ticketOf = (id: string) => attempts.find((a) => a.notification_id === id)!.ticket_id!;
    h.push.receipts.set(ticketOf(ok.id), { status: "ok" });
    h.push.receipts.set(ticketOf(bad.id), { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } });
    h.advance(11 * 60_000);
    let summary = await h.tick();
    expect(summary).toMatchObject({ receiptsChecked: 2, delivered: 1, failed: 1, tokensDisabled: 1 });
    expect(h.row(ok.id)).toMatchObject({ status: "delivered" });
    expect(h.row(ok.id).delivered_at).not.toBeNull();
    expect(h.row(bad.id)).toMatchObject({ status: "failed", last_error: "receipt: DeviceNotRegistered" });
    expect(h.store.tokens.get(tokenA.id)!.disabled_reason).toBe("device_not_registered");
    expect(h.row(lost.id)).toMatchObject({ status: "sent", receipts_checked_at: null });
    const okAttempt = (await h.store.listAttempts([ok.id]))[0];
    expect(okAttempt).toMatchObject({ receipt_outcome: "ok" });

    // The lost ticket is asked about again on later ticks until the give-up window.
    h.advance(60 * 60_000);
    await h.tick();
    expect(h.push.receiptQueries.at(-1)).toEqual([ticketOf(lost.id)]);
    expect(h.row(lost.id).receipts_checked_at).toBeNull();
    h.advance(24 * 60 * 60_000);
    summary = await h.tick();
    expect(summary.receiptsChecked).toBe(1);
    expect(h.row(lost.id).status).toBe("sent");
    expect(h.row(lost.id).receipts_checked_at).not.toBeNull();
    expect((await h.store.listAttempts([lost.id]))[0].receipt_outcome).toBe("missing");
  });

  it("never downgrades an opened notification when its receipt arrives later", async () => {
    const h = harness();
    h.store.addToken(P1, TOKEN_A);
    const { row } = await h.enqueue();
    await h.tick();
    // The app reported the open before receipts were checked.
    await h.store.updateNotification(row.id, { status: "opened", opened_at: h.clock().toISOString() });
    const ticket = (await h.store.listAttempts([row.id]))[0].ticket_id!;
    h.push.receipts.set(ticket, { status: "ok" });
    h.advance(20 * 60_000);
    await h.tick();
    // Row stayed opened; receipt bookkeeping closed because it left the "sent" set.
    expect(h.row(row.id).status).toBe("opened");
    expect((await h.tick()).receiptsChecked).toBe(0);
  });

  it("dedupes on the idempotency key", async () => {
    const h = harness();
    const first = await h.enqueue({ dedupeKey: "coach_outreach:p1:2026-06-20" });
    const second = await h.enqueue({ dedupeKey: "coach_outreach:p1:2026-06-20" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(h.store.notifications.size).toBe(1);
  });

  it("is safe across two workers: claims are exclusive and a lost lease drops the late write", async () => {
    const h = harness();
    h.store.addToken(P1, TOKEN_A);
    const { row } = await h.enqueue();
    // Worker A claims but stalls (simulate by claiming directly and not finishing).
    const claimedA = await h.store.claimDue("worker-a", 10, 120);
    expect(claimedA).toHaveLength(1);
    // Worker B sees nothing while A's lease is live.
    expect((await h.tick("worker-b")).claimed).toBe(0);
    // A's lease expires; B re-claims and sends.
    h.advance(121_000);
    const summaryB = await h.tick("worker-b");
    expect(summaryB.sent).toBe(1);
    expect(h.row(row.id)).toMatchObject({ status: "sent", lease_owner: null });
    // A wakes up and tries to finish its stale work: the guarded write is dropped.
    const late = await h.store.updateNotification(
      row.id,
      { status: "failed", last_error: "stale" },
      { leaseOwner: "worker-a" },
    );
    expect(late).toBeNull();
    expect(h.row(row.id).status).toBe("sent");
    expect(h.push.sent).toHaveLength(1);
  });
});
