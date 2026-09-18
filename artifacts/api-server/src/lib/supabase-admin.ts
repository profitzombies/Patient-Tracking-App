/**
 * Shared service-role Supabase helper for server-side flows (claiming,
 * account linking). The service key never leaves this process; callers get
 * plain status+json back and decide what to reveal to clients.
 */

export function supabaseBase(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return url.replace(/\/$/, "");
}

export function serviceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return key;
}

export interface AdminResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  contentRange: string | null;
}

export async function supabaseAdmin(
  method: string,
  path: string,
  body?: unknown,
  prefer?: string,
): Promise<AdminResponse> {
  const response = await fetch(`${supabaseBase()}${path}`, {
    method,
    headers: {
      apikey: serviceKey(),
      Authorization: `Bearer ${serviceKey()}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty body */
  }
  return { status: response.status, json, contentRange: response.headers.get("content-range") };
}

export interface AuthUser {
  id: string;
  email: string | null;
  phone: string | null;
}

const AUTH_LOOKUP_TIMEOUT_MS = 10_000;
/** One retry, jittered, so a blip does not become a 503 for the caller. */
const AUTH_LOOKUP_RETRY_MIN_MS = 100;
const AUTH_LOOKUP_RETRY_MAX_MS = 300;

let retryDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Test seam: replace the retry sleep (never used in production code paths). */
export function setAuthLookupRetryDelayForTests(delay: ((ms: number) => Promise<void>) | null): void {
  retryDelay = delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

class RetryableAuthLookup extends Error {}

async function authUserOnce(token: string): Promise<AuthUser | null> {
  let response: Response;
  try {
    response = await fetch(`${supabaseBase()}/auth/v1/user`, {
      headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(AUTH_LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    // Timeouts and connection resets are worth one more try; nothing else is.
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError" || name === "TypeError") {
      throw new RetryableAuthLookup(`auth lookup failed (${name || "network"})`);
    }
    throw error;
  }
  if (response.status === 401 || response.status === 403) return null;
  if (response.status >= 500) throw new RetryableAuthLookup(`auth lookup failed (${response.status})`);
  if (!response.ok) throw new Error(`auth lookup failed (${response.status})`);
  const json = (await response.json()) as { id?: string; email?: string; phone?: string };
  if (!json?.id) return null;
  return {
    id: json.id,
    email: json.email ? String(json.email) : null,
    phone: json.phone ? String(json.phone) : null,
  };
}

/**
 * Ask Supabase Auth who is behind a client-supplied access token. Returns
 * null for a missing/invalid token; throws on upstream outage so callers
 * can 503 instead of mislabeling an outage as "signed out". Timeouts and
 * 5xx answers get exactly one jittered retry; 401/403 are never retried.
 *
 * Ordinary routes no longer call this per request — see
 * `auth/identify.ts`, which verifies tokens locally and reserves this
 * remote confirmation for the route families named in
 * `auth/verification-policy.ts`.
 */
export async function fetchAuthUser(token: string): Promise<AuthUser | null> {
  try {
    return await authUserOnce(token);
  } catch (error) {
    if (!(error instanceof RetryableAuthLookup)) throw error;
    const jitter = AUTH_LOOKUP_RETRY_MIN_MS + Math.random() * (AUTH_LOOKUP_RETRY_MAX_MS - AUTH_LOOKUP_RETRY_MIN_MS);
    await retryDelay(Math.round(jitter));
    try {
      return await authUserOnce(token);
    } catch (second) {
      throw second instanceof RetryableAuthLookup ? new Error(second.message) : second;
    }
  }
}
