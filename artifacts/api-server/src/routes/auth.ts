/**
 * Passwordless code login + patient signup, both realms.
 *
 * Staff (operations app) sign in with business email + emailed 6-digit code.
 * Patients sign in with cell phone + texted code, or email + emailed code as
 * the fallback. New patients sign up with a provider code, verify their
 * phone by text, and get a real patient row in their office's roster.
 *
 * Privacy rules match the claim flow this rides on:
 *   * Login-start responses are byte-shape identical whether or not anything
 *     matched — "if those details match an account, a code is on its way."
 *   * Code checks answer with one generic error for wrong/expired/unknown.
 *   * Send caps are absorbed silently and response timing is floored so
 *     neither can become an account-existence oracle.
 *   * Locked or disabled accounts never receive codes and cannot verify.
 *   * Nothing in this file logs identifiers or codes.
 *
 * Delivery: dev mode returns the code in a dev-only response field (nothing
 * is sent anywhere); live mode uses Twilio Verify for SMS and Resend for
 * email, and fails loudly (503) when flipped on without credentials.
 */
import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { supabaseAdmin } from "../lib/supabase-admin";
import { normalizeIdentifier, type NormalizedIdentifier } from "../claim/normalize";
import {
  deliveryMode,
  DeliveryNotConfiguredError,
  assertLiveChannelReady,
  holdUntilSmsDeliveryFloor,
  generateCode,
  startTwilioVerification,
  checkTwilioVerification,
  sendClaimEmail,
} from "../claim/delivery";
import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  SENDS_PER_IDENTIFIER_PER_HOUR,
  type VerificationRow,
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
import {
  lookupStaffByEmail,
  lookupPatients,
  loadPatientById,
  resolveSignupOffice,
  resolveSignupOfficeById,
} from "../auth/directory";
import {
  mintSessionTokenHash,
  getAuthUserEmail,
  ensurePatientAuthUser,
  ensureStaffAuthUser,
  deleteAuthUserQuietly,
  patientSyntheticEmail,
  PhoneExistsError,
  createConfirmedPatientUser,
  updatePatientPassword,
  verifyPatientPassword,
} from "../auth/session";
import { passwordIssue } from "../claim/normalize";
import {
  acquireSendSlot,
  acquireCheckSlot,
  acquireOfficeSlot,
  acquireFinishSlot,
} from "../auth/limits";

const router: IRouter = Router();

export const AUTH_LOGIN_START_PATH = "/auth/login/start";
export const AUTH_LOGIN_VERIFY_PATH = "/auth/login/verify";
export const AUTH_PATIENT_PASSWORD_LOGIN_PATH = "/auth/patient/password/login";
export const AUTH_PATIENT_RECOVERY_START_PATH = "/auth/patient/recovery/start";
export const AUTH_PATIENT_RECOVERY_VERIFY_PATH = "/auth/patient/recovery/verify";
export const AUTH_PATIENT_RECOVERY_COMPLETE_PATH = "/auth/patient/recovery/complete";
export const AUTH_SIGNUP_OFFICE_PATH = "/auth/signup/office";
export const AUTH_SIGNUP_START_PATH = "/auth/signup/start";
export const AUTH_SIGNUP_VERIFY_PATH = "/auth/signup/verify";
export const AUTH_SIGNUP_COMPLETE_PATH = "/auth/signup/complete";

/** Shown for every login-start request, match or not. */
const NEUTRAL_MESSAGE =
  "If those details match an account, a sign-in code is on its way. Codes can take a minute to arrive.";
/** Signup phone step — always neutral about whether the number is known. */
const SIGNUP_SENT_MESSAGE =
  "A verification code is on its way by text. Codes can take a minute to arrive.";
/** One generic answer for wrong, expired, and unknown codes alike. */
const CODE_ERROR = "That code didn't match or has expired. Check it and try again.";
/** Terminal answer when automatic verification cannot pick one account. */
const CLINIC_MESSAGE =
  "We couldn't verify your account automatically. Please contact your clinic and they'll get you set up.";
const OFFICE_CODE_ERROR =
  "That provider code doesn't match an active office. Double-check it with your provider.";
const PATIENT_PASSWORD_ERROR =
  "The phone or email and password you entered don't match. Check them and try again, or reset your password.";
const CODE_SEND_ERROR =
  "We couldn't send a verification code right now. Check your connection and try again in a moment.";
const CODE_SEND_LIMIT =
  "Too many verification codes were requested. Wait a little while, then try again.";
const SESSION_EXPIRED = "That session has expired. Please start over.";
const SERVER_ERROR = "We couldn't process that just now. Please try again in a moment.";

function patientUniqueConflict(message: string): "email" | "phone" | null {
  if (/patients_email_(?:normalized_)?unique_idx/.test(message)) return "email";
  if (/patients_phone_(?:normalized_)?unique_idx/.test(message)) return "phone";
  return null;
}

/** Signup sends per office per hour — a safety valve, not a bottleneck. */
const SIGNUP_SENDS_PER_OFFICE_PER_HOUR = 30;
const SIGNUP_SCOPE_PREFIX = "signup:";

