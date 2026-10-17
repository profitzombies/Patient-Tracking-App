/**
 * App-access checkout tokens — the capability behind the public
 * /pay/app-access/<token> page.
 *
 * The patient endpoint mints one bound to (patient, office, expiry) and the
 * mobile app opens it in the external browser, where no patient session
 * exists. The public routes verify the signature and let that patient start
 * their office's app subscription — nothing else. The token is stateless
 * (no payment-link row: those are product links with office-side lists and
 * product validation); it is short-lived and a later entitlement read mints
 * a fresh one.
 *
 * Shape: `<patientId>.<providerIdBase64url>.<expEpochSeconds>.<hmacSha256Hex>`.
 * Provider ids are free text (`live-<hex>` in production, anything in
 * fixtures), so they ride base64url-encoded; the patient id is a UUID.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const APP_ACCESS_CHECKOUT_TOKEN_TTL_SEC = 60 * 60;

const SIGNING_KEY = `app-access-checkout:${process.env.SESSION_SECRET || randomBytes(32).toString("hex")}`;
const UUID = /^[0-9a-f-]{36}$/i;
const BASE64URL = /^[A-Za-z0-9_-]{1,120}$/;
const MAX_TOKEN_LENGTH = 300;

function encodeProvider(providerId: string): string {
  return Buffer.from(providerId, "utf8").toString("base64url");
}

function signature(patientId: string, providerId: string, exp: number): string {
  return createHmac("sha256", SIGNING_KEY).update(`${patientId}.${providerId}.${exp}`).digest("hex");
}

export function mintAppAccessCheckoutToken(patientId: string, providerId: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + APP_ACCESS_CHECKOUT_TOKEN_TTL_SEC;
  return `${patientId}.${encodeProvider(providerId)}.${exp}.${signature(patientId, providerId, exp)}`;
}

export interface AppAccessCheckoutClaims { patientId: string; providerId: string; exp: number }

/** The claims of an unexpired, correctly signed token; null for anything else. */
export function verifyAppAccessCheckoutToken(token: string, nowMs = Date.now()): AppAccessCheckoutClaims | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [patientId, encodedProvider, expText, given] = parts;
  if (!UUID.test(patientId) || !BASE64URL.test(encodedProvider)) return null;
  const providerId = Buffer.from(encodedProvider, "base64url").toString("utf8");
  if (providerId.length === 0 || encodeProvider(providerId) !== encodedProvider) return null;
  const exp = Number(expText);
  if (!Number.isInteger(exp) || exp <= Math.floor(nowMs / 1000)) return null;
  const expected = Buffer.from(signature(patientId, providerId, exp), "utf8");
  const supplied = Buffer.from(given, "utf8");
  if (supplied.length !== expected.length) return null;
  try {
    return timingSafeEqual(supplied, expected) ? { patientId, providerId, exp } : null;
  } catch {
    return null;
  }
}
