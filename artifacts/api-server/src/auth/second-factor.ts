/**
 * Staff second factor: one verified phone per staff identity plus the rule
 * that decides who must text-confirm after the emailed sign-in code.
 *
 * Identities are keyed the way the login directory resolves them (HQ
 * membership id, provider id, team_members.id) so a cleared phone forces
 * re-enrolment at the very next sign-in without touching auth.users.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import { DEFAULT_ORG_POLICY, loadOrgPolicy, type OrgPolicy, type SecondFactorPolicy } from "../lib/org-policy";
import type { StaffClass, StaffOfficeRole } from "./directory";

export type StaffFactorKind = "hq" | "provider" | "team_member";

export interface StaffSecondFactor {
  kind: StaffFactorKind;
  ref: string;
  /** E.164 phone that received a verified code. */
  phone: string;
  verifiedAt: string;
  /** Self-service opt-in; policy-required staff are covered regardless. */
  enabled: boolean;
}

interface FactorRow {
  staff_kind: StaffFactorKind;
  staff_ref: string;
  phone: string;
  verified_at: string;
  enabled: boolean;
}

const enc = encodeURIComponent;

export function factorKindOf(staffClass: StaffClass): StaffFactorKind {
  return staffClass === "hq_active" || staffClass === "hq_invited" ? "hq" : staffClass;
}

/** `•••-•••-1234` — the only phone shape that ever leaves the API. */
export function maskPhone(phone: string): string {
  return `•••-•••-${phone.slice(-4)}`;
}

function fromRow(row: FactorRow): StaffSecondFactor {
  return {
    kind: row.staff_kind,
    ref: String(row.staff_ref),
    phone: String(row.phone),
    verifiedAt: String(row.verified_at),
    enabled: row.enabled === true,
  };
}

export async function loadStaffSecondFactor(kind: StaffFactorKind, ref: string): Promise<StaffSecondFactor | null> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/staff_second_factors?staff_kind=eq.${kind}&staff_ref=eq.${enc(ref)}&select=staff_kind,staff_ref,phone,verified_at,enabled&limit=1`,
  );
  if (res.status >= 300) throw new Error(`second factor lookup failed (${res.status})`);
  const row = Array.isArray(res.json) ? (res.json[0] as FactorRow | undefined) : undefined;
  return row ? fromRow(row) : null;
}

/** Every verified phone for one identity kind, keyed by ref (team page lists). */
export async function loadStaffSecondFactors(kind: StaffFactorKind, refs: string[]): Promise<Map<string, StaffSecondFactor>> {
  const out = new Map<string, StaffSecondFactor>();
  if (refs.length === 0) return out;
  const list = refs.map((ref) => `"${ref.replace(/"/g, "")}"`).join(",");
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/staff_second_factors?staff_kind=eq.${kind}&staff_ref=in.(${enc(list)})&select=staff_kind,staff_ref,phone,verified_at,enabled&limit=1000`,
  );
  if (res.status >= 300) throw new Error(`second factor list failed (${res.status})`);
  for (const row of Array.isArray(res.json) ? (res.json as FactorRow[]) : []) out.set(String(row.staff_ref), fromRow(row));
  return out;
}

/** Record a freshly proven phone (replacing any prior one) and turn the step on. */
export async function saveStaffSecondFactor(kind: StaffFactorKind, ref: string, phone: string): Promise<StaffSecondFactor> {
  const now = new Date().toISOString();
  const res = await supabaseAdmin(
    "POST",
    "/rest/v1/staff_second_factors?on_conflict=staff_kind,staff_ref&select=staff_kind,staff_ref,phone,verified_at,enabled",
    { staff_kind: kind, staff_ref: ref, phone, verified_at: now, enabled: true, updated_at: now },
    "resolution=merge-duplicates,return=representation",
  );
  if (res.status >= 300) throw new Error(`second factor save failed (${res.status})`);
  const row = Array.isArray(res.json) ? (res.json[0] as FactorRow | undefined) : undefined;
  return row ? fromRow(row) : { kind, ref, phone, verifiedAt: now, enabled: true };
}

/** Self-service switch; returns false when no verified phone exists. */
export async function setStaffSecondFactorEnabled(kind: StaffFactorKind, ref: string, enabled: boolean): Promise<boolean> {
  const res = await supabaseAdmin(
    "PATCH",
    `/rest/v1/staff_second_factors?staff_kind=eq.${kind}&staff_ref=eq.${enc(ref)}&select=staff_ref`,
    { enabled, updated_at: new Date().toISOString() },
    "return=representation",
  );
  if (res.status >= 300) throw new Error(`second factor update failed (${res.status})`);
  return Array.isArray(res.json) && res.json.length === 1;
}

/** Lost phone: drop the verified number so the next sign-in re-enrols. */
export async function clearStaffSecondFactor(kind: StaffFactorKind, ref: string): Promise<boolean> {
  const res = await supabaseAdmin(
    "DELETE",
    `/rest/v1/staff_second_factors?staff_kind=eq.${kind}&staff_ref=eq.${enc(ref)}&select=staff_ref`,
    undefined,
    "return=representation",
  );
  if (res.status >= 300) throw new Error(`second factor clear failed (${res.status})`);
  return Array.isArray(res.json) && res.json.length > 0;
}

export interface SecondFactorSubject {
  class: StaffClass;
  officeRole: StaffOfficeRole | null;
}

/** Whether the organization rule (not the personal opt-in) covers this staff member. */
export function secondFactorRequiredByPolicy(policy: SecondFactorPolicy, subject: SecondFactorSubject): boolean {
  if (policy.allStaff) return true;
  if (subject.class === "hq_active" || subject.class === "hq_invited") return policy.hqUsers;
  const manager = subject.class === "provider" || subject.officeRole === "owner" || subject.officeRole === "admin";
  return manager && policy.officeManagers;
}

/**
 * The live rule, read fresh for every sign-in so an HQ policy change applies
 * on the very next login. A policy outage falls back to the defaults (HQ +
 * office managers required), never to "no second step".
 */
export async function currentSecondFactorPolicy(): Promise<SecondFactorPolicy> {
  let policy: OrgPolicy;
  try {
    policy = await loadOrgPolicy({ fresh: true });
  } catch {
    policy = DEFAULT_ORG_POLICY;
  }
  return policy.secondFactor;
}

/** Policy rule OR the person's own opt-in (an opt-in needs a verified phone). */
export function secondFactorApplies(
  policy: SecondFactorPolicy,
  subject: SecondFactorSubject,
  factor: StaffSecondFactor | null,
): boolean {
  return secondFactorRequiredByPolicy(policy, subject) || Boolean(factor?.enabled);
}
