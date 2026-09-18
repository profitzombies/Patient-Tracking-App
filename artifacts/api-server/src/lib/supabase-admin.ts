/**
 * Shared service-role Supabase helper for server-side flows (claiming,
 * account linking). The service key never leaves this process; callers get
 * plain status+json back and decide what to reveal to clients.
 */
import { markRequestDependency } from "./request-context";

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

export type AdminCallKind = "read" | "write";

export interface AdminCallOptions {
  /**
   * Overrides the method-based classification. Only reads are ever retried;
   * pass `kind: "read"` for a POST RPC that provably changes nothing, or
   * `kind: "write"` to pin a GET that has side effects (there should be none).
   */
  kind?: AdminCallKind;
}

/**
 * POST RPCs that only read. Everything else posted to /rest/v1/rpc/ counts
 * as a write and is never retried: a claim, an enqueue, or a mutate that
 * timed out may well have landed, and a blind replay would double it.
 */
export const READ_ONLY_RPCS: ReadonlySet<string> = new Set([
  "hq_request_latency",
  "hq_slow_statements",
  "hq_relation_sizes",
  "hq_patient_sign_in_metrics",
  "provider_leaderboard_facts",
  "patient_chat_inbox_list",
  "storage_ledger_paths",
  "storage_referenced_paths",
  "search_food_catalog",
  "search_food_catalog_grouped",
  "coach_memory_recall",
]);

const RPC_PATH = /^\/rest\/v1\/rpc\/([^/?]+)/;

/** Reads: GET/HEAD, or a POST to an allow-listed read-only RPC. Everything else writes. */
export function classifyAdminCall(method: string, path: string, options?: AdminCallOptions): AdminCallKind {
  if (options?.kind) return options.kind;
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return "read";
  if (verb === "POST") {
    const rpc = RPC_PATH.exec(path)?.[1];
    if (rpc && READ_ONLY_RPCS.has(decodeURIComponent(rpc))) return "read";
  }
  return "write";
}

const ADMIN_TIMEOUT_MS = 15_000;
/** Transient answers from PostgREST or the proxy in front of it. */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const READ_RETRY_MIN_MS = 100;
const READ_RETRY_MAX_MS = 300;

let readRetryDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Test seam: replace the read-retry sleep (never used in production code paths). */
export function setAdminReadRetryDelayForTests(delay: ((ms: number) => Promise<void>) | null): void {
  readRetryDelay = delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

function isTransientFetchError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError" || name === "TypeError";
}

async function adminOnce(method: string, path: string, body: unknown, prefer: string | undefined): Promise<AdminResponse> {
  const response = await fetch(`${supabaseBase()}${path}`, {
    method,
    headers: {
      apikey: serviceKey(),
      Authorization: `Bearer ${serviceKey()}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
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

/**
 * One PostgREST call with the service key. Reads (see classifyAdminCall)
 * get exactly one jittered retry after a timeout, a connection failure, or a
 * 502/503/504; writes and data-changing RPCs are never retried here —
 * callers that want a replay must make it idempotent themselves. Marks the
 * current request as database-backed for the request log and metrics.
 */
export async function supabaseAdmin(
  method: string,
  path: string,
  body?: unknown,
  prefer?: string,
  options?: AdminCallOptions,
): Promise<AdminResponse> {
  markRequestDependency("db");
  const kind = classifyAdminCall(method, path, options);
  if (kind === "write") return adminOnce(method, path, body, prefer);
  let first: AdminResponse;
  try {
    first = await adminOnce(method, path, body, prefer);
  } catch (error) {
    if (!isTransientFetchError(error)) throw error;
    await readRetryDelay(Math.round(READ_RETRY_MIN_MS + Math.random() * (READ_RETRY_MAX_MS - READ_RETRY_MIN_MS)));
    return adminOnce(method, path, body, prefer);
  }
  if (!TRANSIENT_STATUSES.has(first.status)) return first;
  await readRetryDelay(Math.round(READ_RETRY_MIN_MS + Math.random() * (READ_RETRY_MAX_MS - READ_RETRY_MIN_MS)));
  return adminOnce(method, path, body, prefer);
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
