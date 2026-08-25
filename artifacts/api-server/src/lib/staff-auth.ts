/**
 * Staff authorization for the training-media routes.
 *
 * The operations web app signs users in with Supabase; the API server has no
 * session of its own. Callers forward their existing Supabase access token
 * (`Authorization: Bearer <token>`) and this module verifies it in two hops:
 *
 *   1. `GET {SUPABASE_URL}/auth/v1/user` with the caller's token — Supabase
 *      itself confirms the token is live (signature, expiry, revocation).
 *   2. `GET /rest/v1/profiles?id=eq.<uid>&select=role` with the service role
 *      key — roles come from the `staff_role_assignments`-synchronized
 *      profile row, never from claims a client could mint.
 *
 * Verified identities are cached for one minute per token so a lesson page
 * requesting playback URLs doesn't hammer Supabase; that window matches how
 * quickly a role revocation must bite (revocations also kill the session
 * server-side, which hop 1 sees on the next cold check).
 */
import type { NextFunction, Request, Response } from "express";

export type StaffRole = "hq_admin" | "provider_staff";

export interface StaffIdentity {
  userId: string;
  role: StaffRole;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

/** token → verified identity (or null for "valid request, not staff"). */
const cache = new Map<string, { identity: StaffIdentity | null; expiresAt: number }>();

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

function remember(token: string, identity: StaffIdentity | null): StaffIdentity | null {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(token, { identity, expiresAt: Date.now() + CACHE_TTL_MS });
  return identity;
}

/**
 * Resolve a Supabase access token to a staff identity.
 * Returns null for anything that is not a live staff/HQ session; throws only
 * when Supabase itself is unreachable (callers map that to 503, not 401 —
 * an outage must never read as "you are signed out").
 */
export async function verifyStaffToken(token: string): Promise<StaffIdentity | null> {
  const hit = cache.get(token);
  if (hit && hit.expiresAt > Date.now()) return hit.identity;
  cache.delete(token);

  const base = supabaseBase();
  const key = serviceKey();

  const userRes = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (userRes.status === 401 || userRes.status === 403) return remember(token, null);
  if (!userRes.ok) throw new Error(`Supabase auth check failed (${userRes.status})`);
  const user = (await userRes.json()) as { id?: string };
  if (!user.id) return remember(token, null);

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
  if (role !== "hq_admin" && role !== "provider_staff") return remember(token, null);
  return remember(token, { userId: user.id, role });
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
      identity = await verifyStaffToken(token);
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
