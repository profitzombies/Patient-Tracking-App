/**
 * Session minting + just-in-time auth-user linking for passwordless login.
 *
 * After a code is verified server-side, the client still needs a real
 * Supabase session. The server asks GoTrue's admin API for a magiclink and
 * hands the client only its `hashed_token`; the client redeems it with
 * `supabase.auth.verifyOtp({ token_hash, type: 'email' })`. The email link
 * itself is never sent anywhere — the code the person already typed is the
 * proof, and the hashed token is single-use with a short GoTrue-side expiry.
 *
 * Staff and patient records that predate their first code login get their
 * auth user created here at verify time, with the same claim markers the
 * claim flow uses so the demo-provisioning trigger stays out of the way.
 * Patients get a synthetic login email (their real email lives on the
 * patient row) because patient emails are only unique among patients, while
 * GoTrue enforces global uniqueness across both realms.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import type { StaffHit } from "./directory";
import { loadPendingHqInvitation, type PatientRow } from "./directory";

function enc(value: string): string {
  return encodeURIComponent(value);
}

export function patientSyntheticEmail(patientId: string): string {
  return `pt-${patientId.toLowerCase()}@patients.thinnr.invalid`;
}

/** GoTrue duplicate-phone rejections, in their assorted shapes. */
export function isPhoneExistsError(json: unknown): boolean {
  const body = (json ?? {}) as { error_code?: unknown; code?: unknown; msg?: unknown; message?: unknown };
  const codeText = String(body.error_code ?? body.code ?? "");
  const message = String(body.msg ?? body.message ?? "");
  return codeText === "phone_exists" || /phone.*(exists|registered)/i.test(message);
}

export class PhoneExistsError extends Error {
  constructor() {
    super("phone already registered to a login");
  }
}

/**
 * Mint a single-use session token hash for an auth user (by their GoTrue
 * email). The client exchanges it for a session via verifyOtp.
 */
export async function mintSessionTokenHash(email: string): Promise<string> {
  const res = await supabaseAdmin("POST", "/auth/v1/admin/generate_link", {
    type: "magiclink",
    email,
  });
  const hashed =
    (res.json?.hashed_token as string | undefined) ??
    (res.json?.properties?.hashed_token as string | undefined) ??
    null;
  if (res.status >= 300 || typeof hashed !== "string" || hashed.length === 0) {
    throw new Error(`session link generation failed (${res.status})`);
  }
  return hashed;
}

export async function getAuthUserEmail(userId: string): Promise<string> {
  const res = await supabaseAdmin("GET", `/auth/v1/admin/users/${enc(userId)}`);
  const email = res.json?.email as string | undefined;
  if (res.status >= 300 || !email) {
    throw new Error(`auth user lookup failed (${res.status})`);
  }
  return email;
}

export async function deleteAuthUserQuietly(userId: string): Promise<void> {
  await supabaseAdmin("DELETE", `/auth/v1/admin/users/${enc(userId)}`).catch(() => {});
}

interface CreateUserInput {
  email: string;
  phone?: string | null;
  displayName?: string | null;
  appMetadata: Record<string, unknown>;
}

async function createConfirmedUser(input: CreateUserInput): Promise<string> {
  const attempt = async (withPhone: boolean) =>
    supabaseAdmin("POST", "/auth/v1/admin/users", {
      email: input.email,
      email_confirm: true,
      ...(withPhone && input.phone ? { phone: input.phone, phone_confirm: true } : {}),
      ...(input.displayName ? { user_metadata: { display_name: input.displayName } } : {}),
      app_metadata: input.appMetadata,
    });

  let res = await attempt(true);
  if (res.status >= 300 && input.phone && isPhoneExistsError(res.json)) {
    throw new PhoneExistsError();
  }
  if (res.status >= 300) {
    throw new Error(`auth user creation failed (${res.status})`);
  }
  const id = res.json?.id as string | undefined;
  if (!id) throw new Error("auth user creation returned no id");
  return id;
}

/**
 * Link a just-created auth user into a directory row, guarded so two
 * concurrent first logins cannot double-link: the PATCH only lands while
 * auth_user_id is still null. On a lost race the new user is deleted and the
 * winner's link is used instead.
 */
async function linkGuarded(
  table: string,
  refCol: string,
  ref: string,
  userId: string,
): Promise<string> {
  const patch = await supabaseAdmin(
    "PATCH",
    `/rest/v1/${table}?${refCol}=eq.${enc(ref)}&auth_user_id=is.null`,
    { auth_user_id: userId, claimed_at: new Date().toISOString() },
    "return=representation",
  );
  if (patch.status >= 300) {
    await deleteAuthUserQuietly(userId);
    throw new Error(`account linking failed (${patch.status})`);
  }
  if (Array.isArray(patch.json) && patch.json.length === 1) return userId;

  // Lost the race — someone else linked first. Use their link.
  await deleteAuthUserQuietly(userId);
  const reread = await supabaseAdmin(
    "GET",
    `/rest/v1/${table}?${refCol}=eq.${enc(ref)}&select=auth_user_id&limit=1`,
  );
  const winner = Array.isArray(reread.json) ? (reread.json[0]?.auth_user_id as string | null) : null;
  if (!winner) throw new Error("account linking race left no login");
  return winner;
}

/**
 * Portal-invited rows become active the moment their login exists: flip
 * activation_status invited -> activated, guarded on the old value so the
 * write is idempotent. Failures throw — the verify endpoint answers 502 and
 * a retried login re-runs the flip (both call paths below reach it), so the
 * row can never silently stay "invited" while holding a login.
 */
