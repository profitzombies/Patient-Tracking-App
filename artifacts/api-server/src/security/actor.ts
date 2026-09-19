/**
 * Who owns an auth user id, for the security rails: a patient (with their
 * office) or a staff login (HQ member, provider owner, or office teammate).
 * Used both to resolve "me" from a bearer token and to describe the account
 * an alert is about. Never returns anything a client could not already see
 * about themselves.
 */
import { identifyBearer } from "../auth/identify";
import { bearerToken } from "../lib/patient-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { officeRoleOf, type StaffOfficeRole } from "../auth/directory";
import { sessionIdOfToken } from "./device";

const enc = encodeURIComponent;

export type SecurityActor =
  | {
      realm: "patient";
      userId: string;
      patientId: string;
      providerId: string | null;
      name: string | null;
      email: string | null;
      phone: string | null;
    }
  | {
      realm: "staff";
      userId: string;
      staffKind: "hq" | "provider" | "team_member";
      ref: string;
      providerId: string | null;
      /** owner/admin/staff for office identities (provider = owner); null for HQ. */
      officeRole: StaffOfficeRole | null;
      name: string | null;
      email: string | null;
    };

function first<T>(res: { status: number; json: unknown }, what: string): T | null {
  if (res.status >= 300) throw new Error(`${what} failed (${res.status})`);
  return Array.isArray(res.json) && res.json[0] ? (res.json[0] as T) : null;
}

/** Describe the account behind an auth user id (null = no directory row). */
export async function describeAccount(userId: string): Promise<SecurityActor | null> {
  const patient = first<{ id: string; provider_id: string | null; name: string | null; email: string | null; phone: string | null }>(
    await supabaseAdmin(
      "GET",
      `/rest/v1/patients?auth_user_id=eq.${enc(userId)}&select=id,provider_id,name,email,phone&limit=1`,
    ),
    "patient lookup",
  );
  if (patient) {
    return {
      realm: "patient",
      userId,
      patientId: String(patient.id),
      providerId: patient.provider_id ? String(patient.provider_id) : null,
      name: patient.name,
      email: patient.email,
      phone: patient.phone,
    };
  }
  const membership = first<{ id: string; display_name: string | null; email: string | null; status: string | null }>(
    await supabaseAdmin(
      "GET",
      `/rest/v1/hq_memberships?auth_user_id=eq.${enc(userId)}&select=id,display_name,email,status&limit=1`,
    ),
    "hq membership lookup",
  );
  if (membership) {
    return { realm: "staff", userId, staffKind: "hq", ref: String(membership.id), providerId: null, officeRole: null, name: membership.display_name, email: membership.email };
  }
  const provider = first<{ provider_id: string; provider_name: string | null; email: string | null }>(
    await supabaseAdmin(
      "GET",
      `/rest/v1/providers?auth_user_id=eq.${enc(userId)}&select=provider_id,provider_name,email&limit=1`,
    ),
    "provider lookup",
  );
  if (provider) {
    return { realm: "staff", userId, staffKind: "provider", ref: String(provider.provider_id), providerId: String(provider.provider_id), officeRole: "owner", name: provider.provider_name, email: provider.email };
  }
  const member = first<{ id: string; provider_id: string | null; name: string | null; email: string | null; office_role?: string | null }>(
    await supabaseAdmin(
      "GET",
      `/rest/v1/team_members?auth_user_id=eq.${enc(userId)}&select=id,provider_id,name,email,office_role&limit=1`,
    ),
    "team member lookup",
  );
  if (member) {
    return { realm: "staff", userId, staffKind: "team_member", ref: String(member.id), providerId: member.provider_id ? String(member.provider_id) : null, officeRole: officeRoleOf(member.office_role), name: member.name, email: member.email };
  }
  return null;
}

export type ResolvedActor =
  | { ok: true; actor: SecurityActor; token: string; sessionId: string | null }
  | { ok: false; status: number; error: string };

/**
 * Resolve the caller from their bearer token. 401 for no/expired session,
 * 403 for a live session with no account behind it, 503 when GoTrue is down.
 *
 * Always verified REMOTELY: these are the security-settings flows (session
 * lists, sign-out-others, password changes) where Supabase Auth itself must
 * vouch for the session, whatever path they are mounted on.
 */
export async function resolveSecurityActor(req: { headers: Record<string, unknown> }): Promise<ResolvedActor> {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: "Sign in to continue." };
  let user: Awaited<ReturnType<typeof identifyBearer>>;
  try {
    user = await identifyBearer(token, "remote");
  } catch {
    return { ok: false, status: 503, error: "Could not verify your session. Try again in a moment." };
  }
  if (!user) return { ok: false, status: 401, error: "Your session has expired. Sign in again to continue." };
  const actor = await describeAccount(user.id);
  if (!actor) return { ok: false, status: 403, error: "This session isn't linked to an account." };
  if (actor.realm === "staff" && !actor.email && user.email) actor.email = user.email;
  return { ok: true, actor, token, sessionId: sessionIdOfToken(token) };
}

export function firstName(name: string | null | undefined): string {
  const clean = (name ?? "").trim();
  if (!clean) return "there";
  return clean.split(/\s+/)[0];
}
