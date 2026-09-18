/**
 * Server-side session revocation list.
 *
 * Locally verified tokens never ask GoTrue whether the session behind them
 * is still alive, so every place the server signs sessions out (admin
 * "sign out everywhere", "sign out other devices", forced staff sign-outs,
 * purge) first records the affected session ids here. The per-request check
 * is one indexed lookup by session id; rows carry their own expiry (the
 * latest moment an access token minted for that session could still be
 * valid) so the list never grows past the live-token horizon, and a sweep
 * job deletes what has lapsed.
 *
 * Listing and ending sessions happen in ONE database statement, so a
 * session can never be ended without being listed (or the reverse), and a
 * failure leaves everything signed in for a clean retry: reporting "signed
 * out" while a locally verified token would keep working until it expires
 * is exactly the outcome this list exists to prevent.
 */
import { supabaseAdmin } from "../lib/supabase-admin";

const enc = encodeURIComponent;
export const SESSION_REVOCATIONS_TABLE = "auth_session_revocations";
/**
 * Default horizon for a revoked session's access tokens: the longest JWT
 * lifetime Supabase allows (one week). Tighten via
 * AUTH_REVOCATION_ROW_TTL_SECONDS to the project's real `jwt_exp` once it is
 * pinned; never set it below that value.
 */
const DEFAULT_ROW_TTL_SECONDS = 7 * 24 * 3600;

export type SessionRevocationReason =
  | "admin_logout"
  | "signed_out_others"
  | "password_changed"
  | "reported"
  | "purge"
  | (string & {});

export function revocationRowTtlSeconds(): number {
  const raw = process.env.AUTH_REVOCATION_ROW_TTL_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ROW_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ROW_TTL_SECONDS;
  return Math.floor(parsed);
}

/**
 * Sign a user's GoTrue sessions out server-side, atomically: ONE SQL
 * statement (`security_revoke_auth_sessions`) puts every targeted session
 * id on the list — with its own expiry, computed in SQL from the session's
 * latest (re)issue plus the token horizon, capped by `not_after` — and
 * deletes the same `auth.sessions` rows (refresh tokens cascade). No row
 * cap, and no window in which a session is ended without being listed or
 * listed without being ended; a session opened after the statement's
 * snapshot is a new login and stays valid.
 *
 * `exceptSessionId` spares one session ("sign out other devices"). Without
 * it every session goes, the caller's included.
 *
 * Returns the number of sessions revoked. Throws when the database refuses
 * — callers must then NOT report the sign-out as complete.
 */
export async function revokeUserSessions(input: {
  userId: string;
  reason: SessionRevocationReason;
  exceptSessionId?: string | null;
}): Promise<number> {
  const res = await supabaseAdmin("POST", "/rest/v1/rpc/security_revoke_auth_sessions", {
    p_user_id: input.userId,
    p_reason: String(input.reason).slice(0, 40),
    p_ttl_seconds: revocationRowTtlSeconds(),
    p_except_session_id: input.exceptSessionId ?? null,
  });
  if (res.status >= 300) throw new Error(`session revocation failed (${res.status})`);
  const count = typeof res.json === "number" ? res.json : Number(res.json);
  return Number.isFinite(count) ? count : 0;
}

/**
 * Is this session on the list? One indexed lookup; throws when the database
 * cannot answer (callers map that to 503 — an outage must never read as
 * "still signed in").
 */
export async function isSessionRevoked(sessionId: string, now: Date = new Date()): Promise<boolean> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/${SESSION_REVOCATIONS_TABLE}?session_id=eq.${enc(sessionId)}&expires_at=gt.${enc(now.toISOString())}&select=session_id&limit=1`,
  );
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`session revocation lookup failed (${res.status})`);
  return res.json.length > 0;
}

/** Delete rows whose expiry has passed. Returns the number deleted (0 when unknown). */
export async function sweepExpiredRevocations(now: Date = new Date()): Promise<number> {
  const res = await supabaseAdmin(
    "DELETE",
    `/rest/v1/${SESSION_REVOCATIONS_TABLE}?expires_at=lt.${enc(now.toISOString())}`,
    undefined,
    "return=minimal,count=exact",
  );
  if (res.status >= 300) throw new Error(`session revocation sweep failed (${res.status})`);
  const range = res.contentRange ?? "";
  const total = range.includes("/") ? Number(range.split("/")[1]) : NaN;
  return Number.isFinite(total) ? total : 0;
}
