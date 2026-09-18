/**
 * Turn a bearer token into an auth user — locally when the policy allows,
 * remotely (Supabase Auth) where instant revocation matters.
 *
 * Local path: verify the JWT against the project's published keys, then
 * refuse it if its session id is on the server's revocation list (the list
 * is checked on the remote path as well, so a server-side sign-out holds on
 * every route). Anything
 * the local verifier cannot decide (legacy symmetric tokens, an unknown key
 * after one JWKS refresh, JWKS unreachable, strings that are not JWTs) goes
 * to the remote lookup, which answers exactly as it did before local
 * verification existed.
 *
 * Contract shared with `fetchAuthUser`: null means "not signed in"; a throw
 * means "could not tell" and callers answer 503 — an outage must never read
 * as "signed out".
 */
import { fetchAuthUser, type AuthUser } from "../lib/supabase-admin";
import { verifyAccessTokenLocally } from "./access-token";
import { isSessionRevoked } from "./session-revocations";
import { verificationModeFor, type VerificationMode, type VerificationRequest } from "./verification-policy";

export interface IdentifiedUser extends AuthUser {
  /** GoTrue session id claim (null for tokens without one). */
  sessionId: string | null;
  /** How this identity was established. */
  verifiedBy: VerificationMode;
}

export type { VerificationMode, VerificationRequest };

/** Pull the bearer token out of an Authorization header value. */
export function bearerOf(authorization: unknown): string {
  const header = typeof authorization === "string" ? authorization : "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function unverifiedSessionId(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { session_id?: unknown };
    return typeof payload.session_id === "string" && /^[0-9a-f-]{36}$/i.test(payload.session_id) ? payload.session_id : null;
  } catch {
    return null;
  }
}

async function identifyRemotely(token: string): Promise<IdentifiedUser | null> {
  const user = await fetchAuthUser(token);
  if (!user) return null;
  // GoTrue vouched for the token, so its session claim is genuine. The
  // revocation list is authoritative on every route: a session the server
  // signed out is refused here too, even before GoTrue's own state catches up.
  const sessionId = unverifiedSessionId(token);
  if (sessionId && (await isSessionRevoked(sessionId))) return null;
  return { ...user, sessionId, verifiedBy: "remote" };
}

/**
 * Identify the caller behind `token`. `mode` normally comes from
 * `verificationModeFor(req)`; pass "remote" explicitly for flows that must
 * always confirm with Supabase Auth regardless of path.
 */
export async function identifyBearer(token: string, mode: VerificationMode): Promise<IdentifiedUser | null> {
  if (!token) return null;
  if (mode === "remote") return identifyRemotely(token);

  const local = await verifyAccessTokenLocally(token);
  if (local.outcome === "rejected") return null;
  if (local.outcome === "unverifiable") return identifyRemotely(token);
  // A genuine token with no session claim cannot be checked against the
  // revocation list, so it does not get the local shortcut.
  if (!local.sessionId) return identifyRemotely(token);
  if (await isSessionRevoked(local.sessionId)) return null;
  return { ...local.user, sessionId: local.sessionId, verifiedBy: "local" };
}

/** Convenience: identify the caller of an Express-shaped request per policy. */
export async function identifyRequest(
  req: VerificationRequest & { headers: Record<string, unknown> },
  override?: VerificationMode,
): Promise<IdentifiedUser | null> {
  return identifyBearer(bearerOf(req.headers.authorization), override ?? verificationModeFor(req));
}
