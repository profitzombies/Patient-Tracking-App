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
import { STAFF_REAUTH_SCOPE_PREFIX } from "../auth/fresh-code";
import { APP_REVIEW_DELIVERY, appReviewIdentity, type AppReviewRealm } from "../auth/app-review";
import { loadOfficeIsAppReview } from "../lib/office-status";
import { normalizeIdentifier, type NormalizedIdentifier } from "../claim/normalize";
import {
  PASSWORD_RESET_REQUIRED_CODE,
  PASSWORD_RESET_REQUIRED_MESSAGE,
  afterRecoveryCompleted,
  respondSessionContainmentFailed,
  SessionContainmentError,
  sweepSessionsBeforeRecovery,
  forcedResetPending,
  noteSignIn,
} from "../security/sign-in-hooks";
import { recordAdminAuditEvent, requestIdOf, type AuditActorKind } from "../lib/admin-audit";
import {
  deliveryMode,
  DeliveryNotConfiguredError,
  assertLiveChannelReady,
  holdUntilSmsDeliveryFloor,
  generateCode,
  startTwilioVerification,
  checkTwilioVerification,
  twilioVerifyServiceFor,
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
  type StaffHit,
} from "../auth/directory";
import {
  currentSecondFactorPolicy,
  factorKindOf,
  loadStaffSecondFactor,
  maskPhone,
  saveStaffSecondFactor,
  secondFactorApplies,
  type StaffSecondFactor,
} from "../auth/second-factor";
import {
  mintSessionTokenHash,
  getAuthUserEmail,
  ensureStaffAuthUser,
  deleteAuthUserQuietly,
  patientSyntheticEmail,
  PhoneExistsError,
  createConfirmedPatientUser,
  updatePatientPassword,
  verifyPatientPassword,
  setEnrollmentLogin,
  undoEnrollmentLogin,
  WeakPasswordError,
  WEAK_PASSWORD_CODE,
} from "../auth/session";
import { passwordIssue } from "../claim/normalize";
import { logger } from "../lib/logger";
import { loadPrivacyState } from "./patient-privacy";
import {
  acquireSendSlot,
  acquireCheckSlot,
  acquireOfficeSlot,
  acquireFinishSlot,
  RECOVERY_PER_IDENTITY_PER_DAY,
} from "../auth/limits";

const router: IRouter = Router();

export const AUTH_LOGIN_START_PATH = "/auth/login/start";
export const AUTH_LOGIN_VERIFY_PATH = "/auth/login/verify";
export const AUTH_LOGIN_PHONE_START_PATH = "/auth/login/phone/start";
export const AUTH_LOGIN_PHONE_VERIFY_PATH = "/auth/login/phone/verify";
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
/** Step-token failures on the texted-code step: the client restarts at email. */
const STEP_EXPIRED_CODE = "STEP_EXPIRED";
const PHONE_ON_FILE_MESSAGE = "A verified phone is already on file for this account. Codes go to that number.";
const PHONE_REQUIRED_MESSAGE = "Enter the mobile number that should receive your sign-in codes.";
const SERVER_ERROR = "We couldn't process that just now. Please try again in a moment.";

/** GoTrue refused the password (breach list or policy): say so on the field. */
export function respondWeakPassword(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  error: WeakPasswordError,
  field = "password",
): void {
  res.status(400).json({ error: error.userMessage, field, code: WEAK_PASSWORD_CODE });
}

/**
 * Give back a one-time capability this request reserved (consumed_at stamp)
 * when the work it guarded did not happen. Guarded on our own stamp so it
 * can never reopen a row some other request finished.
 */
async function releaseReservation(rowId: string, consumedAt: string): Promise<void> {
  await patchRow(rowId, { consumed_at: null }, `&consumed_at=eq.${encodeURIComponent(consumedAt)}`);
}

