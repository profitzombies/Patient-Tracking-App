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

/**
 * Look up the auth user behind a client-supplied access token. Returns null
 * for a missing/invalid token; throws on upstream outage so callers can 503
 * instead of mislabeling an outage as "signed out".
 */
export async function fetchAuthUser(token: string): Promise<{
  id: string;
  email: string | null;
  phone: string | null;
} | null> {
  const response = await fetch(`${supabaseBase()}/auth/v1/user`, {
    headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`auth lookup failed (${response.status})`);
  const json = (await response.json()) as { id?: string; email?: string; phone?: string };
  if (!json?.id) return null;
  return {
    id: json.id,
    email: json.email ? String(json.email) : null,
    phone: json.phone ? String(json.phone) : null,
  };
}
