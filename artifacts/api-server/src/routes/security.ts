/**
 * Account security — /api/security
 *
 * Self-service for anyone signed in (patient or staff):
 *   GET  /security/me                       recent sign-ins + live sessions
 *   POST /security/me/attach                link the fresh GoTrue session to its ledger row
 *   POST /security/me/sign-out-others       end every session but this one
 *   POST /security/me/sign-ins/:id/report   "this wasn't me" (signed in)
 *   POST /security/me/password/start        patient: prove current password, get a code
 *   POST /security/me/password/complete     patient: code + new password
 *
 * From an alert email, without a session:
 *   POST /security/report { token }         "this wasn't me" via one-time token
 *
 * HQ, on a patient record (never an office login — a patient's sessions are
 * not an office's business, but HQ answers the lost-phone call):
 *   GET  /office/patients/:id/sessions?office=
 *   POST /office/patients/:id/sign-out?office=  { reason }
 *
 * Rules that hold everywhere here:
 *   * No response ever carries a session token, refresh token, or raw GoTrue
 *     session id — sessions are named by an opaque ref.
 *   * Nothing reveals whether an identifier exists: every route needs either
 *     a live session or a 256-bit token; failures share one generic message.
 *   * Every action that changes a session or password is audited with an
 *     enum reason, never free text.
 */
import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { acquireSecuritySlot } from "../auth/limits";
import { clientIp, holdUntilFloor, patchRow, sha256 } from "../auth/ledger";
import { resolveOfficeScope, respondOfficeScopeDenied } from "../auth/office-scope";
import { updatePatientPassword, verifyPatientPassword } from "../auth/session";
import { DeliveryNotConfiguredError, assertLiveChannelReady, deliveryMode, holdUntilSmsDeliveryFloor, sendClaimEmail } from "../claim/delivery";
import { normalizeIdentifier, passwordIssue } from "../claim/normalize";
import { recordAdminAuditEvent, requestIdOf, type AuditActorKind } from "../lib/admin-audit";
import { supabaseAdmin } from "../lib/supabase-admin";
import { describeAccount, resolveSecurityActor, type SecurityActor } from "../security/actor";
import { sendPasswordChangedConfirmation } from "../security/alerts";
import { SessionContainmentError, respondSessionContainmentFailed } from "../security/sign-in-hooks";
import {
  REPORT_TOKEN_TTL_MS,
  adminLogoutAll,
  attachSession,
  loadSecurityState,
  loadSignIn,
  loadSignInByReportToken,
  logoutOthers,
  markReported,
  markRevoked,
  securityOverview,
  setForcedReset,
  stampPasswordChanged,
  touchSession,
  type RevokeReason,
  type SignInRow,
} from "../security/ledger";
import { claimCode, deliverSmsRegistered, matchCode, registerSend, spendUndelivered } from "./auth";

const router: IRouter = Router();
const enc = encodeURIComponent;

export const SECURITY_ME_PATH = "/security/me";
export const SECURITY_REPORT_PATH = "/security/report";

const SERVER_ERROR = "We couldn't process that just now. Please try again in a moment.";
const CODE_ERROR = "That code didn't match or has expired. Check it and try again.";
const PASSWORD_CHANGE_SIGN_OUT_FAILED =
  "We could not sign out your other devices just now, so your password was not changed. Try again in a moment.";
const CURRENT_PASSWORD_ERROR = "That doesn't match your current password.";
const PATIENTS_ONLY = "Only patient accounts have a password to change.";
const REPORT_LINK_ERROR = "That link has expired or was already used. Sign in and open Security to review your account.";
const CODE_SEND_ERROR = "We couldn't send a verification code right now. Check your connection and try again in a moment.";
const CODE_SEND_LIMIT = "Too many verification codes were requested. Wait a little while, then try again.";
const NO_CONTACT_ERROR = "Add a phone number or email address to your profile before changing your password.";

export const FORCE_SIGN_OUT_REASONS = ["lost_device", "suspicious_activity", "patient_request", "other"] as const;
export type ForceSignOutReason = (typeof FORCE_SIGN_OUT_REASONS)[number];
const ReasonSchema = z.object({ reason: z.enum(FORCE_SIGN_OUT_REASONS) });

