/**
 * Store-reviewer sign-in rule.
 *
 * Apple and Google reviewers cannot receive THINNR's one-time codes, so a
 * production environment variable names exactly two identities — one patient
 * and one office staff login — whose sign-in code is a fixed value that is
 * never texted or emailed. Everything else about them is a normal account in
 * the dedicated App Review office.
 *
 *   APP_REVIEW_SIGN_IN='{"patient":{"identifier":"+15555550100","code":"123456"},
 *                       "staff":{"identifier":"reviewer@example.com","code":"654321"}}'
 *
 * Rules (all fail closed — a malformed variable disables the path entirely):
 *   * unset or blank  → no reviewer path at all;
 *   * both identities are required, each with a six-digit code;
 *   * the staff identity must be an email (the staff directory is email-keyed);
 *   * identities are matched after the same normalization the directory uses,
 *     so formatting differences cannot create a second matching identity;
 *   * the code is compared through the ordinary salted-hash ledger row, so
 *     attempt counting, expiry and single use apply unchanged.
 *
 * The variable is read on every call: tests pin it per suite, and a removed
 * variable must also refuse a reviewer row that was issued before removal.
 */
import { normalizeIdentifier, type NormalizedIdentifier } from "../claim/normalize";
import { logger } from "../lib/logger";

export const APP_REVIEW_ENV = "APP_REVIEW_SIGN_IN";
/** The ledger delivery kind for a reviewer code: nothing is ever sent. */
export const APP_REVIEW_DELIVERY = "app_review";

export type AppReviewRealm = "patient" | "staff";

export interface AppReviewIdentity {
  realm: AppReviewRealm;
  identifier: NormalizedIdentifier;
  code: string;
}

export interface AppReviewConfig {
  patient: AppReviewIdentity;
  staff: AppReviewIdentity;
}

const CODE_RE = /^\d{6}$/;

function identityOf(realm: AppReviewRealm, raw: unknown): AppReviewIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { identifier?: unknown; code?: unknown };
  const identifier = normalizeIdentifier(value.identifier);
  if (!identifier) return null;
  if (realm === "staff" && identifier.kind !== "email") return null;
  if (typeof value.code !== "string" || !CODE_RE.test(value.code)) return null;
  return { realm, identifier, code: value.code };
}

function sameIdentifier(a: NormalizedIdentifier, b: NormalizedIdentifier): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "phone" ? a.e164 === (b as { e164: string }).e164 : a.email === (b as { email: string }).email;
}

let warnedFor: string | null = null;
function warnOnce(raw: string, reason: string): void {
  if (warnedFor === raw) return;
  warnedFor = raw;
  logger.warn({ reason }, `${APP_REVIEW_ENV} is malformed; the store-reviewer sign-in path is disabled`);
}

/** Parse the variable; null when unset, blank or malformed (fail closed). */
export function appReviewConfig(env: NodeJS.ProcessEnv = process.env): AppReviewConfig | null {
  const raw = env[APP_REVIEW_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnOnce(raw, "not valid JSON");
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnOnce(raw, "not a JSON object");
    return null;
  }
  const value = parsed as { patient?: unknown; staff?: unknown };
  const patient = identityOf("patient", value.patient);
  const staff = identityOf("staff", value.staff);
  if (!patient || !staff) {
    warnOnce(raw, !patient ? "patient identity missing or invalid" : "staff identity missing or invalid");
    return null;
  }
  if (sameIdentifier(patient.identifier, staff.identifier)) {
    warnOnce(raw, "patient and staff identities must differ");
    return null;
  }
  return { patient, staff };
}

/**
 * The reviewer identity for a sign-in, or null for everyone else. The realm
 * comes from the directory hit (patient vs staff), never from the request, so
 * a listed patient contact can never unlock the staff rule or vice versa.
 */
export function appReviewIdentity(
  realm: AppReviewRealm,
  identifier: NormalizedIdentifier,
  env: NodeJS.ProcessEnv = process.env,
): AppReviewIdentity | null {
  const config = appReviewConfig(env);
  if (!config) return null;
  const identity = config[realm];
  return sameIdentifier(identity.identifier, identifier) ? identity : null;
}
