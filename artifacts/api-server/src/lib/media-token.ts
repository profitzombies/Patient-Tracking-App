/**
 * Patient-scoped media read tokens — the session-equivalent capability that
 * authorizes GET /patient-media/file.
 *
 * Progress photos made patient media sensitive, so knowing an object path
 * must not be enough to read it. But <Image> tags can't send bearer
 * headers, so the read authorization has to ride the URL itself: the
 * authenticated state hydrate mints an HMAC token bound to the patient id,
 * the client appends it to display URLs it builds, and the file route
 * verifies the token belongs to the patient the path is namespaced under
 * before minting a signed storage URL.
 *
 * Shape: `<expEpochSeconds>.<hmacSha256Hex(patientId + "." + exp)>`. The
 * token carries no patient id — the path supplies the claimed owner and
 * the signature only verifies for that same patient, so one patient's
 * token can never open another patient's directory.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Session-equivalent leash: re-minted on every hydrate, dead in a day. */
export const PATIENT_MEDIA_TOKEN_TTL_SEC = 24 * 60 * 60;

// SESSION_SECRET is the deployment's signing secret. When unset (bare dev
// shells), fall back to a per-boot random key: everything works within one
// server lifetime and nothing ever signs with a known constant.
const SIGNING_KEY = `patient-media:${process.env.SESSION_SECRET || randomBytes(32).toString("hex")}`;

function signature(patientId: string, exp: number): string {
  return createHmac("sha256", SIGNING_KEY).update(`${patientId}.${exp}`).digest("hex");
}

export function mintPatientMediaToken(patientId: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + PATIENT_MEDIA_TOKEN_TTL_SEC;
  return `${exp}.${signature(patientId, exp)}`;
}

/** True only for an unexpired token whose signature matches THIS patient. */
export function verifyPatientMediaToken(
  token: string,
  patientId: string,
  nowMs = Date.now(),
): boolean {
  if (typeof token !== "string" || token.length > 200) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isInteger(exp) || exp <= Math.floor(nowMs / 1000)) return false;
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(signature(patientId, exp), "utf8");
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}