/**
 * The start answer — one shape for every outcome. In dev mode a decoy code
 * accompanies non-matches so even the dev field cannot reveal existence.
 */
function neutralBody(requestId: string, devCode: string | null, message = NEUTRAL_MESSAGE) {
  return {
    ok: true as const,
    message,
    requestId,
    ...(devCode ? { devCode } : {}),
  };
}

/** SMS is acknowledged before response on identity-neutral code-start rails. */
async function deliverSmsRegistered(
  row: VerificationRow,
): Promise<void> {
  if (row.delivery === "twilio_verify") {
    await startTwilioVerification(row.identifier);
  }
}

/**
 * A patient who has already proved the account password can enter the MFA
 * screen while Twilio accepts the text. Unknown-account and wrong-password
 * requests keep the provider-sized timing floor in the route below, so this
 * faster success path does not create an account-existence oracle.
 */
function deliverPatientPasswordSmsAfterResponse(
  res: { once: (event: "close", handler: () => void) => void },
  log: { error: (obj: unknown, msg: string) => void } | undefined,
  row: VerificationRow,
): void {
  if (row.delivery !== "twilio_verify") return;
  res.once("close", () => {
    void deliverSmsRegistered(row).catch((error) => {
      log?.error({ err: error }, "patient password sms delivery rejected");
      void spendUndelivered(row).catch((spendError) => {
        log?.error(
          { err: spendError },
          "patient password rejected-send ledger update failed",
        );
      });
    });
  });
}

function deliverEmailAfterResponse(
  res: { once: (event: "close", handler: () => void) => void },
  log: { error: (obj: unknown, msg: string) => void } | undefined,
  row: VerificationRow,
  localCode: string | null,
): void {
  if (row.delivery !== "resend" || !localCode) return;
  res.once("close", () => {
    void sendClaimEmail(row.identifier, localCode).catch((error) => {
      log?.error({ err: error }, "auth email delivery failed");
    });
  });
}

async function spendUndelivered(row: VerificationRow): Promise<void> {
  const spent = await patchRow(
    row.id,
    { consumed_at: new Date().toISOString() },
    "&verified_at=is.null&consumed_at=is.null",
  );
  if (spent !== 1) throw new Error("undelivered auth send could not be spent");
}

interface RegisterSendInput {
  purpose: "login" | "signup" | "recovery";
  identifier: NormalizedIdentifier;
  accountType: VerificationRow["account_type"];
  candidates: Candidate[];
  scopeKey?: string | null;
  scopeMaxPerHour?: number | null;
}

/**
 * Ledger row + per-identifier hourly send cap in ONE atomic database call
 * (advisory lock + count + insert), so concurrent requests cannot race past
 * the cap. Cap hits come back as null and are absorbed silently so the cap
 * itself cannot become an existence oracle.
 */
async function registerSend(
  input: RegisterSendInput,
): Promise<{ row: VerificationRow; localCode: string | null } | null> {
  const kind = input.identifier.kind;
  const stored = kind === "phone" ? input.identifier.e164 : input.identifier.email;
  const mode = deliveryMode(kind === "phone" ? "sms" : "email");
  const delivery = mode === "dev" ? "dev" : kind === "phone" ? "twilio_verify" : "resend";
  const localCode = delivery === "twilio_verify" ? null : generateCode();
  const salt = localCode ? crypto.randomBytes(16).toString("hex") : null;

  const registered = await supabaseAdmin("POST", "/rest/v1/rpc/claim_register_send", {
    p_purpose: input.purpose,
    p_identifier_kind: kind,
    p_identifier: stored,
    p_account_type: input.accountType,
    p_candidates: input.candidates,
    p_delivery: delivery,
    p_code_salt: salt,
    p_code_hash: localCode && salt ? sha256(salt + localCode) : null,
    p_code_expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    p_auth_user_id: null,
    p_scope_key: input.scopeKey ?? null,
    p_max_per_hour: SENDS_PER_IDENTIFIER_PER_HOUR,
    p_scope_max_per_hour: input.scopeMaxPerHour ?? null,
  });
  if (registered.status >= 300 || !Array.isArray(registered.json)) {
    throw new Error(`auth send registration failed (${registered.status})`);
  }
  if (registered.json.length === 0) return null;
  return { row: registered.json[0] as VerificationRow, localCode };
}

/** Shared code-check preamble: row guards, attempt counting, code matching. */
async function checkCode(
  purpose: "login" | "signup" | "recovery",
  requestId: unknown,
  code: unknown,
): Promise<VerificationRow | null> {
  if (!isUuid(requestId) || !isCodeShaped(code)) return null;
  const row = await loadRowById(requestId);
  if (
    !row ||
    row.purpose !== purpose ||
    row.consumed_at ||
    row.verified_at ||
    row.code_attempts >= MAX_CODE_ATTEMPTS ||
    !row.code_expires_at ||
    new Date(row.code_expires_at).getTime() < Date.now()
  ) {
    return null;
  }
  if (!(await takeAttempt(row))) return null;

  let matched: boolean;
  if (row.delivery === "twilio_verify") {
    matched = await checkTwilioVerification(row.identifier, code);
  } else {
    matched = codeMatches(row, code);
  }
  if (!matched) return null;

  // A one-time code is redeemable exactly ONCE: atomically claim the row
  // while it is still unclaimed (a single conditional UPDATE — concurrent
  // claimers serialize on the row lock and exactly one sees the guard
  // columns still null). A parallel verify that matched the same code loses
  // this write and gets the same wrong-code answer, so the race leaks
  // nothing. The claim deliberately lands BEFORE any account or session
  // work: if that later work fails, the code is spent (fail closed) and the
  // user requests a fresh one.
  const claimed = await patchRow(
    row.id,
    { verified_at: new Date().toISOString() },
    "&verified_at=is.null&consumed_at=is.null",
  );
  return claimed === 1 ? row : null;
}

