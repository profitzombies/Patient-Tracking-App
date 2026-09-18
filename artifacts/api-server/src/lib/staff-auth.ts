/**
 * Staff authorization for HQ routes.
 *
 * The operations web app signs users in with Supabase; the API server has no
 * session of its own. Callers forward their existing Supabase access token
 * (`Authorization: Bearer <token>`) and this module verifies it in two hops:
 *
 *   1. The token is verified — locally against the project's signing keys
 *      plus the server's session revocation list, or by Supabase Auth itself
 *      for the route families `auth/verification-policy.ts` marks remote.
 *   2. `GET /rest/v1/hq_memberships` (then the legacy profile row) with the
 *      service role key — roles come from durable membership rows, never
 *      from claims a client could mint.
 */
import type { NextFunction, Request, Response } from "express";
import { identifyBearer } from "../auth/identify";
import { verificationModeFor, type VerificationMode } from "../auth/verification-policy";
import { recordAccessDenied } from "./admin-audit";

export type StaffRole = "hq_admin";
export type HqDepartmentRole = "super_admin" | "admin" | "clinical" | "support" | "content";
export type HqPermission =
  | "team_manage"
  | "settings_manage"
  | "provider_manage"
  | "provider_read"
  | "provider_contact_read"
  | "clinical_read"
  | "analytics_read"
  | "conversation_clinical"
  | "conversation_support"
  | "content_manage"
  | "financial_read"
  | "account_lock"
  | "audit_read";

export interface StaffIdentity {
  userId: string;
  role: StaffRole;
  /** The active durable membership role (legacy HQ admins are treated as admin). */
  departmentRole: HqDepartmentRole;
}

const PERMISSIONS: Record<HqDepartmentRole, readonly HqPermission[]> = {
  super_admin: ["team_manage", "settings_manage", "provider_manage", "provider_read", "provider_contact_read", "clinical_read", "analytics_read", "conversation_clinical", "conversation_support", "content_manage", "financial_read", "account_lock", "audit_read"],
  admin: ["team_manage", "settings_manage", "provider_manage", "provider_read", "provider_contact_read", "clinical_read", "analytics_read", "conversation_clinical", "conversation_support", "content_manage", "financial_read", "account_lock", "audit_read"],
  clinical: ["provider_read", "provider_contact_read", "clinical_read", "analytics_read", "conversation_clinical"],
  support: ["provider_contact_read", "conversation_support"],
  content: ["content_manage"],
};

function isDepartmentRole(value: unknown): value is HqDepartmentRole {
  return value === "super_admin" || value === "admin" || value === "clinical" ||
    value === "support" || value === "content";
}

export function hasHqPermission(identity: StaffIdentity, permission: HqPermission): boolean {
  return PERMISSIONS[identity.departmentRole].includes(permission);
}

function supabaseBase(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return url.replace(/\/$/, "");
}

function serviceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return key;
}

/**
 * Resolve a Supabase access token to a staff identity.
 * Returns null for anything that is not a live staff/HQ session; throws only
 * when Supabase itself is unreachable (callers map that to 503, not 401 —
 * an outage must never read as "you are signed out").
 */
export async function verifyStaffToken(
  token: string,
  options: { verification?: VerificationMode } = {},
): Promise<StaffIdentity | null> {
  const user = await identifyBearer(token, options.verification ?? "local");
  if (!user) return null;
  return staffIdentityForUser(user.id);
}

/**
 * Membership lookup for an ALREADY verified auth user id. Split out so a
 * caller that has just identified the bearer (office scope) does not verify
 * the same token twice.
 */
export async function staffIdentityForUser(userId: string): Promise<StaffIdentity | null> {
  const base = supabaseBase();
  const key = serviceKey();
  const user = { id: userId };

  // Always inspect memberships before considering the legacy profile. In
  // particular, a revoked membership must not fall through to a stale
  // `profiles.role = hq_admin` row.
  const membershipRes = await fetch(
    `${base}/rest/v1/hq_memberships?auth_user_id=eq.${encodeURIComponent(user.id)}&select=department_role,status&limit=2`,
    {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!membershipRes.ok) throw new Error(`Supabase membership check failed (${membershipRes.status})`);
  const memberships = (await membershipRes.json()) as Array<{ department_role?: unknown; status?: unknown }>;
  const activeRole = memberships
    .filter((membership) => membership.status === "active")
    .map((membership) => membership.department_role)
    .find(isDepartmentRole);
  if (activeRole) {
    return { userId: user.id, role: "hq_admin", departmentRole: activeRole };
  }
  // A durable row is authoritative even when it is invited or revoked.
  if (memberships.length > 0) return null;

  // Temporary compatibility for installations which have not yet created a
  // durable membership for an existing HQ admin.
  const profileRes = await fetch(
    `${base}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role`,
    {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!profileRes.ok) throw new Error(`Supabase profile check failed (${profileRes.status})`);
  const rows = (await profileRes.json()) as Array<{ role?: string }>;
  const role = rows[0]?.role;
  if (role !== "hq_admin") return null;
  return { userId: user.id, role, departmentRole: "admin" };
}

/**
 * Express guard: verifies the bearer token and requires one of `roles`.
 * On success the identity lands in `res.locals.staff`.
 */
export function requireStaff(roles: readonly StaffRole[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    let identity: StaffIdentity | null;
    try {
      identity = await verifyStaffToken(token, { verification: verificationModeFor(req) });
    } catch (error) {
      req.log?.error({ err: error }, "staff token verification unavailable");
      res.status(503).json({ error: "Could not verify your session — try again in a moment." });
      return;
    }
    if (!identity) {
      res.status(401).json({ error: "Sign in with a staff account to continue." });
      return;
    }
    if (!roles.includes(identity.role)) {
      res.status(403).json({ error: "Only HQ administrators can do this." });
      return;
    }
    res.locals.staff = identity;
    next();
  };
}

/** Require one explicit HQ permission. Unknown permissions are impossible at
 * the type level and identities without an active membership fail closed. */
export function requireHqPermission(permission: HqPermission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    let identity: StaffIdentity | null;
    try {
      identity = await verifyStaffToken(token, { verification: verificationModeFor(req) });
    } catch (error) {
      req.log?.error({ err: error }, "staff token verification unavailable");
      res.status(503).json({ error: "Could not verify your session — try again in a moment." });
      return;
    }
    if (!identity) {
      res.status(401).json({ error: "Sign in with an active HQ account to continue." });
      return;
    }
    if (!hasHqPermission(identity, permission)) {
      res.status(403).json({ error: "Your HQ role does not have permission to do this." });
      recordAccessDenied(req, {
        actorUserId: identity.userId,
        actorKind: "hq",
        reason: "permission",
        status: 403,
      });
      return;
    }
    res.locals.staff = identity;
    next();
  };
}
