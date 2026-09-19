/**
 * warehouse-submit: every 2 minutes, drain pending WarehouseCraft submission
 * intents (paid orders not yet at the warehouse) in small batches under the
 * job lease. Each intent is submitted once per attempt; the outcome (sent,
 * duplicate reconciled by lookup, definite rejection → needs attention with a
 * staff alert, transient → bounded backoff) is recorded by submitOne.
 *
 * The HQ kill switch (billing_settings.warehouse_auto_submit) pauses the drain
 * without touching the queue. Dry runs count what is due and send nothing.
 * Production runs no process timers: this job is reachable from the external
 * tick like every other worker family.
 */
import { selectMany, selectOne } from "../../billing/store";
import { HELD_PREFIX, submitOne, type SubmissionDeps } from "../../billing/warehouse-submissions";
import { warehouseTenantMode } from "../../shipping/warehousecraft";
import { loadInactiveOfficeIds } from "../../lib/office-status";
import type { JobContext, JobDefinition } from "../types";

const MINUTE_MS = 60_000;
export const BATCH_SIZE = 10;
export const MAX_BATCHES = 5;

export interface WarehouseSubmitDeps extends SubmissionDeps {
  /** Overrides the kill-switch read (tests). */
  autoSubmit?: () => Promise<boolean>;
  /** Overrides the offboarding/offboarded office scan (tests). */
  inactiveOffices?: () => Promise<Set<string>>;
}

async function readAutoSubmit(): Promise<boolean> {
  const settings = await selectOne("billing_settings", "id=eq.1&select=warehouse_auto_submit");
  return settings?.warehouse_auto_submit !== false;
}

export async function runWarehouseSubmit(ctx: JobContext, deps: WarehouseSubmitDeps = {}): Promise<void> {
  const enabled = await (deps.autoSubmit ?? readAutoSubmit)();
  const nowIso = ctx.now.toISOString();
  if (!enabled) {
    const waiting = await selectMany("billing_warehouse_submissions", "state=eq.pending&select=id");
    ctx.tally("pausedPending", waiting.length);
    ctx.log("warehouse_submit_paused", { pending: waiting.length });
    return;
  }
  const tenantMode = deps.tenantMode ?? warehouseTenantMode();
  // Rows already held for the live tenant cannot change verdict until the mode flips, so
  // while the connection is still in test mode they stay out of the batch budget entirely.
  const heldFilter = tenantMode === "test" ? `&or=(last_error.is.null,last_error.not.like.${encodeURIComponent(`${HELD_PREFIX}*`)})` : "";
  // Orders of an office leaving THINNR never reach the warehouse from here; HQ settles them by hand.
  const inactiveOffices = await (deps.inactiveOffices ?? loadInactiveOfficeIds)();
  const offboardedFilter = inactiveOffices.size
    ? `&provider_id=not.in.(${[...inactiveOffices].map((id) => encodeURIComponent(`"${id}"`)).join(",")})`
    : "";
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    ctx.checkpoint();
    const due = await selectMany("billing_warehouse_submissions",
      `state=eq.pending&next_attempt_at=lte.${encodeURIComponent(nowIso)}${heldFilter}${offboardedFilter}&order=next_attempt_at.asc,created_at.asc&limit=${BATCH_SIZE}`);
    if (!due.length) break;
    ctx.tally("due", due.length);
    if (ctx.dryRun) { ctx.tally("wouldSubmit", due.length); break; }
    for (const submission of due) {
      if (ctx.leaseLost) return;
      try {
        const priorAttempts = submission.attempts;
        const outcome = await submitOne(submission, { client: deps.client, now: () => ctx.now, tenantMode });
        ctx.tally(outcome, 1);
        if (priorAttempts > 0 && outcome !== "retry" && outcome !== "held") ctx.tally("retriesResolved", 1);
        if (outcome === "rejected" || outcome === "exhausted") ctx.failItem(`order:${submission.order_id}`, new Error(`warehouse ${outcome}`), { reportLocal: true });
      } catch (error) {
        // Store failures: leave the intent as it is; the next drain retries it.
        ctx.failItem(`order:${submission.order_id}`, error);
      }
    }
    if (due.length < BATCH_SIZE) break;
  }
}

export const warehouseSubmitJob: JobDefinition = {
  name: "warehouse-submit",
  title: "Warehouse order submission",
  description: "Sends paid orders to WarehouseCraft (one intent per order, retried with bounded backoff), reconciles duplicate acknowledgements by lookup, and parks definite rejections as Needs attention with a staff alert.",
  intervalMs: 2 * MINUTE_MS,
  leaseSeconds: 4 * 60,
  run: runWarehouseSubmit,
};