function eligibleLinkedPatient(patient: Awaited<ReturnType<typeof loadPatientById>>): boolean {
  return Boolean(
    patient &&
      patient.auth_user_id &&
      (patient.activation_status === "active" ||
        patient.activation_status === "activated" ||
        patient.activation_status === "invited"),
  );
}

async function resolveEligibleLinkedPatient(identifier: NormalizedIdentifier) {
  const hits = await lookupPatients(identifier);
  if (hits.length !== 1) return null;
  const patient = await loadPatientById(hits[0].ref);
  return eligibleLinkedPatient(patient) ? patient : null;
}

async function patientCodeStart(
  req: any,
  res: any,
  purpose: "login" | "recovery",
  started = Date.now(),
  boundPatient: { id: string; authUserId: string } | null = null,
): Promise<void> {
  const identifier = normalizeIdentifier((req.body ?? {}).identifier);
  if (!identifier) {
    res.status(400).json({ error: "Enter your cell phone number or email address.", field: "identifier" });
    return;
  }
  assertLiveChannelReady(identifier.kind === "phone" ? "sms" : "email");
  const mode = deliveryMode(identifier.kind === "phone" ? "sms" : "email");
  // Re-resolve after password proof: if the contact or auth link changed
  // during that request, do not transfer the proof to a different binding.
  const patient = await resolveEligibleLinkedPatient(identifier);
  const requireAcceptedDelivery = boundPatient !== null;
  const bindingChanged = Boolean(
    boundPatient &&
      patient &&
      (String(patient.id) !== boundPatient.id ||
        String(patient.auth_user_id) !== boundPatient.authUserId),
  );
  if (!patient || bindingChanged) {
    await holdUntilFloor(started);
    if (identifier.kind === "phone") await holdUntilSmsDeliveryFloor(started);
    if (requireAcceptedDelivery) {
      res.status(409).json({ error: SERVER_ERROR, retryable: true });
      return;
    }
    res.json(neutralBody(crypto.randomUUID(), mode === "dev" ? generateCode() : null));
    return;
  }
  const registered = await registerSend({
    purpose, identifier, accountType: "patient",
    candidates: [{ type: "patient", ref: patient.id, name: patient.name, dob: null, claimed: true, auth_user_id: patient.auth_user_id }],
    scopeKey: purpose === "login" ? `patient-password:${patient.id}` : null,
  });
  if (!registered) {
    await holdUntilFloor(started);
    if (identifier.kind === "phone") await holdUntilSmsDeliveryFloor(started);
    if (requireAcceptedDelivery) {
      res.status(429).json({ error: CODE_SEND_LIMIT, retryable: true });
      return;
    }
    res.json(neutralBody(crypto.randomUUID(), mode === "dev" ? generateCode() : null));
    return;
  }
  if (requireAcceptedDelivery && registered.row.delivery === "twilio_verify") {
    deliverPatientPasswordSmsAfterResponse(res, req.log, registered.row);
  } else if (registered.row.delivery === "twilio_verify") {
    let accepted = true;
    try {
      await deliverSmsRegistered(registered.row);
    } catch (error) {
      accepted = false;
      req.log?.error({ err: error }, "patient password sms delivery rejected");
      void spendUndelivered(registered.row).catch((spendError) => {
        req.log?.error({ err: spendError }, "patient password rejected-send ledger update failed");
      });
    }
    await holdUntilSmsDeliveryFloor(started);
    if (requireAcceptedDelivery && !accepted) {
      await holdUntilFloor(started);
      res.status(502).json({ error: CODE_SEND_ERROR, retryable: true });
      return;
    }
  } else if (requireAcceptedDelivery && registered.row.delivery === "resend" && registered.localCode) {
    try {
      await sendClaimEmail(registered.row.identifier, registered.localCode);
    } catch (error) {
      req.log?.error({ err: error }, "patient password email delivery rejected");
      void spendUndelivered(registered.row).catch((spendError) => {
        req.log?.error({ err: spendError }, "patient password rejected-send ledger update failed");
      });
      await holdUntilFloor(started);
      res.status(502).json({ error: CODE_SEND_ERROR, retryable: true });
      return;
    }
  } else deliverEmailAfterResponse(res, req.log, registered.row, registered.localCode);
  await holdUntilFloor(started);
  res.json(neutralBody(registered.row.id, mode === "dev" ? registered.localCode : null));
}

