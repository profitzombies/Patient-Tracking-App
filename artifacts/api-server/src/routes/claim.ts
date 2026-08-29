/**
 * Account claiming + password reset for migrated THINNR accounts.
 *
 * One flow serves both jobs: prove control of the phone/email on file with a
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

const router: IRouter = Router();

export const CLAIM_IDENTIFY_PATH = "/claim/identify";
export const CLAIM_VERIFY_PATH = "/claim/verify";
export const CLAIM_BIRTHDAY_PATH = "/claim/birthday";
export const CLAIM_COMPLETE_PATH = "/claim/complete";
export const CLAIM_WHOAMI_PATH = "/claim/whoami";
export const CLAIM_ADD_PHONE_PATH = "/claim/add-phone";
export const CLAIM_ADD_PHONE_VERIFY_PATH = "/claim/add-phone/verify";

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

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const SENDS_PER_IDENTIFIER_PER_HOUR = 3;
/** Across ALL destination numbers one signed-in account may try per hour. */
const ADD_PHONE_SENDS_PER_ACCOUNT_PER_HOUR = 6;

/**
 * Identify must take the same time whether or not an account exists —
 * otherwise response timing becomes an existence oracle even though the
 * response bodies are identical. Every account-dependent outcome (miss,
 * send-capped, hit) is held to this minimum elapsed time. The real work is
 * one database round trip, which fits well inside the floor; live SMS/email
 * delivery is fired after the response and never adds to it.
 */
const IDENTIFY_FLOOR_DEFAULT_MS = 350;

