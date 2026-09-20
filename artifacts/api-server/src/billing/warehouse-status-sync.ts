/**
 * WarehouseCraft status sync: applies what the 3PL's order-status feed says
 * to the shipments of orders that were submitted to the warehouse.
 *
 * - Rows are matched to a `sent` submission by the warehouse order id, then
 *   by ClientOrderId (= our order number). Anything else (other clients' test
 *   orders, orders that never went to the warehouse) is ignored.
 * - The mapping (warehouse-status.ts) turns a row into a shipment state; the
 *   state is written through recordShipment with source "provider" so the
 *   order mirror, audit trail, shipped/delivered emails, and the patient push
 *   notice happen exactly as for a staff write, once per transition.
 * - Idempotency: every row carries an event key; a shipment that already
 *   applied that key is skipped, and the forward-only guard drops anything
 *   older than the shipment's current state, so re-polling an overlapping
 *   window is a no-op and a late duplicate row cannot rewind a later state.
 * - Every poll writes one ledger row (window, rows seen, matched, transitions,
 *   errors). System health reads the ledger; the stalled-feed alert fires
 *   when no poll has succeeded for over an hour.
 */
import { envInt } from "../lib/env";
import { logger } from "../lib/logger";
import type { JobContext } from "../jobs/types";
import { WarehouseCraftError, warehouseCraftConfig } from "../shipping/warehousecraft";
import {
  addDays, warehouseDate, warehouseStatusClient, type WarehouseOrderStatus, type WarehouseStatusClient,
} from "../shipping/warehousecraft-status";
import { notifyOrderShipped } from "./patient-notices";
import { ensureShipment, recordShipment } from "./shipments";
import {
  insert, remove, selectMany, selectOne, update, type BillingOrderRow, type BillingShipmentRow, type BillingWarehouseSubmissionRow,
  type BillingWarehouseSyncPollRow,
} from "./store";
import { raiseWarehouseHqAlert } from "./warehouse-alerts";
import { canTransitionShipment, mapWarehouseStatus, type MappedWarehouseStatus } from "./warehouse-status";

const enc = encodeURIComponent;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** How far back a poll re-reads behind the last successful poll (late rows, clock skew between us and the 3PL). */
export const OVERLAP_MS = 2 * HOUR_MS;
/** A poll always covers at least this many days back, so a shipment reported days after its OrderDate is still seen. */
export const BASELINE_DAYS = 7;
/** Never ask the 3PL for more than this (months-wide windows time out on the tenant). */
export const MAX_WINDOW_DAYS = 30;
/** Per-id follow-ups per run for submitted orders that left the date window without a terminal state. */
export const FOLLOW_UP_LIMIT = 50;
/** Follow-ups stop once a shipped order has been shipped for this long without delivery evidence. */
export const FOLLOW_UP_SHIPPED_DAYS = 21;
/** Poll rows older than this are trimmed by the job. */
export const POLL_RETENTION_DAYS = 7;

export function stalledAfterMs(): number { return envInt("WAREHOUSE_POLL_STALLED_MINUTES", 60) * 60_000; }

export interface PollWindow { start: string; end: string }

/**
 * The date-only window for one poll. Start = the earlier of (last success −
 * overlap) and (now − baseline), never more than MAX_WINDOW_DAYS back; end =
 * the warehouse's calendar date of now plus one day, so a row stamped ahead
 * of our clock is still inside the window. Both bounds are inclusive calendar
 * days in the warehouse's zone.
 */
export function computePollWindow(now: Date, lastSuccessAt: Date | null): PollWindow {
  const baseline = now.getTime() - BASELINE_DAYS * DAY_MS;
  const overlapStart = lastSuccessAt ? lastSuccessAt.getTime() - OVERLAP_MS : baseline;
  const floor = now.getTime() - MAX_WINDOW_DAYS * DAY_MS;
  const start = Math.max(floor, Math.min(baseline, overlapStart));
  return { start: warehouseDate(new Date(start)), end: addDays(warehouseDate(now), 1) };
}