/** First/last name for enrollment: trimmed, single-spaced, 1–80 chars. */
function cleanNamePart(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

interface EnrollmentNameRow {
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email_verified_at?: string | null;
  phone_verified_at?: string | null;
}

async function loadEnrollmentNames(patientId: string): Promise<EnrollmentNameRow | null> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${encodeURIComponent(patientId)}&archived_at=is.null&select=name,first_name,last_name,email_verified_at,phone_verified_at&limit=1`,
  );
  if (res.status >= 300) throw new Error(`patient name lookup failed (${res.status})`);
  const rows = Array.isArray(res.json) ? (res.json as EnrollmentNameRow[]) : [];
  return rows[0] ?? null;
}

/** Office-entered name split the same way the roster DTO splits it. */
async function loadInvitedName(patientId: string): Promise<{ firstName: string; lastName: string } | null> {
  const row = await loadEnrollmentNames(patientId);
  if (!row) return null;
  const whole = String(row.name ?? "").trim().split(/\s+/).filter(Boolean);
  const firstName = cleanNamePart(row.first_name) || whole[0] || "";
  const lastName = cleanNamePart(row.last_name) || whole.slice(1).join(" ");
  return firstName || lastName ? { firstName, lastName } : null;
}

/**
 * Which verified-at column the signup code proved: the phone or email the
 * code was delivered to, but only when that is the contact on the patient row.
 */
function provenContactColumn(
  row: { identifier_kind: string; identifier: string },
  onFile: { email: string | null | undefined; phone: string | null | undefined },
): "email_verified_at" | "phone_verified_at" | null {
  const proven = normalizeIdentifier(row.identifier);
  if (!proven || proven.kind !== row.identifier_kind) return null;
  const stored = normalizeIdentifier(proven.kind === "phone" ? onFile.phone : onFile.email);
  if (!stored || stored.kind !== proven.kind) return null;
  if (proven.kind === "phone" && stored.kind === "phone") {
    return proven.e164 === stored.e164 ? "phone_verified_at" : null;
  }
  if (proven.kind === "email" && stored.kind === "email") {
    return proven.email === stored.email ? "email_verified_at" : null;
  }
  return null;
}

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
export async function deliverSmsRegistered(
  row: VerificationRow,
): Promise<void> {
  if (row.delivery === "twilio_verify") {
    // Each purpose rides its own Verify service where one exists, so the
    // texted code is bound to the purpose of this ledger row.
    await startTwilioVerification(row.identifier, twilioVerifyServiceFor(row.purpose));
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

/**
 * Which reviewer identity (if any) a resolved account type may match. The
 * realm is derived from the directory hit, never the request, and HQ account
 * types never map to a reviewer realm.
 */
function appReviewRealmOf(accountType: VerificationRow["account_type"]): AppReviewRealm | null {
  if (accountType === "patient") return "patient";
  if (accountType === "provider" || accountType === "team_member") return "staff";
  return null;
}

export async function spendUndelivered(row: VerificationRow): Promise<void> {
  const spent = await patchRow(
    row.id,
    { consumed_at: new Date().toISOString() },
    "&verified_at=is.null&consumed_at=is.null",
  );
  if (spent !== 1) throw new Error("undelivered auth send could not be spent");
}

export type CodePurpose = "login" | "signup" | "recovery" | "password_change" | "cart_pay" | "staff_sms" | "account_deletion";

export interface RegisterSendInput {
  purpose: CodePurpose;
  identifier: NormalizedIdentifier;
  accountType: VerificationRow["account_type"];
  candidates: Candidate[];
  scopeKey?: string | null;
  scopeMaxPerHour?: number | null;
  /**
   * The office the resolved account belongs to. Only the store-reviewer rule
   * reads it: a listed identity gets the fixed code solely while its account
   * sits in the flagged App Review office. Omitted = no reviewer path.
   */
  officeId?: string | null;
}

/**
 * Ledger row + per-identifier hourly send cap in ONE atomic database call
 * (advisory lock + count + insert), so concurrent requests cannot race past
 * the cap. Cap hits come back as null and are absorbed silently so the cap
 * itself cannot become an existence oracle.
 */
export async function registerSend(
  input: RegisterSendInput,
): Promise<{ row: VerificationRow; localCode: string | null } | null> {
  const kind = input.identifier.kind;
  const stored = kind === "phone" ? input.identifier.e164 : input.identifier.email;
  const mode = deliveryMode(kind === "phone" ? "sms" : "email");
  // Store reviewers: the environment-named patient / staff identity gets a
  // fixed code on a row nothing delivers. Only sign-in codes, only after the
  // directory matched the identity (this runs after the lookup), the realm
  // follows the resolved account type rather than the request, and the
  // account must sit in the flagged App Review office. HQ logins and listed
  // identities in any ordinary office stay on the delivered path.
  const reviewerRealm = appReviewRealmOf(input.accountType);
  const listed =
    input.purpose === "login" && reviewerRealm ? appReviewIdentity(reviewerRealm, input.identifier) : null;
  const reviewer = listed && input.officeId && (await loadOfficeIsAppReview(input.officeId)) ? listed : null;
  const delivery: VerificationRow["delivery"] = reviewer
    ? APP_REVIEW_DELIVERY
    : mode === "dev"
      ? "dev"
      : kind === "phone"
        ? "twilio_verify"
        : "resend";
  const localCode = reviewer ? reviewer.code : delivery === "twilio_verify" ? null : generateCode();
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
  // A reviewer code is known to the reviewer already; it never rides a
  // response (dev inline code included) or a message.
  return { row: registered.json[0] as VerificationRow, localCode: reviewer ? null : localCode };
}

/** Shared code-check preamble: row guards, attempt counting, code matching. */
export async function checkCode(
  purpose: CodePurpose,
  requestId: unknown,
  code: unknown,
): Promise<VerificationRow | null> {
  const row = await matchCode(purpose, requestId, code);
  return row && (await claimCode(row)) ? row : null;
}

/**
 * Match without claiming: spends an attempt and answers whether the code is
 * right, but leaves the one-time claim to claimCode. Only for callers that
 * must do a reversible pre-step (e.g. sign out other sessions) BEFORE the
 * proof is spent, so a refused pre-step leaves the same code retryable.
 * Between match and claim the code is still redeemable exactly once: the
 * claim below is the single conditional UPDATE, so a parallel matcher loses.
 */
export async function matchCode(
  purpose: CodePurpose,
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
    matched = await checkTwilioVerification(row.identifier, code, twilioVerifyServiceFor(row.purpose));
  } else {
    matched = codeMatches(row, code);
  }
  if (!matched) return null;
  return row;
}

/** The one-time claim; see checkCode. True when this caller won the row. */
export async function claimCode(row: VerificationRow): Promise<boolean> {
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
  return claimed === 1;
}

/**
 * Activation states that keep a patient's login working. Paused and
 * discharged are office program statuses set by staff, not account locks:
 * the patient can still sign in and see their own record.
 */
const LOGIN_ELIGIBLE_ACTIVATION = ["invited", "active", "activated", "paused", "discharged"];

export function eligibleLinkedPatient(patient: Awaited<ReturnType<typeof loadPatientById>>): boolean {
  return Boolean(
    patient &&
      patient.auth_user_id &&
      LOGIN_ELIGIBLE_ACTIVATION.includes(patient.activation_status ?? ""),
  );
}

async function resolveEligibleLinkedPatient(identifier: NormalizedIdentifier) {
  const hits = await lookupPatients(identifier);
  if (hits.length !== 1) return null;
  const patient = await loadPatientById(hits[0].ref);
  return eligibleLinkedPatient(patient) ? patient : null;
}

/**
 * Per-identity recovery cap: how many recovery codes this phone/email has
 * asked for in the last 24 hours, regardless of which connection asked. The
 * shared hourly send pot already slows a burst; this stops a patient day-long
 * drip and, with the per-IP limits, closes the distributed-guessing angle.
 */
async function recoveryBudgetSpent(
  identifier: NormalizedIdentifier,
  purpose: "recovery" | "account_deletion" = "recovery",
): Promise<boolean> {
  const stored = identifier.kind === "phone" ? identifier.e164 : identifier.email;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const counted = await supabaseAdmin(
    "GET",
    `/rest/v1/claim_verifications?purpose=eq.${purpose}&identifier=eq.${encodeURIComponent(stored)}&created_at=gt.${encodeURIComponent(since)}&select=id&limit=${RECOVERY_PER_IDENTITY_PER_DAY + 1}`,
  );
  if (counted.status >= 300 || !Array.isArray(counted.json)) throw new Error(`recovery budget read failed (${counted.status})`);
  return counted.json.length >= RECOVERY_PER_IDENTITY_PER_DAY;
}

/**
 * Identity-neutral patient code start shared by sign-in, recovery and the
 * public delete-account page: one answer shape for match and non-match, the
 * shared send pot reserved before any delivery, timing floors on every exit.
 */
export async function patientCodeStart(
  req: any,
  res: any,
  purpose: "login" | "recovery" | "account_deletion",
  started = Date.now(),
  boundPatient: { id: string; authUserId: string } | null = null,
): Promise<void> {
  const identifier = normalizeIdentifier((req.body ?? {}).identifier);
  if (!identifier) {
    res.status(400).json({ error: "Enter your cell phone number or email address.", field: "identifier" });
    return;
  }
  assertLiveChannelReady(identifier.kind === "phone" ? "sms" : "email", twilioVerifyServiceFor(purpose));
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
  const registered =
    (purpose === "recovery" || purpose === "account_deletion") && (await recoveryBudgetSpent(identifier, purpose))
      ? null
      : await registerSend({
          purpose, identifier, accountType: "patient",
          candidates: [{ type: "patient", ref: patient.id, name: patient.name, dob: null, claimed: true, auth_user_id: patient.auth_user_id }],
          scopeKey: purpose === "login" ? `patient-password:${patient.id}` : null,
          officeId: patient.provider_id ?? null,
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
    let officeId: string | null = null;
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
        officeId = staff.hit.providerId;
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
      officeId,
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
    if ((row.scope_key ?? "").startsWith(STAFF_REAUTH_SCOPE_PREFIX)) {
      // A staff re-authentication code proves an existing session, never a new one.
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
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

    // A reviewer row (fixed, never-delivered code) is honoured only while the
    // environment still names this exact identity for this realm. Removing or
    // breaking the variable refuses rows issued before the change too. The
    // account it resolves to is re-checked below: it must still be the same
    // account class and reference the row was issued for, inside the flagged
    // App Review office. An identity moved to another office or promoted to
    // HQ since issuance never turns the fixed code into a session.
    const reviewerRealm = appReviewRealmOf(row.account_type);
    const reviewer = row.delivery === APP_REVIEW_DELIVERY && reviewerRealm ? appReviewIdentity(reviewerRealm, identifier) : null;
    if (row.delivery === APP_REVIEW_DELIVERY && !reviewer) {
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
      res.status(400).json({ error: CODE_ERROR });
      return;
    }
    const reviewerBound = async (resolved: {
      accountType: VerificationRow["account_type"];
      ref: string;
      providerId: string | null;
    }): Promise<boolean> =>
      resolved.accountType === row.account_type &&
      row.candidates.length === 1 &&
      row.candidates[0].ref === resolved.ref &&
      resolved.providerId !== null &&
      (await loadOfficeIsAppReview(resolved.providerId));

    let userId: string | null = null;
    let realm: "staff" | "patient";
    let reviewerAudit: { actorKind: AuditActorKind; providerId: string | null } | null = null;
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
        if (reviewer) {
          const bound = await reviewerBound({
            accountType: "patient",
            ref: String(patient.id),
            providerId: patient.provider_id ?? null,
          });
          if (!bound) {
            await patchRow(row.id, { consumed_at: new Date().toISOString() });
            res.status(409).json({ error: CLINIC_MESSAGE });
            return;
          }
          reviewerAudit = { actorKind: "patient", providerId: patient.provider_id ?? null };
        }
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
        if (staff.kind === "ok") {
          if (reviewer) {
            // The fixed code was issued for an office staff account of the
            // App Review office. Re-resolve that binding before it buys
            // anything: a different class (HQ membership now owns the email),
            // a different record, or an office without the flag ends here.
            const bound = await reviewerBound({
              accountType: staff.hit.class === "provider" || staff.hit.class === "team_member" ? staff.hit.class : "hq_admin",
              ref: staff.hit.ref,
              providerId: staff.hit.providerId,
            });
            if (!bound) {
              await patchRow(row.id, { consumed_at: new Date().toISOString() });
              res.status(409).json({ error: CLINIC_MESSAGE });
              return;
            }
          }
          // The reviewer staff identity has no phone a reviewer could read, so
          // the texted second factor is skipped for that one identity only.
          const step = reviewer ? null : await staffSecondFactorStep(staff.hit);
          if (step) {
            // The emailed code is proven but the session is NOT issued yet:
            // the row keeps verified_at (so the code can never be replayed)
            // and carries a short-lived step token the texted-code routes
            // redeem. consumed_at lands only when the second step completes.
            await patchRow(row.id, {
              verified_at: new Date().toISOString(),
              resolved_ref: staff.hit.ref,
              claim_token_hash: sha256(step.token),
            });
            res.json({ ok: true, realm, secondFactor: step.body });
            return;
          }
          userId = await ensureStaffAuthUser(staff.hit);
          await startOfficeIncludedPeriod(staff.hit, userId, req);
          if (reviewer) {
            reviewerAudit = {
              actorKind: staff.hit.class === "provider" ? "provider" : staff.hit.class === "team_member" ? "team_member" : "hq",
              providerId: staff.hit.providerId,
            };
          }
        }
      }
    }

    if (!userId) {
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
      res.status(409).json({ error: CLINIC_MESSAGE });
      return;
    }

    // Every reviewer sign-in lands in the audit ledger BEFORE a session is
    // minted: a failed audit write refuses the sign-in (502) rather than
    // leaving an unrecorded reviewer session.
    if (reviewerAudit) {
      await recordAdminAuditEvent({
        action: "app_review_sign_in",
        actorUserId: userId,
        actorKind: reviewerAudit.actorKind,
        providerId: reviewerAudit.providerId,
        targetKind: "auth_user",
        targetId: userId,
        requestId: requestIdOf(req),
        metadata: { realm },
      });
    }

    const now = new Date().toISOString();
    await patchRow(row.id, {
      verified_at: now,
      consumed_at: now,
      resolved_ref: row.candidates?.[0]?.ref ?? null,
      auth_user_id: userId,
    });

    // A "this wasn't me" report holds the account until a recovery lands a
    // fresh password. The code is already spent, so the person restarts via
    // "Forgot password" rather than retrying this one.
    if (realm === "patient" && (await forcedResetPending(userId))) {
      res.status(403).json({ error: PASSWORD_RESET_REQUIRED_MESSAGE, code: PASSWORD_RESET_REQUIRED_CODE });
      return;
    }

    const signInId = await noteSignIn(req, {
      userId,
      realm,
      method:
        realm === "staff" ? "email_code" : identifier.kind === "phone" ? "password_sms_code" : "password_email_code",
    });
    const tokenHash = await mintSessionTokenHash(await getAuthUserEmail(userId));
    res.json({ ok: true, realm, tokenHash, signInId });
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
    // Only a proven password reaches this branch, so the answer reveals
    // nothing about unknown identifiers.
    if (await forcedResetPending(String(patient.auth_user_id))) {
      await holdUntilFloor(started);
      if (identifier.kind === "phone") await holdUntilSmsDeliveryFloor(started);
      res.status(403).json({ error: PASSWORD_RESET_REQUIRED_MESSAGE, code: PASSWORD_RESET_REQUIRED_CODE });
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
    // Containment comes first and is required: whoever held the old password
    // (or a lost phone) must be out before the new password exists. A refused
    // sweep leaves the proof unconsumed so the same request can be retried.
    try {
      await sweepSessionsBeforeRecovery(req, patient!.auth_user_id!);
    } catch (error) {
      if (error instanceof SessionContainmentError) { respondSessionContainmentFailed(res); return; }
      throw error;
    }
    const consumedAt = new Date().toISOString();
    const consumed = await patchRow(row.id, { consumed_at: consumedAt }, "&consumed_at=is.null");
    if (consumed !== 1) { res.status(400).json({ error: SESSION_EXPIRED }); return; }
    try {
      await updatePatientPassword(patient!.auth_user_id!, password as string);
    } catch (error) {
      if (!(error instanceof WeakPasswordError)) throw error;
      // The password never changed: hand the same reset proof back so the
      // patient can pick another password without a fresh code.
      await releaseReservation(row.id, consumedAt);
      respondWeakPassword(res, error);
      return;
    }
    await afterRecoveryCompleted(req, {
      userId: patient!.auth_user_id!,
      patientId: String(patient!.id),
      providerId: patient!.provider_id ? String(patient!.provider_id) : null,
      requestId: requestIdOf(req),
    });
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
        if (!patient || !LOGIN_ELIGIBLE_ACTIVATION.includes(patient.activation_status ?? "")) {
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
    const resolvedRef = row.candidates.length === 1 ? row.candidates[0].ref : null;
    await patchRow(row.id, {
      verified_at: new Date().toISOString(),
      claim_token_hash: sha256(token),
      resolved_ref: resolvedRef,
    });
    // Ownership of the invited contact is proven at this point, so the name
    // the office entered can come back for the patient to confirm or edit.
    // A failed lookup only loses the prefill; the token is already minted.
    const invitedName = resolvedRef
      ? await loadInvitedName(resolvedRef).catch((error) => {
          req.log?.error({ err: error }, "auth signup verify name prefill failed");
          return null;
        })
      : null;
    res.json({
      ok: true,
      mode: "enroll" as const,
      signupToken: token,
      ...(invitedName ? { invitedName } : {}),
    });
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
  const clock = stageClock();
  try {
    const { signupToken, name, firstName, lastName, email, password } = (req.body ?? {}) as {
      signupToken?: unknown;
      name?: unknown;
      firstName?: unknown;
      lastName?: unknown;
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
    // First + last name (the app's name step); a bare `name` is still
    // accepted from older clients.
    const splitName = typeof firstName === "string" || typeof lastName === "string";
    const first = cleanNamePart(firstName);
    const last = cleanNamePart(lastName);
    if (splitName) {
      if (!first) { res.status(400).json({ error: "Enter your first name.", field: "firstName" }); return; }
      if (!last) { res.status(400).json({ error: "Enter your last name.", field: "lastName" }); return; }
      if (first.length > 80) { res.status(400).json({ error: "First name is too long.", field: "firstName" }); return; }
      if (last.length > 80) { res.status(400).json({ error: "Last name is too long.", field: "lastName" }); return; }
    }
    const legacyName = cleanNamePart(name);
    const fullName = splitName ? `${first} ${last}` : legacyName;

    const row = await loadRowByToken(signupToken);
    clock.mark("token");
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
      // The office's name and proven-contact fields load alongside the
      // patient row; a failed read only matters once the patient is known
      // to be eligible.
      const namesLoad = loadEnrollmentNames(row.resolved_ref).then(
        (names) => ({ ok: true as const, names }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const [patient, namesResult] = await Promise.all([loadPatientById(row.resolved_ref), namesLoad]);
      clock.mark("patient");
      if (!patient || !LOGIN_ELIGIBLE_ACTIVATION.includes(patient.activation_status ?? "")) {
        res.status(400).json({ error: SESSION_EXPIRED });
        return;
      }
      const normalizedEmail = normalizeIdentifier(email);
      const fill: Record<string, unknown> = {};
      // A confirmed or edited name replaces the office's version.
      if (splitName) Object.assign(fill, { first_name: first, last_name: last, name: fullName });
      else if (!patient.name && legacyName) fill.name = legacyName;
      if (!patient.email && normalizedEmail?.kind === "email") fill.email = normalizedEmail.email;
      if (!patient.phone && row.identifier_kind === "phone") fill.phone = row.identifier;
      if (patient.activation_status === "invited") fill.activation_status = "activated";
      if (!namesResult.ok) throw namesResult.error;
      const priorNames = namesResult.names;
      // The signup code proved this contact, so the details step never asks
      // for it again. Stamped only when it is the contact actually on file.
      const provenColumn = provenContactColumn(row, {
        email: (fill.email as string | undefined) ?? patient.email,
        phone: (fill.phone as string | undefined) ?? patient.phone,
      });
      if (provenColumn && !priorNames?.[provenColumn]) fill[provenColumn] = new Date().toISOString();
      const prior: Record<string, unknown> = {};
      for (const key of Object.keys(fill)) {
        prior[key] =
          priorNames && key in priorNames
            ? priorNames[key as keyof EnrollmentNameRow]
            : (patient as unknown as Record<string, unknown>)[key] ?? null;
      }

      // Reserve the capability before any patient or GoTrue mutation.  A
      // second completion racing this one sees the same generic expiry and
      // cannot overwrite the winning password.
      const reservedAt = new Date().toISOString();
      const reserved = await patchRow(row.id, { consumed_at: reservedAt }, "&consumed_at=is.null");
      clock.mark("reserve");
      if (reserved !== 1) { res.status(400).json({ error: SESSION_EXPIRED }); return; }

      // Order matters: the password must be accepted by GoTrue (breach list
      // included) on the login before the patient is marked activated, and
      // any failure unwinds every step so the same code can be retried.
      let login: { userId: string; created: boolean } | null = null;
      let patientTouched = false;
      try {
        login = await setEnrollmentLogin(
          {
            ...patient,
            phone: (fill.phone as string | undefined) ?? patient.phone,
            name: (fill.name as string | undefined) ?? patient.name,
          },
          password as string,
        );
        clock.mark("login");
        // The password is accepted, so activation, the session mint and the
        // sign-in ledger no longer depend on each other: run them together
        // and unwind everything if any one fails. A login this attempt
        // created carries the synthetic address, so no lookup is needed.
        const accepted = login;
        if (Object.keys(fill).length) patientTouched = true;
        const [minted, activated, ledger, privacy] = await Promise.allSettled([
          (accepted.created
            ? Promise.resolve(patientSyntheticEmail(patient.id))
            : getAuthUserEmail(accepted.userId)
          ).then((authEmail) => mintSessionTokenHash(authEmail)),
          patientTouched
            ? supabaseAdmin("PATCH", `/rest/v1/patients?id=eq.${encodeURIComponent(patient.id)}`, fill).then((updated) => {
                if (updated.status >= 300) throw new Error(`patient enrollment update failed (${updated.status})`);
              })
            : Promise.resolve(),
          noteSignIn(req, { userId: accepted.userId, realm: "patient", method: "signup", firstSignIn: accepted.created }),
          signupPrivacy(patient.id),
        ]);
        clock.mark("finish");
        for (const step of [minted, activated, ledger]) if (step.status === "rejected") throw step.reason;
        clock.send(res, req);
        res.json(signupSuccess({
          tokenHash: (minted as PromiseFulfilledResult<string>).value,
          signInId: (ledger as PromiseFulfilledResult<string>).value,
          patientId: patient.id,
          privacy: privacy.status === "fulfilled" ? privacy.value : null,
        }));
        return;
      } catch (error) {
        await rollbackInvitedEnrollment({
          patientId: patient.id,
          prior: patientTouched ? prior : null,
          login,
          rowId: row.id,
          reservedAt,
        }).catch((rollbackError) =>
          req.log?.error({ err: rollbackError, patientId: patient.id }, "auth signup rollback incomplete"),
        );
        if (error instanceof WeakPasswordError) {
          respondWeakPassword(res, error);
          return;
        }
        throw error;
      }
    }

    if (fullName.length < 1 || fullName.length > 120) {
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
    //
    // The office must still be active — a lock applied mid-signup blocks it.
    // Both reads are independent and run together; the email answer is
    // checked first so a taken email never consumes the code.
    const officeRef = (row.scope_key ?? "").startsWith(SIGNUP_SCOPE_PREFIX)
      ? (row.scope_key ?? "").slice(SIGNUP_SCOPE_PREFIX.length).split("|", 1)[0]
      : "";
    const [emailCheck, officeCheck] = await Promise.allSettled([
      supabaseAdmin(
        "GET",
        `/rest/v1/patients?email=ilike.${encodeURIComponent(normalizedEmail.email)}&archived_at=is.null&select=id&limit=1`,
      ),
      officeRef ? resolveSignupOfficeById(officeRef) : Promise.resolve(null),
    ]);
    clock.mark("checks");
    if (emailCheck.status === "rejected") throw emailCheck.reason;
    const emailTaken = emailCheck.value;
    if (emailTaken.status >= 300) throw new Error(`email check failed (${emailTaken.status})`);
    if (Array.isArray(emailTaken.json) && emailTaken.json.length > 0) {
      res.status(409).json({
        error: "That email is already on a patient account. Use a different email, or sign in with it instead.",
        field: "email",
      });
      return;
    }

    if (officeCheck.status === "rejected") throw officeCheck.reason;
    const office = officeCheck.value;
    if (!office) {
      await patchRow(row.id, { consumed_at: new Date().toISOString() });
      res.status(409).json({ error: OFFICE_CODE_ERROR });
      return;
    }

    const patientId = crypto.randomUUID();
    const patient = {
      id: patientId,
      provider_id: office.providerId,
      name: fullName,
      ...(splitName ? { first_name: first, last_name: last } : {}),
      email: normalizedEmail.email,
      phone: row.identifier,
      // The signup code was texted to this phone; the email is still unproven.
      ...(row.identifier_kind === "phone" ? { phone_verified_at: new Date().toISOString() } : {}),
      activation_status: "activated",
      created_at: new Date().toISOString(),
    };

    // Auth user first, carrying the password (it can fail on a phone already
    // holding a login, or on a password GoTrue refuses), then the patient
    // row, then the link — with cleanup on every failure. Nothing activates
    // before GoTrue has accepted the password.
    let userId: string;
    try {
      userId = await createConfirmedPatientUser(
        { id: patientId, phone: row.identifier, name: fullName },
        password as string,
      );
      clock.mark("login");
    } catch (error) {
      if (error instanceof PhoneExistsError) {
        res.status(409).json({
          error: "That phone number already has a login. Go back and sign in instead.",
        });
        return;
      }
      if (error instanceof WeakPasswordError) {
        respondWeakPassword(res, error);
        return;
      }
      throw error;
    }

    // The password is accepted. The session mint, the sign-in ledger (a
    // brand-new login has no history to compare) and the privacy snapshot
    // need only the login, so they run beside the patient row and the code
    // consumption. The ledger stays fail-closed: the response waits for it.
    const sideSteps = Promise.allSettled([
      mintSessionTokenHash(patientSyntheticEmail(patientId)),
      noteSignIn(req, { userId, realm: "patient", method: "signup", firstSignIn: true }),
      signupPrivacy(patientId),
    ]);

    const inserted = await supabaseAdmin(
      "POST",
      "/rest/v1/patients",
      { ...patient, auth_user_id: userId, claimed_at: new Date().toISOString() },
      "return=representation",
    );
    clock.mark("insert");
    if (inserted.status >= 300) {
      await sideSteps;
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

    // From here a failure removes the new row and login and leaves the code
    // unconsumed, so the patient can simply try again.
    const consumedAt = new Date().toISOString();
    let consumed = false;
    try {
      consumed = (await patchRow(
        row.id,
        { consumed_at: consumedAt, resolved_ref: patientId, auth_user_id: userId },
        "&consumed_at=is.null",
      )) === 1;
      clock.mark("consume");
      if (!consumed) {
        await sideSteps;
        await rollbackNewSignup({ patientId, userId, rowId: row.id, consumedAt: null });
        res.status(400).json({ error: SESSION_EXPIRED });
        return;
      }
      const [minted, ledger, privacySnapshot] = await sideSteps;
      clock.mark("finish");
      if (minted.status === "rejected") throw minted.reason;
      if (ledger.status === "rejected") throw ledger.reason;
      const tokenHash = minted.value;
      const signInId = ledger.value;
      const privacy = privacySnapshot.status === "fulfilled" ? privacySnapshot.value : null;
      clock.send(res, req);
      res.json(signupSuccess({ tokenHash, signInId, patientId, privacy }));
    } catch (error) {
      // Let the concurrent steps settle first so an unwind never races a
      // ledger row landing after its login is gone.
      await sideSteps;
      await rollbackNewSignup({ patientId, userId, rowId: row.id, consumedAt: consumed ? consumedAt : null }).catch(
        (rollbackError) => req.log?.error({ err: rollbackError, patientId }, "auth signup rollback incomplete"),
      );
      createdPatientId = null;
      throw error;
    }
  } catch (error) {
    req.log?.error({ err: error, patientId: createdPatientId }, "auth signup complete failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

type SignupPrivacy = Awaited<ReturnType<typeof loadPrivacyState>>;

/**
 * The new account's privacy state, handed back with the session so the app
 * can open the consent page without another round trip. Best effort: a
 * failed read only means the app fetches it itself; it never fails signup.
 */
function signupPrivacy(patientId: string): Promise<SignupPrivacy | null> {
  return loadPrivacyState(patientId).catch((error) => {
    logger.warn({ err: error }, "signup privacy snapshot unavailable");
    return null;
  });
}

function signupSuccess(input: {
  tokenHash: string;
  signInId: string;
  patientId: string;
  privacy: SignupPrivacy | null;
}) {
  return {
    ok: true as const,
    tokenHash: input.tokenHash,
    signInId: input.signInId,
    patientId: input.patientId,
    ...(input.privacy ? { privacy: input.privacy } : {}),
  };
}

/**
 * Stage durations for the signup completion, sent back as a Server-Timing
 * header (names and milliseconds only) so the account-creation wait can be
 * measured stage by stage from any client.
 */
function stageClock() {
  const started = performance.now();
  let last = started;
  const stages: Array<[string, number]> = [];
  return {
    mark(name: string) {
      const now = performance.now();
      stages.push([name, now - last]);
      last = now;
    },
    send(res: { setHeader(name: string, value: string): unknown }, req: { log?: { info?: (obj: object, msg: string) => void } }) {
      const total = performance.now() - started;
      res.setHeader(
        "Server-Timing",
        [...stages, ["total", total] as [string, number]].map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`).join(", "),
      );
      req.log?.info?.({ stages: Object.fromEntries(stages.map(([n, ms]) => [n, Math.round(ms)])), totalMs: Math.round(total) }, "auth signup complete timing");
    },
  };
}

