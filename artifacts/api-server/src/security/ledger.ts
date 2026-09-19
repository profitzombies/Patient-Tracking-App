/**
 * Sign-in ledger + live session reads (auth_sign_ins, account_security_state,
 * security_list_auth_sessions). Service-role only; nothing here ever touches
 * or returns a token.
 *
 * Lifecycle of one row:
 *   verify route ──recordSignIn──▶ row (facts, new_device decided here)
 *   client verifyOtp, then ──attachSession──▶ row.session_id
 *   sign-out others / force sign-out / recovery ──markRevoked──▶ revoked_at
 *
 * "New device" = the user already has sign-ins on record and none of them
 * carries this fingerprint. A first-ever sign-in is not "new" (nothing to
 * compare against), so fresh accounts do not get an alert about themselves.
 */
import crypto from "node:crypto";
import { supabaseAdmin } from "../lib/supabase-admin";
import { logger } from "../lib/logger";
import { revokeUserSessions, type SessionRevocationReason } from "../auth/session-revocations";
import {
  describeUserAgent,
  fingerprintOf,
  platformOf,
  plainIp,
  sessionRef,
  userAgentOf,
  type Platform,
} from "./device";
import { lookupRegion, regionFromHeaders } from "./geo";

const enc = encodeURIComponent;

export type SignInMethod =
  | "email_code"
  | "sms_code"
  | "password_sms_code"
  | "password_email_code"
  | "email_sms_code"
  | "signup"
  | "claim";
export type Realm = "patient" | "staff";
export type RevokeReason =
  | "signed_out_others"
  | "password_changed"
  | "recovery"
  | "reported"
  | "staff_forced"
  | "hq_forced"
  | "lost_device"
  | "suspicious_activity"
  | "patient_request"
  | "other";

export interface SignInRow {
  id: string;
  user_id: string;
  realm: Realm;
  method: SignInMethod;
  platform: Platform;
  user_agent: string | null;
  ip_region: string | null;
  device_fingerprint: string;
  device_label: string | null;
  new_device: boolean;
  session_id: string | null;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  reported_at: string | null;
  report_token_hash: string | null;
  report_token_expires_at: string | null;
  /** Last one-time code proof for this session (sign-in or inline re-authentication). */
  code_verified_at?: string | null;
}

export interface SecurityStateRow {
  user_id: string;
  force_password_reset: boolean;
  forced_reason: string | null;
  forced_at: string | null;
  password_changed_at: string | null;
  updated_at: string;
}

interface AuthSessionRow {
  session_id: string;
  created_at: string;
  updated_at: string | null;
  refreshed_at: string | null;
  not_after: string | null;
  user_agent: string | null;
  ip: string | null;
}

const SIGN_IN_SELECT =
  "id,user_id,realm,method,platform,user_agent,ip_region,device_fingerprint,device_label,new_device,session_id," +
  "created_at,last_seen_at,revoked_at,revoked_reason,reported_at,report_token_hash,report_token_expires_at,code_verified_at";

/** Verify routes hand this over; it is what the request already knows. */
export interface SignInRequestFacts {
  headers: Record<string, unknown>;
  ip: string;
}

export interface RecordedSignIn {
  row: SignInRow;
  /** Set when the sign-in should raise a new-device alert. */
  newDevice: boolean;
  /** One-time "this wasn't me" token for email alerts (only minted when newDevice). */
  reportToken: string | null;
}

export const REPORT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256Hex(value: string): string {
  return sha256(value);
}