export type ApplyOutcome =
  | "unmatched" | "not_submitted" | "mismatch" | "duplicate" | "unknown_status" | "awaiting_tracking"
  | "stale" | "noted" | "transition" | "tracking_updated";

export interface SyncDeps {
  client?: WarehouseStatusClient;
  now?: () => Date;
}

async function findSubmission(row: WarehouseOrderStatus): Promise<{ submission: BillingWarehouseSubmissionRow; order: BillingOrderRow } | ApplyOutcome> {
  let submission = await selectOne("billing_warehouse_submissions", `warehouse_order_id=eq.${enc(String(row.order_id))}`);
  let order: BillingOrderRow | null = null;
  if (submission) {
    order = await selectOne("billing_orders", `id=eq.${enc(submission.order_id)}`);
    // By-id reads answer for other clients' orders: the ClientOrderId must be ours.
    if (!order || (row.client_order_id && order.order_number !== row.client_order_id)) return "mismatch";
  } else if (row.client_order_id) {
    order = await selectOne("billing_orders", `order_number=eq.${enc(row.client_order_id)}`);
    if (!order) return "unmatched";
    submission = await selectOne("billing_warehouse_submissions", `order_id=eq.${enc(order.id)}`);
    if (!submission) return "not_submitted";
  } else {
    return "unmatched";
  }
  if (order.livemode !== true || submission.state !== "sent") return "not_submitted";
  return { submission, order };
}

function rowSummary(row: WarehouseOrderStatus): Record<string, unknown> {
  return {
    order_id: row.order_id, client_order_id: row.client_order_id, status: row.status, order_date: row.order_date, import_date: row.import_date,
    carrier_code: row.carrier_code, shipping_method: row.shipping_method,
    parcels: row.parcels.map((parcel) => ({ ship_date: parcel.ship_date, deliver_date: parcel.deliver_date, tracking_status: parcel.tracking_status, carrier: parcel.carrier, tracking_number: parcel.tracking_number })),
  };
}

async function noteOnly(shipment: BillingShipmentRow, submission: BillingWarehouseSubmissionRow, mapped: MappedWarehouseStatus, row: WarehouseOrderStatus, at: string, applied: boolean): Promise<void> {
  const patch: Partial<BillingShipmentRow> = { warehouse_status: mapped.raw_status || null, warehouse_synced_at: at, warehouse_last_event: rowSummary(row) };
  if (shipment.warehouse_status !== (mapped.raw_status || null)) patch.warehouse_status_at = at;
  if (applied) patch.warehouse_event_key = mapped.event_key;
  await update("billing_shipments", `id=eq.${enc(shipment.id)}`, patch);
  if (submission.warehouse_status !== (mapped.raw_status || null)) {
    await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, { warehouse_status: mapped.raw_status || null });
  }
}

/**
 * Applies one feed row. Never throws for warehouse content; store failures
 * propagate so the job can record them per order.
 */