function identifyFloorMs(): number {
  const raw = Number(process.env.CLAIM_IDENTIFY_FLOOR_MS ?? IDENTIFY_FLOOR_DEFAULT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : IDENTIFY_FLOOR_DEFAULT_MS;
}

async function holdUntilFloor(startedAt: number): Promise<void> {
  const wait = identifyFloorMs() - (Date.now() - startedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

type AccountType = "patient" | "provider" | "team_member" | "hq_admin";

interface Candidate {
  type: AccountType;
  ref: string;
  name: string | null;
  dob: string | null;
  claimed: boolean;
  auth_user_id: string | null;
}

interface ClaimRow {
  id: string;
  created_at: string;
  purpose: "claim" | "add_phone";
  identifier_kind: "phone" | "email";
  identifier: string;
  account_type: AccountType | null;
  candidates: Candidate[];
  resolved_ref: string | null;
  delivery: "dev" | "twilio_verify" | "resend";
  code_salt: string | null;
  code_hash: string | null;
  code_expires_at: string | null;
  code_attempts: number;
  verified_at: string | null;
  claim_token_hash: string | null;
  birthday_checked: boolean;
  consumed_at: string | null;
  auth_user_id: string | null;
}

const TABLE_FOR_TYPE: Record<
  Exclude<AccountType, "hq_admin">,
  { table: string; refCol: string; select: string }
> = {
  patient: { table: "patients", refCol: "id", select: "id,auth_user_id,name,email,phone" },
  provider: {
    table: "providers",
    refCol: "provider_id",
    select: "provider_id,auth_user_id,provider_name,office_name,email",
  },
  team_member: { table: "team_members", refCol: "id", select: "id,auth_user_id,name,email" },
};

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function codeMatches(row: ClaimRow, code: string): boolean {
  if (!row.code_salt || !row.code_hash) return false;
  const expected = Buffer.from(row.code_hash, "hex");
  const actual = Buffer.from(sha256(row.code_salt + code), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

async function loadRowById(id: string): Promise<ClaimRow | null> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/claim_verifications?id=eq.${enc(id)}&select=*`,
  );
  if (res.status >= 300) throw new Error(`claim row load failed (${res.status})`);
  return Array.isArray(res.json) && res.json.length > 0 ? (res.json[0] as ClaimRow) : null;
}

async function loadRowByToken(token: string): Promise<ClaimRow | null> {
  const hash = sha256(token);
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/claim_verifications?claim_token_hash=eq.${enc(hash)}&select=*`,
  );
  if (res.status >= 300) throw new Error(`claim row load failed (${res.status})`);
  return Array.isArray(res.json) && res.json.length > 0 ? (res.json[0] as ClaimRow) : null;
}

async function patchRow(id: string, patch: Record<string, unknown>, guard = ""): Promise<number> {
  const res = await supabaseAdmin(
    "PATCH",
    `/rest/v1/claim_verifications?id=eq.${enc(id)}${guard}`,
    patch,
    "return=representation",
  );
  if (res.status >= 300) throw new Error(`claim row update failed (${res.status})`);
  return Array.isArray(res.json) ? res.json.length : 0;
}

/**
 * Count-a-code-attempt with an optimistic guard so parallel guesses cannot
 * share one attempt slot. Returns false when the row moved underneath us.
 */
async function takeAttempt(row: ClaimRow): Promise<boolean> {
  const rows = await patchRow(
    row.id,
    { code_attempts: row.code_attempts + 1 },
    `&code_attempts=eq.${row.code_attempts}`,
  );
  return rows === 1;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isTokenShaped(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isCodeShaped(value: unknown): value is string {
  return typeof value === "string" && /^\d{4,8}$/.test(value);
}

function clientIp(req: { ip?: string }): string {
  return req.ip ?? "unknown";
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

  // The HQ admin claims/resets through the same flow. Their pre-approved
  // email maps to the pre-provisioned auth user via the profiles row.
  if (identifier.kind === "email") {
    const approval = await supabaseAdmin(
      "GET",
      `/rest/v1/staff_role_assignments?email=eq.${enc(identifier.email)}&role=eq.hq_admin&select=email`,
    );
    if (approval.status < 300 && Array.isArray(approval.json) && approval.json.length > 0) {
      const profile = await supabaseAdmin(
        "GET",
        `/rest/v1/profiles?email=eq.${enc(identifier.email)}&role=eq.hq_admin&select=id,display_name`,
      );
      if (profile.status < 300 && Array.isArray(profile.json) && profile.json.length > 0) {
        rows.push({
          type: "hq_admin",
          ref: String(profile.json[0].id),
          name: profile.json[0].display_name ?? null,
          dob: null,
          claimed: true,
          auth_user_id: String(profile.json[0].id),
        });
      }
    }
  }

  // Precedence when one email lives in several tables: the operationally
  // narrower identity wins; patients with a colliding email use their phone.
  for (const type of ["hq_admin", "provider", "team_member", "patient"] as const) {
    const group = rows.filter((c) => c.type === type);
    if (group.length > 0) return group;
  }
  return [];
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

    // Opportunistic ledger hygiene — expired rows are useless after a day.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    void supabaseAdmin(
      "DELETE",
      `/rest/v1/claim_verifications?created_at=lt.${enc(dayAgo)}`,
    ).catch(() => {});

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
    await patchRow(row.id, {
      verified_at: new Date().toISOString(),
      claim_token_hash: sha256(token),
      resolved_ref: single ? candidates[0].ref : null,
    });

    const identifier = normalizeIdentifier(row.identifier);
    res.json({
      ok: true,
      claimToken: token,
      accountType: row.account_type,
      masked: identifier ? maskIdentifier(identifier) : null,
      ...(single
        ? {
            next: "password" as const,
            mode:
              candidates[0].claimed || row.account_type === "hq_admin"
                ? ("reset" as const)
                : ("create" as const),
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
    if (!target || !row.account_type) {
      res.status(400).json({ error: SESSION_EXPIRED });
      return;
    }

    const signIn = {
      method: row.identifier_kind === "phone" ? ("phone" as const) : ("email" as const),
      identifier: row.identifier,
    };

    // The HQ admin login is pre-provisioned; proving the email sets its password.
    if (row.account_type === "hq_admin") {
      const updated = await supabaseAdmin("PUT", `/auth/v1/admin/users/${target.ref}`, {
        password,
      });
      if (updated.status === 400 || updated.status === 422) {
        res.status(400).json({
          error: rejectedPasswordMessage(updated.json),
          field: "password",
        });
        return;
      }
      if (updated.status >= 300) throw new Error(`admin password update failed (${updated.status})`);
      await patchRow(row.id, { consumed_at: new Date().toISOString(), auth_user_id: target.ref });
      res.json({ ok: true, mode: "reset" as const, signIn });
      return;
    }

    const mapping = TABLE_FOR_TYPE[row.account_type];
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

    // Already linked → this is a password reset on the existing login.
    if (freshRow.auth_user_id) {
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
        auth_user_id: String(freshRow.auth_user_id),
      });
      res.json({ ok: true, mode: "reset" as const, signIn });
      return;
    }

    // Unclaimed → create the login with ONLY the verified contact, marked so
    // the demo signup triggers stand aside, then link the record.
    const displayName =
      row.account_type === "provider"
        ? (freshRow.provider_name || freshRow.office_name || "").trim() || null
        : (freshRow.name || "").trim() || null;
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
        `/rest/v1/patients?auth_user_id=eq.${enc(user.id)}&select=id,name,provider_id`,
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
      hasPhone: Boolean(user.phone),
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
