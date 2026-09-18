/**
 * Shared bearer-session → patient resolver for per-patient rails.
 *
 * Every authenticated patient route (the diary/library data rail, the
 * patient-media rail, and whatever rides them next) resolves identity the
 * same way the claim flow's whoami does: the client's bearer session token
 * is looked up in GoTrue, then the auth user is mapped to a patients row
 * via patients.auth_user_id. Routes never trust a client-supplied patient
 * id — the resolved row IS the identity.
 *
 * Failure ladder, mirrored by every caller:
 *   401 — no/expired session token,
 *   403 — a real session that is not linked to a patient record (staff),
 *   403 + code CONSENT_REQUIRED — a real patient who has not recorded the
 *         CURRENT consent policy version (or whose record predates a bump);
 *         `details.consent` carries what the app needs to prompt,
 *   403 + code PHOTO_ANALYSIS_OPT_IN_REQUIRED — the route sends a photo to
 *         a model and the patient declined optional photo analysis,
 *   503 — the auth lookup itself is down (never mislabeled as signed-out).
 * A patients-table lookup failure THROWS so callers answer with their own
 * 502 "try again" message.
 *
 * Consent is enforced HERE, at the one identity choke point, so no data
 * route can be reached before the patient agreed — the mobile navigation
 * gate is a convenience, not the control. Only the consent/privacy routes
 * themselves opt out (`consent: "skip"`): they are how a patient records
 * consent, reads their pending deletion, or cancels it.
 *
 * App presence is recorded here too: once a bearer resolves to a patient
 * row the request counts as "the app is open" for that patient's local day
 * (throttled, fire-and-forget — see ./patient-presence). Staff sessions never
 * reach a patient row, so they never leave a presence trace.
 */
import { fetchAuthUser, supabaseAdmin } from "./supabase-admin";
import { consentDto, loadLatestConsent, type ConsentDto } from "../privacy/consent";
import { notePatientPresence } from "./patient-presence";

const enc = encodeURIComponent;

export function bearerToken(req: { headers: Record<string, unknown> }): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export type PatientAuthCode = "CONSENT_REQUIRED" | "PHOTO_ANALYSIS_OPT_IN_REQUIRED";

export interface PatientAuthFailureDetails {
  code: PatientAuthCode;
  consent: ConsentDto;
}

export type ResolvedPatient =
  | { ok: true; patientId: string; authUserId: string; consent: ConsentDto }
  | { ok: false; status: number; error: string; code?: PatientAuthCode; details?: PatientAuthFailureDetails };

export interface ResolvePatientOptions {
  /**
   * "required" (default) — the current policy version must be on record.
   * "photo-analysis" — required consent PLUS the optional photo-analysis
   *   opt-in; use on every route that hands a patient photo to a model.
   * "skip" — identity only; reserved for the consent/privacy routes.
   */
  consent?: "required" | "photo-analysis" | "skip";
}

export const CONSENT_REQUIRED_MESSAGE = "Please review and accept the current terms before continuing.";
export const PHOTO_ANALYSIS_OPT_IN_MESSAGE =
  "Photo analysis is off for your account. Turn it on under Privacy & data to use this.";

export async function resolvePatient(
  req: { headers: Record<string, unknown> },
  options: ResolvePatientOptions = {},
): Promise<ResolvedPatient> {
  const identity = await resolvePatientIdentityInternal(req, "throw");
  if (!identity.ok) return identity;
  notePatientPresence(identity.patientId, req.headers);
  const mode = options.consent ?? "required";
  if (mode === "skip") return { ...identity, consent: consentDto(null) };
  const consent = consentDto(await loadLatestConsent(identity.patientId));
  if (!consent.satisfied) {
    return {
      ok: false,
      status: 403,
      error: CONSENT_REQUIRED_MESSAGE,
      code: "CONSENT_REQUIRED",
      details: { code: "CONSENT_REQUIRED", consent },
    };
  }
  if (mode === "photo-analysis" && consent.photoAnalysis !== true) {
    return {
      ok: false,
      status: 403,
      error: PHOTO_ANALYSIS_OPT_IN_MESSAGE,
      code: "PHOTO_ANALYSIS_OPT_IN_REQUIRED",
      details: { code: "PHOTO_ANALYSIS_OPT_IN_REQUIRED", consent },
    };
  }
  return { ...identity, consent };
}

type ResolvedIdentity =
  | { ok: true; patientId: string; authUserId: string }
  | { ok: false; status: number; error: string };

/**
 * Resolve only the canonical patient identity.  Bloodwork uses this first so
 * it can compare the URL patient id before checking setup, consent, or account
 * lifecycle state.  That ordering is important: a patient must not learn
 * whether another patient's account is archived, incomplete, or missing
 * consent.
 */
export async function resolvePatientIdentity(req: {
  headers: Record<string, unknown>;
}): Promise<ResolvedIdentity> {
  const identity = await resolvePatientIdentityInternal(req, "respond");
  if (identity.ok) notePatientPresence(identity.patientId, req.headers);
  return identity;
}

async function resolvePatientIdentityInternal(
  req: { headers: Record<string, unknown> },
  lookupFailure: "throw" | "respond",
): Promise<ResolvedIdentity> {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: "Sign in required." };
  let user: Awaited<ReturnType<typeof fetchAuthUser>>;
  try {
    user = await fetchAuthUser(token);
  } catch {
    return { ok: false, status: 503, error: "Account lookup is unavailable right now." };
  }
  if (!user) return { ok: false, status: 401, error: "Sign in required." };
  let lookup;
  try {
    lookup = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?auth_user_id=eq.${enc(user.id)}&select=id&limit=2`,
    );
  } catch (error) {
    if (lookupFailure === "throw") throw error;
    return { ok: false, status: 503, error: "Account lookup is unavailable right now." };
  }
  if (lookup.status >= 300 || !Array.isArray(lookup.json)) {
    if (lookupFailure === "throw") throw new Error(`patient lookup failed (${lookup.status})`);
    return { ok: false, status: 503, error: "Account lookup is unavailable right now." };
  }
  if (lookup.json.length > 1) {
    if (lookupFailure === "throw") throw new Error("patient lookup is ambiguous");
    return { ok: false, status: 503, error: "Account lookup is unavailable right now." };
  }
  const row = lookup.json[0] as { id?: unknown } | undefined;
  if (!row || typeof row.id !== "string" || row.id.length === 0) {
    return { ok: false, status: 403, error: "This account is not linked to a patient record." };
  }
  return { ok: true, patientId: row.id, authUserId: user.id };
}

/**
 * Gate for the tokenless photo-analysis routes (menu / label scans). They
 * serve the demo persona anonymously, so a missing bearer keeps the demo
 * behavior; when a bearer IS present the caller is a real patient and must
 * have consented to photo analysis before the image reaches a model.
 *
 *   { ok: true }                  — proceed (anonymous demo, staff persona, or a consented patient)
 *   { ok: false, status, body }   — answer with this status/body and stop
 */
export async function gatePhotoAnalysis(req: {
  headers: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  if (bearerToken(req) === null) return { ok: true };
  const auth = await resolvePatient(req, { consent: "photo-analysis" });
  if (auth.ok) return { ok: true };
  // A real session that is not a patient (staff browsing the persona) keeps
  // the demo behavior; every other refusal is answered honestly.
  if (auth.status === 403 && auth.code === undefined) return { ok: true };
  return { ok: false, status: auth.status, body: { error: auth.error, ...auth.details } };
}