export async function applyStatusRow(row: WarehouseOrderStatus, deps: SyncDeps = {}): Promise<ApplyOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const found = await findSubmission(row);
  if (typeof found === "string") return found;
  const { submission, order } = found;
  const shipment = await ensureShipment(order);
  const mapped = mapWarehouseStatus(row);
  if (mapped.event_key === shipment.warehouse_event_key) {
    if (shipment.warehouse_synced_at !== at) await update("billing_shipments", `id=eq.${enc(shipment.id)}`, { warehouse_synced_at: at });
    return "duplicate";
  }
  if (mapped.kind === "unknown") {
    logger.warn({ warehouseOrderId: row.order_id, status: row.status }, "warehouse status not in the mapping table");
    await noteOnly(shipment, submission, mapped, row, at, true);
    return "unknown_status";
  }
  if (mapped.kind === "awaiting_tracking") {
    // Shipped without a tracking number: hold; the next poll sees the upload.
    await noteOnly(shipment, submission, mapped, row, at, false);
    return "awaiting_tracking";
  }
  if (!canTransitionShipment(shipment.status, mapped.status)) {
    // The feed is behind a later state (staff delivered it, or a late row):
    // remember what the warehouse said, never rewind.
    await noteOnly(shipment, submission, mapped, row, at, true);
    return "stale";
  }
  const extra = {
    warehouse_status: mapped.raw_status || null, warehouse_status_at: shipment.warehouse_status === (mapped.raw_status || null) ? shipment.warehouse_status_at ?? at : at,
    warehouse_back_ordered: mapped.back_ordered, warehouse_event_key: mapped.event_key, warehouse_last_event: rowSummary(row), warehouse_synced_at: at,
  };
  if (submission.warehouse_status !== (mapped.raw_status || null)) {
    await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, { warehouse_status: mapped.raw_status || null });
  }
  const sameStatus = shipment.status === mapped.status;
  const trackingChanged = mapped.tracking_number !== null && (mapped.tracking_number !== shipment.tracking_number || (mapped.carrier ?? null) !== (shipment.carrier ?? null));
  if (sameStatus && (mapped.status === "processing" || mapped.status === "canceled" || mapped.status === "delivered" || !trackingChanged)) {
    // Processing → processing (Committed → Being Fulfilled, back order on/off) is bookkeeping, not a transition.
    await update("billing_shipments", `id=eq.${enc(shipment.id)}`, extra);
    if (mapped.back_ordered && !shipment.warehouse_back_ordered) await alertBackOrder(order, mapped.raw_status, now);
    return "noted";
  }
  const previousStatus = shipment.status;
  const result = await recordShipment(order, {
    status: mapped.status, source: "provider", external_id: String(row.order_id),
    // The warehouse is authoritative for tracking once it has it; a processing
    // row never clears staff-entered tracking (recordShipment clears it itself).
    ...(mapped.tracking_number ? { tracking_number: mapped.tracking_number, carrier: mapped.carrier } : {}),
    ...(mapped.shipped_at ? { shipped_at: mapped.shipped_at } : {}),
    ...(mapped.delivered_at ? { delivered_at: mapped.delivered_at } : {}),
    ...(mapped.status === "canceled" ? { canceled_reason: "Canceled at the warehouse." } : {}),
    event: { source: "warehousecraft", key: mapped.event_key, warehouse_status: mapped.raw_status },
    extra,
  });
  if (sameStatus) return "tracking_updated";
  if (mapped.status === "shipped" || (mapped.status === "delivered" && previousStatus === "processing")) {
    await notifyOrderShipped({ order: result.order, shipment: result.shipment });
  }
  if (mapped.status === "canceled") await alertCanceled(order, now);
  if (mapped.back_ordered && !shipment.warehouse_back_ordered) await alertBackOrder(order, mapped.raw_status, now);
  return "transition";
}

async function alertBackOrder(order: BillingOrderRow, rawStatus: string, now: Date): Promise<void> {
  await raiseWarehouseHqAlert({
    key: `${order.id}:${now.toISOString().slice(0, 10)}`, metric: "warehouse_back_order", level: "amber", family: order.order_number,
    title: `Order ${order.order_number} is back-ordered at the warehouse`,
    body: `WarehouseCraft reports order ${order.order_number} as "${rawStatus}". The patient still sees "Preparing your order"; check stock with the warehouse or contact the patient.`,
    data: { order_id: order.id, warehouse_status: rawStatus },
  }, now);
}

async function alertCanceled(order: BillingOrderRow, now: Date): Promise<void> {
  await raiseWarehouseHqAlert({
    key: order.id, metric: "warehouse_canceled", level: "red", family: order.order_number,
    title: `Warehouse canceled order ${order.order_number}`,
    body: `WarehouseCraft canceled paid order ${order.order_number}. Nothing will ship: refund the patient or place the order again from Fulfillment.`,
    data: { order_id: order.id },
  }, now);
}

