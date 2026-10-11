/**
 * The outbox state machine against a fake Expo push service and the
 * in-memory store: tickets, receipts, retries with backoff, dead tokens,
 * preferences, quiet hours, expiry, lease safety across two owners.
 */
import { describe, expect, it } from "vitest";
import { FakePushClient, MemoryNotificationStore } from "./memory-store";
import {
  backoffMs,
  CARE_TEAM_PUSH_BODY,
  CARE_TEAM_PUSH_TITLE,
  CARE_TEAM_SUGGESTION_PUSH_BODY,
  DEFAULT_SENDER_CONFIG,
  nextClaimLimit,
  PUSH_CHANNEL_ID,
  runNotificationTick,
} from "./sender";
import type { NotificationRow } from "./types";
import { DIET_PATIENT_KINDS, DIET_PATIENT_PUSH, DIET_PATIENT_PUSH_KIND, DIET_PATIENT_ROW_COPY } from "../diet/push-kinds";
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
    expect(summary).toMatchObject({ sent: 1, tokensRetired: 1 });
    expect(h.row(row.id).status).toBe("sent");
    expect(h.store.tokens.get(tokenA.id)).toMatchObject({ disabled_reason: "device_not_registered" });
    expect(h.store.tokens.get(tokenB.id)!.disabled_at).toBeNull();

    // Next notification: only B is active; B dies too -> failed, no retry.
    h.push.script(TOKEN_B, { kind: "error", error: "DeviceNotRegistered" });
    const { row: second } = await h.enqueue({ dedupeKey: "second" });
    summary = await h.tick();
    expect(summary).toMatchObject({ failed: 1, tokensRetired: 1 });
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
    expect(summary).toMatchObject({ receiptsChecked: 2, delivered: 1, failed: 1, tokensRetired: 1 });
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

  describe("drain loop", () => {
    const P = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
    /** Many one-device patients, one queued reminder each. */
    async function crowd(h: ReturnType<typeof harness>, count: number) {
      for (let i = 1; i <= count; i++) {
        h.store.addPatient({ patientId: P(i), providerId: "prov-1", timezone: "America/New_York" });
        h.store.addToken(P(i), `ExponentPushToken[${String(i).padStart(22, "0")}]`);
        await h.enqueue({ patientId: P(i), dedupeKey: `reminder:${i}` });
      }
    }

    it("drains 5,000 queued rows in one tick, 100 messages per push request, well inside the budget", async () => {
      const h = harness();
      await crowd(h, 5_000);
      const startedAt = performance.now();
      const summary = await h.tick();
      const wallMs = performance.now() - startedAt;
      expect(summary).toMatchObject({ claimed: 5_000, sent: 5_000, failed: 0, leaseLost: 0, budgetExhausted: false });
      expect(wallMs).toBeLessThan(DEFAULT_SENDER_CONFIG.tickBudgetMs);
      // 25 → 50 → 100 → 200 and then full batches: far fewer rounds than rows.
      expect(summary.batches).toBeLessThanOrEqual(30);
      expect(h.store.claims.map((c) => c.limit).slice(0, 4)).toEqual([25, 50, 100, 200]);
      expect(h.push.sent.every((request) => request.length <= 100)).toBe(true);
      expect(h.push.sent.length).toBeLessThanOrEqual(summary.batches * 2);
      expect(h.push.sent.flat()).toHaveLength(5_000);
      const lastId = [...h.store.notifications.keys()][4_999];
      expect(h.row(lastId).status).toBe("sent");
      expect(await h.store.listAttempts([lastId])).toHaveLength(1);
      expect((await h.store.outboxBacklog(h.clock())).due).toBe(0);
      expect((await h.tick()).claimed).toBe(0);
    });

    it("grows the claim size after clean batches, shrinks it on outages, rate limits, and provider errors, and never leaves [min, max]", async () => {
      const h = harness();
      await crowd(h, 600);
      // Second request (the 50-row batch) hits an outage; the fourth is rate limited.
      let sends = 0;
      h.push.onSend = () => {
        sends += 1;
        if (sends === 2) h.push.failNextSends = 1;
        if (sends === 4) {
          h.push.failStatus = 429;
          h.push.failNextSends = 1;
        }
      };
      const summary = await h.tick();
      const limits = h.store.claims.map((c) => c.limit);
      // 25 ok → 50 outage → 25 ok → 50 rate limited → 25 ok → 50 → 100 → 200 …
      expect(limits.slice(0, 8)).toEqual([25, 50, 25, 50, 25, 50, 100, 200]);
      expect(Math.max(...limits)).toBe(200);
      expect(summary.retried).toBe(100);
      expect(summary.sent).toBe(500);
      expect(summary.claimed).toBe(600);

      // Per-message provider errors also shrink; dead devices do not.
      const g = harness();
      await crowd(g, 80);
      g.push.script(`ExponentPushToken[${String(1).padStart(22, "0")}]`, { kind: "error", error: "ExpoError" });
      g.push.script(`ExponentPushToken[${String(30).padStart(22, "0")}]`, { kind: "error", error: "DeviceNotRegistered" });
      await g.tick();
      // 25 (ExpoError → shrink to 12) → 12 (clean → 24) → 24 → 48 (dead device only, still grows)
      expect(g.store.claims.map((c) => c.limit).slice(0, 4)).toEqual([25, 12, 24, 48]);

      // The floor holds under a sustained outage; the ceiling is the RPC's clamp.
      const f = harness();
      await crowd(f, 40);
      f.push.failNextSends = 99;
      const floor = await f.tick();
      expect(f.store.claims.map((c) => c.limit)).toEqual([25, 12, 10]);
      expect(floor).toMatchObject({ retried: 40, sent: 0, lastClaimLimit: 10 });
      expect(nextClaimLimit(200, { transportFailed: false, rateLimited: false, providerErrors: false }, DEFAULT_SENDER_CONFIG)).toBe(200);
      expect(nextClaimLimit(500, { transportFailed: false, rateLimited: false, providerErrors: false }, { claimLimitMin: 10, claimLimitMax: 10_000 })).toBe(200);
      expect(nextClaimLimit(11, { transportFailed: true, rateLimited: false, providerErrors: false }, DEFAULT_SENDER_CONFIG)).toBe(10);
    });

    it("stops claiming once the budget is spent, finishes the batch in progress, and hands the rest to the next tick", async () => {
      const h = harness();
      await crowd(h, 120);
      // Every push request takes 7 s of wall clock.
      h.push.onSend = () => h.advance(7_000);
      const first = await runNotificationTick({
        store: h.store,
        push: h.push,
        now: h.clock,
        config: { owner: "worker-a", claimLimit: 10, claimLimitMax: 10, tickBudgetMs: 20_000 },
      });
      // 0 s → 7 s → 14 s → 21 s: three batches, the third completes although it crosses the budget.
      expect(first).toMatchObject({ claimed: 30, sent: 30, batches: 3, budgetExhausted: true });
      expect(first.elapsedMs).toBeGreaterThanOrEqual(20_000);
      const backlog = await h.store.outboxBacklog(h.clock());
      expect(backlog).toMatchObject({ due: 90, inFlight: 0 });
      expect(backlog.oldestDueAt).toBe(h.row([...h.store.notifications.keys()][30]).next_attempt_at);
      const second = await runNotificationTick({
        store: h.store,
        push: h.push,
        now: h.clock,
        config: { owner: "worker-a", claimLimit: 10, claimLimitMax: 10, tickBudgetMs: 20_000 },
      });
      expect(second).toMatchObject({ claimed: 30, sent: 30, budgetExhausted: true });
      expect((await h.store.outboxBacklog(h.clock())).due).toBe(60);
    });

    it("retires a device the service reports gone and skips it from the very next batch while the other device keeps receiving", async () => {
      const h = harness();
      const dead = h.store.addToken(P1, TOKEN_A, "device-1");
      const alive = h.store.addToken(P1, TOKEN_B, "device-2", "android");
      h.push.script(TOKEN_A, { kind: "error", error: "DeviceNotRegistered" }, { kind: "ok" });
      const first = await h.enqueue({ dedupeKey: "r1" });
      const second = await h.enqueue({ dedupeKey: "r2" });
      const summary = await runNotificationTick({
        store: h.store,
        push: h.push,
        now: h.clock,
        config: { owner: "worker-a", claimLimit: 1, claimLimitMin: 1, claimLimitMax: 1 },
      });
      expect(summary).toMatchObject({ claimed: 2, sent: 2, tokensRetired: 1, batches: 2 });
      expect(h.push.sent[0].map((m) => m.to).sort()).toEqual([TOKEN_A, TOKEN_B].sort());
      // Second batch never even tried the retired device.
      expect(h.push.sent[1].map((m) => m.to)).toEqual([TOKEN_B]);
      expect(h.store.tokens.get(dead.id)).toMatchObject({ disabled_reason: "device_not_registered" });
      expect(h.store.tokens.get(alive.id)?.disabled_at).toBeNull();
      expect(h.row(first.row.id).status).toBe("sent");
      expect(h.row(second.row.id).status).toBe("sent");
      expect(await h.store.activeTokens(P1)).toHaveLength(1);
    });

    it("renews leases mid-batch when the push service is slow, so the rows stay with the sender that is pushing them", async () => {
      const h = harness();
      await crowd(h, 3);
      // The push request takes 70 s against a 120 s lease.
      h.push.onSend = () => h.advance(70_000);
      const summary = await h.tick();
      expect(summary).toMatchObject({ sent: 3, leasesRenewed: 3, leaseLost: 0 });
      expect(h.store.renewals).toHaveLength(1);
      expect(h.store.renewals[0]).toMatchObject({ owner: "worker-a", renewed: 3 });
      expect(h.store.renewals[0].ids).toHaveLength(3);

      const quick = harness();
      await crowd(quick, 3);
      await quick.tick();
      expect(quick.store.renewals).toHaveLength(0);
    });

    it("re-claims a stalled tick's rows on the next tick once the lease lapses, and drops the stalled tick's late writes", async () => {
      const h = harness();
      await crowd(h, 5);
      let release!: () => void;
      const stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Worker A's first push request hangs (service outage, no response).
      h.push.onSend = async () => {
        h.push.onSend = null;
        await stalled;
      };
      const tickA = h.tick("worker-a");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await h.store.outboxBacklog(h.clock())).inFlight).toBe(5);
      // Nothing for B while A's lease is live.
      expect((await h.tick("worker-b")).claimed).toBe(0);
      // The lease lapses (no renewal ran: A is stuck inside the push call).
      h.advance(121_000);
      expect((await h.store.outboxBacklog(h.clock())).inFlight).toBe(0);
      const tickB = await h.tick("worker-b");
      expect(tickB).toMatchObject({ claimed: 5, sent: 5, leaseLost: 0 });
      // A finally gets its answer: every guarded write is dropped, nothing double-counted.
      release();
      const summaryA = await tickA;
      expect(summaryA).toMatchObject({ claimed: 5, sent: 0, leaseLost: 5 });
      for (const row of h.store.notifications.values()) expect(row).toMatchObject({ status: "sent", lease_owner: null });
      // The patient got exactly one push per reminder from B, plus A's stale request.
      expect(h.push.sent).toHaveLength(2);
    });
  });

  describe("diet notice safety", () => {
    it("sends one generic kind and copy for every diet row; the specific kind and copy stay on the row", async () => {
      for (const kind of DIET_PATIENT_KINDS) {
        const h = harness();
        h.store.addToken(P1, TOKEN_A);
        const copy = DIET_PATIENT_ROW_COPY[kind];
        const { row } = await h.enqueue({
          kind, category: copy.category, title: copy.title, body: copy.body,
          data: { patientId: P1, route: "/food-preferences", day: "2026-07-01" }, dedupeKey: `${kind}:${P1}:2026-07-01`,
        });
        await h.tick();
        expect(h.push.sent).toHaveLength(1);
        const message = h.push.sent[0][0];
        expect(message).toMatchObject({ title: DIET_PATIENT_PUSH.title, body: DIET_PATIENT_PUSH.body });
        expect(message.data).toEqual({ route: "/food-preferences", notificationId: row.id, kind: DIET_PATIENT_PUSH_KIND, category: copy.category });
        const wire = JSON.stringify(message).toLowerCase();
        for (const fragment of [P1, "diet", "pregnan", "breastfeed", "eating", "plan", "answer"]) expect(wire).not.toContain(fragment);
        expect(h.row(row.id).kind).toBe(kind);
        expect(h.row(row.id).title).toBe(copy.title);
      }
    });
  });

  describe("care-team reply safety", () => {
    const careTeam = {
      kind: "care_team_reply",
      category: "office_reminders" as const,
      // Deliberately unsafe queued copy proves the sender does not trust it.
      title: "Dr Person at Private Clinic",
      body: "Patient-specific reply text",
      data: {
        route: "/unsafe",
        messageClientId: "private-client-id",
        providerId: "prov-1",
        conversationId: "22222222-2222-4222-8222-222222222222",
        leakedText: "private reply",
      },
      dedupeKey: "care_team_reply:conversation:client",
    };

    it("sends generic lockscreen copy and only allowlisted deep-link fields", async () => {
      const h = harness();
      h.store.addToken(P1, TOKEN_A);
      const { row } = await h.enqueue(careTeam);
      await h.tick();

      expect(h.push.sent).toHaveLength(1);
      expect(h.push.sent[0][0]).toMatchObject({
        title: CARE_TEAM_PUSH_TITLE,
        body: CARE_TEAM_PUSH_BODY,
        data: {
          patientId: P1,
          thread: "care_team",
          conversationId: careTeam.data.conversationId,
          notificationId: row.id,
          kind: "care_team_reply",
          category: "office_reminders",
        },
      });
      expect(h.push.sent[0][0].data).not.toHaveProperty("providerId");
      expect(h.push.sent[0][0].data).not.toHaveProperty("route");
      expect(h.push.sent[0][0].data).not.toHaveProperty("messageClientId");
      expect(h.push.sent[0][0].data).not.toHaveProperty("leakedText");
    });

    it("uses generic suggestion copy when the row marks a suggestion, never the stored body", async () => {
      const h = harness();
      h.store.addToken(P1, TOKEN_A);
      const suggestionBody = "Your care team suggested Daily Balance for you.";
      await h.enqueue({
        ...careTeam,
        body: suggestionBody,
        data: { ...careTeam.data, suggestion: true },
        dedupeKey: "care_team_reply:suggestion",
      });
      await h.tick();

      expect(h.push.sent[0][0]).toMatchObject({
        title: CARE_TEAM_PUSH_TITLE,
        body: CARE_TEAM_SUGGESTION_PUSH_BODY,
      });
      expect(JSON.stringify(h.push.sent[0][0])).not.toContain("Daily Balance");
    });

    it("uses the existing care-team preference category and current quiet hours/device state", async () => {
      const optedOut = harness();
      optedOut.store.addToken(P1, TOKEN_A);
      optedOut.store.patients.get(P1)!.prefs = { categories: { officeReminders: false } };
      const { row: off } = await optedOut.enqueue(careTeam);
      await optedOut.tick();
      expect(optedOut.row(off.id)).toMatchObject({ status: "opted_out", suppression_reason: "category_off" });
      expect(optedOut.push.sent).toHaveLength(0);

      const quiet = harness("2026-07-01T03:30:00Z");
      quiet.store.addToken(P1, TOKEN_A);
      quiet.store.patients.get(P1)!.prefs = { quietHours: { start: "22:00", end: "07:00" } };
      const { row: deferred } = await quiet.enqueue(careTeam);
      await quiet.tick();
      expect(quiet.row(deferred.id)).toMatchObject({ status: "queued", suppression_reason: "quiet_hours_deferred" });
      expect(quiet.push.sent).toHaveLength(0);

      const device = harness();
      const { row: none } = await device.enqueue(careTeam);
      await device.tick();
      expect(device.row(none.id)).toMatchObject({ status: "suppressed", suppression_reason: "no_device" });
    });

    it.each([
      ["patient deletion/unavailability", { available: false }, "patient_unavailable"],
      ["office lock", { officeLocked: true }, "office_locked"],
      ["disabled or missing office", { officeAvailable: false }, "office_unavailable"],
      ["retained conversation after transfer", { providerId: "prov-2" }, "office_transferred"],
    ])("suppresses for authoritative %s state", async (_label, state, reason) => {
      const h = harness();
      h.store.addToken(P1, TOKEN_A);
      Object.assign(h.store.patients.get(P1)!, state);
      const { row } = await h.enqueue(careTeam);
      await h.tick();
      expect(h.row(row.id)).toMatchObject({ status: "suppressed", suppression_reason: reason });
      expect(h.push.sent).toHaveLength(0);
    });

    it("dedupes transaction retries to one care-team notification", async () => {
      const h = harness();
      const first = await h.enqueue(careTeam);
      const retried = await h.enqueue(careTeam);
      expect(first.created).toBe(true);
      expect(retried).toMatchObject({ created: false });
      expect(retried.row.id).toBe(first.row.id);
      expect(h.store.notifications.size).toBe(1);
    });
  });
});