/** Insert the ledger row for a sign-in the API just minted. Throws on failure. */
export async function recordSignIn(input: {
  userId: string;
  realm: Realm;
  method: SignInMethod;
  request: SignInRequestFacts;
  /** Already-known GoTrue session (inline re-authentication of a session with no ledger row). */
  sessionId?: string | null;
}): Promise<RecordedSignIn> {
  const { headers, ip } = input.request;
  const platform = platformOf(headers);
  const ua = userAgentOf(headers);
  const { fingerprint } = fingerprintOf(headers);
  const priorRes = await supabaseAdmin(
    "GET",
    `/rest/v1/auth_sign_ins?user_id=eq.${enc(input.userId)}&select=id,device_fingerprint&order=created_at.desc&limit=200`,
  );
  if (priorRes.status >= 300) throw new Error(`sign-in ledger read failed (${priorRes.status})`);
  const prior = Array.isArray(priorRes.json) ? (priorRes.json as Array<{ device_fingerprint: string }>) : [];
  const newDevice = prior.length > 0 && !prior.some((row) => row.device_fingerprint === fingerprint);
  const reportToken = newDevice ? crypto.randomBytes(32).toString("hex") : null;
  const inserted = await supabaseAdmin(
    "POST",
    "/rest/v1/auth_sign_ins",
    {
      user_id: input.userId,
      realm: input.realm,
      method: input.method,
      platform,
      user_agent: ua,
      ip_region: regionFromHeaders(headers),
      device_fingerprint: fingerprint,
      device_label: describeUserAgent(ua, platform),
      new_device: newDevice,
      report_token_hash: reportToken ? sha256(reportToken) : null,
      report_token_expires_at: reportToken ? new Date(Date.now() + REPORT_TOKEN_TTL_MS).toISOString() : null,
      // Every sign-in method proves a one-time code (or a password + code),
      // so the session starts with a fresh proof for the sensitive-action gate.
      code_verified_at: new Date().toISOString(),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
    },
    "return=representation",
  );
  if (inserted.status >= 300 || !Array.isArray(inserted.json) || !inserted.json[0]) {
    throw new Error(`sign-in ledger insert failed (${inserted.status})`);
  }
  const row = inserted.json[0] as SignInRow;
  if (!row.ip_region) {
    // Region lookup rides after the response: never in the sign-in's critical path.
    void lookupRegion(plainIp(ip))
      .then(async (region) => {
        if (!region) return;
        await supabaseAdmin("PATCH", `/rest/v1/auth_sign_ins?id=eq.${enc(row.id)}&ip_region=is.null`, { ip_region: region });
      })
      .catch((error) => logger.warn({ err: error }, "sign-in region lookup failed"));
  }
  return { row, newDevice, reportToken };
}

/** Link the client's GoTrue session to its ledger row (user must match, once). */
export async function attachSession(input: { signInId: string; userId: string; sessionId: string }): Promise<boolean> {
  const patched = await supabaseAdmin(
    "PATCH",
    `/rest/v1/auth_sign_ins?id=eq.${enc(input.signInId)}&user_id=eq.${enc(input.userId)}&session_id=is.null`,
    { session_id: input.sessionId, last_seen_at: new Date().toISOString() },
    "return=representation",
  );
  if (patched.status === 409) return false; // session already attached elsewhere
  if (patched.status >= 300) throw new Error(`sign-in attach failed (${patched.status})`);
  return Array.isArray(patched.json) && patched.json.length === 1;
}

export async function listSignIns(userId: string, limit = 20): Promise<SignInRow[]> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/auth_sign_ins?user_id=eq.${enc(userId)}&select=${SIGN_IN_SELECT}&order=created_at.desc&limit=${limit}`,
  );
  if (res.status >= 300) throw new Error(`sign-in ledger list failed (${res.status})`);
  return Array.isArray(res.json) ? (res.json as SignInRow[]) : [];
}

export async function loadSignIn(id: string): Promise<SignInRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await supabaseAdmin("GET", `/rest/v1/auth_sign_ins?id=eq.${enc(id)}&select=${SIGN_IN_SELECT}&limit=1`);
  if (res.status >= 300) throw new Error(`sign-in lookup failed (${res.status})`);
  return Array.isArray(res.json) && res.json[0] ? (res.json[0] as SignInRow) : null;
}

export async function loadSignInByReportToken(token: string): Promise<SignInRow | null> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/auth_sign_ins?report_token_hash=eq.${enc(sha256(token))}&select=${SIGN_IN_SELECT}&limit=1`,
  );
  if (res.status >= 300) throw new Error(`sign-in report lookup failed (${res.status})`);
  const row = Array.isArray(res.json) && res.json[0] ? (res.json[0] as SignInRow) : null;
  if (!row || !row.report_token_expires_at || new Date(row.report_token_expires_at).getTime() < Date.now()) return null;
  return row;
}