/** Submitted orders still processing or shipped whose OrderDate predates the window: polled by id so a late ship date is not missed. */
export async function followUpCandidates(window: PollWindow, now: Date, limit = FOLLOW_UP_LIMIT): Promise<Array<{ shipment: BillingShipmentRow; warehouseOrderId: number }>> {
  const shippedFloor = new Date(now.getTime() - FOLLOW_UP_SHIPPED_DAYS * DAY_MS).toISOString();
  const rows = await selectMany("billing_shipments",
    `warehouse_state=eq.sent&status=in.(processing,shipped)&order=created_at.asc&limit=${limit * 4}&select=*`);
  return rows
    .filter((shipment) => shipment.warehouse_order_id && /^\d+$/.test(shipment.warehouse_order_id))
    .filter((shipment) => (shipment.warehouse_sent_at ?? shipment.created_at) < `${window.start}T00:00:00.000Z`)
    .filter((shipment) => shipment.status !== "shipped" || (shipment.shipped_at ?? shipment.created_at) >= shippedFloor)
    .slice(0, limit)
    .map((shipment) => ({ shipment, warehouseOrderId: Number(shipment.warehouse_order_id) }));
}

export interface PollSummary {
  window: PollWindow;
  rows_seen: number;
  matched: number;
  transitions: number;
  errors: number;
  outcomes: Partial<Record<ApplyOutcome, number>>;
}

/** Last successful poll instant, from the ledger. */
export async function lastSuccessfulPollAt(): Promise<Date | null> {
  const row = await selectOne("billing_warehouse_sync_polls", "ok=eq.true&order=started_at.desc&select=started_at,finished_at");
  return row ? new Date(row.finished_at ?? row.started_at) : null;
}

/**
 * One poll under the job lease: date window, then per-id follow-ups. Feed
 * failures fail the poll (recorded on the ledger row); per-row store failures
 * are counted and reported per order without aborting the run.
 */