async function activateInvitedPatient(patient: PatientRow): Promise<void> {
  if (patient.activation_status !== "invited") return;
  const res = await supabaseAdmin(
    "PATCH",
    `/rest/v1/patients?id=eq.${enc(patient.id)}&activation_status=eq.invited`,
    { activation_status: "activated" },
  );
  if (res.status >= 300) {
    throw new Error(`invited patient activation failed (${res.status})`);
  }
}

/** Patient: existing link wins; otherwise create + link a synthetic-email user. */
export async function ensurePatientAuthUser(patient: PatientRow): Promise<string> {
  if (patient.auth_user_id) {
    await activateInvitedPatient(patient);
    return patient.auth_user_id;
  }
  const input: CreateUserInput = {
    email: patientSyntheticEmail(patient.id),
    phone: patient.phone,
    displayName: patient.name,
    appMetadata: { thinnr_claim: "patient", thinnr_claim_ref: patient.id },
  };
  let userId: string;
  try {
    userId = await createConfirmedUser(input);
  } catch (error) {
    // Staff and patients can legitimately share a household/owner phone.
    // GoTrue requires phone uniqueness across every realm, while THINNR's
    // passwordless rail has already proven this exact invited patient's
    // number. Keep the patient on a separate synthetic-email identity and
    // leave the verified phone authoritative on the patient row.
    if (!(error instanceof PhoneExistsError) || patient.activation_status !== "invited") throw error;
    userId = await createConfirmedUser({ ...input, phone: null });
  }
  const linked = await linkGuarded("patients", "id", patient.id, userId);
  await activateInvitedPatient(patient);
  return linked;
}

/** Office account ids are canonically bare — locks and the HQ UI strip `acct-`. */
function canonicalAccountId(id: string): string {
  return id.startsWith("acct-") ? id.slice(5) : id;
}

/**
 * Provider owners and office team members: run the canonical DB provisioning
 * rail (assignment upsert + provisioning marker + provider_staff profile +
 * training viewer link, one transaction) so a proven staff code always
 * resolves to an authorized office workspace — first logins and repairs of
 * accounts that predate the rail alike. Throws on failure: a session must
 * never be minted for a staff login the operations app would park on the
 * claimed-workspace placeholder.
 */
async function provisionStaffWorkspace(userId: string, hit: StaffHit): Promise<void> {
  const office = hit.class === "provider" ? hit.ref : hit.providerId;
  if (!office) throw new Error("staff login without an owning office");
  const res = await supabaseAdmin("POST", "/rest/v1/rpc/provision_staff_login", {
    p_user_id: userId,
    p_email: hit.email,
    p_display_name: hit.name,
    p_account_code: canonicalAccountId(office),
  });
  if (res.status >= 300) {
    throw new Error(`staff workspace provisioning failed (${res.status})`);
  }
}

/**
 * Staff (provider / team member / invited HQ member): resolve the hit to a
 * linked auth user, creating one on first login.
 */
export async function ensureStaffAuthUser(hit: StaffHit): Promise<string> {
  if (hit.class === "hq_active") {
    if (!hit.authUserId) throw new Error("active hq membership without login");
    return hit.authUserId;
  }

  if (hit.class === "hq_invited") {
    const invitation = await loadPendingHqInvitation(hit.ref);
    if (!invitation) throw new Error("hq invitation expired");
    const userId = await createConfirmedUser({
      email: hit.email,
      displayName: hit.name,
      appMetadata: { thinnr_claim: "hq_member", thinnr_claim_ref: hit.ref },
    });
    const accepted = await supabaseAdmin("POST", "/rest/v1/rpc/hq_accept_team_invitation", {
      p_token_hash: invitation.token_hash,
      p_auth_user_id: userId,
    });
    if (accepted.status >= 300) {
      await deleteAuthUserQuietly(userId);
      throw new Error(`hq invitation acceptance failed (${accepted.status})`);
    }
    return userId;
  }

  if (hit.authUserId) {
    // Existing sign-in (including ones created before the provisioning rail
    // existed, which carry claim markers and no profile): repair/refresh the
    // office authorization on every proven code.
    await provisionStaffWorkspace(hit.authUserId, hit);
    return hit.authUserId;
  }

  if (hit.class === "provider") {
    const userId = await createConfirmedUser({
      email: hit.email,
      displayName: hit.name,
      appMetadata: { thinnr_claim: "provider", thinnr_claim_ref: hit.ref },
    });
    const linked = await linkGuarded("providers", "provider_id", hit.ref, userId);
    await provisionStaffWorkspace(linked, hit);
    return linked;
  }

  // Team member: pre-approved staff emails (staff_role_assignments) keep the
  // provisioning marker so the signup trigger elevates their profile exactly
  // as HQ provisioning always has; everyone else keeps claim markers for
  // provenance. Either way the provisioning rail below guarantees the
  // office workspace.
  const approval = await supabaseAdmin(
    "GET",
    `/rest/v1/staff_role_assignments?email=ilike.${enc(hit.email)}&select=email,role&limit=1`,
  );
  const provisioned =
    approval.status < 300 && Array.isArray(approval.json) && approval.json.length > 0;
  const userId = await createConfirmedUser({
    email: hit.email,
    displayName: hit.name,
    appMetadata: provisioned
      ? { thinnr_provisioned: true }
      : { thinnr_claim: "team_member", thinnr_claim_ref: hit.ref },
  });
  const linked = await linkGuarded("team_members", "id", hit.ref, userId);
  await provisionStaffWorkspace(linked, hit);
  return linked;
}
