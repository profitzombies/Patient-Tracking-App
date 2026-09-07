/**
 * Account claiming for migrated THINNR PATIENT records.
 *
 * Staff (HQ admins, providers, team members) sign in passwordless via
 * routes/auth.ts — identify requests matching staff records answer with the
 * same neutral body as a miss and send nothing. This flow remains for the
 * legacy patient-claiming path (currently dormant until archived patients
 * are re-imported): prove control of the phone/email on file with a
 * one-time code, then set a password. If the record was never linked, the
 * server creates the login and links it (auth_user_id + claimed_at — the only
 * writes ever made to migrated tables). If it was already linked, the same
 * proof lets the person set a NEW password on the existing login — that is
 * the password-reset path, and it never creates a duplicate account.
 *
 * Privacy rules enforced here:
 *   * Identify responses are byte-shape identical whether or not anything
 *     matched — "if those details match an account, a code is on its way."
 *   * Code checks answer with one generic error for wrong/expired/unknown.
 *   * Multi-match patients disambiguate with date of birth, exactly one try;
 *     anything else ends with a neutral "contact your clinic."
 *   * Nothing in this file logs identifiers, codes, or passwords.
 *
 * Delivery: dev mode returns the code in a dev-only response field (nothing
 * is sent anywhere); live mode uses Twilio Verify for SMS and Resend for
 * email, and fails loudly (503) when flipped on without credentials.
 */
import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { supabaseAdmin, fetchAuthUser } from "../lib/supabase-admin";
import { requestIdOf } from "../lib/admin-audit";
import {
  afterRecoveryCompleted,
  respondSessionContainmentFailed,
  SessionContainmentError,
  sweepSessionsBeforeRecovery,
} from "../security/sign-in-hooks";
import {
  normalizeIdentifier,
  passwordIssue,
  maskIdentifier,
  type NormalizedIdentifier,
} from "../claim/normalize";
import {
  deliveryMode,
  DeliveryNotConfiguredError,
  assertLiveChannelReady,
  generateCode,
  startTwilioVerification,
  checkTwilioVerification,
  sendClaimEmail,
} from "../claim/delivery";
import {
  acquireIdentifySlot,
  acquireVerifySlot,
  acquireCompleteSlot,
} from "../claim/limits";
import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  SENDS_PER_IDENTIFIER_PER_HOUR,
  type VerificationRow as ClaimRow,
  type Candidate,
  holdUntilFloor,
  sha256,
  codeMatches,
  loadRowById,
  loadRowByToken,
  patchRow,
  takeAttempt,
  pruneStaleRows,
  isUuid,
  isTokenShaped,
  isCodeShaped,
  clientIp,
} from "../auth/ledger";

const router: IRouter = Router();

export const CLAIM_IDENTIFY_PATH = "/claim/identify";
export const CLAIM_VERIFY_PATH = "/claim/verify";
export const CLAIM_BIRTHDAY_PATH = "/claim/birthday";
export const CLAIM_COMPLETE_PATH = "/claim/complete";
export const CLAIM_WHOAMI_PATH = "/claim/whoami";
export const CLAIM_ADD_PHONE_PATH = "/claim/add-phone";
export const CLAIM_ADD_PHONE_VERIFY_PATH = "/claim/add-phone/verify";
export const CLAIM_TEST_STATE_PATH = "/claim/test-state";

const CLAIM_TEST_PATIENT_ID = "93c85218-e8c2-409a-966b-a8a5bd98cdbb";
const CLAIM_TEST_PHONE = "+18135145141";
const CLAIM_TEST_SCENARIOS = new Set([
  "claim_phone",
  "recover_phone",
  "claim_email",
  "recover_email",
]);

/** Shown for every identify request, match or not. */
const NEUTRAL_MESSAGE =
  "If those details match an account, a verification code is on its way. Codes can take a minute to arrive.";
/** One generic answer for wrong, expired, and unknown codes alike. */
const CODE_ERROR = "That code didn't match or has expired. Check it and try again.";
/** Terminal answer when automatic verification cannot pick one account. */
const CLINIC_MESSAGE =
  "We couldn't verify your account automatically. Please contact your clinic and they'll get you set up.";
const SESSION_EXPIRED = "That session has expired. Please start over.";
const SERVER_ERROR = "We couldn't process that just now. Please try again in a moment.";

/** Across ALL destination numbers one signed-in account may try per hour. */
const ADD_PHONE_SENDS_PER_ACCOUNT_PER_HOUR = 6;

