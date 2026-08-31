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
 *   503 — the auth lookup itself is down (never mislabeled as signed-out).
 * A patients-table lookup failure THROWS so callers answer with their own
 * 502 "try again" message.
 */
import { fetchAuthUser, supabaseAdmin } from "./supabase-admin";

const enc = encodeURIComponent;

export function bearerToken(req: { headers: Record<string, unknown> }): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export type ResolvedPatient =
  | { ok: true; patientId: string }
  | { ok: false; status: number; error: string };

export async function resolvePatient(req: {
  headers: Record<string, unknown>;
}): Promise<ResolvedPatient> {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: "Sign in required." };
  let user: Awaited<ReturnType<typeof fetchAuthUser>>;
  try {
    user = await fetchAuthUser(token);
  } catch {
    return { ok: false, status: 503, error: "Account lookup is unavailable right now." };
  }
  if (!user) return { ok: false, status: 401, error: "Sign in required." };
  const lookup = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?auth_user_id=eq.${enc(user.id)}&select=id`,
  );
  if (lookup.status >= 300 || !Array.isArray(lookup.json)) {
    throw new Error(`patient lookup failed (${lookup.status})`);
  }
  const row = lookup.json[0] as { id?: unknown } | undefined;
  if (!row || typeof row.id !== "string" || row.id.length === 0) {
    return { ok: false, status: 403, error: "This account is not linked to a patient record." };
  }
  return { ok: true, patientId: row.id };
}
