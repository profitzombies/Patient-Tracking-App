/**
 * Account directory lookups for passwordless login.
 *
 * Two realms, keyed on different identity fields so the same human can hold
 * both kinds of account without collision:
 *   * Staff (operations app) — keyed on business email. Precedence when one
 *     email appears in several staff tables: HQ membership > provider >
 *     team member. Anything ambiguous, disabled, locked, or revoked
 *     collapses to "none" — the caller answers neutrally and sends nothing.
 *   * Patients (mobile app) — keyed on cell phone, with email fallback. The
 *     lookup rides the same last-10-digit phone matching the claim flow uses.
 *
 * Lock/disabled rules mirror the password paths they replace: locked or
 * disabled offices never receive codes, and their staff cannot sign in.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import type { NormalizedIdentifier } from "../claim/normalize";
import type { Candidate } from "./ledger";

function enc(value: string): string {
  return encodeURIComponent(value);
}

export type StaffClass = "hq_active" | "hq_invited" | "provider" | "team_member";
export type StaffOfficeRole = "owner" | "admin" | "staff";

export interface StaffHit {
  class: StaffClass;
  /** hq membership id / provider_id / team_members.id */
  ref: string;
  email: string;
  name: string | null;
  authUserId: string | null;
  /** Owning office for provider + team_member classes. */
  providerId: string | null;
  /**
   * Office role for provider (always owner) + team_member classes; null for
   * HQ. Drives the "office owners and admins" second-factor rule.
   */
  officeRole: StaffOfficeRole | null;
}

export function officeRoleOf(value: unknown): StaffOfficeRole {
  return value === "owner" || value === "admin" ? value : "staff";
}

export type StaffLookup = { kind: "ok"; hit: StaffHit } | { kind: "none" };

const NONE: StaffLookup = { kind: "none" };

/** Presence of a lock row (by provider id or seeded acct-<id> code) = locked. */
export async function providerLocked(providerId: string): Promise<boolean> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/provider_account_locks?or=(account_id.eq.${enc(providerId)},account_id.eq.${enc(`acct-${providerId}`)})&select=account_id&limit=1`,
  );
  if (res.status >= 300) throw new Error(`lock lookup failed (${res.status})`);
  return Array.isArray(res.json) && res.json.length > 0;
}

interface ProviderRow {
  provider_id: string;
  provider_name: string | null;
  office_name: string | null;
  email: string | null;
  access_disabled: boolean | null;
  auth_user_id: string | null;
}

async function loadProviderById(providerId: string): Promise<ProviderRow | null> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?provider_id=eq.${enc(providerId)}&select=provider_id,provider_name,office_name,email,access_disabled,auth_user_id&limit=2`,
  );
  if (res.status >= 300) throw new Error(`provider lookup failed (${res.status})`);
  const rows = Array.isArray(res.json) ? (res.json as ProviderRow[]) : [];
  return rows.length === 1 ? rows[0] : null;
}

export interface PendingHqInvitation {
  id: string;
  token_hash: string;
  expires_at: string;
}

/** The newest pending, unexpired invitation for an invited HQ membership. */
export async function loadPendingHqInvitation(
  membershipId: string,
): Promise<PendingHqInvitation | null> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/hq_invitations?membership_id=eq.${enc(membershipId)}&status=eq.pending&select=id,token_hash,expires_at&order=created_at.desc&limit=1`,
  );
  if (res.status >= 300) throw new Error(`invitation lookup failed (${res.status})`);
  const rows = Array.isArray(res.json) ? (res.json as PendingHqInvitation[]) : [];
  const invitation = rows[0];
  if (!invitation) return null;
  return new Date(invitation.expires_at).getTime() > Date.now() ? invitation : null;
}

/**
 * Resolve a staff login email to exactly one account, or "none". Every
 * failure mode (no match, several matches inside the winning class, disabled
 * office, lock, revoked membership, expired invitation) looks identical to
 * the caller so responses stay neutral about what exists.
 */
export async function lookupStaffByEmail(email: string): Promise<StaffLookup> {
  // 1. HQ memberships (active or invited-with-pending-invite) outrank all.
  const hq = await supabaseAdmin(
    "GET",
    `/rest/v1/hq_memberships?email=ilike.${enc(email)}&select=id,email,display_name,status,auth_user_id&limit=3`,
  );
  if (hq.status >= 300) throw new Error(`hq membership lookup failed (${hq.status})`);
  const memberships = (Array.isArray(hq.json) ? hq.json : []).filter(
    (m: { status?: string }) => m.status === "active" || m.status === "invited",
  );
  if (memberships.length > 1) return NONE;
  if (memberships.length === 1) {
    const m = memberships[0] as {
      id: string;
      email: string;
      display_name: string | null;
      status: string;
      auth_user_id: string | null;
    };
    if (m.status === "active") {
      if (!m.auth_user_id) return NONE;
      return {
        kind: "ok",
        hit: {
          class: "hq_active",
          ref: m.id,
          email: m.email,
          name: m.display_name,
          authUserId: m.auth_user_id,
          providerId: null,
          officeRole: null,
        },
      };
    }
    const invitation = await loadPendingHqInvitation(m.id);
    if (!invitation) return NONE;
    return {
      kind: "ok",
      hit: {
        class: "hq_invited",
        ref: m.id,
        email: m.email,
        name: m.display_name,
        authUserId: m.auth_user_id,
        providerId: null,
        officeRole: null,
      },
    };
  }

  // 2. Provider (office owner) accounts.
  const providers = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?email=ilike.${enc(email)}&select=provider_id,provider_name,office_name,email,access_disabled,auth_user_id&limit=3`,
  );
  if (providers.status >= 300) throw new Error(`provider lookup failed (${providers.status})`);
  const providerRows = (Array.isArray(providers.json) ? (providers.json as ProviderRow[]) : []).filter(
    (p) => p.access_disabled !== true,
  );
  if (providerRows.length > 1) return NONE;
  if (providerRows.length === 1) {
    const p = providerRows[0];
    if (await providerLocked(p.provider_id)) return NONE;
    return {
      kind: "ok",
      hit: {
        class: "provider",
        ref: p.provider_id,
        email: p.email ?? email,
        name: p.provider_name ?? p.office_name,
        authUserId: p.auth_user_id,
        providerId: p.provider_id,
        officeRole: "owner",
      },
    };
  }

  // 3. Office staff (team members). Their office must be active and unlocked.
  const members = await supabaseAdmin(
    "GET",
    `/rest/v1/team_members?email=ilike.${enc(email)}&select=id,provider_id,name,email,activation_status,office_role,auth_user_id&limit=3`,
  );
  if (members.status >= 300) throw new Error(`team member lookup failed (${members.status})`);
  const memberRows = (Array.isArray(members.json) ? members.json : []).filter(
    (m: { activation_status?: string | null }) => m.activation_status !== "disabled",
  );
  if (memberRows.length !== 1) return NONE;
  const member = memberRows[0] as {
    id: string;
    provider_id: string | null;
    name: string | null;
    email: string;
    office_role?: string | null;
    auth_user_id: string | null;
  };
  if (!member.provider_id) return NONE;
  const office = await loadProviderById(member.provider_id);
  if (!office || office.access_disabled === true) return NONE;
  if (await providerLocked(member.provider_id)) return NONE;
  return {
    kind: "ok",
    hit: {
      class: "team_member",
      ref: member.id,
      email: member.email,
      name: member.name,
      authUserId: member.auth_user_id,
      providerId: member.provider_id,
      officeRole: officeRoleOf(member.office_role),
    },
  };
}