export async function runWarehouseStatusPoll(ctx: JobContext, deps: SyncDeps = {}): Promise<PollSummary | null> {
  const client = deps.client ?? warehouseStatusClient;
  const config = warehouseCraftConfig();
  if (!deps.client && (!config.orderApiBaseUrl || !config.authorization)) {
    ctx.tally("unconfigured", 1);
    ctx.log("warehouse_status_sync_unconfigured");
    return null;
  }
  const now = ctx.now;
  const window = computePollWindow(now, await lastSuccessfulPollAt());
  const summary: PollSummary = { window, rows_seen: 0, matched: 0, transitions: 0, errors: 0, outcomes: {} };
  const count = (outcome: ApplyOutcome) => {
    summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
    ctx.tally(outcome, 1);
    if (outcome !== "unmatched" && outcome !== "not_submitted" && outcome !== "mismatch") summary.matched += 1;
    if (outcome === "transition") summary.transitions += 1;
  };
  if (ctx.dryRun) {
    ctx.log("warehouse_status_sync_dry_run", { window });
    return summary;
  }
  const poll = await insert("billing_warehouse_sync_polls", { started_at: now.toISOString(), ok: false, window_start: window.start, window_end: window.end } as Partial<BillingWarehouseSyncPollRow>);
  const finish = async (ok: boolean, error: string | null) => {
    await update("billing_warehouse_sync_polls", `id=eq.${enc(poll.id)}`, {
      finished_at: new Date().toISOString(), ok, rows_seen: summary.rows_seen, matched: summary.matched, transitions: summary.transitions, errors: summary.errors, error,
    });
  };
  const apply = async (row: WarehouseOrderStatus) => {
    try {
      count(await applyStatusRow(row, { now: () => ctx.now }));
    } catch (error) {
      summary.errors += 1;
      ctx.failItem(`warehouse:${row.order_id}`, error);
    }
  };
  try {
    ctx.checkpoint();
    const rows = await client.byDate(window.start, window.end);
    summary.rows_seen = rows.length;
    ctx.tally("rowsSeen", rows.length);
    const seen = new Set<number>();
    for (const row of rows) {
      if (ctx.leaseLost) break;
      seen.add(row.order_id);
      await apply(row);
    }
    ctx.checkpoint();
    const followUps = (await followUpCandidates(window, now)).filter((candidate) => !seen.has(candidate.warehouseOrderId));
    ctx.tally("followUps", followUps.length);
    for (const candidate of followUps) {
      if (ctx.leaseLost) break;
      try {
        const row = await client.byId(candidate.warehouseOrderId);
        if (!row) { ctx.tally("followUpMissing", 1); continue; }
        summary.rows_seen += 1;
        await apply(row);
      } catch (error) {
        if (error instanceof WarehouseCraftError && error.kind !== "transient") { summary.errors += 1; ctx.failItem(`warehouse:${candidate.warehouseOrderId}`, error); continue; }
        throw error;
      }
    }
    await finish(true, null);
    await remove("billing_warehouse_sync_polls", `started_at=lt.${enc(new Date(now.getTime() - POLL_RETENTION_DAYS * DAY_MS).toISOString())}`);
    ctx.log("warehouse_status_sync", { window, ...summary.outcomes, rows_seen: summary.rows_seen, transitions: summary.transitions, errors: summary.errors });
    return summary;
  } catch (error) {
    summary.errors += 1;
    await finish(false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export interface WarehouseSyncHealth {
  /** The last poll that succeeded; null when none has. */
  last_success_at: string | null;
  last_poll_at: string | null;
  last_error: string | null;
  /** Window of the most recent poll. */
  last_window: PollWindow | null;
  rows_seen_24h: number;
  transitions_24h: number;
  errors_24h: number;
  polls_24h: number;
  failed_polls_24h: number;
  /** True once no poll has succeeded for longer than the stalled threshold (only after at least one poll ran). */
  stalled: boolean;
  stalled_after_minutes: number;
  /** Submitted orders currently flagged back-ordered by the warehouse. */
  back_ordered: number;
  /** Submitted orders the feed reports shipped but without a tracking number yet. */
  awaiting_tracking: number;
}

/** Feed freshness for System health and the stalled-feed threshold. */
export async function warehouseSyncHealth(now: Date): Promise<WarehouseSyncHealth> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const [latest, lastOk, recent, backOrdered, awaiting] = await Promise.all([
    selectOne("billing_warehouse_sync_polls", "order=started_at.desc&select=*"),
    selectOne("billing_warehouse_sync_polls", "ok=eq.true&order=started_at.desc&select=started_at,finished_at"),
    selectMany("billing_warehouse_sync_polls", `started_at=gte.${enc(since)}&select=ok,rows_seen,transitions,errors`),
    selectMany("billing_shipments", "warehouse_state=eq.sent&warehouse_back_ordered=eq.true&status=eq.processing&select=id"),
    selectMany("billing_shipments", "warehouse_state=eq.sent&status=eq.processing&warehouse_status=in.(Shipped,Closed,shipped,closed)&select=id"),
  ]);
  const threshold = stalledAfterMs();
  const lastSuccess = lastOk ? new Date(lastOk.finished_at ?? lastOk.started_at) : null;
  const stalled = Boolean(latest) && (!lastSuccess || now.getTime() - lastSuccess.getTime() > threshold);
  return {
    last_success_at: lastSuccess ? lastSuccess.toISOString() : null,
    last_poll_at: latest ? latest.started_at : null,
    last_error: latest && !latest.ok ? latest.error : null,
    last_window: latest ? { start: latest.window_start, end: latest.window_end } : null,
    rows_seen_24h: recent.reduce((sum, row) => sum + (row.rows_seen ?? 0), 0),
    transitions_24h: recent.reduce((sum, row) => sum + (row.transitions ?? 0), 0),
    errors_24h: recent.reduce((sum, row) => sum + (row.errors ?? 0), 0),
    polls_24h: recent.length, failed_polls_24h: recent.filter((row) => !row.ok).length,
    stalled, stalled_after_minutes: Math.round(threshold / 60_000),
    back_ordered: backOrdered.length, awaiting_tracking: awaiting.length,
  };
}
