import crypto from "node:crypto";
import { supabaseAdmin } from "../lib/supabase-admin";
import { publicOrigin } from "./app-origin";
import { insert, selectMany, selectOne, update, type BillingPaymentLinkRow, type BillingPayerRow } from "./store";
import type { PatientSearchHit, PaymentLink } from "./types";

export class BillingLinkError extends Error {
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}
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
  const person = row.patient_id ? await patient(row.provider_id, row.patient_id) : null;
  return {
    id: row.id, token: row.token, url: linkUrl(row.token), provider_id: row.provider_id,
    patient_id: row.patient_id, patient_name: person ? patientName(person) : null, label: row.label,
    active: row.active, uses: row.uses, last_used_at: row.last_used_at, created_at: row.created_at,
  };
}
export async function createLink(providerId: string, actor: string, input: { patient_id?: string | null; label?: string | null }): Promise<PaymentLink> {
  if (input.patient_id && !(await patient(providerId, input.patient_id))) throw new BillingLinkError("Patient not found.", 404, "patient_id");
  const row = await insert("billing_payment_links", {
    token: crypto.randomBytes(24).toString("base64url"), provider_id: providerId,
    patient_id: input.patient_id ?? null, created_by: actor, label: input.label?.trim() || null,
    active: true, expires_at: null, uses: 0, last_used_at: null,
  });
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
  if (!row || !row.active || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
    throw new BillingLinkError("This payment link is no longer active.", 404);
  }
  return row;
}
export async function touchLinkUse(id: string): Promise<void> {
  const row = await selectOne("billing_payment_links", `id=eq.${encodeURIComponent(id)}`);
  if (row) await update("billing_payment_links", `id=eq.${encodeURIComponent(id)}`, {
    uses: row.uses + 1, last_used_at: new Date().toISOString(),
  });
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