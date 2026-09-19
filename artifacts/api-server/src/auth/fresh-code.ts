/**
 * Fresh-code gate for the most sensitive staff actions (whole-office exports,
 * team role changes and deactivations, forced sign-outs).
 *
 * A staff session lives for days, but these actions need proof that the
 * person at the keyboard is still the account holder: a one-time code
 * proven within the last FRESH_CODE_WINDOW_MS. The proof time is
 * `auth_sign_ins.code_verified_at` on the ledger row backing the caller's
 * GoTrue session — set when the sign-in code was verified, refreshed by the
 * inline re-authentication flow (POST /security/me/reauth/verify).
 *
 * Routes call `requireFreshCode(req, res, userId)` AFTER their own
 * authorization; when the proof is stale (or the session has no ledger row
 * at all) it answers 401 with `code: "reauth_required"` and the web client
 * opens its re-authentication sheet, then retries the action.
 */
import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase-admin";
import { bearerOf, sessionIdOfToken } from "./identify";

export const FRESH_CODE_WINDOW_MINUTES = 10;
export const FRESH_CODE_WINDOW_MS = FRESH_CODE_WINDOW_MINUTES * 60 * 1000;
export const REAUTH_REQUIRED_CODE = "reauth_required";
/** Scope key prefix binding a re-authentication send to one staff account. */
export const STAFF_REAUTH_SCOPE_PREFIX = "staff-reauth:";
export const REAUTH_REQUIRED_MESSAGE = "For security, confirm it's you with a fresh code before continuing.";

const enc = encodeURIComponent;

/** The session id claim of the (already verified) bearer on this request. */
export function sessionIdOfRequest(req: { headers: Record<string, unknown> }): string | null {
  return sessionIdOfToken(bearerOf(req.headers.authorization));
}

/**
 * When a code was last proven for this user's current session (ISO), or
 * null when the session has no live ledger row or never proved a code.
 */
export async function lastCodeVerifiedAt(userId: string, sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/auth_sign_ins?user_id=eq.${enc(userId)}&session_id=eq.${enc(sessionId)}&revoked_at=is.null` +
      "&select=code_verified_at&order=code_verified_at.desc.nullslast&limit=1",
  );
  if (result.status >= 300) throw new Error(`fresh-code lookup failed (${result.status})`);
  const row = Array.isArray(result.json) ? (result.json[0] as { code_verified_at?: unknown } | undefined) : undefined;
  return typeof row?.code_verified_at === "string" ? row.code_verified_at : null;
}

export function isFresh(codeVerifiedAt: string | null, now = Date.now()): boolean {
  if (!codeVerifiedAt) return false;
  const at = new Date(codeVerifiedAt).getTime();
  return Number.isFinite(at) && now - at <= FRESH_CODE_WINDOW_MS;
}

/** What the client needs to decide whether to pre-empt the gate. */
export async function freshCodeState(userId: string, sessionId: string | null): Promise<{ codeVerifiedAt: string | null; fresh: boolean }> {
  const codeVerifiedAt = await lastCodeVerifiedAt(userId, sessionId);
  return { codeVerifiedAt, fresh: isFresh(codeVerifiedAt) };
}

/**
 * Gate a sensitive action. Returns true when the caller may proceed;
 * otherwise the 401 has already been written. A ledger outage fails closed
 * (503, retryable) rather than letting the action through unproven.
 */
export async function requireFreshCode(req: Request, res: Response, userId: string): Promise<boolean> {
  let state: { fresh: boolean };
  try {
    state = await freshCodeState(userId, sessionIdOfRequest(req));
  } catch (error) {
    req.log?.error({ err: error }, "fresh-code check failed");
    res.status(503).json({ error: "Could not confirm your recent sign-in right now. Try again in a moment.", retryable: true });
    return false;
  }
  if (state.fresh) return true;
  res.status(401).json({ error: REAUTH_REQUIRED_MESSAGE, code: REAUTH_REQUIRED_CODE, windowMinutes: FRESH_CODE_WINDOW_MINUTES });
  return false;
}

/**
 * Record a fresh code proof on the ledger row backing this session. True
 * when a row was stamped; false when the session has no ledger row (the
 * caller then records one).
 */
export async function stampCodeVerified(userId: string, sessionId: string, at = new Date().toISOString()): Promise<boolean> {
  const patched = await supabaseAdmin(
    "PATCH",
    `/rest/v1/auth_sign_ins?user_id=eq.${enc(userId)}&session_id=eq.${enc(sessionId)}&revoked_at=is.null`,
    { code_verified_at: at, last_seen_at: at },
    "return=representation",
  );
  if (patched.status >= 300) throw new Error(`fresh-code stamp failed (${patched.status})`);
  return Array.isArray(patched.json) && patched.json.length > 0;
}
