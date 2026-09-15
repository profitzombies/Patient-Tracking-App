import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { supabaseAdmin } from "../lib/supabase-admin";
import { publicOrigin } from "./app-origin";
import { insert, selectMany, selectOne, update, type BillingPaymentLinkRow, type BillingPayerRow } from "./store";
import type { PatientSearchHit, PaymentLink, PaymentLinkInput, PaymentLinkUpdate } from "./types";

export class BillingLinkError extends Error {
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}
const claimedLink = new AsyncLocalStorage<string>();
type Patient = {
  id: string; first_name?: string | null; last_name?: string | null; name?: string | null;
  email?: string | null; phone?: string | null;
};
function patientName(row: Patient): string {
  return row.name?.trim() || `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Patient";
}
async function patient(providerId: string, patientId: string): Promise<Patient | null> {
  const result = await supabaseAdmin("GET",
    `/rest/v1/patients?id=eq.${encodeURIComponent(patientId)}&provider_id=eq.${encodeURIComponent(providerId)}&select=id,first_name,last_name,name,email,phone&limit=1`);
  if (result.status >= 300) throw new BillingLinkError("Could not load that patient.", 502);
  return Array.isArray(result.json) ? result.json[0] ?? null : null;
}
export function linkUrl(token: string): string { return `${publicOrigin()}/pay/${token}`; }
async function toLink(row: BillingPaymentLinkRow): Promise<PaymentLink> {
  const [person, product] = await Promise.all([
    row.patient_id ? patient(row.provider_id, row.patient_id) : null,
    row.product_id ? selectOne("billing_products", `id=eq.${encodeURIComponent(row.product_id)}`) : null,
  ]);
  const maxUses = row.max_uses ?? null;
  const usable = row.active && (!row.expires_at || Date.parse(row.expires_at) > Date.now()) &&
    (maxUses === null || row.uses < maxUses);
  return {
    id: row.id, token: row.token, url: linkUrl(row.token), provider_id: row.provider_id,
    patient_id: row.patient_id, patient_name: person ? patientName(person) : null, label: row.label,
    active: row.active, uses: row.uses, last_used_at: row.last_used_at, created_at: row.created_at,
    product_id: row.product_id ?? null, product_name: product?.name ?? null, expires_at: row.expires_at,
    max_uses: maxUses, usable,
  };
}
async function validateProduct(providerId: string, productId: string): Promise<void> {
  const [product, price] = await Promise.all([
    selectOne("billing_products", `id=eq.${encodeURIComponent(productId)}&active=eq.true`),
    selectOne("billing_office_prices", `provider_id=eq.${encodeURIComponent(providerId)}&product_id=eq.${encodeURIComponent(productId)}`),
  ]);
  if (!product || !price) throw new BillingLinkError("Choose an active product offered by this office.", 400, "product_id");
}
export async function createLink(providerId: string, actor: string, input: PaymentLinkInput): Promise<PaymentLink> {
  if (input.patient_id && !(await patient(providerId, input.patient_id))) throw new BillingLinkError("Patient not found.", 404, "patient_id");
  if (input.product_id) await validateProduct(providerId, input.product_id);
  const expiresAt = input.expires_in_hours == null
    ? null : new Date(Date.now() + input.expires_in_hours * 3_600_000).toISOString();
  const row = await insert("billing_payment_links", {
    token: crypto.randomBytes(24).toString("base64url"), provider_id: providerId,
    patient_id: input.patient_id ?? null, created_by: actor, label: input.label?.trim() || null,
    active: true, expires_at: expiresAt, uses: 0, last_used_at: null,
    product_id: input.product_id ?? null, max_uses: input.max_uses ?? null,
  });
  return toLink(row);
}
export async function updateLink(providerId: string, id: string, input: PaymentLinkUpdate): Promise<PaymentLink> {
  const before = await selectOne("billing_payment_links",
    `id=eq.${encodeURIComponent(id)}&provider_id=eq.${encodeURIComponent(providerId)}`);
  if (!before) throw new BillingLinkError("Payment link not found.", 404);
  if (input.max_uses !== undefined && input.max_uses !== null && input.max_uses < before.uses) {
    throw new BillingLinkError(`Maximum uses cannot be below the current use count (${before.uses}).`, 400, "max_uses");
  }
  const patch: Partial<BillingPaymentLinkRow> = {};
  if (input.label !== undefined) patch.label = input.label?.trim() || null;
  if (input.active !== undefined) patch.active = input.active;
  if (input.expires_at !== undefined) patch.expires_at = input.expires_at;
  if (input.max_uses !== undefined) patch.max_uses = input.max_uses;
  const row = await update("billing_payment_links",
    `id=eq.${encodeURIComponent(id)}&provider_id=eq.${encodeURIComponent(providerId)}`, patch);
  if (!row) throw new BillingLinkError("Payment link not found.", 404);
  return toLink(row);
}
export async function listLinks(providerId: string): Promise<PaymentLink[]> {
  const rows = await selectMany("billing_payment_links", `provider_id=eq.${encodeURIComponent(providerId)}&order=created_at.desc`);
  return Promise.all(rows.map(toLink));
}
export async function deactivateLink(providerId: string, id: string): Promise<void> {
  const row = await update("billing_payment_links",
    `id=eq.${encodeURIComponent(id)}&provider_id=eq.${encodeURIComponent(providerId)}`, { active: false });
  if (!row) throw new BillingLinkError("Payment link not found.", 404);
}
export async function resolveActiveLink(token: string): Promise<BillingPaymentLinkRow> {
  const row = await selectOne("billing_payment_links", `token=eq.${encodeURIComponent(token)}`);
  if (!row || !row.active || (row.expires_at && Date.parse(row.expires_at) <= Date.now()) ||
      (row.max_uses != null && row.uses >= row.max_uses)) {
    throw new BillingLinkError("This payment link is no longer active.", 404);
  }
  return row;
}
export async function touchLinkUse(id: string): Promise<void> {
  if (claimedLink.getStore() === id) return;
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/billing_claim_payment_link_use", { p_link_id: id });
  if (result.status >= 300) throw new BillingLinkError("Could not claim this payment link.", 502);
  if (result.json !== true) throw new BillingLinkError("This payment link has already been used.", 409);
}
export async function releaseLinkUse(id: string): Promise<void> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/billing_release_payment_link_use", { p_link_id: id });
  if (result.status >= 300) throw new BillingLinkError("Could not release this payment link.", 502);
}
export async function withClaimedLinkUse<T>(id: string, work: () => Promise<T>): Promise<T> {
  await touchLinkUse(id);
  try {
    return await claimedLink.run(id, work);
  } catch (error) {
    await releaseLinkUse(id);
    throw error;
  }
}
function normalizePhone(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}
async function allPatients(providerId: string): Promise<Patient[]> {
  const result = await supabaseAdmin("GET",
    `/rest/v1/patients?provider_id=eq.${encodeURIComponent(providerId)}&select=id,first_name,last_name,name,email,phone&limit=1000`);
  if (result.status >= 300) throw new BillingLinkError("Could not resolve the payer.", 502);
  return Array.isArray(result.json) ? result.json : [];
}
export async function resolvePayer(
  providerId: string, link: BillingPaymentLinkRow,
  input?: { name: string; email: string; phone: string },
): Promise<BillingPayerRow> {
  if (link.patient_id) {
    const person = await patient(providerId, link.patient_id);
    if (!person) throw new BillingLinkError("Patient not found.", 404);
    const existing = await selectOne("billing_payers", `provider_id=eq.${encodeURIComponent(providerId)}&patient_id=eq.${encodeURIComponent(person.id)}`);
    if (existing) return existing;
    return insert("billing_payers", {
      provider_id: providerId, patient_id: person.id, name: patientName(person),
      email: person.email?.toLowerCase() ?? null, phone: person.phone ?? null, stripe_customer_id: null,
    });
  }
  if (!input?.name.trim() || !input.email.trim()) throw new BillingLinkError("Enter payer details.", 400, "payer");
  const email = input.email.trim().toLowerCase();
  const phone = normalizePhone(input.phone);
  const patients = await allPatients(providerId);
  const matched = patients.find((person) => person.email?.trim().toLowerCase() === email) ??
    (phone ? patients.find((person) => normalizePhone(person.phone) === phone) : undefined);
  if (matched) {
    const existing = await selectOne("billing_payers", `provider_id=eq.${encodeURIComponent(providerId)}&patient_id=eq.${encodeURIComponent(matched.id)}`);
    if (existing) return existing;
    return insert("billing_payers", {
      provider_id: providerId, patient_id: matched.id, name: patientName(matched),
      email: matched.email?.toLowerCase() ?? email, phone: matched.phone ?? input.phone, stripe_customer_id: null,
    });
  }
  const existing = await selectOne("billing_payers", `provider_id=eq.${encodeURIComponent(providerId)}&email=eq.${encodeURIComponent(email)}`);
  if (existing) return existing;
  return insert("billing_payers", {
    provider_id: providerId, patient_id: null, name: input.name.trim(), email,
    phone: input.phone.trim() || null, stripe_customer_id: null,
  });
}
export async function searchPatients(providerId: string, q: string): Promise<PatientSearchHit[]> {
  const term = q.trim();
  if (!term) return [];
  const escaped = term.replace(/[%(),]/g, "");
  const result = await supabaseAdmin("GET",
    `/rest/v1/patients?provider_id=eq.${encodeURIComponent(providerId)}&or=(name.ilike.*${encodeURIComponent(escaped)}*,first_name.ilike.*${encodeURIComponent(escaped)}*,last_name.ilike.*${encodeURIComponent(escaped)}*,email.ilike.*${encodeURIComponent(escaped)}*,phone.ilike.*${encodeURIComponent(escaped)}*)&select=id,first_name,last_name,name,email,phone&limit=10`);
  if (result.status >= 300) throw new BillingLinkError("Could not search patients.", 502);
  return (Array.isArray(result.json) ? result.json as Patient[] : []).map((row) => ({
    id: row.id, name: patientName(row), email: row.email ?? null, phone: row.phone ?? null,
  }));
}