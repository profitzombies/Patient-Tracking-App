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
import type { Request, Response } from "express";
import { recordAccessDenied } from "../lib/admin-audit";
import { supabaseAdmin } from "../lib/supabase-admin";
import { providerLocked } from "./directory";
import { OFFICE_OFFBOARDED_STAFF_MESSAGE, offboardingStatusOf } from "../lib/office-status";
import { identifyBearer } from "./identify";
import { isLaunchAllowedPath, readLaunch, operationalLaunchComplete } from "../practice-launch/state";
import { verificationModeFor, type VerificationRequest } from "./verification-policy";
import {
  hasHqPermission,
  staffIdentityForUser,
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
  /**
   * Office-level authority. The provider account holder and HQ drill-ins act
   * as owners; team members carry their team_members.office_role.
   */
  officeRole: OfficeRole;
  /** The caller's own team_members row, when they are a teammate. */
  teamMemberId: string | null;
}

export type OfficeRole = "owner" | "admin" | "staff";

export type OfficeScopeDenialReason =
  | "sign_in"
  | "staff_only"
  | "office_locked"
  | "office_unavailable"
  | "office_offboarded"
  | "deactivated"
  | "permission"
  | "office_required";

export type OfficeScopeDenied = {
  kind: "denied";
  status: number;
  message: string;
  reason: OfficeScopeDenialReason;
  /** The authenticated caller behind the refusal, when the token was live. */
  actorUserId: string | null;
  /** The office the refusal concerned, when one resolved. */
  providerId: string | null;
};

export type OfficeScopeResult = { kind: "ok"; scope: OfficeScope } | OfficeScopeDenied;

function denied(
  status: number,
  message: string,
  reason: OfficeScopeDenialReason,
  actorUserId: string | null = null,
  providerId: string | null = null,
): OfficeScopeDenied {
  return { kind: "denied", status, message, reason, actorUserId, providerId };
}

const SIGN_IN_MESSAGE = "Sign in to continue.";
const STAFF_ONLY_MESSAGE = "Only office staff can use this.";
const OFFICE_LOCKED_MESSAGE = "This office's account is locked. Contact THINNR support.";
const OFFICE_UNAVAILABLE_MESSAGE = "That office isn't available.";
export const STAFF_DEACTIVATED_MESSAGE =
  "Your office access has been deactivated. Ask an office owner to reactivate it.";

interface OfficeRow {
  provider_id: string;
  provider_name: string | null;
  office_name: string | null;
  onboarding_code: string | null;
  access_disabled: boolean | null;
  offboarding_status?: string | null;
}

const OFFICE_SELECT = "provider_id,provider_name,office_name,onboarding_code,access_disabled,offboarding_status";

/** Staff of an office whose program is ending or ended fail closed; HQ still reads. */
function officeEndedForStaff(row: OfficeRow): boolean {
  return offboardingStatusOf(row.offboarding_status) !== "active";
}

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
  member: { id: string; officeRole: OfficeRole } | null = null,
): OfficeScope {
  return {
    providerId: row.provider_id,
    officeName: String(row.office_name ?? row.provider_name ?? "your office"),
    providerName: String(row.provider_name ?? row.office_name ?? "your provider"),
    onboardingCode: row.onboarding_code ? String(row.onboarding_code) : null,
    actorUserId,
    actorKind,
    officeRole: member ? member.officeRole : "owner",
    teamMemberId: member ? member.id : null,
  };
}

export function isOfficeRole(value: unknown): value is OfficeRole {
  return value === "owner" || value === "admin" || value === "staff";
}

