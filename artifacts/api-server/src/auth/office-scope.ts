/**
 * Office scope resolution for the provider-portal live endpoints (roster +
 * patient invitations).
 *
 * Two caller shapes resolve to exactly one office:
 *   * Provider staff — the bearer token's auth user links to a providers or
 *     team_members row, and the office is ALWAYS their own. Staff callers can
 *     never choose a different office: any explicit office input is ignored
 *     for them, so a compromised client cannot widen its scope.
 *   * HQ — an active HQ membership with the required permission names the
 *     office explicitly (the drill-in page's account id). HQ without an
 *     explicit office is a 400, never a fallback to "some office".
 *
 * Disabled offices fail closed for everyone. Locked offices fail closed for
 * their own staff (mirroring how the account lock collapses office reads in
 * the operations app); HQ read access survives a lock, but write callers pass
 * `requireUnlocked` so invitations into a locked office are refused for HQ
 * too.
 */
import { fetchAuthUser, supabaseAdmin } from "../lib/supabase-admin";
import { providerLocked } from "./directory";
import {
  hasHqPermission,
  verifyStaffToken,
  type HqPermission,
} from "../lib/staff-auth";

function enc(value: string): string {
  return encodeURIComponent(value);
}

export interface OfficeScope {
  providerId: string;
  officeName: string;
  providerName: string;
  /** Raw onboarding code from the providers row (may be null for legacy offices). */
  onboardingCode: string | null;
  /** Auth user id of the caller — recorded as the inviter. */
  actorUserId: string;
  actorKind: "provider" | "team_member" | "hq";
}

export type OfficeScopeResult =
  | { kind: "ok"; scope: OfficeScope }
  | { kind: "denied"; status: number; message: string };

const SIGN_IN = { kind: "denied", status: 401, message: "Sign in to continue." } as const;
const STAFF_ONLY = {
  kind: "denied",
  status: 403,
  message: "Only office staff can use this.",
} as const;
const OFFICE_LOCKED = {
  kind: "denied",
  status: 403,
  message: "This office's account is locked. Contact THINNR support.",
} as const;
const OFFICE_UNAVAILABLE = {
  kind: "denied",
  status: 404,
  message: "That office isn't available.",
} as const;

interface OfficeRow {
  provider_id: string;
  provider_name: string | null;
  office_name: string | null;
  onboarding_code: string | null;
  access_disabled: boolean | null;
}

const OFFICE_SELECT = "provider_id,provider_name,office_name,onboarding_code,access_disabled";

async function loadOffice(providerId: string): Promise<OfficeRow | null> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?provider_id=eq.${enc(providerId)}&select=${OFFICE_SELECT}&limit=2`,
  );
  if (res.status >= 300) throw new Error(`office lookup failed (${res.status})`);
  const rows = Array.isArray(res.json) ? (res.json as OfficeRow[]) : [];
  return rows.length === 1 ? rows[0] : null;
}

function officeScopeFrom(
  row: OfficeRow,
  actorUserId: string,
  actorKind: OfficeScope["actorKind"],
): OfficeScope {
  return {
    providerId: row.provider_id,
    officeName: String(row.office_name ?? row.provider_name ?? "your office"),
    providerName: String(row.provider_name ?? row.office_name ?? "your provider"),
    onboardingCode: row.onboarding_code ? String(row.onboarding_code) : null,
    actorUserId,
    actorKind,
  };
}

/** Office account ids arrive bare or seeded (`acct-<id>`); locks and the HQ UI use bare. */
function canonicalOfficeId(id: string): string {
  return id.startsWith("acct-") ? id.slice(5) : id;
}

export async function resolveOfficeScope(input: {
  authorization: string | undefined;
  /** Explicit office id — honored ONLY for HQ callers. */
  explicitOfficeId?: string | null;
  /** Permission an HQ caller must hold for this operation. */
  hqPermission: HqPermission;
  /** Refuse locked offices (invitation writes); reads let HQ through a lock. */
  requireUnlocked: boolean;
}): Promise<OfficeScopeResult> {
  const header = input.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return SIGN_IN;

  // Hop 1: GoTrue confirms the token is live and yields the auth user id.
  const user = await fetchAuthUser(token);
  if (!user) return SIGN_IN;

  // Provider owner? The office is their own — explicit input is ignored.
  const providers = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?auth_user_id=eq.${enc(user.id)}&select=${OFFICE_SELECT}&limit=2`,
  );
  if (providers.status >= 300) throw new Error(`provider lookup failed (${providers.status})`);
  const providerRows = Array.isArray(providers.json) ? (providers.json as OfficeRow[]) : [];
  if (providerRows.length === 1) {
    const row = providerRows[0];
    if (row.access_disabled === true) return OFFICE_UNAVAILABLE;
    if (await providerLocked(row.provider_id)) return OFFICE_LOCKED;
    return { kind: "ok", scope: officeScopeFrom(row, user.id, "provider") };
  }

  // Office team member? Same rule — always their own office.
  const members = await supabaseAdmin(
    "GET",
    `/rest/v1/team_members?auth_user_id=eq.${enc(user.id)}&select=id,provider_id,activation_status&limit=2`,
  );
  if (members.status >= 300) throw new Error(`team member lookup failed (${members.status})`);
  const memberRows = (Array.isArray(members.json) ? members.json : []) as Array<{
    provider_id: string | null;
    activation_status: string | null;
  }>;
  if (memberRows.length === 1 && memberRows[0].activation_status !== "disabled") {
    const providerId = memberRows[0].provider_id;
    if (!providerId) return STAFF_ONLY;
    const office = await loadOffice(providerId);
    if (!office || office.access_disabled === true) return OFFICE_UNAVAILABLE;
    if (await providerLocked(office.provider_id)) return OFFICE_LOCKED;
    return { kind: "ok", scope: officeScopeFrom(office, user.id, "team_member") };
  }

  // HQ — must name the office explicitly and hold the permission.
  const identity = await verifyStaffToken(token);
  if (!identity) return STAFF_ONLY;
  if (!hasHqPermission(identity, input.hqPermission)) {
    return {
      kind: "denied",
      status: 403,
      message: "Your HQ role does not have permission to do this.",
    };
  }
  const explicit = (input.explicitOfficeId ?? "").trim();
  if (!explicit) {
    return {
      kind: "denied",
      status: 400,
      message: "Choose an office before managing its patients.",
    };
  }
  const office = await loadOffice(canonicalOfficeId(explicit));
  if (!office || office.access_disabled === true) return OFFICE_UNAVAILABLE;
  if (input.requireUnlocked && (await providerLocked(office.provider_id))) {
    return OFFICE_LOCKED;
  }
  return { kind: "ok", scope: officeScopeFrom(office, identity.userId, "hq") };
}
