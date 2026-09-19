/**
 * warehouse-status-sync: every 15 minutes, poll WarehouseCraft's order-status
 * feed for a rolling window (last successful poll minus a two-hour overlap,
 * never less than a week and never more than thirty days back, through
 * tomorrow in the warehouse's clock) and apply what it says to the shipments
 * of orders that were submitted to the warehouse: tracking numbers and
 * carriers as soon as they appear, shipped / delivered / canceled states, and
 * the back-ordered flag. Orders that left the window without a terminal state
 * are followed up by id (bounded per run).
 *
 * Writes go through the shipment write path with source "provider", so the
 * order mirror, audit trail, shipped and delivered emails, and the patient
 * push notice fire once per transition exactly as for a staff write. The
 * event key on the shipment and the forward-only transition guard make
 * re-polling idempotent. Dry runs compute the window and touch nothing.
 * Production runs no process timers: this job is reachable from the external
 * tick like every other worker family.
 */
import { runWarehouseStatusPoll, type SyncDeps } from "../../billing/warehouse-status-sync";
import type { JobContext, JobDefinition } from "../types";

const MINUTE_MS = 60_000;

export async function runWarehouseStatusSync(ctx: JobContext, deps: SyncDeps = {}): Promise<void> {
  await runWarehouseStatusPoll(ctx, deps);
}

export const warehouseStatusSyncJob: JobDefinition = {
  name: "warehouse-status-sync",
  title: "Warehouse status feed",
  description: "Polls WarehouseCraft for order status, tracking numbers, delivery, back orders, and cancellations of submitted orders and applies them to shipments (forward-only, one email per transition).",
  intervalMs: 15 * MINUTE_MS,
  leaseSeconds: 10 * 60,
  run: runWarehouseStatusSync,
};
