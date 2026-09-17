import crypto from "node:crypto";
import { normalizeIdentifier } from "../claim/normalize";
import { deliverSmsRegistered, registerSend, checkCode } from "../routes/auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { BillingCartError, checkoutCart } from "./cart";
import { officeOffering } from "./catalog";
import { getPublishableKey, isSandbox } from "./stripe-client";
import { insert, selectMany, selectOne, update, type BillingOrderRow, type BillingPayerRow, type BillingPrebuiltCartRow } from "./store";
import { getProvider, officeName } from "./store-orders";
import { publicOrigin } from "./app-origin";
import { loadRowById, sha256 } from "../auth/ledger";
import type {
  CartCheckoutResponse, CartLineInput, CartQuote, PrebuiltCart, PrebuiltCartStatus,
  PublicCartDetails, PublicCartPeek, PublicCartStatus, ShippingAddress,
} from "./types";

const enc = encodeURIComponent;
export class PrebuiltCartError extends Error {
  attempts_left?: number;
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}
type Patient = { id: string; first_name?: string | null; last_name?: string | null; name?: string | null; email?: string | null; phone?: string | null };
function patientName(row: Patient): string {
  return row.name?.trim() || `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Patient";
}
export async function cartPatient(providerId: string, patientId: string): Promise<Patient | null> {
  const result = await supabaseAdmin("GET", `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}&select=id,first_name,last_name,name,email,phone&limit=1`);
  if (result.status >= 300) throw new PrebuiltCartError("Could not load that patient.", 502);
  return Array.isArray(result.json) ? result.json[0] as Patient ?? null : null;
}
function derivedCartId(id: string, attempt: number): string {
  const digest = crypto.createHash("sha256").update(`prebuilt:${id}:attempt:${attempt}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
