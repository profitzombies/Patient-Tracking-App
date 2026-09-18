/**
 * Local verification of Supabase (GoTrue) access tokens.
 *
 * Every authenticated request used to round-trip to `/auth/v1/user`. That
 * hop is the first thing to fall over under load (Auth rate limits are far
 * lower than the database's), so ordinary requests now check the token
 * themselves against the project's published signing keys (JWKS):
 * signature, expiry, issuer, and audience.
 *
 * Outcomes are deliberately three-way:
 *   verified      — the token is genuine and live; claims can be trusted.
 *   rejected      — the token is provably bad (expired, tampered, another
 *                   project's, malformed JWT with a known key). No remote
 *                   call will change that answer.
 *   unverifiable  — we cannot decide locally: symmetric (HS256) legacy
 *                   tokens, a key id the JWKS still does not know after one
 *                   refresh, or the JWKS endpoint being unreachable. Callers
 *                   fall back to the remote lookup, which answers exactly as
 *                   it always did.
 *
 * Strings that are not JWTs at all are reported unverifiable rather than
 * rejected: they were never a Supabase session, and letting GoTrue refuse
 * them keeps the observable behavior identical to the remote-only days.
 */
import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { logger } from "../lib/logger";
import { serviceKey, supabaseBase } from "../lib/supabase-admin";

export interface VerifiedAccessToken {
  outcome: "verified";
  user: { id: string; email: string | null; phone: string | null };
  sessionId: string | null;
  issuedAt: number;
  expiresAt: number;
}

export interface RejectedAccessToken {
  outcome: "rejected";
  reason: "malformed" | "expired" | "not_yet_valid" | "bad_signature" | "wrong_issuer" | "wrong_audience" | "no_subject" | "unsupported_algorithm";
}

export interface UnverifiableAccessToken {
  outcome: "unverifiable";
  reason: "not_a_jwt" | "symmetric_key" | "unknown_key" | "jwks_unavailable";
}

export type LocalVerification = VerifiedAccessToken | RejectedAccessToken | UnverifiableAccessToken;

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  crv?: string;
  use?: string;
  [key: string]: unknown;
}

interface JwksEntry {
  key: KeyObject;
  alg: string | null;
  kty: string;
}

const JWKS_TTL_MS = 10 * 60_000;
const JWKS_REFRESH_COOLDOWN_MS = 30_000;
const JWKS_TIMEOUT_MS = 5_000;
/** Seconds of clock skew tolerated on exp/nbf/iat. */
const CLOCK_SKEW_SECONDS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ASYMMETRIC: Record<string, { kty: string; hash: string; ec?: boolean }> = {
  ES256: { kty: "EC", hash: "sha256", ec: true },
  RS256: { kty: "RSA", hash: "sha256" },
};

interface JwksCache {
  keys: Map<string, JwksEntry>;
  fetchedAt: number;
  lastRefreshAttemptAt: number;
  inflight: Promise<boolean> | null;
}

const cache: JwksCache = { keys: new Map(), fetchedAt: 0, lastRefreshAttemptAt: 0, inflight: null };

/** Test seam: forget every cached key and refresh timestamp. */
export function resetAccessTokenVerifierForTests(): void {
  cache.keys = new Map();
  cache.fetchedAt = 0;
  cache.lastRefreshAttemptAt = 0;
  cache.inflight = null;
}

export function jwksUrl(): string {
  return `${supabaseBase()}/auth/v1/.well-known/jwks.json`;
}

/** Issuer GoTrue stamps on every token for this project. */
export function expectedIssuer(): string {
  const override = process.env.SUPABASE_JWT_ISSUER?.trim();
  return override ? override.replace(/\/$/, "") : `${supabaseBase()}/auth/v1`;
}

function importJwk(jwk: Jwk): JwksEntry | null {
  if (typeof jwk.kid !== "string" || !jwk.kid) return null;
  if (jwk.kty !== "EC" && jwk.kty !== "RSA") return null;
  if (jwk.use && jwk.use !== "sig") return null;
  try {
    const key = createPublicKey({ key: jwk as Record<string, unknown>, format: "jwk" });
    return { key, alg: typeof jwk.alg === "string" ? jwk.alg : null, kty: jwk.kty };
  } catch (error) {
    logger.warn({ err: error, kid: jwk.kid }, "jwks key import failed");
    return null;
  }
}

