import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: vi.fn(async () => { throw new Error("no network in this suite"); }) }));

import type { JobContext } from "../types";
import type { OfficeHealthRow } from "../../routes/hq-customer-health";
import { ALL_JOBS } from "../index";
import {
  buildWeeklyNotifications,
  runWeeklyCustomerHealth,
  weeklyCustomerHealthJob,
  weeklyEmailData,
  weeklyHealthDedupeKey,
  type WeeklyHealthStore,
} from "./weekly-customer-health";
import { renderWeeklyCustomerHealthEmail } from "../../alerts/staff-sender";
import type { StaffNotificationRow } from "../../alerts/store";

// Monday 2026-10-12 09:00 EDT.
const MONDAY_9AM = new Date("2026-10-12T13:00:00Z");
const DAY = 86_400_000;
const ago = (days: number, from = MONDAY_9AM) => new Date(from.getTime() - days * DAY).toISOString();

function office(providerId: string, extra: Partial<OfficeHealthRow> = {}): OfficeHealthRow {
  return {
    providerId, officeName: `${providerId} office`, providerName: `Dr ${providerId}`, accessDisabled: false, offboardingStatus: "active",
    createdAt: ago(400), lastPaidOrderAt: null, activeSubscribers: 0, cancellingSubscriptions: 0, appUsers: 0,
    activeAppUsers30d: 0, activeAppUsersPrior30d: 0, staffEnrolled: 0, ...extra,
  };
}

function ctx(now: Date, dryRun = false) {
  const tallies: Record<string, number> = {};
  const logs: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const context: JobContext = {
    dryRun, now, leaseLost: false,
    tally: (key, by = 1) => { tallies[key] = (tallies[key] ?? 0) + by; },
    failItem: () => undefined,
    log: (event, detail) => { logs.push({ event, detail }); },
    checkpoint: () => undefined,
  };
  return { context, tallies, logs };
}

function fakeStore(overrides: Partial<WeeklyHealthStore> = {}) {
  const snapshots: Record<string, unknown>[] = [];
  const queued: Record<string, unknown>[] = [];
  const runs: Record<string, unknown>[] = [];
  const existingKeys = new Set<string>();
  const calls: string[] = [];
  const store: WeeklyHealthStore = {
    timeZone: async () => { calls.push("timeZone"); return "America/New_York"; },
    runExists: async (week) => { calls.push("runExists"); return runs.some((run) => run.iso_week === week); },
    loadRows: async () => { calls.push("loadRows"); return [
      office("a", { lastPaidOrderAt: ago(5), activeSubscribers: 10, appUsers: 25, activeAppUsers30d: 25, staffEnrolled: 3 }),
      office("b", { lastPaidOrderAt: ago(75), appUsers: 10, activeAppUsers30d: 2, activeAppUsersPrior30d: 6 }),
      office("c", { offboardingStatus: "offboarding", lastPaidOrderAt: ago(1) }),
      office("f", { officeName: "Fern · Field Clinic", lastPaidOrderAt: ago(500), cancellingSubscriptions: 2, activeSubscribers: 2 }),
    ]; },
    priorScores: async (week) => { calls.push(`priorScores:${week}`); return week === "2026-W41" ? new Map([["a", 88], ["b", 50]]) : new Map(); },
    subscribers: async () => { calls.push("subscribers"); return [
      { auth_user_id: "u1", email: "one@example.com", display_name: "Danielle" },
      { auth_user_id: "u2", email: null, display_name: null },
      { auth_user_id: "u3", email: "three@example.com", display_name: " " },
    ]; },
    writeSnapshots: async (rows) => { calls.push("writeSnapshots"); snapshots.push(...rows); return rows.length; },
    enqueue: async (rows) => {
      calls.push("enqueue");
      let fresh = 0;
      for (const row of rows) { const key = String(row.dedupe_key); if (existingKeys.has(key)) continue; existingKeys.add(key); queued.push(row); fresh += 1; }
      return fresh;
    },
    recordRun: async (row) => { calls.push("recordRun"); runs.push(row); },
    ...overrides,
  };
  return { store, snapshots, queued, runs, calls, existingKeys };
}