/** Stamp revoked_at on the user's still-live rows (optionally sparing one session). */
export async function markRevoked(input: { userId: string; reason: RevokeReason; exceptSessionId?: string | null }): Promise<void> {
  const except = input.exceptSessionId ? `&session_id=neq.${enc(input.exceptSessionId)}` : "";
  const res = await supabaseAdmin(
    "PATCH",
    `/rest/v1/auth_sign_ins?user_id=eq.${enc(input.userId)}&revoked_at=is.null${except}`,
    { revoked_at: new Date().toISOString(), revoked_reason: input.reason },
  );
  if (res.status >= 300) throw new Error(`sign-in revoke mark failed (${res.status})`);
}

export async function markReported(id: string): Promise<void> {
  const res = await supabaseAdmin("PATCH", `/rest/v1/auth_sign_ins?id=eq.${enc(id)}&reported_at=is.null`, {
    reported_at: new Date().toISOString(),
    report_token_hash: null,
    report_token_expires_at: null,
  });
  if (res.status >= 300) throw new Error(`sign-in report mark failed (${res.status})`);
}

export async function touchSession(sessionId: string): Promise<void> {
  const res = await supabaseAdmin("PATCH", `/rest/v1/auth_sign_ins?session_id=eq.${enc(sessionId)}`, {
    last_seen_at: new Date().toISOString(),
  });
  if (res.status >= 300) logger.warn({ status: res.status }, "sign-in last_seen update failed");
}

// ── Live GoTrue sessions ─────────────────────────────────────────────────────

export async function listAuthSessions(userId: string): Promise<AuthSessionRow[]> {
  const res = await supabaseAdmin("POST", "/rest/v1/rpc/security_list_auth_sessions", { p_user_id: userId });
  if (res.status >= 300) throw new Error(`auth session list failed (${res.status})`);
  return Array.isArray(res.json) ? (res.json as AuthSessionRow[]) : [];
}

/**
 * Every session for the user (the server-side "sign out everywhere"): one
 * atomic RPC lists the session ids on the server's revocation list and ends
 * the GoTrue sessions (GoTrue on this project serves no per-user admin
 * logout route — it answers "404 page not found" — so the sessions are
 * ended the way GoTrue's own global logout does it, by deleting the user's
 * auth.sessions rows, refresh tokens included). A refused write signs
 * nothing out and reports failure, so the caller can safely retry.
 */
export async function adminLogoutAll(userId: string, reason: SessionRevocationReason = "admin_logout"): Promise<boolean> {
  try {
    await revokeUserSessions({ userId, reason });
    return true;
  } catch (error) {
    logger.error({ err: error, userId }, "session revocation failed; admin logout aborted");
    return false;
  }
}

/**
 * Every session except the caller's own. Same atomic RPC, sparing the
 * session behind the caller's token. A token without a session claim cannot
 * be spared, so every session (the caller's too) is ended — the safe side.
 */
export async function logoutOthers(
  owner: { userId: string; sessionId: string | null; reason?: SessionRevocationReason },
): Promise<boolean> {
  const { userId, sessionId } = owner;
  try {
    await revokeUserSessions({ userId, reason: owner.reason ?? "signed_out_others", exceptSessionId: sessionId });
    return true;
  } catch (error) {
    logger.error({ err: error, userId }, "session revocation failed; logout-others aborted");
    return false;
  }
}

// ── Security state (forced reset) ────────────────────────────────────────────

export async function loadSecurityState(userId: string): Promise<SecurityStateRow | null> {
  const res = await supabaseAdmin("GET", `/rest/v1/account_security_state?user_id=eq.${enc(userId)}&select=*&limit=1`);
  if (res.status >= 300) throw new Error(`security state read failed (${res.status})`);
  return Array.isArray(res.json) && res.json[0] ? (res.json[0] as SecurityStateRow) : null;
}

