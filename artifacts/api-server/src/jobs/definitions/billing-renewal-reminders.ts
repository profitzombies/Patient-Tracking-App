import { notifyRenewalReminder, renewalReminderDays } from "../../billing/customer-emails";
import { accountFor } from "../../billing/subscriptions";
import { connectedOpts, getStripe } from "../../billing/stripe-client";
import { selectMany, type BillingSubscriptionRow } from "../../billing/store";
import { loadInactiveOfficeIds } from "../../lib/office-status";
import type { JobContext, JobDefinition } from "../types";
import { forEachBillingScope } from "../../billing/lifecycle-scopes";

/**
 * Emails patients a fixed number of days before a subscription's next shipment
 * is charged. The reminder is keyed on the subscription AND the shipment date,
 * so each upcoming shipment earns exactly one email no matter how often the
 * job runs, and a moved date earns a fresh one.
 */
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Active, unpaused, not-ending subscriptions whose next shipment falls inside the reminder window. */
export function reminderWindow(now: Date, days: number): { from: string; to: string } {
  // The first hourly run at which the shipment is `days` days away (or less)
  // sends; the window reaches a day back so a missed run still catches up,
  // and the date-keyed claim absorbs overlap between runs.
  const target = now.getTime() + days * DAY_MS;
  return { from: new Date(target - DAY_MS).toISOString(), to: new Date(target).toISOString() };
}

export async function dueForReminder(now: Date, days: number): Promise<BillingSubscriptionRow[]> {
  const { from, to } = reminderWindow(now, days);
  const enc = encodeURIComponent;
  return selectMany("billing_subscriptions",
    `status=eq.active&paused_at=is.null&cancel_at_period_end=is.false&next_shipment_at=gte.${enc(from)}&next_shipment_at=lte.${enc(to)}&order=next_shipment_at.asc&limit=500`);
}

async function defaultCard(row: BillingSubscriptionRow): Promise<any> {
  if (!row.stripe_subscription_id) return null;
  try {
    const account = await accountFor(row.provider_id);
    const live: any = await (await getStripe()).subscriptions.retrieve(
      row.stripe_subscription_id, { expand: ["default_payment_method", "customer.invoice_settings.default_payment_method"] } as any,
      connectedOpts(account.stripe_account_id),
    );
    return live.default_payment_method ?? live.customer?.invoice_settings?.default_payment_method ?? null;
  } catch {
    return null;
  }
}

export async function sendRenewalReminders(ctx: JobContext): Promise<void> {
  const days = renewalReminderDays();
  const due = await dueForReminder(ctx.now, days);
  ctx.tally("due", due.length);
  // Offices leaving THINNR send no renewal reminders; their subscriptions are wound down by HQ.
  const inactiveOffices = due.length ? await loadInactiveOfficeIds() : new Set<string>();
  for (const row of due) {
    ctx.checkpoint();
    if (row.livemode !== true) { ctx.tally("skipped_test"); continue; }
    if (inactiveOffices.has(row.provider_id)) { ctx.tally("skipped_offboarded"); continue; }
    if (ctx.dryRun) { ctx.tally("would_send"); continue; }
    try {
      const outcome = await notifyRenewalReminder(row, await defaultCard(row));
      ctx.tally(outcome);
    } catch (error) {
      ctx.failItem(`subscription:${row.id}`, error);
    }
  }
}

export const billingRenewalRemindersJob: JobDefinition = {
  name: "billing-renewal-reminders",
  title: "Subscription renewal reminders",
  description: "Emails patients a few days before each subscription shipment is charged, with skip and manage links.",
  intervalMs: 60 * MINUTE_MS,
  leaseSeconds: 10 * 60,
  run: (ctx) => forEachBillingScope(() => sendRenewalReminders(ctx), ["live"]),
};