describe("weekly-customer-health job", () => {
  it("is registered in the shared job list on a 15-minute poll so the external tick reaches it", () => {
    expect(ALL_JOBS.map((job) => job.name)).toContain("weekly-customer-health");
    expect(weeklyCustomerHealthJob.intervalMs).toBe(15 * 60_000);
  });

  it("does nothing before Monday 09:00 local or on other days — not even a facts read", async () => {
    for (const at of [new Date("2026-10-12T12:59:00Z"), new Date("2026-10-13T14:00:00Z"), new Date("2026-10-11T14:00:00Z"), new Date("2026-10-16T13:00:00Z")]) {
      const fake = fakeStore();
      const run = ctx(at);
      await runWeeklyCustomerHealth(run.context, fake.store);
      expect(run.tallies).toEqual({ notDue: 1 });
      expect(fake.calls).toEqual(["timeZone"]);
      expect(fake.snapshots).toEqual([]);
      expect(fake.queued).toEqual([]);
    }
  });

  it("on Monday at 09:00 local: snapshots every active office, queues one email per subscriber with an address, then records the run", async () => {
    const fake = fakeStore();
    const run = ctx(MONDAY_9AM);
    await runWeeklyCustomerHealth(run.context, fake.store);
    expect(fake.calls).toEqual(["timeZone", "runExists", "loadRows", "priorScores:2026-W41", "subscribers", "writeSnapshots", "enqueue", "recordRun"]);
    expect(run.tallies).toMatchObject({ officesScored: 3, attention: 2, subscribers: 3, priorWeekSnapshots: 2, snapshotsWritten: 3, emailsQueued: 2, runsRecorded: 1 });

    // One snapshot per active office for the ISO week (offboarding c is dropped), with the five inputs and the as-of local date.
    expect(fake.snapshots.map((row) => row.provider_id)).toEqual(["a", "b", "f"]);
    expect(fake.snapshots[0]).toMatchObject({
      iso_week: "2026-W42", provider_id: "a", as_of_date: "2026-10-12", office_name: "a office", rank: 1, score: 100, band: "healthy", bucket: "active", is_new: false,
      active_subscribers: 10, cancelling_subscriptions: 0, app_users: 25, active_app_users_30d: 25, active_app_users_prior_30d: 0, staff_enrolled: 3, flags: [],
      captured_at: "2026-10-12T13:00:00.000Z",
    });
    expect(fake.snapshots[0].last_paid_order_at).toBe(ago(5));
    expect(fake.snapshots[2]).toMatchObject({ provider_id: "f", bucket: "quietOverYear", band: "atRisk" });
    expect((fake.snapshots[2].flags as Array<{ kind: string }>).map((flag) => flag.kind)).toEqual(["subscriptionsCancelling", "atRisk"]);

    // Emails: u2 has no address and is skipped; u3's blank display name becomes null.
    expect(fake.queued.map((row) => row.auth_user_id)).toEqual(["u1", "u3"]);
    const first = fake.queued[0];
    expect(first).toMatchObject({
      provider_id: null, channel: "email", email: "one@example.com", kind: "weekly_customer_health", category: "staff_alerts",
      dedupe_key: "weekly_customer_health:2026-W42:u1:email", scheduled_at: "2026-10-12T13:00:00.000Z", next_attempt_at: "2026-10-12T13:00:00.000Z",
      expires_at: "2026-10-19T13:00:00.000Z", title: "Customer health · Monday, October 12, 2026",
    });
    expect(first.body).toBe("2 offices need attention this week; 3 active offices scored. Fern · Field Clinic (3, —); b office (44, −6 vs last week).");
    const data = first.data as Record<string, unknown>;
    expect(data).toMatchObject({ isoWeek: "2026-W42", weekLabel: "Monday, October 12, 2026", officeCount: 3, attentionCount: 2, recipientName: "Danielle" });
    expect(data.bucketCounts).toEqual([
      { label: "Active", count: 2 }, { label: "Quiet 3–6 months", count: 0 }, { label: "Quiet 6–12 months", count: 0 }, { label: "Quiet over a year / never ordered", count: 1 },
    ]);
    expect(data.attention).toEqual([
      { providerId: "f", officeName: "Fern · Field Clinic", score: 3, band: "At risk", change: null, reasons: [expect.stringContaining("cancel"), expect.stringContaining("At risk")] },
      { providerId: "b", officeName: "b office", score: 44, band: "Watch", change: -6, reasons: [expect.stringContaining("75 days ago"), expect.stringContaining("Active app users")] },
    ]);
    expect((fake.queued[1].data as Record<string, unknown>).recipientName).toBeNull();
    // Nothing in the row names a patient: only office names, counts and the page's reasons.
    const serialized = JSON.stringify(fake.queued);
    expect(serialized).not.toMatch(/patientName|weight|bmi|medication|diagnos/i);

    expect(fake.runs).toEqual([{ iso_week: "2026-W42", generated_at: "2026-10-12T13:00:00.000Z", time_zone: "America/New_York", office_count: 3, attention_count: 2, recipients_queued: 2 }]);
  });

  it("runs once per ISO week: later Monday ticks and a restart mid-run cannot queue a second email", async () => {
    const fake = fakeStore();
    await runWeeklyCustomerHealth(ctx(MONDAY_9AM).context, fake.store);
    // A later tick the same Monday, and Monday night local (already Tuesday in UTC).
    for (const at of [new Date("2026-10-12T13:15:00Z"), new Date("2026-10-13T03:30:00Z")]) {
      const run = ctx(at);
      await runWeeklyCustomerHealth(run.context, fake.store);
      expect(run.tallies).toEqual({ alreadyRan: 1 });
    }
    expect(fake.queued).toHaveLength(2);
    expect(fake.snapshots).toHaveLength(3);

    // Restart between the enqueue and the run-row insert: the run row is missing, so the
    // job repeats — snapshots merge and the dedupe key makes every email a duplicate.
    const restarted = fakeStore();
    restarted.existingKeys.add(weeklyHealthDedupeKey("2026-W42", "u1"));
    restarted.existingKeys.add(weeklyHealthDedupeKey("2026-W42", "u3"));
    const run = ctx(new Date("2026-10-12T13:15:00Z"));
    await runWeeklyCustomerHealth(run.context, restarted.store);
    expect(run.tallies).toMatchObject({ emailsQueued: 0, snapshotsWritten: 3, runsRecorded: 1 });
    expect(restarted.queued).toEqual([]);

    // The following Monday is a new week with its own key and run row.
    const nextMonday = new Date("2026-10-19T13:00:00Z");
    const next = ctx(nextMonday);
    await runWeeklyCustomerHealth(next.context, fake.store);
    expect(next.tallies).toMatchObject({ emailsQueued: 2, runsRecorded: 1 });
    expect(fake.queued[2].dedupe_key).toBe("weekly_customer_health:2026-W43:u1:email");
    expect(fake.calls.filter((call) => call.startsWith("priorScores:")).at(-1)).toBe("priorScores:2026-W42");
  });

  it("still emails the counts when no office needs attention", async () => {
    const fake = fakeStore({
      loadRows: async () => [office("a", { lastPaidOrderAt: ago(5), activeSubscribers: 10, appUsers: 25, activeAppUsers30d: 25, staffEnrolled: 3 })],
    });
    await runWeeklyCustomerHealth(ctx(MONDAY_9AM).context, fake.store);
    expect(fake.queued).toHaveLength(2);
    const data = fake.queued[0].data as Record<string, unknown>;
    expect(data).toMatchObject({ officeCount: 1, attentionCount: 0, attention: [] });
    expect(fake.queued[0].body).toBe("No offices need attention this week; 1 active office scored.");
    const rendered = renderWeeklyCustomerHealthEmail({ ...(fake.queued[0] as unknown as StaffNotificationRow), id: "n1", status: "queued", attempts: 0, suppression_reason: null, lease_owner: null });
    expect(rendered.text).toContain("No offices need attention this week");
    expect(rendered.text).toContain("Active — 1");
    expect(rendered.text).toContain("1 active office scored");
  });

  it("with no subscribers, still writes the snapshots and the run row", async () => {
    const fake = fakeStore({ subscribers: async () => [] });
    const run = ctx(MONDAY_9AM);
    await runWeeklyCustomerHealth(run.context, fake.store);
    expect(run.tallies).toMatchObject({ subscribers: 0, snapshotsWritten: 3, emailsQueued: 0, runsRecorded: 1 });
    expect(fake.runs[0]).toMatchObject({ recipients_queued: 0 });
  });

  it("dry runs tally what would happen and write nothing", async () => {
    const fake = fakeStore();
    const run = ctx(MONDAY_9AM, true);
    await runWeeklyCustomerHealth(run.context, fake.store);
    expect(run.tallies).toMatchObject({ snapshotsWouldWrite: 3, emailsWouldQueue: 2 });
    expect(fake.calls).not.toContain("writeSnapshots");
    expect(fake.calls).not.toContain("enqueue");
    expect(fake.calls).not.toContain("recordRun");
  });

  it("honours the organization's zone across DST: the autumn Monday is due at 14:00Z, not 13:00Z", async () => {
    const fake = fakeStore();
    const early = ctx(new Date("2026-11-02T13:00:00Z"));
    await runWeeklyCustomerHealth(early.context, fake.store);
    expect(early.tallies).toEqual({ notDue: 1 });
    const onTime = ctx(new Date("2026-11-02T14:00:00Z"));
    await runWeeklyCustomerHealth(onTime.context, fake.store);
    expect(onTime.tallies).toMatchObject({ runsRecorded: 1 });
    expect(fake.runs[0].iso_week).toBe("2026-W45");
    expect(fake.queued[0].expires_at).toBe("2026-11-09T14:00:00.000Z");
  });

  it("renders the queued row through the shared template: office names flattened, change labels, no patient data", () => {
    const data = weeklyEmailData({
      generatedAt: MONDAY_9AM.toISOString(),
      offices: [], bucketCounts: { active: 4, quiet3to6: 1, quiet6to12: 0, quietOverYear: 2 }, bandCounts: { healthy: 4, watch: 1, atRisk: 2 },
      attention: [{
        providerId: "f", officeName: "Fern · Field Clinic", providerName: "Dr F", rank: 7, score: 3, band: "atRisk", bucket: "quietOverYear", isNew: false,
        parts: { recency: 0, subscribers: 3, appUsers: 0, activeAppUsers: 0, staff: 0 }, lastOrderDate: null, lastOrderAt: null, daysSinceLastOrder: 500, officeAgeDays: 400,
        activeSubscribers: 2, cancellingSubscriptions: 2, appUsers: 0, activeAppUsers30d: 0, activeAppUsersPrior30d: 0, staffEnrolled: 0,
        flags: [{ kind: "subscriptionsCancelling", reason: "2 of 2 app subscriptions cancel at period end." }, { kind: "atRisk", reason: "At risk: score 3." }],
      }],
    }, "2026-W42", new Map([["f", 15]]));
    const [queued] = buildWeeklyNotifications({ data, recipients: [{ auth_user_id: "u1", email: "one@example.com", display_name: "Danielle" }], now: MONDAY_9AM, expiresAt: new Date("2026-10-19T13:00:00Z") });
    const rendered = renderWeeklyCustomerHealthEmail({ ...(queued as unknown as StaffNotificationRow), id: "n1", status: "queued", attempts: 0, suppression_reason: null, lease_owner: null });
    expect(rendered.subject).toContain("Customer health");
    expect(rendered.text).toContain("Fern - Field Clinic");
    expect(rendered.text).toContain("−12 vs last week");
    expect(rendered.text).toContain("At risk");
    expect(rendered.text).toContain("1 office needs attention this week");
    expect(rendered.text).toContain("Quiet over a year / never ordered — 2");
    expect(rendered.html).toContain("/admin/customer-health");
  });
});
