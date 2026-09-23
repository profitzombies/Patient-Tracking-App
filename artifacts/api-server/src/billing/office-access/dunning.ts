/**
 * THINNR's own recovery schedule.
 *
 * When every instrument fails, a seven-day clock starts at the moment we were
 * told (for an ACH bounce that is the day the bounce arrived, not the day the
 * debit went out). We re-run the waterfall immediately and then on days 2, 4
 * and 6, and the office is restricted at the end of day 7 if nothing has been
 * collected. A payment at any point clears the clock.
 *
 * All of it is driven from the job tick, never an in-process timer, because
 * production runs no long-lived process timers. Stripe's own dunning is not
 * involved: the engine charges PaymentIntents directly, so there is no
 * subscription or invoice for Smart Retries to act on.
 */
import { selectMany, type BillingOfficeAccessSubscriptionRow as Row } from "../store";
import { chargeAccessPeriod } from "./charge";
import { loadAccessBillingSettings } from "./settings";
import { dueBillingPeriod, isLifetime } from "./state";
import { applyAccessInput, recordAccessEvent, refreshAccessState, SYSTEM_ACTOR } from "./subscription";

const DAY_MS = 86_400_000;

/** Days after the failure notification on which the waterfall runs again. */
export const DUNNING_OFFSET_DAYS: readonly number[] = [0, 2, 4, 6];

/** Cycle 1 is the original billing run, so recovery cycles start at 2. */
export function cycleForOffset(index: number): number {
  return index + 2;
}

/**
 * The recovery cycle that is due at `now`, or null before the first one. Only
 * the latest reached offset is returned: a worker that was down for a day
 * catches up with one attempt, not a burst.
 */
export function dueDunningCycle(graceStartedAt: string, now: Date): { cycle: number; offsetDays: number } | null {
  const started = Date.parse(graceStartedAt);
  if (!Number.isFinite(started)) return null;
  const elapsedDays = (now.getTime() - started) / DAY_MS;
  let due: { cycle: number; offsetDays: number } | null = null;
  DUNNING_OFFSET_DAYS.forEach((offset, index) => {
    if (elapsedDays >= offset) due = { cycle: cycleForOffset(index), offsetDays: offset };
  });
  return due;
}

/** True once the grace window has fully elapsed. */
export function graceElapsed(row: Pick<Row, "grace_ends_at">, now: Date): boolean {
  if (!row.grace_ends_at) return false;
  const ends = Date.parse(row.grace_ends_at);
  return Number.isFinite(ends) && ends <= now.getTime();
}

export interface DunningStep {
  providerId: string;
  action: "charged" | "restricted" | "none";
}

/**
 * Advance one office: restrict it if the window closed, otherwise run the due
 * recovery cycle. The claim RPC makes a repeated cycle a no-op, so running
 * this more often than the schedule changes nothing.
 */
export async function runDunningStep(row: Row, now: Date): Promise<DunningStep> {
  if (!row.grace_started_at) return { providerId: row.provider_id, action: "none" };
  const settings = await loadAccessBillingSettings();

  if (graceElapsed(row, now)) {
    if (row.restricted_at) return { providerId: row.provider_id, action: "none" };
    const result = await applyAccessInput({
      row, input: { kind: "grace_elapsed", at: now }, event: "restricted",
      detail: { graceStartedAt: row.grace_started_at },
    });
    // Trigger point for the restriction notice; the wording lives with the
    // email templates, not here.
    await recordAccessEvent({
      row: result.row, event: "dunning_notice", actor: SYSTEM_ACTOR,
      toState: result.to, detail: { notice: "restricted" },
    });
    return { providerId: row.provider_id, action: "restricted" };
  }

  const due = dueDunningCycle(row.grace_started_at, now);
  if (!due) return { providerId: row.provider_id, action: "none" };
  const period = dueBillingPeriod(row, now);
  if (!period) return { providerId: row.provider_id, action: "none" };
  const outcome = await chargeAccessPeriod({ row, period, cycle: due.cycle, now });
  if (outcome.status === "skipped" && outcome.reason === "already_claimed") {
    return { providerId: row.provider_id, action: "none" };
  }
  await recordAccessEvent({
    row: outcome.row, event: "dunning_notice", actor: SYSTEM_ACTOR,
    detail: {
      notice: outcome.status === "succeeded" ? "recovered" : "retry_failed",
      cycle: due.cycle, offsetDays: due.offsetDays,
      graceEndsAt: row.grace_ends_at ?? null, gracePeriodDays: settings.gracePeriodDays,
    },
  });
  return { providerId: row.provider_id, action: "charged" };
}

/**
 * One pass over every office: renew the ones whose paid access has lapsed and
 * advance the ones inside a recovery window.
 */
export async function runOfficeAccessBilling(ctx: {
  now: Date; dryRun: boolean;
  tally(key: string, by?: number): void;
  failItem(item: string, error: unknown): void;
  checkpoint(): void;
}): Promise<void> {
  const rows = await selectMany("billing_office_access_subscriptions", "order=created_at.asc");
  for (const stored of rows) {
    ctx.checkpoint();
    ctx.tally("scanned");
    if (isLifetime(stored)) continue;
    try {
      if (ctx.dryRun) {
        if (stored.grace_started_at) {
          ctx.tally(graceElapsed(stored, ctx.now) ? "wouldRestrict" : "wouldRetry");
        } else if (dueBillingPeriod(stored, ctx.now)) {
          ctx.tally("wouldCharge");
        }
        continue;
      }
      const row = await refreshAccessState(stored, ctx.now);
      if (row.grace_started_at) {
        const step = await runDunningStep(row, ctx.now);
        if (step.action !== "none") ctx.tally(step.action === "restricted" ? "restricted" : "retried");
        continue;
      }
      if (!dueBillingPeriod(row, ctx.now)) continue;
      const outcome = await chargeAccessPeriod({ row, now: ctx.now });
      if (outcome.status === "succeeded") ctx.tally("charged");
      else if (outcome.status === "processing") ctx.tally("pending");
      else if (outcome.status === "failed") ctx.tally("failed");
    } catch (error) {
      ctx.failItem(stored.provider_id, error);
    }
  }
}