function limited(req: Request, res: Response): { release: () => void } | null {
  const slot = acquireSecuritySlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return null;
  }
  return slot;
}

function actorKindOf(actor: SecurityActor): AuditActorKind {
  if (actor.realm === "patient") return "patient";
  return actor.staffKind === "hq" ? "hq" : actor.staffKind;
}

function audit(req: Request, actor: SecurityActor, action: string, metadata: Record<string, string | number | boolean | null>): void {
  void recordAdminAuditEvent({
    action,
    actorUserId: actor.userId,
    actorKind: actorKindOf(actor),
    providerId: actor.providerId,
    targetKind: actor.realm === "patient" ? "patient" : actor.staffKind === "hq" ? "hq_member" : actor.staffKind === "provider" ? "provider_account" : "team_member",
    targetId: actor.realm === "patient" ? actor.patientId : actor.ref,
    requestId: requestIdOf(req),
    metadata,
  }).catch((error) => req.log?.error({ err: error }, "security audit failed"));
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `•••-${digits.slice(-4)}` : "•••";
}

function maskEmail(email: string | null): string | null {
  if (!email || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

/**
 * "This wasn't me": every session must end FIRST; only then do patients go
 * on a forced reset, the ledger records why, and the token is spent. A
 * refused sweep is a hard stop that changes nothing — token live, state and
 * ledger untouched — and answers with a retryable failure: the one moment
 * nobody may be told "signed out" when they are not.
 */
async function lockDownAfterReport(req: Request, row: SignInRow, via: "session" | "email_link"): Promise<{ forcedReset: boolean }> {
  const actor = await describeAccount(row.user_id);
  const forcedReset = actor?.realm === "patient";
  const loggedOut = await adminLogoutAll(row.user_id);
  if (!loggedOut) {
    req.log?.error({ userId: row.user_id }, "report global logout failed");
    if (actor) audit(req, actor, "security_sign_in_reported", { via, sessions: "sign_out_failed", forcedReset, platform: row.platform });
    throw new SessionContainmentError();
  }
  if (forcedReset) await setForcedReset(row.user_id, true, "reported_sign_in");
  await markRevoked({ userId: row.user_id, reason: "reported" });
  await markReported(row.id);
  if (actor) {
    audit(req, actor, "security_sign_in_reported", { via, sessions: "signed_out", forcedReset, platform: row.platform });
  }
  return { forcedReset };
}

// ── Self-service ─────────────────────────────────────────────────────────────

router.get(SECURITY_ME_PATH, async (req, res) => {
  try {
    const resolved = await resolveSecurityActor(req);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const { actor, sessionId } = resolved;
    const [overview, state] = await Promise.all([securityOverview(actor.userId, sessionId), loadSecurityState(actor.userId)]);
    if (sessionId) void touchSession(sessionId);
    res.json({
      realm: actor.realm,
      canChangePassword: actor.realm === "patient",
      contact:
        actor.realm === "patient"
          ? { phone: maskPhone(actor.phone), email: maskEmail(actor.email) }
          : { phone: null, email: maskEmail(actor.email) },
      passwordChangedAt: state?.password_changed_at ?? null,
      currentSessionKnown: sessionId !== null,
      sessions: overview.sessions,
      signIns: overview.signIns,
    });
  } catch (error) {
    req.log?.error({ err: error }, "security overview failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.post(`${SECURITY_ME_PATH}/attach`, async (req, res) => {
  try {
    const resolved = await resolveSecurityActor(req);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const signInId = (req.body ?? {}).signInId;
    if (typeof signInId !== "string" || !/^[0-9a-f-]{36}$/i.test(signInId) || !resolved.sessionId) {
      res.status(400).json({ error: "Nothing to attach." });
      return;
    }
    const attached = await attachSession({ signInId, userId: resolved.actor.userId, sessionId: resolved.sessionId });
    res.json({ ok: true, attached });
  } catch (error) {
    req.log?.error({ err: error }, "security attach failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.post(`${SECURITY_ME_PATH}/sign-out-others`, async (req, res) => {
  const slot = limited(req, res);
  if (!slot) return;
  try {
    const resolved = await resolveSecurityActor(req);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const ok = await logoutOthers(resolved.token);
    if (!ok) {
      res.status(502).json({ error: "We couldn't sign out your other devices just now. Try again in a moment." });
      return;
    }
    await markRevoked({ userId: resolved.actor.userId, reason: "signed_out_others", exceptSessionId: resolved.sessionId });
    audit(req, resolved.actor, "security_sessions_signed_out", { scope: "others" });
    res.json({ ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "security sign-out-others failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.release();
  }
});

router.post(`${SECURITY_ME_PATH}/sign-ins/:id/report`, async (req, res) => {
  const slot = limited(req, res);
  if (!slot) return;
  try {
    const resolved = await resolveSecurityActor(req);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const row = await loadSignIn(String(req.params.id));
    if (!row || row.user_id !== resolved.actor.userId) {
      res.status(404).json({ error: "That sign-in isn't on your account." });
      return;
    }
    const outcome = await lockDownAfterReport(req, row, "session");
    res.json({ ok: true, signedOut: true, ...outcome });
  } catch (error) {
    if (error instanceof SessionContainmentError) {
      respondSessionContainmentFailed(res);
      return;
    }
    req.log?.error({ err: error }, "security report failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.release();
  }
});

router.post(SECURITY_REPORT_PATH, async (req, res) => {
  const slot = limited(req, res);
  if (!slot) return;
  const started = Date.now();
  try {
    const token = (req.body ?? {}).token;
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
      await holdUntilFloor(started);
      res.status(400).json({ error: REPORT_LINK_ERROR });
      return;
    }
    const row = await loadSignInByReportToken(token);
    if (!row) {
      await holdUntilFloor(started);
      res.status(400).json({ error: REPORT_LINK_ERROR });
      return;
    }
    const outcome = await lockDownAfterReport(req, row, "email_link");
    await holdUntilFloor(started);
    res.json({ ok: true, signedOut: true, realm: row.realm, ...outcome });
  } catch (error) {
    if (error instanceof SessionContainmentError) {
      await holdUntilFloor(started);
      respondSessionContainmentFailed(res);
      return;
    }
    req.log?.error({ err: error }, "security token report failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.release();
  }
});

// ── Change password (patients) ───────────────────────────────────────────────

router.post(`${SECURITY_ME_PATH}/password/start`, async (req, res) => {
  const slot = limited(req, res);
  if (!slot) return;
  const started = Date.now();
  try {
    const resolved = await resolveSecurityActor(req);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const { actor } = resolved;
    if (actor.realm !== "patient") {
      res.status(403).json({ error: PATIENTS_ONLY });
      return;
    }
    const currentPassword = (req.body ?? {}).currentPassword;
    if (typeof currentPassword !== "string" || !currentPassword) {
      res.status(400).json({ error: "Enter your current password.", field: "currentPassword" });
      return;
    }
    const valid = await verifyPatientPassword(actor.patientId, currentPassword);
    if (!valid) {
      await holdUntilFloor(started);
      res.status(401).json({ error: CURRENT_PASSWORD_ERROR, field: "currentPassword" });
      return;
    }
    // Code goes to the verified phone first (same channel as sign-in MFA),
    // else the verified email.
    const identifier = normalizeIdentifier(actor.phone ?? "") ?? normalizeIdentifier(actor.email ?? "");
    if (!identifier) {
      res.status(409).json({ error: NO_CONTACT_ERROR });
      return;
    }
    assertLiveChannelReady(identifier.kind === "phone" ? "sms" : "email");
    const mode = deliveryMode(identifier.kind === "phone" ? "sms" : "email");
    const registered = await registerSend({
      purpose: "password_change",
      identifier,
      accountType: "patient",
      candidates: [{ type: "patient", ref: actor.patientId, name: actor.name, dob: null, claimed: true, auth_user_id: actor.userId }],
      scopeKey: `password-change:${actor.patientId}`,
    });
    if (!registered) {
      res.status(429).json({ error: CODE_SEND_LIMIT, retryable: true });
      return;
    }
    try {
      if (registered.row.delivery === "twilio_verify") await deliverSmsRegistered(registered.row);
      else if (registered.row.delivery === "resend" && registered.localCode) await sendClaimEmail(registered.row.identifier, registered.localCode);
    } catch (error) {
      req.log?.error({ err: error }, "password change code delivery rejected");
      void spendUndelivered(registered.row).catch((spendError) => req.log?.error({ err: spendError }, "password change rejected-send mark failed"));
      res.status(502).json({ error: CODE_SEND_ERROR, retryable: true });
      return;
    }
    if (identifier.kind === "phone") await holdUntilSmsDeliveryFloor(started);
    res.json({
      ok: true,
      requestId: registered.row.id,
      channel: identifier.kind === "phone" ? "sms" : "email",
      destination: identifier.kind === "phone" ? maskPhone(actor.phone) : maskEmail(actor.email),
      ...(mode === "dev" && registered.localCode ? { devCode: registered.localCode } : {}),
    });
  } catch (error) {
    if (error instanceof DeliveryNotConfiguredError) {
      res.status(503).json({ error: error.message });
      return;
    }
    req.log?.error({ err: error }, "password change start failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.release();
  }
});

router.post(`${SECURITY_ME_PATH}/password/complete`, async (req, res) => {
  const slot = limited(req, res);
  if (!slot) return;
  try {
    const resolved = await resolveSecurityActor(req);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const { actor, token, sessionId } = resolved;
    if (actor.realm !== "patient") {
      res.status(403).json({ error: PATIENTS_ONLY });
      return;
    }
    const { requestId, code, newPassword } = (req.body ?? {}) as { requestId?: unknown; code?: unknown; newPassword?: unknown };
    const issue = passwordIssue(newPassword);
    if (issue) {
      res.status(400).json({ error: issue, field: "newPassword" });
      return;
    }
    let row: Awaited<ReturnType<typeof matchCode>>;
    try {
      row = await matchCode("password_change", requestId, code);
    } catch (error) {
      if (error instanceof DeliveryNotConfiguredError) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }
    // The code must be this patient's own password-change code. Someone else
    // matching it means the code leaked: spend it for everyone (fail closed).
    if (!row || row.scope_key !== `password-change:${actor.patientId}` || row.candidates?.[0]?.auth_user_id !== actor.userId) {
      if (row) await claimCode(row);
      res.status(400).json({ error: CODE_ERROR, field: "code" });
      return;
    }
    // Containment first and required: every OTHER session ends before the
    // proof is claimed or the password moves, so a refused sign-out changes
    // nothing — the same code stays redeemable for a retry — and the
    // confirmation that says "every other device was signed out" is only
    // ever sent when true.
    const othersOut = await logoutOthers(token);
    if (!othersOut) {
      req.log?.error({ patientId: actor.patientId }, "pre-password-change logout failed");
      audit(req, actor, "security_password_changed", { sessions: "sign_out_failed", outcome: "aborted" });
      respondSessionContainmentFailed(res, PASSWORD_CHANGE_SIGN_OUT_FAILED);
      return;
    }
    // Now the one-time claim (a parallel redeem of the same code loses here).
    if (!(await claimCode(row))) {
      res.status(400).json({ error: CODE_ERROR, field: "code" });
      return;
    }
    const now = new Date().toISOString();
    const consumed = await patchRow(row.id, { consumed_at: now, resolved_ref: actor.patientId, auth_user_id: actor.userId }, "&consumed_at=is.null");
    if (consumed !== 1) {
      res.status(400).json({ error: CODE_ERROR, field: "code" });
      return;
    }
    await updatePatientPassword(actor.userId, newPassword as string);
    await stampPasswordChanged(actor.userId);
    await markRevoked({ userId: actor.userId, reason: "password_changed", exceptSessionId: sessionId }).catch((error) =>
      req.log?.error({ err: error }, "password change ledger revoke failed"),
    );
    audit(req, actor, "security_password_changed", { sessions: "others_signed_out" });

    // Confirmation carries a one-time report link (email) bound to the
    // current sign-in row, so a hijacked change can still be undone.
    const reportToken = crypto.randomBytes(32).toString("hex");
    if (sessionId) {
      await supabaseAdmin("PATCH", `/rest/v1/auth_sign_ins?session_id=eq.${enc(sessionId)}`, {
        report_token_hash: sha256(reportToken),
        report_token_expires_at: new Date(Date.now() + REPORT_TOKEN_TTL_MS).toISOString(),
      });
    }
    void sendPasswordChangedConfirmation(actor, { changedAt: now, reportToken: sessionId ? reportToken : null }).catch((error) =>
      req.log?.error({ err: error }, "password change confirmation failed"),
    );
    res.json({ ok: true, othersSignedOut: true });
  } catch (error) {
    req.log?.error({ err: error }, "password change complete failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.release();
  }
});

// ── HQ: a patient's sessions ─────────────────────────────────────────────────

const PATIENT_SESSIONS_HQ_ONLY = "Only THINNR HQ can view or end a patient's sessions.";

async function hqPatientScope(req: Request, res: Response): Promise<{ providerId: string; actorUserId: string } | null> {
  const resolved = await resolveOfficeScope({
    authorization: req.headers.authorization,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
    hqPermission: "provider_manage",
    requireUnlocked: false,
  });
  if (resolved.kind !== "ok") {
    respondOfficeScopeDenied(req, res, resolved);
    return null;
  }
  if (resolved.scope.actorKind !== "hq") {
    res.status(403).json({ error: PATIENT_SESSIONS_HQ_ONLY });
    return null;
  }
  return { providerId: resolved.scope.providerId, actorUserId: resolved.scope.actorUserId };
}

async function loadScopedPatient(providerId: string, patientId: string): Promise<{ id: string; auth_user_id: string | null } | null> {
  if (!/^[0-9a-z-]{8,64}$/i.test(patientId)) return null;
  const found = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}&select=id,auth_user_id&limit=1`,
  );
  if (found.status >= 300) throw new Error(`patient lookup failed (${found.status})`);
  return Array.isArray(found.json) && found.json[0] ? (found.json[0] as { id: string; auth_user_id: string | null }) : null;
}

router.get("/office/patients/:id/sessions", async (req, res) => {
  try {
    const scope = await hqPatientScope(req, res);
    if (!scope) return;
    const patient = await loadScopedPatient(scope.providerId, String(req.params.id ?? ""));
    if (!patient) {
      res.status(404).json({ error: "That patient isn't on this office's roster." });
      return;
    }
    const overview = patient.auth_user_id ? await securityOverview(patient.auth_user_id, null) : { signIns: [], sessions: [] };
    void recordAdminAuditEvent({
      action: "patient_sessions_viewed",
      actorUserId: scope.actorUserId,
      actorKind: "hq",
      providerId: scope.providerId,
      targetKind: "patient",
      targetId: String(patient.id),
      requestId: requestIdOf(req),
      metadata: { sessions: overview.sessions.length },
    }).catch((error) => req.log?.error({ err: error }, "patient sessions audit failed"));
    res.json({ linked: Boolean(patient.auth_user_id), sessions: overview.sessions, signIns: overview.signIns });
  } catch (error) {
    req.log?.error({ err: error }, "patient sessions read failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.post("/office/patients/:id/sign-out", async (req, res) => {
  try {
    const scope = await hqPatientScope(req, res);
    if (!scope) return;
    const parsed = ReasonSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Choose a reason for signing this patient out.", field: "reason" });
      return;
    }
    const patient = await loadScopedPatient(scope.providerId, String(req.params.id ?? ""));
    if (!patient) {
      res.status(404).json({ error: "That patient isn't on this office's roster." });
      return;
    }
    let sessionInvalidation: "not_applicable" | "complete" | "failed" = "not_applicable";
    if (patient.auth_user_id) {
      sessionInvalidation = (await adminLogoutAll(patient.auth_user_id)) ? "complete" : "failed";
      if (sessionInvalidation === "failed") {
        res.status(502).json({ error: "Could not sign that patient out right now." });
        return;
      }
      await markRevoked({ userId: patient.auth_user_id, reason: parsed.data.reason as RevokeReason });
    }
    void recordAdminAuditEvent({
      action: "patient_signed_out",
      actorUserId: scope.actorUserId,
      actorKind: "hq",
      providerId: scope.providerId,
      targetKind: "patient",
      targetId: String(patient.id),
      requestId: requestIdOf(req),
      metadata: { reason: parsed.data.reason, sessions: sessionInvalidation },
    }).catch((error) => req.log?.error({ err: error }, "patient sign-out audit failed"));
    res.json({ ok: true, sessionInvalidation });
  } catch (error) {
    req.log?.error({ err: error }, "patient sign-out failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

export default router;