/**
 * Unwind a failed invited enrollment: prior patient fields (activation
 * included) first, then a login this attempt created, then the reserved
 * code — each attempted even if an earlier step fails.
 */
async function rollbackInvitedEnrollment(input: {
  patientId: string;
  prior: Record<string, unknown> | null;
  login: { userId: string; created: boolean } | null;
  rowId: string;
  reservedAt: string;
}): Promise<void> {
  const failures: unknown[] = [];
  if (input.prior && Object.keys(input.prior).length) {
    try {
      const restored = await supabaseAdmin(
        "PATCH",
        `/rest/v1/patients?id=eq.${encodeURIComponent(input.patientId)}`,
        input.prior,
      );
      if (restored.status >= 300) throw new Error(`patient restore failed (${restored.status})`);
    } catch (error) { failures.push(error); }
  }
  if (input.login?.created) {
    try { await undoEnrollmentLogin(input.patientId, input.login.userId); } catch (error) { failures.push(error); }
  }
  try { await releaseReservation(input.rowId, input.reservedAt); } catch (error) { failures.push(error); }
  if (failures.length) throw failures[0];
}

/** Unwind a failed provider-code signup after its patient row landed. */
async function rollbackNewSignup(input: {
  patientId: string;
  userId: string;
  rowId: string;
  consumedAt: string | null;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    const removed = await supabaseAdmin(
      "DELETE",
      `/rest/v1/patients?id=eq.${encodeURIComponent(input.patientId)}&auth_user_id=eq.${encodeURIComponent(input.userId)}`,
    );
    if (removed.status >= 300) throw new Error(`patient removal failed (${removed.status})`);
  } catch (error) { failures.push(error); }
  await deleteAuthUserQuietly(input.userId);
  if (input.consumedAt) {
    try {
      await patchRow(
        input.rowId,
        { consumed_at: null, resolved_ref: null, auth_user_id: null },
        `&consumed_at=eq.${encodeURIComponent(input.consumedAt)}`,
      );
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
}

// ── Staff second factor (texted code after the emailed code) ────────────────

/** How long a proven emailed code keeps its texted-code step open. */
const SECOND_FACTOR_STEP_TTL_MS = CODE_TTL_MS;
const SECOND_FACTOR_SCOPE_PREFIX = "staff-second-factor:";

export interface SecondFactorStepBody {
  stepToken: string;
  /** "sms" = a verified phone is on file; "enroll" = the person must add one first. */
  mode: "sms" | "enroll";
  /** Masked phone on file (sms mode). */
  destination: string | null;
}

/**
 * Decide, right after the emailed code is proven, whether this staff member
 * owes a texted code. Returns null when the emailed code alone signs them in.
 */
/**
 * An office owner reaching the provider dashboard starts that office's
 * included access period (once, ever). Imported lazily so the auth route does
 * not pull the billing engine in for every other sign-in.
 */
async function startOfficeIncludedPeriod(
  hit: StaffHit,
  userId: string,
  req: { log?: { error(detail: unknown, message: string): void } },
): Promise<void> {
  if (hit.class !== "provider" || !hit.providerId) return;
  try {
    const { noteOwnerDashboardSignInForSelectedMode } = await import("../billing/office-access/sign-in");
    await noteOwnerDashboardSignInForSelectedMode({ providerId: hit.providerId, staffClass: hit.class, authUserId: userId });
  } catch (error) {
    req.log?.error({ err: error }, "office access included period start failed");
  }
}

async function staffSecondFactorStep(hit: StaffHit): Promise<{ token: string; body: SecondFactorStepBody } | null> {
  const factor = await loadStaffSecondFactor(factorKindOf(hit.class), hit.ref);
  const policy = await currentSecondFactorPolicy();
  if (!secondFactorApplies(policy, hit, factor)) return null;
  const token = crypto.randomBytes(32).toString("hex");
  return {
    token,
    body: {
      stepToken: token,
      mode: factor ? "sms" : "enroll",
      destination: factor ? maskPhone(factor.phone) : null,
    },
  };
}

/**
 * Load the proven emailed-code row behind a step token. Everything that
 * makes the step unusable (unknown, patient, not yet proven, already
 * finished, older than the TTL) answers the same way.
 */
async function loadSecondFactorStep(stepToken: unknown): Promise<VerificationRow | null> {
  if (!isTokenShaped(stepToken)) return null;
  const row = await loadRowByToken(stepToken);
  if (
    !row ||
    row.purpose !== "login" ||
    row.account_type === "patient" ||
    row.identifier_kind !== "email" ||
    !row.verified_at ||
    row.consumed_at ||
    !row.resolved_ref ||
    new Date(row.verified_at).getTime() + SECOND_FACTOR_STEP_TTL_MS < Date.now()
  ) {
    return null;
  }
  return row;
}

/** Re-resolve the staff identity FRESH and require it to be the one that proved the email. */
async function resolveStepStaff(step: VerificationRow): Promise<StaffHit | null> {
  const identifier = normalizeIdentifier(step.identifier);
  if (!identifier || identifier.kind !== "email") return null;
  const staff = await lookupStaffByEmail(identifier.email);
  if (staff.kind !== "ok" || staff.hit.ref !== step.resolved_ref) return null;
  return staff.hit;
}

function stepScopeKey(step: VerificationRow, mode: "sms" | "enroll"): string {
  return `${SECOND_FACTOR_SCOPE_PREFIX}${step.id}:${mode}`;
}

/**
 * Send (or resend) the texted code for a step. With a verified phone on
 * file the text always goes there — a supplied number is refused, otherwise
 * possession of the mailbox alone could re-point the second factor. Without
 * one, the supplied number is enrolled once its code is proven.
 */
router.post(AUTH_LOGIN_PHONE_START_PATH, async (req, res) => {
  const slot = acquireSendSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const { stepToken, phone } = (req.body ?? {}) as { stepToken?: unknown; phone?: unknown };
    const step = await loadSecondFactorStep(stepToken);
    const hit = step ? await resolveStepStaff(step) : null;
    if (!step || !hit) {
      res.status(400).json({ error: SESSION_EXPIRED, code: STEP_EXPIRED_CODE });
      return;
    }
    const factor = await loadStaffSecondFactor(factorKindOf(hit.class), hit.ref);
    let mode: "sms" | "enroll";
    let identifier: NormalizedIdentifier | null;
    if (factor) {
      if (phone !== undefined && phone !== null && String(phone).trim() !== "") {
        res.status(409).json({ error: PHONE_ON_FILE_MESSAGE });
        return;
      }
      mode = "sms";
      identifier = normalizeIdentifier(factor.phone);
    } else {
      mode = "enroll";
      identifier = normalizeIdentifier(phone);
      if (!identifier || identifier.kind !== "phone") {
        res.status(400).json({ error: PHONE_REQUIRED_MESSAGE, field: "phone" });
        return;
      }
    }
    if (!identifier || identifier.kind !== "phone") {
      res.status(400).json({ error: SESSION_EXPIRED, code: STEP_EXPIRED_CODE });
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
    const devMode = deliveryMode("sms") === "dev";
    const registered = await registerSend({
      purpose: "staff_sms",
      identifier,
      accountType: step.account_type,
      candidates: step.candidates,
      scopeKey: stepScopeKey(step, mode),
    });
    if (!registered) {
      res.status(429).json({ error: CODE_SEND_LIMIT, retryable: true });
      return;
    }
    if (registered.row.delivery === "twilio_verify") {
      try {
        await deliverSmsRegistered(registered.row);
      } catch (error) {
        req.log?.error({ err: error }, "staff second factor sms delivery rejected");
        await spendUndelivered(registered.row).catch((spendError) => {
          req.log?.error({ err: spendError }, "staff second factor rejected-send ledger update failed");
        });
        res.status(502).json({ error: CODE_SEND_ERROR, retryable: true });
        return;
      }
    }
    res.json({
      ok: true,
      mode,
      requestId: registered.row.id,
      destination: maskPhone(identifier.e164),
      devCode: devMode ? registered.localCode : null,
    });
  } catch (error) {
    req.log?.error({ err: error }, "staff second factor start failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

/** Texted code proven → the session is finally issued (method email+sms). */
router.post(AUTH_LOGIN_PHONE_VERIFY_PATH, async (req, res) => {
  const slot = acquireCheckSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const { stepToken, requestId, code } = (req.body ?? {}) as { stepToken?: unknown; requestId?: unknown; code?: unknown };
    const step = await loadSecondFactorStep(stepToken);
    if (!step) {
      res.status(400).json({ error: SESSION_EXPIRED, code: STEP_EXPIRED_CODE });
      return;
    }
    let smsRow: VerificationRow | null;
    try {
      smsRow = await checkCode("staff_sms", requestId, code);
    } catch (error) {
      if (error instanceof DeliveryNotConfiguredError) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }
    // The texted code must belong to THIS step (scope key carries the email
    // row id + mode); any other proven code is just a wrong code here.
    const mode: "sms" | "enroll" | null =
      smsRow?.scope_key === stepScopeKey(step, "sms") ? "sms" : smsRow?.scope_key === stepScopeKey(step, "enroll") ? "enroll" : null;
    if (!smsRow || !mode) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }

    // Both codes proven. Re-resolve the account FRESH and re-check the phone
    // binding: a phone HQ cleared (or re-pointed) mid-step must not be
    // silently re-enrolled by an on-file code, and an enrolment must not
    // overwrite a phone that landed meanwhile.
    const hit = await resolveStepStaff(step);
    const kind = hit ? factorKindOf(hit.class) : null;
    const factor = hit && kind ? await loadStaffSecondFactor(kind, hit.ref) : null;
    const phoneBound =
      mode === "sms" ? factor !== null && factor.phone === smsRow.identifier : factor === null;
    if (!hit || !kind || !phoneBound) {
      await patchRow(smsRow.id, { consumed_at: new Date().toISOString() });
      res.status(409).json({ error: CLINIC_MESSAGE });
      return;
    }

    // Finish the step exactly once: the guarded PATCH loses to a parallel
    // completion, which then owns the session.
    const now = new Date().toISOString();
    const finished = await patchRow(step.id, { consumed_at: now }, "&consumed_at=is.null");
    if (finished !== 1) {
      res.status(400).json({ error: CODE_ERROR });
      return;
    }
    let enrolled: StaffSecondFactor | null = factor;
    if (mode === "enroll") enrolled = await saveStaffSecondFactor(kind, hit.ref, smsRow.identifier);
    const userId = await ensureStaffAuthUser(hit);
    await startOfficeIncludedPeriod(hit, userId, req);
    await patchRow(step.id, { auth_user_id: userId });
    await patchRow(smsRow.id, { consumed_at: now, resolved_ref: hit.ref, auth_user_id: userId });
    if (mode === "enroll") {
      await recordAdminAuditEvent({
        action: "security_second_factor_enrolled",
        actorUserId: userId,
        actorKind: kind,
        providerId: hit.providerId,
        targetKind: kind === "hq" ? "hq_member" : kind === "provider" ? "provider_account" : "team_member",
        targetId: hit.ref,
        requestId: requestIdOf(req),
        metadata: { kind: "sign_in", enabled: enrolled?.enabled ?? true },
      }).catch((error) => req.log?.error({ err: error }, "second factor enrol audit failed"));
    }
    const signInId = await noteSignIn(req, { userId, realm: "staff", method: "email_sms_code" });
    const tokenHash = await mintSessionTokenHash(await getAuthUserEmail(userId));
    res.json({ ok: true, realm: "staff", tokenHash, signInId });
  } catch (error) {
    req.log?.error({ err: error }, "staff second factor verify failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

export default router;