const PATIENT_TABLE = {
  table: "patients",
  refCol: "id",
  select: "id,auth_user_id,name,email,phone",
} as const;

function enc(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The identify answer — one shape for every outcome. In dev mode a decoy code
 * accompanies non-matches so even the dev field cannot reveal existence.
 */
function neutralBody(requestId: string, devCode: string | null) {
  return {
    ok: true as const,
    message: NEUTRAL_MESSAGE,
    requestId,
    ...(devCode ? { devCode } : {}),
  };
}

async function findCandidates(identifier: NormalizedIdentifier): Promise<Candidate[]> {
  const value = identifier.kind === "phone" ? identifier.e164 : identifier.email;
  const rpc = await supabaseAdmin("POST", "/rest/v1/rpc/claim_find_candidates", {
    p_kind: identifier.kind,
    p_value: value,
  });
  if (rpc.status >= 300) throw new Error(`candidate lookup failed (${rpc.status})`);
  const rows: Candidate[] = Array.isArray(rpc.json) ? (rpc.json as Candidate[]) : [];

  // Claiming serves PATIENT records only. Staff identities (HQ, providers,
  // team members) sign in with login codes via /api/auth — a staff email
  // here is a miss, answered exactly like any other miss.
  return rows.filter((c) => c.type === "patient");
}

router.post(CLAIM_IDENTIFY_PATH, async (req, res) => {
  const slot = acquireIdentifySlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  const started = Date.now();
  try {
    const identifier = normalizeIdentifier((req.body ?? {}).identifier);
    if (!identifier) {
      res.status(400).json({
        error: "Enter the phone number or email your clinic has on file.",
        field: "identifier",
      });
      return;
    }
    try {
      assertLiveChannelReady(identifier.kind === "phone" ? "sms" : "email");
    } catch (error) {
      if (error instanceof DeliveryNotConfiguredError) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }

    pruneStaleRows();

    const mode = deliveryMode(identifier.kind === "phone" ? "sms" : "email");
    const storedIdentifier = identifier.kind === "phone" ? identifier.e164 : identifier.email;

    const candidates = await findCandidates(identifier);
    if (candidates.length === 0) {
      // Same body, same message, decoy dev code, same response time (floor).
      // Nothing stored, nothing sent.
      await holdUntilFloor(started);
      res.json(neutralBody(crypto.randomUUID(), mode === "dev" ? generateCode() : null));
      return;
    }

    const delivery =
      mode === "dev" ? "dev" : identifier.kind === "phone" ? "twilio_verify" : "resend";
    const localCode = delivery === "twilio_verify" ? null : generateCode();
    const salt = localCode ? crypto.randomBytes(16).toString("hex") : null;

    // Ledger row + per-identifier hourly send cap in ONE atomic database
    // call (advisory lock + count + insert), so concurrent requests cannot
    // race past the cap. Cap hits are absorbed silently so the cap itself
    // cannot become an existence oracle.
    const registered = await supabaseAdmin("POST", "/rest/v1/rpc/claim_register_send", {
      p_purpose: "claim",
      p_identifier_kind: identifier.kind,
      p_identifier: storedIdentifier,
      p_account_type: candidates[0].type,
      p_candidates: candidates,
      p_delivery: delivery,
      p_code_salt: salt,
      p_code_hash: localCode && salt ? sha256(salt + localCode) : null,
      p_code_expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      p_auth_user_id: null,
      p_scope_key: null,
      p_max_per_hour: SENDS_PER_IDENTIFIER_PER_HOUR,
      p_scope_max_per_hour: null,
    });
    if (registered.status >= 300 || !Array.isArray(registered.json)) {
      throw new Error(`claim send registration failed (${registered.status})`);
    }
    if (registered.json.length === 0) {
      await holdUntilFloor(started);
      res.json(neutralBody(crypto.randomUUID(), mode === "dev" ? generateCode() : null));
      return;
    }
    const row = registered.json[0] as ClaimRow;

    // Live delivery must START strictly after the response is sent —
    // initiating the upstream call pre-response would make delivery-start
    // overhead a hit-only timing signal. `close` fires once the response
    // stream ends (flushed or aborted), so the code still goes out either way.
    if (delivery === "twilio_verify") {
      res.once("close", () => {
        void startTwilioVerification(storedIdentifier).catch((error) => {
          req.log?.error({ err: error }, "claim sms delivery failed");
        });
      });
    } else if (delivery === "resend" && localCode) {
      res.once("close", () => {
        void sendClaimEmail(storedIdentifier, localCode).catch((error) => {
          req.log?.error({ err: error }, "claim email delivery failed");
        });
      });
    }

    await holdUntilFloor(started);
    res.json(neutralBody(row.id, mode === "dev" ? localCode : null));
  } catch (error) {
    req.log?.error({ err: error }, "claim identify failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post(CLAIM_VERIFY_PATH, async (req, res) => {
  const slot = acquireVerifySlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const { requestId, code } = (req.body ?? {}) as { requestId?: unknown; code?: unknown };
    if (!isUuid(requestId) || !isCodeShaped(code)) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }
    const row = await loadRowById(requestId);
    if (
      !row ||
      row.purpose !== "claim" ||
      row.consumed_at ||
      row.verified_at ||
      row.code_attempts >= MAX_CODE_ATTEMPTS ||
      !row.code_expires_at ||
      new Date(row.code_expires_at).getTime() < Date.now()
    ) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }
    if (!(await takeAttempt(row))) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }

    let matched: boolean;
    if (row.delivery === "twilio_verify") {
      try {
        matched = await checkTwilioVerification(row.identifier, code);
      } catch (error) {
        if (error instanceof DeliveryNotConfiguredError) {
          res.status(503).json({ error: error.message });
          return;
        }
        throw error;
      }
    } else {
      matched = codeMatches(row, code);
    }
    if (!matched) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }

    const candidates = row.candidates ?? [];
    if (candidates.length === 0) {
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
      res.status(409).json({ error: CLINIC_MESSAGE });
      return;
    }

    // Several staff/provider records behind one email cannot self-serve —
    // there is no birthday on file to tell them apart.
    if (candidates.length > 1 && row.account_type !== "patient") {
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
      res.status(409).json({ error: CLINIC_MESSAGE });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const single = candidates.length === 1;
    // Exactly one verify may redeem the code: this conditional write is the
    // atomic claim, so a concurrent request that matched the same code loses
    // here and is answered like any wrong guess.
    const claimed = await patchRow(
      row.id,
      {
        verified_at: new Date().toISOString(),
        claim_token_hash: sha256(token),
        resolved_ref: single ? candidates[0].ref : null,
      },
      "&verified_at=is.null&consumed_at=is.null",
    );
    if (claimed !== 1) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }

    const identifier = normalizeIdentifier(row.identifier);
    res.json({
      ok: true,
      claimToken: token,
      accountType: row.account_type,
      masked: identifier ? maskIdentifier(identifier) : null,
      ...(single
        ? {
            next: "password" as const,
            mode: candidates[0].claimed ? ("reset" as const) : ("create" as const),
          }
        : { next: "birthday" as const }),
    });
  } catch (error) {
    req.log?.error({ err: error }, "claim verify failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post(CLAIM_BIRTHDAY_PATH, async (req, res) => {
  const slot = acquireVerifySlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const { claimToken, birthday } = (req.body ?? {}) as {
      claimToken?: unknown;
      birthday?: unknown;
    };
    if (!isTokenShaped(claimToken)) {
      res.status(400).json({ error: SESSION_EXPIRED });
      return;
    }
    if (
      typeof birthday !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(birthday) ||
      Number.isNaN(Date.parse(birthday)) ||
      birthday < "1900-01-01" ||
      birthday > new Date().toISOString().slice(0, 10)
    ) {
      res.status(400).json({ error: "Enter your date of birth.", field: "birthday" });
      return;
    }
    const row = await loadRowByToken(claimToken);
    if (
      !row ||
      row.purpose !== "claim" ||
      row.consumed_at ||
      !row.verified_at ||
      row.account_type !== "patient" ||
      row.resolved_ref ||
      row.birthday_checked
    ) {
      res.status(400).json({ error: SESSION_EXPIRED });
      return;
    }
    // Exactly one try — a second submission means starting over.
    const marked = await patchRow(row.id, { birthday_checked: true }, "&birthday_checked=is.false");
    if (marked !== 1) {
      res.status(400).json({ error: SESSION_EXPIRED });
      return;
    }

    const matches = (row.candidates ?? []).filter((c) => c.dob === birthday);
    if (matches.length !== 1) {
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
      res.status(409).json({ error: CLINIC_MESSAGE });
      return;
    }
    await patchRow(row.id, { resolved_ref: matches[0].ref });
    res.json({
      ok: true,
      next: "password" as const,
      mode: matches[0].claimed ? ("reset" as const) : ("create" as const),
    });
  } catch (error) {
    req.log?.error({ err: error }, "claim birthday failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post(CLAIM_COMPLETE_PATH, async (req, res) => {
  const slot = acquireCompleteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  let createdUserId: string | null = null;
  try {
    const { claimToken, password, passwordConfirm } = (req.body ?? {}) as {
      claimToken?: unknown;
      password?: unknown;
      passwordConfirm?: unknown;
    };
    if (!isTokenShaped(claimToken)) {
      res.status(400).json({ error: SESSION_EXPIRED });
      return;
    }
    const issue = passwordIssue(password);
    if (issue || typeof password !== "string") {
      res.status(400).json({ error: issue ?? "Choose a password.", field: "password" });
      return;
    }
    // Defense in depth: the apps enforce the confirm box, and the API refuses
    // to finish a claim unless the retyped password matches exactly.
    if (typeof passwordConfirm !== "string" || passwordConfirm !== password) {
      res.status(400).json({ error: "Both password boxes need to match.", field: "passwordConfirm" });
      return;
    }
    const row = await loadRowByToken(claimToken);
    if (!row || row.purpose !== "claim" || row.consumed_at || !row.verified_at || !row.resolved_ref) {
      res.status(400).json({ error: SESSION_EXPIRED });
      return;
    }
    const target = (row.candidates ?? []).find((c) => c.ref === row.resolved_ref);
    if (!target || row.account_type !== "patient") {
      res.status(400).json({ error: SESSION_EXPIRED });
      return;
    }

    const signIn = {
      method: row.identifier_kind === "phone" ? ("phone" as const) : ("email" as const),
      identifier: row.identifier,
    };

    const mapping = PATIENT_TABLE;
    const fresh = await supabaseAdmin(
      "GET",
      `/rest/v1/${mapping.table}?${mapping.refCol}=eq.${enc(target.ref)}&select=${mapping.select}`,
    );
    if (fresh.status >= 300) throw new Error(`target lookup failed (${fresh.status})`);
    const freshRow = Array.isArray(fresh.json) && fresh.json.length > 0 ? fresh.json[0] : null;
    if (!freshRow) {
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
      res.status(409).json({ error: CLINIC_MESSAGE });
      return;
    }

    // Already linked → this is a password reset on the existing login. It is
    // a recovery path, so every existing session must be gone before the new
    // password exists; a refused sweep fails honestly with nothing consumed.
    if (freshRow.auth_user_id) {
      const resetUserId = String(freshRow.auth_user_id);
      try {
        await sweepSessionsBeforeRecovery(req, resetUserId);
      } catch (error) {
        if (error instanceof SessionContainmentError) {
          respondSessionContainmentFailed(res);
          return;
        }
        throw error;
      }
      const updated = await supabaseAdmin("PUT", `/auth/v1/admin/users/${freshRow.auth_user_id}`, {
        password,
      });
      if (updated.status === 400 || updated.status === 422) {
        res.status(400).json({
          error: rejectedPasswordMessage(updated.json),
          field: "password",
        });
        return;
      }
      if (updated.status >= 300) throw new Error(`password reset failed (${updated.status})`);
      await patchRow(row.id, {
        consumed_at: new Date().toISOString(),
        auth_user_id: resetUserId,
      });
      await afterRecoveryCompleted(req, {
        userId: resetUserId,
        patientId: String(target.ref),
        providerId: null,
        requestId: requestIdOf(req),
      });
      res.json({ ok: true, mode: "reset" as const, signIn });
      return;
    }

    // Unclaimed → create the login with ONLY the verified contact, marked so
    // the demo signup triggers stand aside, then link the record.
    const displayName = (freshRow.name || "").trim() || null;
    const created = await supabaseAdmin("POST", "/auth/v1/admin/users", {
      ...(row.identifier_kind === "phone"
        ? { phone: row.identifier, phone_confirm: true }
        : { email: row.identifier, email_confirm: true }),
      password,
      app_metadata: { thinnr_claim: row.account_type, thinnr_claim_ref: target.ref },
      ...(displayName ? { user_metadata: { display_name: displayName } } : {}),
    });
    if (created.status === 400 || created.status === 422) {
      const codeText = String(created.json?.error_code ?? "");
      const message = String(created.json?.msg ?? created.json?.message ?? "");
      if (codeText === "phone_exists" || /phone.*(exists|registered)/i.test(message)) {
        res.status(409).json({
          error:
            "That phone number already secures a different login. Try claiming with your email instead, or contact your clinic.",
        });
        return;
      }
      if (codeText === "email_exists" || /already (been )?registered/i.test(message)) {
        res.status(409).json({
          error:
            "That email already has a login. Try signing in, or use Forgot password to reset it.",
        });
        return;
      }
      if (codeText === "weak_password" || /password/i.test(message)) {
        res.status(400).json({ error: rejectedPasswordMessage(created.json), field: "password" });
        return;
      }
      throw new Error(`user create rejected (${created.status}: ${codeText || "unknown"})`);
    }
    createdUserId = created.json?.id ?? created.json?.user?.id ?? null;
    if ((created.status !== 200 && created.status !== 201) || !createdUserId) {
      throw new Error(`user create failed (${created.status})`);
    }

    // Link exactly once. Losing this guarded update means someone else
    // finished claiming between code entry and now — undo our login.
    const linked = await supabaseAdmin(
      "PATCH",
      `/rest/v1/${mapping.table}?${mapping.refCol}=eq.${enc(target.ref)}&auth_user_id=is.null`,
      { auth_user_id: createdUserId, claimed_at: new Date().toISOString() },
      "return=representation",
    );
    if (linked.status >= 300) throw new Error(`link update failed (${linked.status})`);
    if (!Array.isArray(linked.json) || linked.json.length === 0) {
      await supabaseAdmin("DELETE", `/auth/v1/admin/users/${createdUserId}`);
      createdUserId = null;
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
      res.status(409).json({
        error:
          "This account was already claimed. Sign in with your password, or use Forgot password.",
      });
      return;
    }

    await patchRow(row.id, {
      consumed_at: new Date().toISOString(),
      auth_user_id: createdUserId,
    });
    res.json({ ok: true, mode: "create" as const, signIn });
  } catch (error) {
    req.log?.error({ err: error }, "claim complete failed");
    if (createdUserId) {
      // The login exists but the link never landed — undo it so a retry
      // starts clean instead of stranding a contact behind email_exists.
      try {
        await supabaseAdmin("DELETE", `/auth/v1/admin/users/${createdUserId}`);
      } catch {
        /* best effort */
      }
    }
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

function rejectedPasswordMessage(json: unknown): string {
  const message = String(
    (json as { msg?: string; message?: string })?.msg ??
      (json as { message?: string })?.message ??
      "",
  );
  if (/pwned|leaked|data breach|known to be weak|easy to guess/i.test(message)) {
    return "That password has appeared in a known data breach or is too easy to guess. Please choose a different one.";
  }
  return message ? `That password was rejected: ${message}` : "That password is too weak.";
}

function bearerToken(req: { headers: Record<string, unknown> }): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

interface ClaimTestPatient {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  auth_user_id: string;
  claimed_at: string | null;
}

async function authorizedClaimTestPatient(
  req: { headers: Record<string, unknown> },
): Promise<
  | { kind: "ok"; user: { id: string; email: string | null; phone: string | null }; patient: ClaimTestPatient }
  | { kind: "unauthorized" }
  | { kind: "unavailable" }
  | { kind: "forbidden" }
> {
  const token = bearerToken(req);
  if (!token) return { kind: "unauthorized" };
  let user;
  try {
    user = await fetchAuthUser(token);
  } catch {
    return { kind: "unavailable" };
  }
  if (!user) return { kind: "unauthorized" };
  const found = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${CLAIM_TEST_PATIENT_ID}&auth_user_id=eq.${enc(user.id)}&select=id,name,email,phone,auth_user_id,claimed_at`,
  );
  if (found.status >= 300) throw new Error(`test patient authorization failed (${found.status})`);
  if (!Array.isArray(found.json) || found.json.length !== 1) return { kind: "forbidden" };
  return { kind: "ok", user, patient: found.json[0] as ClaimTestPatient };
}

function maskedContact(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeIdentifier(value);
  return normalized ? maskIdentifier(normalized) : null;
}

async function inspectClaimTestState(ownerId: string): Promise<{ collision: boolean }> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/claim_test_state_inspect", {
    p_patient_id: CLAIM_TEST_PATIENT_ID,
    p_owner_auth_user_id: ownerId,
    p_approved_phone: CLAIM_TEST_PHONE,
  });
  if (result.status >= 300) throw new Error(`test state inspection failed (${result.status})`);
  const value = Array.isArray(result.json) ? result.json[0] : result.json;
  return { collision: value?.collision !== false };
}

router.get(CLAIM_TEST_STATE_PATH, async (req, res) => {
  try {
    const auth = await authorizedClaimTestPatient(req);
    if (auth.kind === "unauthorized") {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    if (auth.kind === "unavailable") {
      res.status(503).json({ error: "Account lookup is unavailable right now." });
      return;
    }
    if (auth.kind === "forbidden") {
      res.status(403).json({ error: "This test state belongs to a different account." });
      return;
    }
    if ((await inspectClaimTestState(auth.user.id)).collision) {
      res.status(409).json({ error: "The test state has a contact collision and cannot be used." });
      return;
    }
    const patient = auth.patient;
    res.json({
      patient: {
        name: patient.name,
        emailMasked: maskedContact(patient.email),
        phoneMasked: maskedContact(patient.phone),
      },
      state: {
        claimed: Boolean(patient.auth_user_id),
        hasPhone: Boolean(patient.phone),
        hasEmail: Boolean(patient.email),
      },
    });
  } catch (error) {
    req.log?.error({ err: error }, "claim test state inspection failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.post(CLAIM_TEST_STATE_PATH, async (req, res) => {
  try {
    const auth = await authorizedClaimTestPatient(req);
    if (auth.kind === "unauthorized") {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    if (auth.kind === "unavailable") {
      res.status(503).json({ error: "Account lookup is unavailable right now." });
      return;
    }
    if (auth.kind === "forbidden") {
      res.status(403).json({ error: "This test state belongs to a different account." });
      return;
    }
    const scenario = (req.body ?? {}).scenario;
    if (typeof scenario !== "string" || !CLAIM_TEST_SCENARIOS.has(scenario)) {
      res.status(400).json({ error: "Choose a valid claim test scenario.", field: "scenario" });
      return;
    }
    if ((await inspectClaimTestState(auth.user.id)).collision) {
      res.status(409).json({ error: "The test state has a contact collision and cannot be used." });
      return;
    }

    let authContactChanged = false;
    if (scenario.startsWith("recover_")) {
      const identifier = scenario === "recover_phone" ? CLAIM_TEST_PHONE : auth.patient.email;
      if (!identifier) throw new Error("test patient email missing");
      try {
        const update =
          scenario === "recover_phone"
            ? { phone: identifier, phone_confirm: true }
            : { email: identifier, email_confirm: true };
        const updated = await supabaseAdmin("PUT", `/auth/v1/admin/users/${auth.user.id}`, update);
        if (updated.status >= 300) throw new Error(`test login contact update failed (${updated.status})`);
        authContactChanged = true;
      } catch (error) {
        throw error; // no database work has happened yet
      }
    }
    const prepared = await supabaseAdmin("POST", "/rest/v1/rpc/claim_test_state_prepare", {
      p_patient_id: CLAIM_TEST_PATIENT_ID,
      p_owner_auth_user_id: auth.user.id,
      p_approved_phone: CLAIM_TEST_PHONE,
      p_scenario: scenario,
    });
    if (prepared.status >= 300) {
      if (authContactChanged) {
        const restored = await supabaseAdmin("PUT", `/auth/v1/admin/users/${auth.user.id}`, {
          email: auth.user.email,
          phone: auth.user.phone,
          email_confirm: Boolean(auth.user.email),
          phone_confirm: Boolean(auth.user.phone),
        });
        if (restored.status >= 300) throw new Error(`test login contact rollback failed (${restored.status})`);
      }
      if (prepared.status === 409 || prepared.status === 400) {
        res.status(409).json({ error: "The test state has a contact collision and cannot be used." });
        return;
      }
      throw new Error(`test state preparation failed (${prepared.status})`);
    }
    const result = Array.isArray(prepared.json) ? prepared.json[0] : prepared.json;
    if (!result || result.prepared !== true || typeof result.identifier !== "string") {
      throw new Error("test state preparation returned an invalid result");
    }

    res.json({
      prepared: true,
      scenario,
      identifier: result.identifier,
      mode: scenario.startsWith("claim_") ? ("create" as const) : ("reset" as const),
    });
  } catch (error) {
    req.log?.error({ err: error }, "claim test state preparation failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.get(CLAIM_WHOAMI_PATH, async (req, res) => {
  try {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    let user;
    try {
      user = await fetchAuthUser(token);
    } catch {
      res.status(503).json({ error: "Account lookup is unavailable right now." });
      return;
    }
    if (!user) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }

    const [profile, patient, provider, teamMember] = await Promise.all([
      supabaseAdmin(
        "GET",
        `/rest/v1/profiles?id=eq.${enc(user.id)}&select=role,provider_account_code,display_name`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patients?auth_user_id=eq.${enc(user.id)}&select=id,name,provider_id,phone`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/providers?auth_user_id=eq.${enc(user.id)}&select=provider_id,provider_name,office_name`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/team_members?auth_user_id=eq.${enc(user.id)}&select=id,name,provider_id`,
      ),
    ]);
    for (const r of [profile, patient, provider, teamMember]) {
      if (r.status >= 300) throw new Error(`whoami lookup failed (${r.status})`);
    }
    const profileRow = Array.isArray(profile.json) ? profile.json[0] : null;
    const patientRow = Array.isArray(patient.json) ? patient.json[0] : null;
    const providerRow = Array.isArray(provider.json) ? provider.json[0] : null;
    const teamRow = Array.isArray(teamMember.json) ? teamMember.json[0] : null;

    let kind:
      | "hq_admin"
      | "provider"
      | "team_member"
      | "patient"
      | "demo_staff"
      | "demo_patient"
      | "none" = "none";
    let name: string | null = null;
    let providerId: string | null = null;
    let officeName: string | null = null;
    let patientId: string | null = null;

    if (profileRow?.role === "hq_admin") {
      kind = "hq_admin";
      name = profileRow.display_name ?? null;
    } else if (providerRow) {
      kind = "provider";
      name = providerRow.provider_name || providerRow.office_name || null;
      providerId = String(providerRow.provider_id);
      officeName = providerRow.office_name || providerRow.provider_name || null;
    } else if (teamRow) {
      kind = "team_member";
      name = teamRow.name ?? null;
      providerId = String(teamRow.provider_id);
    } else if (patientRow) {
      kind = "patient";
      name = patientRow.name ?? null;
      patientId = String(patientRow.id);
      providerId = patientRow.provider_id ? String(patientRow.provider_id) : null;
    } else if (profileRow?.role === "provider_staff") {
      kind = "demo_staff";
      name = profileRow.display_name ?? null;
    } else if (profileRow) {
      kind = "demo_patient";
      name = profileRow.display_name ?? null;
    }

    // A team member's welcome shows their office name; one extra lookup.
    if (kind === "team_member" && providerId) {
      const office = await supabaseAdmin(
        "GET",
        `/rest/v1/providers?provider_id=eq.${enc(providerId)}&select=provider_name,office_name`,
      );
      if (office.status < 300 && Array.isArray(office.json) && office.json.length > 0) {
        officeName = office.json[0].office_name || office.json[0].provider_name || null;
      }
    }

    res.json({
      kind,
      name,
      providerId,
      officeName,
      patientId,
      hasPhone: Boolean(user.phone || (kind === "patient" && patientRow?.phone)),
      hasEmail: Boolean(user.email),
    });
  } catch (error) {
    req.log?.error({ err: error }, "claim whoami failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.post(CLAIM_ADD_PHONE_PATH, async (req, res) => {
  const slot = acquireIdentifySlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const token = bearerToken(req);
    const user = token ? await fetchAuthUser(token).catch(() => undefined) : null;
    if (user === undefined) {
      res.status(503).json({ error: "Account lookup is unavailable right now." });
      return;
    }
    if (!user) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    const linked = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?auth_user_id=eq.${enc(user.id)}&select=id`,
    );
    if (linked.status >= 300) throw new Error(`patient lookup failed (${linked.status})`);
    if (!Array.isArray(linked.json) || linked.json.length === 0) {
      res.status(403).json({ error: "Only claimed patient accounts can add a phone here." });
      return;
    }
    if (user.phone) {
      res.status(409).json({ error: "This account already has a phone number." });
      return;
    }
    const identifier = normalizeIdentifier((req.body ?? {}).phone);
    if (!identifier || identifier.kind !== "phone") {
      res.status(400).json({ error: "Enter a valid mobile number.", field: "phone" });
      return;
    }
    try {
      assertLiveChannelReady("sms");
    } catch (error) {
      if (error instanceof DeliveryNotConfiguredError) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }

    const mode = deliveryMode("sms");
    const delivery = mode === "dev" ? "dev" : "twilio_verify";
    const localCode = delivery === "dev" ? generateCode() : null;
    const salt = localCode ? crypto.randomBytes(16).toString("hex") : null;
    // Same atomic ledger+cap call as identify, with a second cap across ALL
    // destinations this signed-in account has tried, so a claimed login
    // cannot rotate numbers to spray verification texts.
    const inserted = await supabaseAdmin("POST", "/rest/v1/rpc/claim_register_send", {
      p_purpose: "add_phone",
      p_identifier_kind: "phone",
      p_identifier: identifier.e164,
      p_account_type: "patient",
      p_candidates: [],
      p_delivery: delivery,
      p_code_salt: salt,
      p_code_hash: localCode && salt ? sha256(salt + localCode) : null,
      p_code_expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      p_auth_user_id: user.id,
      p_scope_key: `user:${user.id}`,
      p_max_per_hour: SENDS_PER_IDENTIFIER_PER_HOUR,
      p_scope_max_per_hour: ADD_PHONE_SENDS_PER_ACCOUNT_PER_HOUR,
    });
    if (inserted.status >= 300 || !Array.isArray(inserted.json)) {
      throw new Error(`add-phone send registration failed (${inserted.status})`);
    }
    if (inserted.json.length === 0) {
      // The caller is signed in and asking about their own sends — an honest
      // answer is fine here; no account-existence question is in play.
      res.status(429).json({
        error: "Too many codes sent just now. Please wait an hour and try again.",
        retryable: true,
      });
      return;
    }
    const row = inserted.json[0] as ClaimRow;
    if (delivery === "twilio_verify") {
      void startTwilioVerification(identifier.e164).catch((error) => {
        req.log?.error({ err: error }, "add-phone sms delivery failed");
      });
    }
    res.json({
      ok: true,
      requestId: row.id,
      message: "We sent a verification code to that number.",
      ...(localCode ? { devCode: localCode } : {}),
    });
  } catch (error) {
    req.log?.error({ err: error }, "add-phone failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post(CLAIM_ADD_PHONE_VERIFY_PATH, async (req, res) => {
  const slot = acquireVerifySlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const token = bearerToken(req);
    const user = token ? await fetchAuthUser(token).catch(() => undefined) : null;
    if (user === undefined) {
      res.status(503).json({ error: "Account lookup is unavailable right now." });
      return;
    }
    if (!user) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    const { requestId, code } = (req.body ?? {}) as { requestId?: unknown; code?: unknown };
    if (!isUuid(requestId) || !isCodeShaped(code)) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }
    const row = await loadRowById(requestId);
    if (
      !row ||
      row.purpose !== "add_phone" ||
      row.auth_user_id !== user.id ||
      row.consumed_at ||
      row.code_attempts >= MAX_CODE_ATTEMPTS ||
      !row.code_expires_at ||
      new Date(row.code_expires_at).getTime() < Date.now()
    ) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }
    if (!(await takeAttempt(row))) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }

    let matched: boolean;
    if (row.delivery === "twilio_verify") {
      try {
        matched = await checkTwilioVerification(row.identifier, code);
      } catch (error) {
        if (error instanceof DeliveryNotConfiguredError) {
          res.status(503).json({ error: error.message });
          return;
        }
        throw error;
      }
    } else {
      matched = codeMatches(row, code);
    }
    if (!matched) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }

    // Claim the row atomically before touching the account: one verify wins,
    // concurrent racers are answered like wrong guesses.
    const claimed = await patchRow(
      row.id,
      { verified_at: new Date().toISOString() },
      "&verified_at=is.null&consumed_at=is.null",
    );
    if (claimed !== 1) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }

    const updated = await supabaseAdmin("PUT", `/auth/v1/admin/users/${user.id}`, {
      phone: row.identifier,
      phone_confirm: true,
    });
    if (updated.status === 400 || updated.status === 422) {
      const codeText = String(updated.json?.error_code ?? "");
      const message = String(updated.json?.msg ?? updated.json?.message ?? "");
      if (codeText === "phone_exists" || /phone.*(exists|registered)/i.test(message)) {
        res.status(409).json({
          error: "That phone number is already connected to a different login.",
        });
        return;
      }
      throw new Error(`phone update rejected (${updated.status}: ${codeText || "unknown"})`);
    }
    if (updated.status >= 300) throw new Error(`phone update failed (${updated.status})`);

    await patchRow(row.id, { consumed_at: new Date().toISOString(), verified_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "add-phone verify failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

export default router;
