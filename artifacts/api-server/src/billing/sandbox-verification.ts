/**
 * Per-order sandbox verification allowance.
 *
 * Stripe TEST (sandbox) orders are never submitted to the warehouse, never
 * status-synced, and never email or push anybody: the lifecycle jobs run in
 * the LIVE billing scope only and every outbound seam checks `livemode`.
 * End-to-end verification of the checkout → warehouse → tracking → email chain
 * needs one deliberately narrow exception. It opens only when BOTH hold:
 *
 *   1. the warehouse connection points at the SANDBOX tenant
 *      (warehouseTenantMode() is "test": no live flag, or a live flag without
 *      the complete live login), and
 *   2. an explicit, time-bounded verification row names THIS order id.
 *
 * Everything else is unchanged: a live-tenant connection never sends a sandbox
 * order (flagged or not); an unflagged sandbox order is skipped exactly as
 * before; a real (live-mode) order is never subject to this allowance and stays
 * held until the live tenant is configured. Emails for a flagged order go to
 * the row's designated test inbox, never to the payer. Lookups fail closed:
 * any store error means "no allowance".
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import { logger } from "../lib/logger";
import { warehouseTenantMode, type WarehouseTenantMode } from "../shipping/warehousecraft";
import { forEachBillingScope } from "./lifecycle-scopes";
import { currentBillingIdentity } from "./stripe-environment";
import type { BillingOrderRow } from "./store";

export const SANDBOX_VERIFICATION_TABLE = "billing_sandbox_verifications";
/** Longest a verification row may stay open; the runner asks for far less. */
export const SANDBOX_VERIFICATION_MAX_HOURS = 12;

export interface SandboxVerificationRow {
  order_id: string;
  designated_inbox: string;
  authorized_by: string;
  note: string | null;
  created_at: string;
  expires_at: string;
}

let rowsForTests: SandboxVerificationRow[] | null = null;
/** Unit tests hand the module its rows; null restores the store lookup. */
export function __setSandboxVerificationsForTests(rows: SandboxVerificationRow[] | null): void {
  rowsForTests = rows;
}

function isActive(row: SandboxVerificationRow, now: Date): boolean {
  return typeof row.designated_inbox === "string" && row.designated_inbox.includes("@")
    && typeof row.expires_at === "string" && new Date(row.expires_at).getTime() > now.getTime();
}

async function loadRows(filter: string): Promise<SandboxVerificationRow[]> {
  if (rowsForTests) return rowsForTests;
  try {
    const result = await supabaseAdmin("GET", `/rest/v1/${SANDBOX_VERIFICATION_TABLE}?select=*${filter}`);
    if (result.status !== 200 || !Array.isArray(result.json)) return [];
    return result.json as SandboxVerificationRow[];
  } catch (error) {
    logger.warn({ err: error }, "sandbox verification lookup failed; treating as absent");
    return [];
  }
}

/** True when the process could honour a verification at all (cheap, synchronous). */
export function sandboxVerificationPossible(tenantMode: WarehouseTenantMode = warehouseTenantMode()): boolean {
  if (tenantMode !== "test") return false;
  const identity = currentBillingIdentity();
  return !identity || identity.mode === "test";
}

/**
 * The active allowance for one order, or null. Real (live-mode) orders always
 * get null: this path exists for Stripe sandbox orders only.
 */
export async function sandboxVerificationFor(
  order: Pick<BillingOrderRow, "id" | "livemode">,
  opts: { tenantMode?: WarehouseTenantMode; now?: Date } = {},
): Promise<SandboxVerificationRow | null> {
  if (order.livemode === true) return null;
  if (!sandboxVerificationPossible(opts.tenantMode ?? warehouseTenantMode())) return null;
  const now = opts.now ?? new Date();
  const rows = await loadRows(`&order_id=eq.${encodeURIComponent(order.id)}`);
  const row = rows.find((candidate) => candidate.order_id === order.id);
  return row && isActive(row, now) ? row : null;
}

/** Ids of every order with an open allowance; empty unless the sandbox tenant is configured. */
export async function activeSandboxVerificationOrderIds(now = new Date(), tenantMode: WarehouseTenantMode = warehouseTenantMode()): Promise<string[]> {
  if (tenantMode !== "test") return [];
  const rows = await loadRows(`&expires_at=gt.${encodeURIComponent(now.toISOString())}`);
  return rows.filter((row) => isActive(row, now)).map((row) => row.order_id);
}

/**
 * Runs `work` once in the TEST billing scope, restricted to the flagged order
 * ids, and only when at least one allowance is open under the sandbox tenant.
 * Lifecycle jobs call this after their normal live-scope pass.
 */
export async function forEachSandboxVerificationScope(work: (orderIds: string[]) => Promise<void>, now = new Date()): Promise<void> {
  const orderIds = await activeSandboxVerificationOrderIds(now);
  if (!orderIds.length) return;
  await forEachBillingScope(() => work(orderIds), ["test"]);
}

/** PostgREST `in.(...)` filter fragment for a set of order ids. */
export function orderIdFilter(column: string, orderIds: readonly string[] | undefined): string {
  if (!orderIds?.length) return "";
  return `&${column}=in.(${orderIds.map((id) => encodeURIComponent(`"${id}"`)).join(",")})`;
}