router.post(AUTH_LOGIN_START_PATH, async (req, res) => {
  const slot = acquireSendSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  const started = Date.now();
  try {
    const { realm } = (req.body ?? {}) as { realm?: unknown };
    if (realm !== "staff") {
      res.status(400).json({ error: "Unknown sign-in type." });
      return;
    }
    let identifier = normalizeIdentifier((req.body ?? {}).identifier);
    if (!identifier || (realm === "staff" && identifier.kind !== "email")) {
      res.status(400).json({
        error:
          realm === "staff"
            ? "Enter your work email address."
            : "Enter your cell phone number or email address.",
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

    let candidates: Candidate[] = [];
    let accountType: VerificationRow["account_type"] = null;
    {
      if (identifier.kind !== "email") {
        // Unreachable — the realm guard above already rejected this.
        res.status(400).json({ error: "Enter your work email address.", field: "identifier" });
        return;
      }
      const staff = await lookupStaffByEmail(identifier.email);
      if (staff.kind === "ok") {
        accountType =
          staff.hit.class === "hq_active" || staff.hit.class === "hq_invited"
            ? "hq_admin"
            : staff.hit.class;
        candidates = [
          {
            type: accountType,
            ref: staff.hit.ref,
            name: staff.hit.name,
            dob: null,
            claimed: Boolean(staff.hit.authUserId),
            auth_user_id: staff.hit.authUserId,
          },
        ];
      }
    }

    if (candidates.length === 0) {
      // Same body, same message, decoy dev code, same response time (floor).
      // Nothing stored, nothing sent.
      await holdUntilFloor(started);
      res.json(neutralBody(crypto.randomUUID(), mode === "dev" ? generateCode() : null));
      return;
    }

    const registered = await registerSend({
      purpose: "login",
      identifier,
      accountType,
      candidates,
    });
    if (!registered) {
      await holdUntilFloor(started);
      res.json(neutralBody(crypto.randomUUID(), mode === "dev" ? generateCode() : null));
      return;
    }

    if (registered.row.delivery === "twilio_verify") {
      try {
        await deliverSmsRegistered(registered.row);
      } catch (error) {
        req.log?.error({ err: error }, "auth login sms delivery rejected");
        // Do not await this best-effort terminal mark: the inserted row already
        // counts toward quota, Twilio issued no code, and database latency must
        // not make a matched number slower than a miss.
        void spendUndelivered(registered.row).catch((spendError) => {
          req.log?.error({ err: spendError }, "auth login rejected-send ledger update failed");
        });
      }
      await holdUntilSmsDeliveryFloor(started);
    } else {
      deliverEmailAfterResponse(res, req.log, registered.row, registered.localCode);
    }
    await holdUntilFloor(started);
    res.json(neutralBody(registered.row.id, mode === "dev" ? registered.localCode : null));
  } catch (error) {
    req.log?.error({ err: error }, "auth login start failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post(AUTH_LOGIN_VERIFY_PATH, async (req, res) => {
  const slot = acquireCheckSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const { requestId, code } = (req.body ?? {}) as { requestId?: unknown; code?: unknown };
    let row: VerificationRow | null;
    try {
      row = await checkCode("login", requestId, code);
    } catch (error) {
      if (error instanceof DeliveryNotConfiguredError) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }
    if (!row) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }

    // The code is proven. Re-resolve the account FRESH so locks, disables,
    // and deletions applied since the send still block sign-in.
    const identifier = normalizeIdentifier(row.identifier);
    if (!identifier) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }

    let userId: string | null = null;
    let realm: "staff" | "patient";
    if (row.account_type === "patient") {
      realm = "patient";
      const patients = await lookupPatients(identifier);
      const only = patients.length === 1 ? patients[0] : null;
      const patient = only ? await loadPatientById(only.ref) : null;
      // Password MFA is bound to the exact already-linked patient identity
      // that passed the password check at issuance. Re-resolve every part of
      // that binding after code proof: a disabled, reassigned, or relinked
      // record must never turn an old code into a session.
      if (
        patient &&
        row.scope_key === `patient-password:${patient.id}` &&
        eligibleLinkedPatient(patient) &&
        row.candidates.length === 1 &&
        row.candidates[0].ref === patient.id &&
        row.candidates[0].auth_user_id !== null &&
        row.candidates[0].auth_user_id === patient.auth_user_id
      ) {
        // Unlike staff first-login provisioning, this rail is only available
        // to identities that were linked before password verification.
        userId = patient.auth_user_id;
      } else {
        await patchRow(row.id, { consumed_at: new Date().toISOString() });
        res.status(409).json({ error: CLINIC_MESSAGE });
        return;
      }
    } else {
      realm = "staff";
      if (identifier.kind === "email") {
        const staff = await lookupStaffByEmail(identifier.email);
        if (staff.kind === "ok") userId = await ensureStaffAuthUser(staff.hit);
      }
    }

    if (!userId) {
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
      res.status(409).json({ error: CLINIC_MESSAGE });
      return;
    }

    const now = new Date().toISOString();
    await patchRow(row.id, {
      verified_at: now,
      consumed_at: now,
      resolved_ref: row.candidates?.[0]?.ref ?? null,
      auth_user_id: userId,
    });

    const tokenHash = await mintSessionTokenHash(await getAuthUserEmail(userId));
    res.json({ ok: true, realm, tokenHash });
  } catch (error) {
    req.log?.error({ err: error }, "auth login verify failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post(AUTH_PATIENT_PASSWORD_LOGIN_PATH, async (req, res) => {
  const slot = acquireSendSlot(clientIp(req));
  if (!slot.ok) { res.status(slot.status).json({ error: slot.message, retryable: slot.retryable }); return; }
  const started = Date.now();
  try {
    const identifier = normalizeIdentifier((req.body ?? {}).identifier);
    const password = (req.body ?? {}).password;
    if (!identifier || typeof password !== "string") {
      res.status(400).json({ error: "Enter your cell phone number or email address.", field: "identifier" });
      return;
    }
    assertLiveChannelReady(identifier.kind === "phone" ? "sms" : "email");
    const patient = await resolveEligibleLinkedPatient(identifier);
    // Always execute a grant-shaped request for a miss as well. The synthetic
    // address is random and never leaves this process.
    const valid = patient
      ? await verifyPatientPassword(patient.id, password)
      : await verifyPatientPassword(crypto.randomUUID(), password);
    if (!patient || !valid) {
      await holdUntilFloor(started);
      if (identifier.kind === "phone") await holdUntilSmsDeliveryFloor(started);
      // Wrong credentials and unknown accounts stay byte-for-byte identical,
      // but neither can masquerade as a code that was actually delivered.
      res.status(401).json({ error: PATIENT_PASSWORD_ERROR });
      return;
    }
    await patientCodeStart(req, res, "login", started, {
      id: String(patient.id),
      authUserId: String(patient.auth_user_id),
    });
  } catch (error) {
    if (error instanceof DeliveryNotConfiguredError) { res.status(503).json({ error: error.message }); return; }
    req.log?.error({ err: error }, "patient password login failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally { slot.ok && slot.release(); }
});

router.post(AUTH_PATIENT_RECOVERY_START_PATH, async (req, res) => {
  const slot = acquireSendSlot(clientIp(req));
  if (!slot.ok) { res.status(slot.status).json({ error: slot.message, retryable: slot.retryable }); return; }
  try { await patientCodeStart(req, res, "recovery"); }
  catch (error) {
    if (error instanceof DeliveryNotConfiguredError) { res.status(503).json({ error: error.message }); return; }
    req.log?.error({ err: error }, "patient recovery start failed"); res.status(502).json({ error: SERVER_ERROR });
  }
  finally { slot.ok && slot.release(); }
});

router.post(AUTH_PATIENT_RECOVERY_VERIFY_PATH, async (req, res) => {
  const slot = acquireCheckSlot(clientIp(req));
  if (!slot.ok) { res.status(slot.status).json({ error: slot.message, retryable: slot.retryable }); return; }
  try {
    const row = await checkCode("recovery", (req.body ?? {}).requestId, (req.body ?? {}).code);
    const patient = row?.candidates?.length === 1 ? await loadPatientById(row.candidates[0].ref) : null;
    if (!row || !eligibleLinkedPatient(patient)) { res.status(400).json({ error: CODE_ERROR }); return; }
    const resolvedPatient = patient!;
    const resetToken = crypto.randomBytes(32).toString("hex");
    const changed = await patchRow(row.id, { claim_token_hash: sha256(resetToken), resolved_ref: resolvedPatient.id });
    if (changed !== 1) { res.status(400).json({ error: CODE_ERROR }); return; }
    res.json({ ok: true, resetToken });
  } catch (error) { req.log?.error({ err: error }, "patient recovery verify failed"); res.status(502).json({ error: SERVER_ERROR }); }
  finally { slot.ok && slot.release(); }
});

router.post(AUTH_PATIENT_RECOVERY_COMPLETE_PATH, async (req, res) => {
  const slot = acquireFinishSlot(clientIp(req));
  if (!slot.ok) { res.status(slot.status).json({ error: slot.message, retryable: slot.retryable }); return; }
  try {
    const { resetToken, password } = (req.body ?? {}) as { resetToken?: unknown; password?: unknown };
    const issue = passwordIssue(password);
    if (issue) { res.status(400).json({ error: issue, field: "password" }); return; }
    if (!isTokenShaped(resetToken)) { res.status(400).json({ error: SESSION_EXPIRED }); return; }
    const row = await loadRowByToken(resetToken);
    if (!row || row.purpose !== "recovery" || !row.verified_at || row.consumed_at || !row.resolved_ref) {
      res.status(400).json({ error: SESSION_EXPIRED }); return;
    }
    const patient = await loadPatientById(row.resolved_ref);
    if (
      !eligibleLinkedPatient(patient) ||
      row.candidates.length !== 1 ||
      patient!.auth_user_id !== row.candidates[0].auth_user_id
    ) {
      res.status(400).json({ error: SESSION_EXPIRED }); return;
    }
    const consumed = await patchRow(row.id, { consumed_at: new Date().toISOString() }, "&consumed_at=is.null");
    if (consumed !== 1) { res.status(400).json({ error: SESSION_EXPIRED }); return; }
    await updatePatientPassword(patient!.auth_user_id!, password as string);
    res.json({ ok: true });
  } catch (error) { req.log?.error({ err: error }, "patient recovery complete failed"); res.status(502).json({ error: SERVER_ERROR }); }
  finally { slot.ok && slot.release(); }
});

router.post(AUTH_SIGNUP_OFFICE_PATH, async (req, res) => {
  const slot = acquireOfficeSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== "string" || !/^\s*[0-9]{5,6}\s*$/.test(code)) {
      res.status(400).json({ error: OFFICE_CODE_ERROR, field: "code" });
      return;
    }
    const office = await resolveSignupOffice(code);
    if (!office) {
      res.status(404).json({ error: OFFICE_CODE_ERROR, field: "code" });
      return;
    }
    res.json({ ok: true, officeName: office.officeName });
  } catch (error) {
    req.log?.error({ err: error }, "auth signup office failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post(AUTH_SIGNUP_START_PATH, async (req, res) => {
  const slot = acquireSendSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  const started = Date.now();
  try {
    const { code, flow } = (req.body ?? {}) as { code?: unknown; flow?: unknown };
    // Invitation enrollment proves the contact the office recorded; it never
    // requires (or accepts) a provider code.
    if (flow === "invited") {
      const identifier = normalizeIdentifier((req.body ?? {}).identifier);
      if (!identifier) { res.status(400).json({ error: "Enter your cell phone number or email address.", field: "identifier" }); return; }
      assertLiveChannelReady(identifier.kind === "phone" ? "sms" : "email");
      const mode = deliveryMode(identifier.kind === "phone" ? "sms" : "email");
      const hits = await lookupPatients(identifier);
      const patient = hits.length === 1 ? await loadPatientById(hits[0].ref) : null;
      if (!patient || patient.activation_status !== "invited") {
        await holdUntilFloor(started);
        res.json(neutralBody(crypto.randomUUID(), mode === "dev" ? generateCode() : null, SIGNUP_SENT_MESSAGE));
        return;
      }
      const registered = await registerSend({
        purpose: "signup", identifier, accountType: "patient",
        candidates: [{ type: "patient", ref: patient.id, name: patient.name, dob: null, claimed: Boolean(patient.auth_user_id), auth_user_id: patient.auth_user_id }],
        scopeKey: `${SIGNUP_SCOPE_PREFIX}${patient.provider_id ?? ""}`, scopeMaxPerHour: SIGNUP_SENDS_PER_OFFICE_PER_HOUR,
      });
      if (!registered) { await holdUntilFloor(started); res.json(neutralBody(crypto.randomUUID(), mode === "dev" ? generateCode() : null, SIGNUP_SENT_MESSAGE)); return; }
      if (registered.row.delivery === "twilio_verify") {
        try { await deliverSmsRegistered(registered.row); } catch { void spendUndelivered(registered.row); }
        await holdUntilSmsDeliveryFloor(started);
      }
      else deliverEmailAfterResponse(res, req.log, registered.row, registered.localCode);
      await holdUntilFloor(started);
      res.json(neutralBody(registered.row.id, mode === "dev" ? registered.localCode : null, SIGNUP_SENT_MESSAGE));
      return;
    }
    if (flow === "new") {
      const phone = normalizeIdentifier((req.body ?? {}).phone);
      const signupEmail = normalizeIdentifier((req.body ?? {}).email);
      if (!phone || phone.kind !== "phone") { res.status(400).json({ error: "Enter your cell phone number.", field: "phone" }); return; }
      if (!signupEmail || signupEmail.kind !== "email") { res.status(400).json({ error: "Enter a valid email address.", field: "email" }); return; }
      assertLiveChannelReady("sms");
      const [phoneHits, emailHits] = await Promise.all([lookupPatients(phone), lookupPatients(signupEmail)]);
      const same = phoneHits.length === 1 && emailHits.length === 1 && phoneHits[0].ref === emailHits[0].ref;
      if (phoneHits.length || emailHits.length) {
        if (!same) {
          await holdUntilFloor(started);
          res.json(neutralBody(crypto.randomUUID(), deliveryMode("sms") === "dev" ? generateCode() : null, SIGNUP_SENT_MESSAGE));
          return;
        }
        const patient = await loadPatientById(phoneHits[0].ref);
        if (!patient || !["invited", "active", "activated"].includes(patient.activation_status ?? "")) {
          await holdUntilFloor(started);
          res.json(neutralBody(crypto.randomUUID(), deliveryMode("sms") === "dev" ? generateCode() : null, SIGNUP_SENT_MESSAGE));
          return;
        }
        const registered = await registerSend({
          purpose: "signup", identifier: phone, accountType: "patient",
          candidates: phoneHits, scopeKey: `${SIGNUP_SCOPE_PREFIX}${patient.provider_id ?? ""}`,
          scopeMaxPerHour: SIGNUP_SENDS_PER_OFFICE_PER_HOUR,
        });
        if (registered?.row.delivery === "twilio_verify") {
          try { await deliverSmsRegistered(registered.row); } catch { void spendUndelivered(registered.row); }
          await holdUntilSmsDeliveryFloor(started);
        } else if (registered) {
          deliverEmailAfterResponse(res, req.log, registered.row, registered.localCode);
        }
        await holdUntilFloor(started);
        res.json(neutralBody(registered?.row.id ?? crypto.randomUUID(), deliveryMode("sms") === "dev" ? (registered?.localCode ?? generateCode()) : null, SIGNUP_SENT_MESSAGE));
        return;
      }
    }
    if (typeof code !== "string" || !/^\s*[0-9]{5,6}\s*$/.test(code)) {
      res.status(400).json({ error: OFFICE_CODE_ERROR, field: "code" });
      return;
    }
    const identifier = normalizeIdentifier((req.body ?? {}).phone);
    if (!identifier || identifier.kind !== "phone") {
      res.status(400).json({ error: "Enter your cell phone number.", field: "phone" });
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
    const office = await resolveSignupOffice(code);
    if (!office) {
      res.status(404).json({ error: OFFICE_CODE_ERROR, field: "code" });
      return;
    }

    pruneStaleRows();
    const mode = deliveryMode("sms");

    // The phone is verified before we reveal anything about it, so the send
    // itself is unconditional (existing patients simply sign in at verify).
    const existing = await lookupPatients(identifier);
    const registered = await registerSend({
      purpose: "signup",
      identifier,
      accountType: "patient",
      candidates: existing,
      scopeKey: flow === "new"
        ? `${SIGNUP_SCOPE_PREFIX}${office.providerId}|email:${Buffer.from(
            (normalizeIdentifier((req.body ?? {}).email) as { kind: "email"; email: string } | null)?.email ?? "",
          ).toString("base64url")}`
        : `${SIGNUP_SCOPE_PREFIX}${office.providerId}`,
      scopeMaxPerHour: SIGNUP_SENDS_PER_OFFICE_PER_HOUR,
    });
    if (!registered) {
      await holdUntilFloor(started);
      res.json(
        neutralBody(
          crypto.randomUUID(),
          mode === "dev" ? generateCode() : null,
          SIGNUP_SENT_MESSAGE,
        ),
      );
      return;
    }

    if (registered.row.delivery === "twilio_verify") {
      try {
        await deliverSmsRegistered(registered.row);
      } catch (error) {
        req.log?.error({ err: error }, "auth signup sms delivery rejected");
        void spendUndelivered(registered.row).catch((spendError) => {
          req.log?.error({ err: spendError }, "auth signup rejected-send ledger update failed");
        });
      }
      await holdUntilSmsDeliveryFloor(started);
    } else {
      deliverEmailAfterResponse(res, req.log, registered.row, registered.localCode);
    }
    await holdUntilFloor(started);
    res.json(
      neutralBody(
        registered.row.id,
        mode === "dev" ? registered.localCode : null,
        SIGNUP_SENT_MESSAGE,
      ),
    );
  } catch (error) {
    req.log?.error({ err: error }, "auth signup start failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post(AUTH_SIGNUP_VERIFY_PATH, async (req, res) => {
  const slot = acquireCheckSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const { requestId, code } = (req.body ?? {}) as { requestId?: unknown; code?: unknown };
    let row: VerificationRow | null;
    try {
      row = await checkCode("signup", requestId, code);
    } catch (error) {
      if (error instanceof DeliveryNotConfiguredError) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }
    if (!row) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }

    // Enrollment always continues through the password/details completion
    // capability, including an office-invited row.  It never signs in here.
    if (row.candidates.length > 1) {
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
      res.status(409).json({ error: CLINIC_MESSAGE });
      return;
    }
    const token = crypto.randomBytes(32).toString("hex");
    await patchRow(row.id, {
      verified_at: new Date().toISOString(),
      claim_token_hash: sha256(token),
      resolved_ref: row.candidates.length === 1 ? row.candidates[0].ref : null,
    });
    res.json({ ok: true, mode: "enroll" as const, signupToken: token });
  } catch (error) {
    req.log?.error({ err: error }, "auth signup verify failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post(AUTH_SIGNUP_COMPLETE_PATH, async (req, res) => {
  const slot = acquireFinishSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  let createdPatientId: string | null = null;
  try {
    const { signupToken, name, email, password } = (req.body ?? {}) as {
      signupToken?: unknown;
      name?: unknown;
      email?: unknown;
      password?: unknown;
    };
    if (!isTokenShaped(signupToken)) {
      res.status(400).json({ error: SESSION_EXPIRED });
      return;
    }
    const passwordError = passwordIssue(password);
    if (passwordError) {
      res.status(400).json({ error: passwordError, field: "password" });
      return;
    }
    const row = await loadRowByToken(signupToken);
    if (
      !row ||
      row.purpose !== "signup" ||
      !row.verified_at ||
      row.consumed_at
    ) {
      res.status(400).json({ error: SESSION_EXPIRED });
      return;
    }

    if (row.resolved_ref) {
      const patient = await loadPatientById(row.resolved_ref);
      if (!patient || !["invited", "active", "activated"].includes(patient.activation_status ?? "")) {
        res.status(400).json({ error: SESSION_EXPIRED });
        return;
      }
      const cleanName = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
      const normalizedEmail = normalizeIdentifier(email);
      const fill: Record<string, unknown> = {};
      if (!patient.name && cleanName) fill.name = cleanName;
      if (!patient.email && normalizedEmail?.kind === "email") fill.email = normalizedEmail.email;
      if (!patient.phone && row.identifier_kind === "phone") fill.phone = row.identifier;
      if (patient.activation_status === "invited") fill.activation_status = "activated";
      // Reserve the capability before any patient or GoTrue mutation.  A
      // second completion racing this one sees the same generic expiry and
      // cannot overwrite the winning password.
      const reserved = await patchRow(
        row.id,
        { consumed_at: new Date().toISOString() },
        "&consumed_at=is.null",
      );
      if (reserved !== 1) { res.status(400).json({ error: SESSION_EXPIRED }); return; }
      if (Object.keys(fill).length) {
        const updated = await supabaseAdmin("PATCH", `/rest/v1/patients?id=eq.${encodeURIComponent(patient.id)}`, fill);
        if (updated.status >= 300) throw new Error(`patient enrollment update failed (${updated.status})`);
      }
      const userId = await ensurePatientAuthUser({ ...patient, ...fill });
      await updatePatientPassword(userId, password as string);
      const tokenHash = await mintSessionTokenHash(await getAuthUserEmail(userId));
      res.json({ ok: true, tokenHash });
      return;
    }

    const cleanName = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
    if (cleanName.length < 1 || cleanName.length > 120) {
      res.status(400).json({ error: "Enter your name.", field: "name" });
      return;
    }
    const encodedContextEmail = (row.scope_key ?? "").split("|email:")[1];
    const contextEmail = encodedContextEmail
      ? Buffer.from(encodedContextEmail, "base64url").toString("utf8")
      : email;
    const normalizedEmail = normalizeIdentifier(contextEmail);
    if (!normalizedEmail || normalizedEmail.kind !== "email") {
      res.status(400).json({ error: "Enter a valid email address.", field: "email" });
      return;
    }

    // Patient emails must map to exactly one patient account — the email
    // code fallback depends on it. The partial unique index is the airtight
    // backstop; this pre-check just gives a clear error.
    const emailTaken = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?email=ilike.${encodeURIComponent(normalizedEmail.email)}&select=id&limit=1`,
    );
    if (emailTaken.status >= 300) throw new Error(`email check failed (${emailTaken.status})`);
    if (Array.isArray(emailTaken.json) && emailTaken.json.length > 0) {
      res.status(409).json({
        error: "That email is already on a patient account. Use a different email, or sign in with it instead.",
        field: "email",
      });
      return;
    }

    // The office must still be active — a lock applied mid-signup blocks it.
    const officeRef = (row.scope_key ?? "").startsWith(SIGNUP_SCOPE_PREFIX)
      ? (row.scope_key ?? "").slice(SIGNUP_SCOPE_PREFIX.length).split("|", 1)[0]
      : "";
    const office = officeRef ? await resolveSignupOfficeById(officeRef) : null;
    if (!office) {
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
      res.status(409).json({ error: OFFICE_CODE_ERROR });
      return;
    }

    const patientId = crypto.randomUUID();
    const patient = {
      id: patientId,
      provider_id: office.providerId,
      name: cleanName,
      email: normalizedEmail.email,
      phone: row.identifier,
      activation_status: "activated",
      created_at: new Date().toISOString(),
    };

    // Auth user first (it can fail on a phone already holding a login),
    // then the patient row, then the link — with cleanup on every failure.
    let userId: string;
    try {
      userId = await createConfirmedPatientUser(
        { id: patientId, phone: row.identifier, name: cleanName },
        password as string,
      );
    } catch (error) {
      if (error instanceof PhoneExistsError) {
        res.status(409).json({
          error: "That phone number already has a login. Go back and sign in instead.",
        });
        return;
      }
      throw error;
    }

    const inserted = await supabaseAdmin(
      "POST",
      "/rest/v1/patients",
      { ...patient, auth_user_id: userId, claimed_at: new Date().toISOString() },
      "return=representation",
    );
    if (inserted.status >= 300) {
      await deleteAuthUserQuietly(userId);
      const message = String((inserted.json as { message?: unknown })?.message ?? "");
      const conflict = patientUniqueConflict(message);
      if (conflict === "email") {
        res.status(409).json({
          error: "That email is already on a patient account. Use a different email, or sign in with it instead.",
          field: "email",
        });
        return;
      }
      if (conflict === "phone") {
        res.status(409).json({
          error: "That phone number is already on a patient account. Go back and sign in instead.",
        });
        return;
      }
      throw new Error(`patient creation failed (${inserted.status})`);
    }
    createdPatientId = patientId;

    await patchRow(row.id, {
      consumed_at: new Date().toISOString(),
      resolved_ref: patientId,
      auth_user_id: userId,
    });

    const tokenHash = await mintSessionTokenHash(patientSyntheticEmail(patientId));
    res.json({ ok: true, tokenHash });
  } catch (error) {
    req.log?.error({ err: error, patientId: createdPatientId }, "auth signup complete failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

export default router;
