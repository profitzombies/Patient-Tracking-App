/**
 * Explicit, independent vendor sandbox test; never marks an app order paid.
 * Usage: tsx scripts/controlled-warehouse-test.mts prepare|submit|poll /private/state.json
 * State must be prepared from a private input JSON (third argument to prepare):
 * { patient_id, provider_id, address }. No email or notification path is used.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { warehouseTenantMode } from "../src/shipping/warehousecraft";
import { buildWarehouseOrder, callOrderApi, warehouseOrderClient } from "../src/shipping/warehousecraft-orders";
import { parseWarehouseOrderStatus } from "../src/shipping/warehousecraft-status";
import type { ShippingAddress } from "../src/billing/types";

const [action, statePath, inputPath] = process.argv.slice(2);
if (!["prepare", "submit", "poll"].includes(action) || !statePath?.startsWith("/tmp/")) {
  throw new Error("Use prepare|submit|poll with a private /tmp state path.");
}
if (warehouseTenantMode() !== "test") throw new Error("Warehouse is explicitly live; refused.");
type State = {
  reference: string; created_at: string; patient_id: string; provider_id: string;
  address: ShippingAddress; warehouse_id?: number; status?: string; attempted_at?: string;
  payment: "blocked_connected_account_not_chargeable"; scope: "independent_warehouse_test";
};
const save = (state: State, exclusive = false) => {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600, flag: exclusive ? "wx" : "w" });
  const fd = fs.openSync(statePath, "r"); fs.fsyncSync(fd); fs.closeSync(fd);
};
if (action === "prepare") {
  if (!inputPath) throw new Error("Private input required.");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const state: State = {
    reference: `TH-TEST-${crypto.randomBytes(8).toString("hex").toUpperCase()}`,
    created_at: new Date().toISOString(), patient_id: input.patient_id,
    provider_id: input.provider_id, address: input.address,
    payment: "blocked_connected_account_not_chargeable", scope: "independent_warehouse_test",
  };
  if (!state.patient_id || !state.provider_id) throw new Error("Resolved patient and provider required.");
  save(state, true);
  console.log(JSON.stringify({ reference: state.reference, prepared: true }));
} else {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as State;
  if (!/^TH-TEST-[A-F0-9]{16}$/.test(state.reference) || state.scope !== "independent_warehouse_test") {
    throw new Error("Not a controlled sandbox state.");
  }
  // Vendor's initial sandbox confirmation + no reported cutover are explicit
  // operator prerequisites; a local flag alone is not sandbox evidence.
  if (process.env.CONFIRM_VENDOR_SANDBOX_NO_CUTOVER !== "yes") throw new Error("Vendor sandbox confirmation required.");
  const inventory = await callOrderApi("GET", "/api/InventoryDetails?WarehouseId=1");
  if (inventory.status !== 200 || !Array.isArray(inventory.json)) throw new Error("Inventory read failed; no write permitted.");
  const skus = inventory.json.map((row: { SKU?: string }) => row.SKU);
  if (!["Test01", "Test02"].every(sku => skus.includes(sku)) || skus.some(sku => !/^Test0[1-5]$/.test(sku ?? ""))) {
    throw new Error("Tenant inventory contradicts test-only expectation; stopped.");
  }
  let remote = await warehouseOrderClient.lookup(state.reference);
  if (action === "submit" && !remote) {
    if (state.attempted_at) throw new Error("Previous attempt unresolved. Poll by reference; never blindly resubmit.");
    const payload = buildWarehouseOrder({
      order_number: state.reference, paid_at: state.created_at, address: state.address,
      email: null, method: "standard",
      notes: "TEST ONLY / DO NOT FULFILL / NO PHYSICAL SHIPMENT. Independent vendor test; payment blocked, NOT a paid app order. Leave open for TEST tracking updates.",
      lines: ["Test01", "Test02"].map(sku => ({ sku, name: sku, quantity: 1, unit_price_cents: 0 })),
    });
    state.attempted_at = new Date().toISOString();
    save(state); // Persist idempotency reference before any remote mutation.
    const verdict = await warehouseOrderClient.create(payload);
    if (verdict.kind === "rejected") throw new Error("Warehouse rejected controlled test.");
    remote = await warehouseOrderClient.lookup(state.reference);
  }
  if (!remote || remote.client_order_id !== state.reference) throw new Error("Order lookup has not verified this reference.");
  if (remote.lines.length !== 2 || !["Test01", "Test02"].every(sku => remote!.lines.some(line => line.sku === sku && line.quantity === 1))) {
    throw new Error("Remote order lines differ; stopped.");
  }
  state.warehouse_id = remote.order_id; state.status = remote.status; save(state);
  const feed = await callOrderApi("GET", `/api/OrderStatusDatas?clientOrderId=${encodeURIComponent(state.reference)}`);
  const raw = feed.json as Record<string, unknown> | null;
  if (feed.status !== 200 || raw?.ClientOrderId !== state.reference) throw new Error("Shipment feed identity not verified.");
  const shipment = parseWarehouseOrderStatus(raw);
  if (shipment.order_id !== remote.order_id) throw new Error("Shipment feed warehouse ID differs.");
  console.log(JSON.stringify({
    reference: state.reference, warehouse_id: remote.order_id, status: remote.status,
    payment: state.payment, scope: state.scope, feed_http_status: feed.status,
    feed_status: shipment.status, shipped_at: shipment.parcels.find(parcel => parcel.ship_date)?.ship_date ?? null,
    tracking_present: shipment.parcels.some(parcel => Boolean(parcel.tracking_number)),
    patient_linkage: "private run record only; no app paid order",
  }));
}