const PAID_ORDER_STATUSES = new Set(["paid", "partially_refunded", "refunded", "disputed"]);
async function rawOrders(row: BillingPrebuiltCartRow): Promise<BillingOrderRow[]> {
  return row.cart_id ? selectMany("billing_orders", `cart_id=eq.${enc(row.cart_id)}&order=created_at.asc`) : [];
}
function expectedGroups(row: BillingPrebuiltCartRow): number {
  const groups = (row.quote as { groups?: unknown })?.groups;
  return Array.isArray(groups) ? groups.length : 0;
}
function paymentState(row: BillingPrebuiltCartRow, rows: Awaited<ReturnType<typeof rawOrders>>) {
  const expected = expectedGroups(row);
  const paid = rows.filter((order) => PAID_ORDER_STATUSES.has(order.status)).length;
  const failed = rows.filter((order) => order.status === "failed").length;
  return { expected, paid, failed, complete: expected > 0 && paid >= expected, partial: paid > 0 && paid < expected };
}
async function reread(id: string): Promise<BillingPrebuiltCartRow> {
  const latest = await selectOne("billing_prebuilt_carts", `id=eq.${enc(id)}`);
  if (!latest) throw new PrebuiltCartError("Cart not found.", 404);
  return latest;
}
function requireUsable(status: PrebuiltCartStatus): void {
  if (status === "locked") throw new PrebuiltCartError("This cart is locked. Please ask the office to create another.", 423);
  if (["expired", "paid", "revoked"].includes(status)) throw new PrebuiltCartError("This cart is no longer available.", 410);
}
async function lostTransition(row: BillingPrebuiltCartRow): Promise<never> {
  const latest = await reread(row.id);
  requireUsable(await effectiveStatus(latest));
  throw new PrebuiltCartError("This cart changed while the request was being processed. Try again.", 409);
}
export async function effectiveStatus(row: BillingPrebuiltCartRow): Promise<PrebuiltCartStatus> {
  if (["paid", "revoked", "expired", "locked"].includes(row.status)) return row.status;
  const rows = await rawOrders(row);
  const state = paymentState(row, rows);
  if (state.complete) {
    const paidAt = rows.filter((order) => PAID_ORDER_STATUSES.has(order.status))
      .map((order) => order.paid_at).filter(Boolean).sort().at(-1) ?? new Date().toISOString();
    const changed = await update("billing_prebuilt_carts", `id=eq.${enc(row.id)}&status=eq.${enc(row.status)}`, {
      status: "paid", paid_at: paidAt,
    });
    return changed ? "paid" : (await reread(row.id)).status;
  }
  if (["open", "verified"].includes(row.status) && Date.parse(row.expires_at) <= Date.now()) {
    const changed = await update("billing_prebuilt_carts",
      `id=eq.${enc(row.id)}&status=eq.${row.status}&expires_at=lte.${enc(new Date().toISOString())}`,
      { status: "expired", session_hash: null });
    return changed ? "expired" : (await reread(row.id)).status;
  }
  return row.status;
}
async function orders(row: BillingPrebuiltCartRow) {
  return (await rawOrders(row)).map((order) => ({
    order_id: order.id, order_number: order.order_number,
    kind: order.kind === "one_time" ? "one_time" as const : "subscription" as const, status: order.status,
  }));
}
export async function toPrebuiltCart(row: BillingPrebuiltCartRow): Promise<PrebuiltCart> {
  const status = await effectiveStatus(row);
  const current = status === "paid" && row.status !== "paid" ? await reread(row.id) : row;
  const [person, cartOrders, paymentRows] = await Promise.all([
    current.patient_id ? cartPatient(current.provider_id, current.patient_id) : null, orders(current), rawOrders(current),
  ]);
  return {
    id: current.id, token: current.token, url: `${publicOrigin()}/pay/cart/${current.token}`, status, partial: paymentState(current, paymentRows).partial,
    patient: person ? { id: person.id, name: patientName(person) } : null,
    lines: current.lines as CartLineInput[], quote: current.quote as unknown as CartQuote, label: current.label,
    expires_at: current.expires_at, created_at: current.created_at, paid_at: current.paid_at, orders: cartOrders,
  };
}
export async function createPrebuiltCart(providerId: string, actor: string, input: {
  patient_id?: string | null; lines: CartLineInput[]; quote: CartQuote; label?: string | null; expires_in_minutes?: number;
}): Promise<PrebuiltCart> {
  if (input.patient_id && !(await cartPatient(providerId, input.patient_id))) throw new PrebuiltCartError("Patient not found.", 404, "patient_id");
  const minutes = input.expires_in_minutes ?? 30;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new PrebuiltCartError("Expiry must be between 5 and 1440 minutes.", 400, "expires_in_minutes");
  const row = await insert("billing_prebuilt_carts", {
    token: crypto.randomBytes(24).toString("base64url"), provider_id: providerId, patient_id: input.patient_id ?? null,
    created_by_user_id: actor, label: input.label?.trim() || null, lines: input.lines, quote: input.quote as unknown as Record<string, unknown>,
    expires_at: new Date(Date.now() + minutes * 60_000).toISOString(),
  });
  return toPrebuiltCart(row);
}
export async function getPrebuiltCart(providerId: string, id: string): Promise<PrebuiltCart> {
  const row = await selectOne("billing_prebuilt_carts", `id=eq.${enc(id)}&provider_id=eq.${enc(providerId)}`);
  if (!row) throw new PrebuiltCartError("Cart not found.", 404);
  return toPrebuiltCart(row);
}
export async function listPrebuiltCarts(providerId: string, filters: { patient_id?: string; status?: string }): Promise<PrebuiltCart[]> {
  let query = `provider_id=eq.${enc(providerId)}`;
  if (filters.patient_id) query += `&patient_id=eq.${enc(filters.patient_id)}`;
  if (filters.status) query += `&status=eq.${enc(filters.status)}`;
  const rows = await selectMany("billing_prebuilt_carts", `${query}&order=created_at.desc&limit=50`);
  return Promise.all(rows.map(toPrebuiltCart));
}
export async function revokePrebuiltCart(providerId: string, id: string): Promise<PrebuiltCart> {
  const current = await selectOne("billing_prebuilt_carts", `id=eq.${enc(id)}&provider_id=eq.${enc(providerId)}`);
  if (!current) throw new PrebuiltCartError("Cart not found.", 404);
  if (await effectiveStatus(current) === "paid") return toPrebuiltCart(await reread(current.id));
  const row = await update("billing_prebuilt_carts",
    `id=eq.${enc(id)}&provider_id=eq.${enc(providerId)}&status=in.(open,verified,checkout)`,
    { status: "revoked", session_hash: null });
  if (row) return toPrebuiltCart(row);
  const latest = await reread(current.id);
  return toPrebuiltCart(latest);
}
async function byToken(token: string): Promise<BillingPrebuiltCartRow> {
  const row = await selectOne("billing_prebuilt_carts", `token=eq.${enc(token)}`);
  if (!row) throw new PrebuiltCartError("Cart not found.", 404);
  return row;
}
function publicStatus(status: PrebuiltCartStatus): PublicCartPeek["status"] {
  if (status === "paid") return "used";
  if (status === "checkout" || status === "failed") return "verified";
  return status;
}
export async function publicCartPeek(token: string): Promise<PublicCartPeek> {
  const row = await byToken(token);
  const [provider, sandbox, status] = await Promise.all([getProvider(row.provider_id), isSandbox(), effectiveStatus(row)]);
  if (!provider) throw new PrebuiltCartError("Cart not found.", 404);
  return { status: publicStatus(status), office: { name: officeName(provider) }, sandbox };
}
export async function startCartPhone(token: string, rawPhone: unknown): Promise<{ request_id: string; devCode?: string }> {
  const row = await byToken(token);
  requireUsable(await effectiveStatus(row));
  if (row.status !== "open") throw new PrebuiltCartError("This cart has already been verified.", 409);
  const now = new Date().toISOString();
  const phone = normalizeIdentifier(rawPhone);
  if (!phone || phone.kind !== "phone") throw new PrebuiltCartError("Enter a valid phone number.", 400, "phone");
  const person = row.patient_id ? await cartPatient(row.provider_id, row.patient_id) : null;
  const stored = person ? normalizeIdentifier(person.phone) : null;
  if (person && (!stored || stored.kind !== "phone" || stored.last10 !== phone.last10)) {
    const attempts = Math.min(5, row.phone_attempts + 1);
    const changed = await update("billing_prebuilt_carts",
      `id=eq.${enc(row.id)}&status=eq.open&phone_attempts=eq.${row.phone_attempts}&expires_at=gt.${enc(now)}`, {
      phone_attempts: attempts, ...(attempts >= 5 ? { status: "locked" as const, session_hash: null } : {}),
    });
    if (!changed) return lostTransition(row);
    if (attempts >= 5) throw new PrebuiltCartError("This cart is locked. Please ask the office to create another.", 423);
    const error = new PrebuiltCartError("That number doesn't match the patient on file.", 400);
    error.attempts_left = 5 - attempts;
    throw error;
  }
  const sent = await registerSend({ purpose: "cart_pay", identifier: phone, accountType: null, candidates: [], scopeKey: `cart:${row.id}`, scopeMaxPerHour: 5 });
  if (!sent) throw new PrebuiltCartError("Too many verification codes were requested. Please wait and try again.", 429);
  await deliverSmsRegistered(sent.row);
  const changed = await update("billing_prebuilt_carts",
    `id=eq.${enc(row.id)}&status=eq.open&expires_at=gt.${enc(now)}`, { verification_id: sent.row.id });
  if (!changed) return lostTransition(row);
  return { request_id: sent.row.id, ...(sent.localCode ? { devCode: sent.localCode } : {}) };
}
export async function verifyCartCode(token: string, requestId: unknown, code: unknown): Promise<{ session: string }> {
  const row = await byToken(token);
  requireUsable(await effectiveStatus(row));
  if (row.status !== "open") throw new PrebuiltCartError("This cart has already been verified.", 409);
  if (row.verification_id !== requestId || !(await checkCode("cart_pay", requestId, code))) {
    throw new PrebuiltCartError("That code didn't match or has expired. Check it and try again.", 400);
  }
  const session = crypto.randomBytes(32).toString("base64url");
  const changed = await update("billing_prebuilt_carts",
    `id=eq.${enc(row.id)}&status=eq.open&verification_id=eq.${enc(String(requestId))}&expires_at=gt.${enc(new Date().toISOString())}`, {
    session_hash: sha256(session), verified_at: new Date().toISOString(), status: "verified",
  });
  if (!changed) return lostTransition(row);
  return { session };
}
export async function requireCartSession(token: string, session: unknown): Promise<BillingPrebuiltCartRow> {
  const row = await byToken(token);
  requireUsable(await effectiveStatus(row));
  if (typeof session !== "string" || !row.session_hash || sha256(session) !== row.session_hash) throw new PrebuiltCartError("Verify your phone to continue.", 401);
  return row;
}
export async function publicCartDetails(token: string, session: unknown): Promise<PublicCartDetails> {
  const row = await requireCartSession(token, session);
  const [provider, person, products, account, settings, defaultOrder, sandbox, publishableKey] = await Promise.all([
    getProvider(row.provider_id), row.patient_id ? cartPatient(row.provider_id, row.patient_id) : null,
    officeOffering(row.provider_id), selectOne("billing_connected_accounts", `provider_id=eq.${enc(row.provider_id)}&disconnected_at=is.null`),
    selectOne("billing_settings", "id=eq.1"),
    row.patient_id ? selectOne("billing_orders", `patient_id=eq.${enc(row.patient_id)}&provider_id=eq.${enc(row.provider_id)}&order=created_at.desc`) : null,
    isSandbox(), getPublishableKey(),
  ]);
  if (!provider || !account?.charges_enabled || !settings) throw new PrebuiltCartError("This office is not ready to accept payments.", 409);
  const wanted = new Set((row.lines as CartLineInput[]).map((line) => line.product_id));
  return {
    office: { name: officeName(provider), city: provider.city, state: provider.state },
    patient: person ? { name: patientName(person), email: person.email ?? null, phone: person.phone ?? null } : null,
    lines: (row.quote as unknown as CartQuote).lines, quote: row.quote as unknown as CartQuote,
    products: products.filter((product) => wanted.has(product.product_id)),
    default_address: (defaultOrder?.shipping_address as unknown as ShippingAddress | undefined) ?? null,
    shipping_charge_cents: settings.shipping_charge_cents, tax_enabled: account.tax_enabled,
    stripe_account_id: account.stripe_account_id, publishable_key: publishableKey, sandbox, expires_at: row.expires_at,
  };
}
async function resolveGuestPayer(
  providerId: string, verifiedPhone: string, input: { name: string; email: string; phone: string } | undefined,
): Promise<BillingPayerRow> {
  if (!input?.name.trim() || !input.email.trim()) throw new PrebuiltCartError("Enter payer details.", 400, "payer");
  const existing = await selectOne("billing_payers",
    `provider_id=eq.${enc(providerId)}&patient_id=is.null&phone=eq.${enc(verifiedPhone)}&order=created_at.asc`);
  if (existing) return existing;
  return insert("billing_payers", {
    provider_id: providerId, patient_id: null, name: input.name.trim(), email: input.email.trim().toLowerCase(),
    phone: verifiedPhone, stripe_customer_id: null,
  });
}
async function hasPaidOrder(cartId: string): Promise<boolean> {
  return Boolean(await selectOne("billing_orders",
    `cart_id=eq.${enc(cartId)}&status=in.(paid,partially_refunded,refunded,disputed)`));
}
async function bumpFailedAttempt(
  row: BillingPrebuiltCartRow, sessionHash: string, cartId: string,
): Promise<void> {
  if (await hasPaidOrder(cartId)) return;
  const changed = await update("billing_prebuilt_carts",
    `id=eq.${enc(row.id)}&status=eq.checkout&checkout_attempt=eq.${row.checkout_attempt}&session_hash=eq.${enc(sessionHash)}`, {
      status: "verified", checkout_attempt: row.checkout_attempt + 1, cart_id: null,
    });
  if (!changed) await lostTransition(row);
}
async function markPaidIfComplete(
  row: BillingPrebuiltCartRow, sessionHash: string,
): Promise<void> {
  const rows = await rawOrders(row);
  const state = paymentState(row, rows);
  if (!state.complete) return;
  const paidAt = rows.filter((order) => PAID_ORDER_STATUSES.has(order.status))
    .map((order) => order.paid_at).filter(Boolean).sort().at(-1) ?? new Date().toISOString();
  const changed = await update("billing_prebuilt_carts",
    `id=eq.${enc(row.id)}&status=in.(checkout,verified)&session_hash=eq.${enc(sessionHash)}`, {
      status: "paid", paid_at: paidAt,
    });
  if (!changed) await lostTransition(row);
}
export async function checkoutPrebuiltCart(token: string, session: unknown, input: {
  shipping_address: ShippingAddress; payment_method_id: string; payer?: { name: string; email: string; phone: string };
}): Promise<CartCheckoutResponse> {
  const row = await requireCartSession(token, session);
  if (row.status !== "verified" && row.status !== "checkout") throw new PrebuiltCartError("This cart is not ready for checkout.", 409);
  const sessionHash = sha256(String(session));
  const verification = row.verification_id ? await loadRowById(row.verification_id) : null;
  if (!row.patient_id && (!verification?.verified_at || verification.purpose !== "cart_pay" || verification.identifier_kind !== "phone")) {
    throw new PrebuiltCartError("Verify your phone to continue.", 401);
  }
  const resolvedPayer = row.patient_id ? undefined : await resolveGuestPayer(row.provider_id, verification!.identifier, input.payer);
  const cartId = row.cart_id ?? derivedCartId(row.id, row.checkout_attempt);
  const active = await update("billing_prebuilt_carts",
    `id=eq.${enc(row.id)}&status=in.(verified,checkout)&session_hash=eq.${enc(sessionHash)}&expires_at=gt.${enc(new Date().toISOString())}`,
    { status: "checkout", cart_id: cartId });
  if (!active) return lostTransition(row);
  try {
    const result = await checkoutCart({
      patientId: row.patient_id, providerId: row.provider_id, cartId, lines: row.lines as CartLineInput[],
      shipping_address: input.shipping_address, payment_method_id: input.payment_method_id, resolvedPayer,
    });
    if (result.status === "paid") await markPaidIfComplete(active, sessionHash);
    else if (result.status === "failed") await bumpFailedAttempt(active, sessionHash, cartId);
    return result;
  } catch (error) {
    if (error instanceof BillingCartError && (error.field === "payment_method_id" || error.status === 402)) {
      await bumpFailedAttempt(active, sessionHash, cartId);
    }
    throw error;
  }
}
export async function publicCartCheckoutStatus(token: string, session: unknown): Promise<PublicCartStatus> {
  const row = await byToken(token);
  if (Date.parse(row.expires_at) <= Date.now()) throw new PrebuiltCartError("This cart is no longer available.", 410);
  if (row.status === "locked") throw new PrebuiltCartError("This cart is locked. Please ask the office to create another.", 423);
  if (["expired", "revoked"].includes(row.status)) throw new PrebuiltCartError("This cart is no longer available.", 410);
  if (typeof session !== "string" || !row.session_hash || sha256(session) !== row.session_hash) {
    throw new PrebuiltCartError("Verify your phone to continue.", 401);
  }
  const status = await effectiveStatus(row);
  const current = status === "paid" ? await reread(row.id) : row;
  const [provider, cartOrders] = await Promise.all([getProvider(current.provider_id), rawOrders(current)]);
  if (!provider) throw new PrebuiltCartError("Cart not found.", 404);
  // The session holder already proved the phone: return the real state so the page can settle paid/failed.
  return {
    status, partial: paymentState(current, cartOrders).partial, office_name: officeName(provider), paid_at: current.paid_at,
    orders: cartOrders.map((order) => ({
      order_number: order.order_number, kind: order.kind === "one_time" ? "one_time" : "subscription",
      status: order.status, total_cents: order.total_cents,
    })),
  };
}