async function fetchJwks(): Promise<boolean> {
  try {
    const response = await fetch(jwksUrl(), {
      headers: { apikey: serviceKey() },
      signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`jwks fetch failed (${response.status})`);
    const json = (await response.json()) as { keys?: unknown };
    if (!json || !Array.isArray(json.keys)) throw new Error("jwks response has no keys array");
    const keys = new Map<string, JwksEntry>();
    for (const raw of json.keys) {
      if (!raw || typeof raw !== "object") continue;
      const entry = importJwk(raw as Jwk);
      if (entry) keys.set((raw as Jwk).kid as string, entry);
    }
    cache.keys = keys;
    cache.fetchedAt = Date.now();
    return true;
  } catch (error) {
    logger.warn({ err: error }, "jwks refresh failed; falling back to remote verification");
    return false;
  }
}

/** Refresh the key set, deduplicating concurrent callers. */
function refreshJwks(): Promise<boolean> {
  if (cache.inflight) return cache.inflight;
  cache.lastRefreshAttemptAt = Date.now();
  cache.inflight = fetchJwks().finally(() => {
    cache.inflight = null;
  });
  return cache.inflight;
}

/**
 * Resolve the verification key for a key id. A stale or empty cache is
 * refreshed; an unknown kid triggers at most one extra refresh per cooldown
 * window (rotation handling without letting a flood of bogus kids hammer
 * the JWKS endpoint).
 */
async function keyFor(kid: string): Promise<{ entry: JwksEntry | null; jwksAvailable: boolean }> {
  const stale = cache.keys.size === 0 || Date.now() - cache.fetchedAt > JWKS_TTL_MS;
  let fetched = true;
  if (stale) fetched = await refreshJwks();
  const cached = cache.keys.get(kid);
  if (cached) return { entry: cached, jwksAvailable: true };
  // Unknown kid: the keys may have rotated since the last fetch. One extra
  // refresh (or joining one already in flight) unless we tried moments ago.
  if (!stale && (cache.inflight || Date.now() - cache.lastRefreshAttemptAt >= JWKS_REFRESH_COOLDOWN_MS)) {
    fetched = await refreshJwks();
    const refreshed = cache.keys.get(kid);
    if (refreshed) return { entry: refreshed, jwksAvailable: true };
  }
  return { entry: null, jwksAvailable: cache.keys.size > 0 || fetched };
}

interface DecodedJwt {
  header: { alg?: unknown; kid?: unknown; typ?: unknown };
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Split a compact JWS; null when the string is not shaped like one. */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]);
  if (!header || typeof header !== "object" || Array.isArray(header)) return null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!/^[A-Za-z0-9_-]*$/.test(parts[2])) return null;
  return {
    header: header as DecodedJwt["header"],
    payload: payload as Record<string, unknown>,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], "base64url"),
  };
}

function verifySignature(decoded: DecodedJwt, alg: string, entry: JwksEntry): boolean {
  const spec = ASYMMETRIC[alg];
  if (!spec || entry.kty !== spec.kty) return false;
  if (entry.alg && entry.alg !== alg) return false;
  try {
    const verifier = createVerify(spec.hash);
    verifier.update(decoded.signingInput);
    verifier.end();
    return spec.ec
      ? verifier.verify({ key: entry.key, dsaEncoding: "ieee-p1363" }, decoded.signature)
      : verifier.verify(entry.key, decoded.signature);
  } catch {
    return false;
  }
}

function numberClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function audienceIncludes(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((entry) => entry === expected);
  return false;
}

/**
 * Verify a bearer token against the project's published keys. Never
 * throws: infrastructure trouble surfaces as `unverifiable` so the caller
 * can decide to ask GoTrue instead.
 */
export async function verifyAccessTokenLocally(
  token: string,
  options: { now?: () => number; audience?: string } = {},
): Promise<LocalVerification> {
  const decoded = decodeJwt(token);
  if (!decoded) return { outcome: "unverifiable", reason: "not_a_jwt" };
  const alg = typeof decoded.header.alg === "string" ? decoded.header.alg : "";
  if (alg === "HS256" || alg === "HS384" || alg === "HS512") return { outcome: "unverifiable", reason: "symmetric_key" };
  if (!ASYMMETRIC[alg]) return { outcome: "rejected", reason: "unsupported_algorithm" };
  const kid = typeof decoded.header.kid === "string" ? decoded.header.kid : "";
  if (!kid) return { outcome: "rejected", reason: "malformed" };

  const { entry, jwksAvailable } = await keyFor(kid);
  if (!entry) return { outcome: "unverifiable", reason: jwksAvailable ? "unknown_key" : "jwks_unavailable" };
  if (!verifySignature(decoded, alg, entry)) return { outcome: "rejected", reason: "bad_signature" };

  const claims = decoded.payload;
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
  const exp = numberClaim(claims.exp);
  if (exp === null) return { outcome: "rejected", reason: "malformed" };
  if (exp + CLOCK_SKEW_SECONDS <= nowSeconds) return { outcome: "rejected", reason: "expired" };
  const nbf = numberClaim(claims.nbf);
  if (nbf !== null && nbf - CLOCK_SKEW_SECONDS > nowSeconds) return { outcome: "rejected", reason: "not_yet_valid" };
  if (claims.iss !== expectedIssuer()) return { outcome: "rejected", reason: "wrong_issuer" };
  if (!audienceIncludes(claims.aud, options.audience ?? "authenticated")) return { outcome: "rejected", reason: "wrong_audience" };
  const sub = stringOrNull(claims.sub);
  if (!sub || !UUID.test(sub)) return { outcome: "rejected", reason: "no_subject" };

  const sessionId = stringOrNull(claims.session_id);
  return {
    outcome: "verified",
    user: { id: sub, email: stringOrNull(claims.email), phone: stringOrNull(claims.phone) },
    sessionId: sessionId && UUID.test(sessionId) ? sessionId : null,
    issuedAt: numberClaim(claims.iat) ?? nowSeconds,
    expiresAt: exp,
  };
}