/**
 * Patient lookup by phone or email, riding the claim candidate RPC (which
 * handles last-10-digit phone matching in SQL and excludes disabled
 * patients) filtered to patient rows only.
 */
export async function lookupPatients(identifier: NormalizedIdentifier): Promise<Candidate[]> {
  const value = identifier.kind === "phone" ? identifier.e164 : identifier.email;
  const rpc = await supabaseAdmin("POST", "/rest/v1/rpc/claim_find_candidates", {
    p_kind: identifier.kind,
    p_value: value,
  });
  if (rpc.status >= 300) throw new Error(`candidate lookup failed (${rpc.status})`);
  const rows: Candidate[] = Array.isArray(rpc.json) ? (rpc.json as Candidate[]) : [];
  return rows.filter((c) => c.type === "patient");
}

export interface PatientRow {
  id: string;
  provider_id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  activation_status: string | null;
  auth_user_id: string | null;
}

export async function loadPatientById(id: string): Promise<PatientRow | null> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${enc(id)}&select=id,provider_id,name,email,phone,activation_status,auth_user_id&limit=2`,
  );
  if (res.status >= 300) throw new Error(`patient lookup failed (${res.status})`);
  const rows = Array.isArray(res.json) ? (res.json as PatientRow[]) : [];
  return rows.length === 1 ? rows[0] : null;
}

export interface SignupOffice {
  providerId: string;
  officeName: string;
}

/**
 * Resolve a patient-facing provider code (6-digit onboarding code or 5-digit
 * legacy provider id) to an active, unlocked office. Unlike login lookups
 * this is allowed to answer plainly — provider codes are semi-public and the
 * response carries no patient information.
 */
export async function resolveSignupOffice(code: string): Promise<SignupOffice | null> {
  const trimmed = code.trim();
  let row: ProviderRow | null = null;
  if (/^[0-9]{6}$/.test(trimmed)) {
    const res = await supabaseAdmin(
      "GET",
      `/rest/v1/providers?onboarding_code=eq.${enc(trimmed)}&select=provider_id,provider_name,office_name,email,access_disabled,auth_user_id&limit=2`,
    );
    if (res.status >= 300) throw new Error(`office lookup failed (${res.status})`);
    const rows = Array.isArray(res.json) ? (res.json as ProviderRow[]) : [];
    row = rows.length === 1 ? rows[0] : null;
  } else if (/^[0-9]{5}$/.test(trimmed)) {
    row = await loadProviderById(trimmed);
  } else {
    return null;
  }
  if (!row || row.access_disabled === true) return null;
  if (await providerLocked(row.provider_id)) return null;
  return {
    providerId: row.provider_id,
    officeName: String(row.office_name ?? row.provider_name ?? "your provider's office"),
  };
}

/**
 * The same active-office checks, keyed on the provider id a signup ledger
 * row recorded at start time. Provider ids are not always code-shaped —
 * new-generation offices use `live-<hex>` ids — so completion must never
 * route the stored id back through the code parser above.
 */
export async function resolveSignupOfficeById(providerId: string): Promise<SignupOffice | null> {
  const row = await loadProviderById(providerId);
  if (!row || row.access_disabled === true) return null;
  if (await providerLocked(row.provider_id)) return null;
  return {
    providerId: row.provider_id,
    officeName: String(row.office_name ?? row.provider_name ?? "your provider's office"),
  };
}