/** Owners and admins run the office: team changes and the office audit trail. */
export function canManageOffice(scope: Pick<OfficeScope, "officeRole">): boolean {
  return scope.officeRole === "owner" || scope.officeRole === "admin";
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
  /**
   * The request being served (method + url) so the verification policy can
   * decide local vs remote token verification. Omitted = local.
   */
  request?: VerificationRequest;
}): Promise<OfficeScopeResult> {
  const header = input.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return denied(401, SIGN_IN_MESSAGE, "sign_in");

  // Hop 1: the token is verified (locally, or by GoTrue for the remote
  // families) and yields the auth user id.
  const user = await identifyBearer(token, verificationModeFor(input.request));
  if (!user) return denied(401, SIGN_IN_MESSAGE, "sign_in");

  // Provider owner? The office is their own — explicit input is ignored.
  const providers = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?auth_user_id=eq.${enc(user.id)}&select=${OFFICE_SELECT}&limit=2`,
  );
  if (providers.status >= 300) throw new Error(`provider lookup failed (${providers.status})`);
  const providerRows = Array.isArray(providers.json) ? (providers.json as OfficeRow[]) : [];
  if (providerRows.length === 1) {
    const row = providerRows[0];
    if (officeEndedForStaff(row)) {
      return denied(403, OFFICE_OFFBOARDED_STAFF_MESSAGE, "office_offboarded", user.id, row.provider_id);
    }
    if (row.access_disabled === true) {
      return denied(404, OFFICE_UNAVAILABLE_MESSAGE, "office_unavailable", user.id, row.provider_id);
    }
    if (await providerLocked(row.provider_id)) {
      return denied(403, OFFICE_LOCKED_MESSAGE, "office_locked", user.id, row.provider_id);
    }
    const gate = await launchGate(row.provider_id, user.id, input.request);
    if (gate) return gate;
    return { kind: "ok", scope: officeScopeFrom(row, user.id, "provider") };
  }

  // Office team member? Same rule — always their own office. A deactivated
  // teammate fails closed HERE, before any HQ fallback could be consulted.
  const members = await supabaseAdmin(
    "GET",
    `/rest/v1/team_members?auth_user_id=eq.${enc(user.id)}&select=id,provider_id,activation_status,office_role&limit=2`,
  );
  if (members.status >= 300) throw new Error(`team member lookup failed (${members.status})`);
  const memberRows = (Array.isArray(members.json) ? members.json : []) as Array<{
    id: string;
    provider_id: string | null;
    activation_status: string | null;
    office_role: string | null;
  }>;
  if (memberRows.length === 1) {
    const member = memberRows[0];
    const providerId = member.provider_id;
    if (member.activation_status === "disabled") {
      return denied(403, STAFF_DEACTIVATED_MESSAGE, "deactivated", user.id, providerId);
    }
    if (!providerId) return denied(403, STAFF_ONLY_MESSAGE, "staff_only", user.id);
    const office = await loadOffice(providerId);
    if (office && officeEndedForStaff(office)) {
      return denied(403, OFFICE_OFFBOARDED_STAFF_MESSAGE, "office_offboarded", user.id, providerId);
    }
    if (!office || office.access_disabled === true) {
      return denied(404, OFFICE_UNAVAILABLE_MESSAGE, "office_unavailable", user.id, providerId);
    }
    if (await providerLocked(office.provider_id)) {
      return denied(403, OFFICE_LOCKED_MESSAGE, "office_locked", user.id, providerId);
    }
    const gate = await launchGate(office.provider_id, user.id, input.request);
    if (gate) return gate;
    return {
      kind: "ok",
      scope: officeScopeFrom(office, user.id, "team_member", {
        id: String(member.id),
        officeRole: isOfficeRole(member.office_role) ? member.office_role : "staff",
      }),
    };
  }

  // HQ — must name the office explicitly and hold the permission. The
  // bearer is already verified above; only the membership lookup remains.
  const identity = await staffIdentityForUser(user.id);
  if (!identity) return denied(403, STAFF_ONLY_MESSAGE, "staff_only", user.id);
  if (!hasHqPermission(identity, input.hqPermission)) {
    return denied(
      403,
      "Your HQ role does not have permission to do this.",
      "permission",
      identity.userId,
    );
  }
  const explicit = (input.explicitOfficeId ?? "").trim();
  if (!explicit) {
    return denied(400, "Choose an office before managing its patients.", "office_required", identity.userId);
  }
  const office = await loadOffice(canonicalOfficeId(explicit));
  if (!office || office.access_disabled === true) {
    return denied(404, OFFICE_UNAVAILABLE_MESSAGE, "office_unavailable", identity.userId);
  }
  if (input.requireUnlocked && (await providerLocked(office.provider_id))) {
    return denied(403, OFFICE_LOCKED_MESSAGE, "office_locked", identity.userId, office.provider_id);
  }
  return { kind: "ok", scope: officeScopeFrom(office, identity.userId, "hq") };
}

async function launchGate(providerId:string,userId:string,request?:VerificationRequest):Promise<OfficeScopeDenied|null> {
  const url=request?.originalUrl??request?.url;
  if (!url || isLaunchAllowedPath(url)) return null;
  await readLaunch(providerId);
  if (!await operationalLaunchComplete(providerId)) return denied(403,"The practice owner must complete setup in the current payment mode before using the workspace.","permission",userId,providerId);
  return null;
}

/**
 * Answer a refused office-scope resolution and, when an authenticated caller
 * was turned away from a sensitive route, leave an audit trail of the
 * attempt. Anonymous / expired tokens (401) are not recorded.
 */
export function respondOfficeScopeDenied(req: Request, res: Response, result: OfficeScopeDenied): void {
  res.status(result.status).json({ error: result.message });
  if (result.status !== 403 || !result.actorUserId) return;
  const reason =
    result.reason === "deactivated" || result.reason === "office_locked" ||
    result.reason === "office_unavailable" || result.reason === "staff_only" ||
    result.reason === "office_offboarded"
      ? result.reason
      : "permission";
  recordAccessDenied(req, {
    actorUserId: result.actorUserId,
    actorKind: result.reason === "permission" ? "hq" : "unknown",
    providerId: result.providerId,
    reason,
    status: result.status,
  });
}
