import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../types";

const rows: Array<Record<string, any>> = [];
vi.mock("../../billing/store", () => ({
  selectMany: vi.fn(async (_table: string, query: string) => {
    const params = new URLSearchParams(query);
    // PostgREST repeats the key; URLSearchParams keeps both values.
    const [gte, lte] = params.getAll("next_shipment_at").map((value) => value.replace(/^(gte|lte)\./, ""));
    return rows.filter((row) => row.status === "active" && row.paused_at == null && row.cancel_at_period_end === false
      && row.next_shipment_at != null && row.next_shipment_at >= gte && row.next_shipment_at <= lte);
  }),
}));
const notify = vi.fn(async (_sub: unknown, _card: unknown) => "sent" as const);
vi.mock("../../billing/customer-emails", () => ({
  notifyRenewalReminder: (sub: unknown, card: unknown) => notify(sub, card),
  renewalReminderDays: () => 3,
}));
vi.mock("../../billing/subscriptions", () => ({ accountFor: vi.fn(async () => ({ stripe_account_id: "acct_1" })) }));
vi.mock("../../billing/stripe-client", () => ({
  connectedOpts: (acct: string) => ({ stripeAccount: acct }),
  getStripe: async () => ({ subscriptions: { retrieve: vi.fn(async () => ({ default_payment_method: { id: "pm_1", card: { brand: "visa", last4: "4242" } } })) } }),
}));

import { dueForReminder, reminderWindow, sendRenewalReminders } from "./billing-renewal-reminders";

const NOW = new Date("2026-10-09T15:00:00.000Z");
function ctx(dryRun = false) {
  const counts: Record<string, number> = {};
  const failures: string[] = [];
  const c: JobContext = {
    dryRun, now: NOW, leaseLost: false, checkpoint: () => undefined, log: () => undefined,
    tally: (key, by = 1) => { counts[key] = (counts[key] ?? 0) + by; },
    failItem: (item) => { failures.push(item); },
  };
  return { c, counts, failures };
}
const sub = (id: string, next: string | null, over: Record<string, unknown> = {}) => ({
  id, provider_id: "office-1", stripe_subscription_id: `sub_${id}`, status: "active", paused_at: null,
  cancel_at_period_end: false, next_shipment_at: next, livemode: true, ...over,
});

beforeEach(() => { rows.length = 0; notify.mockClear(); });

describe("renewal reminder job", () => {
  it("targets subscriptions exactly the configured days out, reaching a day back for missed runs", () => {
    const { from, to } = reminderWindow(NOW, 3);
    expect(to).toBe("2026-10-12T15:00:00.000Z");
    expect(from).toBe("2026-10-11T15:00:00.000Z");
  });
  it("skips paused, ending, inactive, and out-of-window subscriptions", async () => {
    rows.push(
      sub("due", "2026-10-12T14:00:00.000Z"),
      sub("late-run", "2026-10-11T20:00:00.000Z"),
      sub("too-far", "2026-10-12T16:00:00.000Z"),
      sub("too-soon", "2026-10-10T12:00:00.000Z"),
      sub("paused", "2026-10-12T14:00:00.000Z", { paused_at: "2026-10-01T00:00:00.000Z" }),
      sub("ending", "2026-10-12T14:00:00.000Z", { cancel_at_period_end: true }),
      sub("past-due", "2026-10-12T14:00:00.000Z", { status: "past_due" }),
      sub("unknown-date", null),
    );
    expect((await dueForReminder(NOW, 3)).map((row) => row.id)).toEqual(["due", "late-run"]);
  });
  it("sends one reminder per due subscription with the card on file, and none in dry-run", async () => {
    rows.push(sub("due", "2026-10-12T14:00:00.000Z"));
    const dry = ctx(true);
    await sendRenewalReminders(dry.c);
    expect(notify).not.toHaveBeenCalled();
    expect(dry.counts).toEqual({ due: 1, would_send: 1 });
    const live = ctx(false);
    await sendRenewalReminders(live.c);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][1]).toMatchObject({ card: { last4: "4242" } });
    expect(live.counts).toEqual({ due: 1, sent: 1 });
  });
  it("never reminds a test-mode (sandbox) subscription, even when it is due", async () => {
    rows.push(sub("sandbox", "2026-10-12T14:00:00.000Z", { livemode: false }));
    const live = ctx(false);
    await sendRenewalReminders(live.c);
    expect(notify).not.toHaveBeenCalled();
    expect(live.counts).toEqual({ due: 1, skipped_test: 1 });
  });
});