export async function setForcedReset(userId: string, forced: boolean, reason: string | null): Promise<void> {
  const now = new Date().toISOString();
  const res = await supabaseAdmin(
    "POST",
    "/rest/v1/account_security_state?on_conflict=user_id",
    {
      user_id: userId,
      force_password_reset: forced,
      forced_reason: forced ? reason : null,
      forced_at: forced ? now : null,
      updated_at: now,
    },
    "resolution=merge-duplicates,return=minimal",
  );
  if (res.status >= 300) throw new Error(`security state write failed (${res.status})`);
}

export async function stampPasswordChanged(userId: string): Promise<void> {
  const now = new Date().toISOString();
  const res = await supabaseAdmin(
    "POST",
    "/rest/v1/account_security_state?on_conflict=user_id",
    { user_id: userId, force_password_reset: false, forced_reason: null, forced_at: null, password_changed_at: now, updated_at: now },
    "resolution=merge-duplicates,return=minimal",
  );
  if (res.status >= 300) throw new Error(`security state write failed (${res.status})`);
}

// ── DTOs (what browsers and apps may see) ────────────────────────────────────

export interface SignInDto {
  id: string;
  at: string;
  method: SignInMethod;
  methodLabel: string;
  platform: Platform;
  device: string;
  region: string | null;
  newDevice: boolean;
  revokedAt: string | null;
  revokedReason: RevokeReason | null;
  reportedAt: string | null;
  /** True while the session behind this sign-in is still live. */
  active: boolean;
  /** True when this sign-in is the caller's current session. */
  current: boolean;
}

export interface SessionDto {
  ref: string;
  createdAt: string;
  lastSeenAt: string;
  device: string;
  platform: Platform;
  region: string | null;
  method: SignInMethod | null;
  signInId: string | null;
  current: boolean;
}

export function methodLabel(method: SignInMethod): string {
  switch (method) {
    case "email_code":
      return "Emailed code";
    case "sms_code":
      return "Texted code";
    case "password_sms_code":
      return "Password + texted code";
    case "password_email_code":
      return "Password + emailed code";
    case "email_sms_code":
      return "Emailed code + texted code";
    case "signup":
      return "Account created";
    case "claim":
      return "Account claimed";
  }
}

/** Sign-in history + live sessions for one user, joined on session id. */
export async function securityOverview(userId: string, currentSessionId: string | null): Promise<{ signIns: SignInDto[]; sessions: SessionDto[] }> {
  const [signIns, sessions] = await Promise.all([listSignIns(userId), listAuthSessions(userId)]);
  const liveIds = new Set(sessions.map((s) => s.session_id));
  const bySession = new Map(signIns.filter((s) => s.session_id).map((s) => [s.session_id as string, s]));
  const sessionDtos: SessionDto[] = sessions.map((session) => {
    const ledger = bySession.get(session.session_id) ?? null;
    const platform = ledger?.platform ?? platformOf({ "user-agent": session.user_agent ?? "" });
    return {
      ref: sessionRef(session.session_id),
      createdAt: session.created_at,
      lastSeenAt: session.refreshed_at ?? session.updated_at ?? session.created_at,
      device: ledger?.device_label ?? describeUserAgent(session.user_agent, platform),
      platform,
      region: ledger?.ip_region ?? null,
      method: ledger?.method ?? null,
      signInId: ledger?.id ?? null,
      current: currentSessionId !== null && session.session_id === currentSessionId,
    };
  });
  const signInDtos: SignInDto[] = signIns.map((row) => ({
    id: row.id,
    at: row.created_at,
    method: row.method,
    methodLabel: methodLabel(row.method),
    platform: row.platform,
    device: row.device_label ?? describeUserAgent(row.user_agent, row.platform),
    region: row.ip_region,
    newDevice: row.new_device,
    revokedAt: row.revoked_at,
    revokedReason: (row.revoked_reason as RevokeReason | null) ?? null,
    reportedAt: row.reported_at,
    active: row.session_id !== null && liveIds.has(row.session_id) && !row.revoked_at,
    current: currentSessionId !== null && row.session_id === currentSessionId,
  }));
  return { signIns: signInDtos, sessions: sessionDtos };
}
