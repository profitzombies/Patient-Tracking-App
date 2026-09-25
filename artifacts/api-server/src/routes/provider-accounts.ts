/**
 * Live HQ provider-account directory.
 *
 * Reads never reconcile, provision, or message an existing row. Creation is
 * intentionally separate and calls the atomic database function only after the
 * caller has passed the HQ staff guard.
 */
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { sendProviderClaimInvitation } from "../claim/delivery";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { offboardingStatusOf } from "../lib/office-status";
import { appBaseUrl } from "../security/alerts";
import { createLimiter } from "../coach/limits";
import { greetingName } from "../lib/greeting-name";

const router: IRouter = Router();

export function isActivePatientStatus(value: unknown): boolean {
  return value === "activated" || value === "active";
}

export function effectiveProviderCode(onboardingCode: unknown, providerId: unknown): string | null {
  const newCode = typeof onboardingCode === "string" ? onboardingCode.trim() : "";
  if (/^[0-9]{6}$/.test(newCode)) return newCode;

  const legacyCode = typeof providerId === "string" || typeof providerId === "number"
    ? String(providerId).trim()
    : "";
  return /^[0-9]{5}$/.test(legacyCode) ? legacyCode : null;
}

const US_STATES = new Map<string, string>([
  ["alabama", "AL"], ["alaska", "AK"], ["arizona", "AZ"], ["arkansas", "AR"],
  ["california", "CA"], ["colorado", "CO"], ["connecticut", "CT"], ["delaware", "DE"],
  ["florida", "FL"], ["georgia", "GA"], ["hawaii", "HI"], ["idaho", "ID"],
  ["illinois", "IL"], ["indiana", "IN"], ["iowa", "IA"], ["kansas", "KS"],
  ["kentucky", "KY"], ["louisiana", "LA"], ["maine", "ME"], ["maryland", "MD"],
  ["massachusetts", "MA"], ["michigan", "MI"], ["minnesota", "MN"], ["mississippi", "MS"],
  ["missouri", "MO"], ["montana", "MT"], ["nebraska", "NE"], ["nevada", "NV"],
  ["new hampshire", "NH"], ["new jersey", "NJ"], ["new mexico", "NM"], ["new york", "NY"],
  ["north carolina", "NC"], ["north dakota", "ND"], ["ohio", "OH"], ["oklahoma", "OK"],
  ["oregon", "OR"], ["pennsylvania", "PA"], ["rhode island", "RI"], ["south carolina", "SC"],
  ["south dakota", "SD"], ["tennessee", "TN"], ["texas", "TX"], ["utah", "UT"],
  ["vermont", "VT"], ["virginia", "VA"], ["washington", "WA"], ["west virginia", "WV"],
  ["wisconsin", "WI"], ["wyoming", "WY"], ["district of columbia", "DC"],
]);

export function normalizeUsState(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^[a-z]{2}$/.test(normalized)) {
    const abbreviation = normalized.toUpperCase();
    return [...US_STATES.values()].includes(abbreviation) ? abbreviation : null;
  }
  return US_STATES.get(normalized) ?? null;
}

export function normalizeUsPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function normalizeUsPostalCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[0-9]{5}(?:-[0-9]{4})?$/.test(normalized) ? normalized : null;
}

const StateInput = z.string().trim().min(1, "State is required.").max(40).transform((value, context) => {
  const state = normalizeUsState(value);
  if (!state) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Choose a valid US state." });
    return z.NEVER;
  }
  return state;
});
const PhoneInput = z.string().trim().min(1, "Office phone is required.").max(40).transform((value, context) => {
  const phone = normalizeUsPhone(value);
  if (!phone) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid 10-digit US office phone number." });
    return z.NEVER;
  }
  return phone;
});
const PostalCodeInput = z.string().trim().min(1, "ZIP code is required.").max(10).transform((value, context) => {
  const postalCode = normalizeUsPostalCode(value);
  if (!postalCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a five-digit ZIP code or ZIP+4." });
    return z.NEVER;
  }
  return postalCode;
});

export const AccountInput = z.object({
  officeName: z.string().trim().min(1).max(200),
  providerName: z.string().trim().min(1).max(160),
  providerRole: z.string().trim().max(120).optional().default("Practitioner"),
  email: z.string().trim().email().max(320),
  // Contact-only office line — never used for sign-in, so a provider's
  // personal cell stays free for their own patient account.
  phone: PhoneInput,
  address1: z.string().trim().min(1, "Address 1 is required.").max(200),
  address2: z.string().trim().max(200).optional().default(""),
  city: z.string().trim().min(1, "City is required.").max(120),
  state: StateInput,
  postalCode: PostalCodeInput,
  plan: z.enum(["Core", "Plus", "Concierge"]).nullable(),
});

const PROVIDER_SELECT =
  "provider_id,provider_name,office_name,email,phone,address_line_1,address_line_2,city,state,postal_code,provider_role,plan,onboarding_code,access_disabled,auth_user_id,claimed_at,created_at,provider_location,offboarding_status,offboarding_started_at,offboarded_at";
const SUPPORT_PROVIDER_SELECT =
  "provider_id,provider_name,office_name,email,phone,address_line_1,address_line_2,city,state,postal_code,provider_role,access_disabled,auth_user_id,created_at,offboarding_status,offboarding_started_at,offboarded_at";

function enc(value: string): string {
  return encodeURIComponent(value);
}

function errorMessage(json: unknown): string {
  if (json && typeof json === "object") {
    const value = json as { message?: unknown; hint?: unknown; details?: unknown };
    if (typeof value.message === "string") return value.message;
  }
  return "The live account request could not be completed.";
}

async function loadAccounts(supportOnly = false) {
  const providers = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?select=${supportOnly ? SUPPORT_PROVIDER_SELECT : PROVIDER_SELECT}&order=created_at.asc&limit=5000`,
  );
  if (providers.status >= 300 || !Array.isArray(providers.json)) {
    throw new Error(`provider list failed (${providers.status})`);
  }
  const patientRows = supportOnly
    ? { status: 200, json: [] }
    : await supabaseAdmin(
        "GET",
        "/rest/v1/patients?select=id,provider_id,activation_status,name,email&limit=20000",
      );
  const teamRows = supportOnly
    ? { status: 200, json: [] }
    : await supabaseAdmin(
        "GET",
        "/rest/v1/team_members?select=id,provider_id,name,email,activation_status,auth_user_id,claimed_at,created_at&limit=5000",
      );
  const locks = await supabaseAdmin(
    "GET",
    "/rest/v1/provider_account_locks?select=account_id,locked_at&limit=5000",
  );
  for (const result of [patientRows, teamRows, locks]) {
    if (result.status >= 300 || !Array.isArray(result.json)) {
      throw new Error(`provider relationship read failed (${result.status})`);
    }
  }

  const activeCounts = new Map<string, number>();
  for (const row of patientRows.json) {
    if (isActivePatientStatus(row.activation_status) && row.provider_id != null) {
      const key = String(row.provider_id);
      activeCounts.set(key, (activeCounts.get(key) ?? 0) + 1);
    }
  }
  const lockMap = new Map<string, string>();
  for (const row of locks.json) {
    const rawId = String(row.account_id);
    const canonicalId = rawId.startsWith("acct-") ? rawId.slice(5) : rawId;
    lockMap.set(canonicalId, String(row.locked_at ?? ""));
  }

  const mapProvider = (row: Record<string, unknown>) => {
    const id = String(row.provider_id);
    // Offboarding wins over every other state: the office is leaving (or has
    // left) THINNR, so a lock or a missing sign-in is no longer the headline.
    const offboarding = offboardingStatusOf(row.offboarding_status);
    return {
      id,
      providerId: id,
      officeName: String(row.office_name ?? row.provider_name ?? "Unnamed office"),
      providerName: row.provider_name ? String(row.provider_name) : "—",
      providerRole: row.provider_role ? String(row.provider_role) : "—",
      providerCode: effectiveProviderCode(row.onboarding_code, row.provider_id),
      status:
        offboarding !== "active"
          ? offboarding
          : row.access_disabled === true || lockMap.has(id)
            ? "locked"
            : row.auth_user_id
              ? "active"
              : "needs_setup",
      offboarding: {
        status: offboarding,
        startedAt: typeof row.offboarding_started_at === "string" ? row.offboarding_started_at : null,
        offboardedAt: typeof row.offboarded_at === "string" ? row.offboarded_at : null,
      },
      plan: row.plan ? String(row.plan) : null,
      address1: row.address_line_1 ? String(row.address_line_1) : "",
      address2: row.address_line_2 ? String(row.address_line_2) : "",
      city: row.city ? String(row.city) : "",
      state: row.state ? String(row.state) : "",
      postalCode: row.postal_code ? String(row.postal_code) : "",
      location: row.provider_location ?? null,
      email: row.email ? String(row.email) : "—",
      phone: row.phone ? String(row.phone) : null,
      joinedKey: String(row.created_at ?? "").slice(0, 10),
      greetingName: greetingName(String(row.provider_name ?? "")) ?? "Provider",
      activePatientCount: activeCounts.get(id) ?? 0,
      lock: lockMap.has(id) ? { lockedAt: lockMap.get(id) } : null,
      // No live source is authoritative for the old demo analytics tiles.
      newEnrollments: null,
      recurringRevenue: null,
      enrollmentRevenue: null,
      activeSubscriptions: null,
      deliveriesInWindow: null,
      engagementRate: null,
      avgPoundsLost: null,
      goalCompletion: null,
      retention: null,
    };
  };

  return {
    accounts: (providers.json as Record<string, unknown>[]).map(mapProvider),
    patientRows: patientRows.json,
    teamRows: teamRows.json,
  };
}

export function supportProviderAccountDto(account: Record<string, unknown>) {
  return {
    id: account.id,
    providerId: account.providerId,
    officeName: account.officeName,
    providerName: account.providerName,
    providerRole: account.providerRole,
    status: account.status,
    offboarding: account.offboarding,
    email: account.email,
    phone: account.phone,
    address1: account.address1,
    address2: account.address2,
    city: account.city,
    state: account.state,
    postalCode: account.postalCode,
    joinedKey: account.joinedKey,
  };
}

function clinicalAccountDto(account: Record<string, unknown>) {
  // Intentionally omit onboarding/provider codes and all admin-only analytics.
  return { ...supportProviderAccountDto(account), plan: account.plan, location: account.location, activePatientCount: account.activePatientCount };
}

function accountDtoFor(identity: StaffIdentity, account: Record<string, unknown>) {
  if (identity.departmentRole === "support") return supportProviderAccountDto(account);
  if (identity.departmentRole === "clinical") return clinicalAccountDto(account);
  return account;
}

export type WelcomeDelivery = "sent" | "not_configured" | "failed";

/** Where the welcome email's "Sign in to THINNR" button lands: the operations sign-in page. */
export function providerSignInUrl(): string | null {
  const base = appBaseUrl("staff");
  return base ? `${base}/` : null;
}

/**
 * Send the owner welcome email and report how it went. The account row is
 * already committed either way, so HQ is told the truth instead of an error.
 */
async function deliverProviderWelcome(
  req: Request,
  email: string,
  input: { officeName: string; providerName: string; providerCode: string },
): Promise<WelcomeDelivery> {
  const signInUrl = providerSignInUrl();
  if (!signInUrl) {
    req.log?.error({}, "provider welcome email has no operations base URL to link to");
    return "failed";
  }
  try {
    await sendProviderClaimInvitation(email, { ...input, signInUrl });
    return "sent";
  } catch (error) {
    req.log?.error({ err: error }, "provider welcome email failed");
    return error instanceof Error && error.name === "DeliveryNotConfiguredError" ? "not_configured" : "failed";
  }
}

router.get("/provider-accounts", requireHqPermission("provider_contact_read"), async (req, res) => {
  try {
    const staff = res.locals.staff as StaffIdentity;
    const snapshot = await loadAccounts(staff.departmentRole === "support");
    res.json({ accounts: snapshot.accounts.map((account) => accountDtoFor(staff, account)) });
  } catch (error) {
    req.log?.error({ err: error }, "provider account list failed");
    res.status(502).json({ error: "Could not load provider accounts right now." });
  }
});

router.get("/provider-accounts/:id", requireHqPermission("provider_contact_read"), async (req, res) => {
  try {
    const identity = res.locals.staff as StaffIdentity;
    const snapshot = await loadAccounts(identity.departmentRole === "support");
    const account = snapshot.accounts.find((item) => item.id === req.params.id);
    if (!account) {
      res.status(404).json({ error: "Provider account not found." });
      return;
    }
    const roster = (snapshot.patientRows as Record<string, unknown>[])
      .filter((row) => String(row.provider_id ?? "") === account.id)
      .slice(0, 5)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name ?? "Patient"),
        email: row.email ? String(row.email) : "—",
        status: String(row.activation_status ?? "—"),
      }));
    const staff = (snapshot.teamRows as Record<string, unknown>[])
      .filter((row) => String(row.provider_id ?? "") === account.id)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name ?? "Staff member"),
        email: String(row.email ?? "—"),
        activationStatus: row.activation_status ? String(row.activation_status) : null,
        authUserId: row.auth_user_id ? String(row.auth_user_id) : null,
        claimedAt: row.claimed_at ? String(row.claimed_at) : null,
      }));
    // Support is deliberately limited to contact and access status. It must
    // never receive patient or provider-staff identities from this endpoint.
    if (identity.departmentRole === "support") {
      res.json({ account: supportProviderAccountDto(account) });
      return;
    }
    res.json({ account: accountDtoFor(identity, account), roster, staff });
  } catch (error) {
    req.log?.error({ err: error }, "provider account detail failed");
    res.status(502).json({ error: "Could not load this provider account right now." });
  }
});

router.post("/provider-accounts", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = AccountInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({
      error: issue?.message ?? "Check the account form and try again.",
      field: typeof issue?.path?.[0] === "string" ? issue.path[0] : undefined,
    });
    return;
  }
  try {
    const callerId = (res.locals.staff as StaffIdentity).userId;
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_create_provider_account", {
      p_created_by: callerId,
      p_office_name: parsed.data.officeName,
      p_provider_name: parsed.data.providerName,
      p_provider_role: parsed.data.providerRole,
      p_email: parsed.data.email.toLowerCase(),
      p_phone: parsed.data.phone,
      p_address_line_1: parsed.data.address1,
      p_address_line_2: parsed.data.address2,
      p_city: parsed.data.city,
      p_state: parsed.data.state,
      p_postal_code: parsed.data.postalCode,
      p_plan: parsed.data.plan,
    });
    if (result.status === 409 || result.status === 400 || result.status === 422) {
      res.status(409).json({ error: errorMessage(result.json) });
      return;
    }
    if (result.status >= 300 || !result.json) throw new Error(`provider create failed (${result.status})`);

    const row = Array.isArray(result.json) ? result.json[0] : result.json;
    const accountId = String(row.provider_id);
    const invitation = await deliverProviderWelcome(req, parsed.data.email.toLowerCase(), {
      officeName: parsed.data.officeName,
      providerName: parsed.data.providerName,
      providerCode: String(row.onboarding_code),
    });
    await recordAdminAuditEvent({ action: "provider_account_created", actorUserId: callerId, actorKind: "hq", providerId: accountId, targetKind: "provider_account", targetId: accountId, requestId: req.headers["x-request-id"]?.toString() ?? null }).catch(error => req.log?.error({ err: error }, "provider account create audit failed"));
    res.status(201).json({
      account: {
        id: accountId,
        providerId: accountId,
        officeName: String(row.office_name),
        providerName: String(row.provider_name),
        providerRole: row.provider_role ? String(row.provider_role) : "—",
        providerCode: row.onboarding_code ? String(row.onboarding_code) : null,
        status: "needs_setup",
        plan: row.plan ? String(row.plan) : null,
        address1: row.address_line_1 ? String(row.address_line_1) : "",
        address2: row.address_line_2 ? String(row.address_line_2) : "",
        city: row.city ? String(row.city) : "",
        state: row.state ? String(row.state) : "",
        postalCode: row.postal_code ? String(row.postal_code) : "",
        email: String(row.email),
        phone: row.phone ? String(row.phone) : null,
        joinedKey: String(row.created_at).slice(0, 10),
        greetingName: greetingName(String(row.provider_name ?? "")) ?? "Provider",
        activePatientCount: 0,
        lock: null,
        newEnrollments: null,
        recurringRevenue: null,
        enrollmentRevenue: null,
        activeSubscriptions: null,
        deliveriesInWindow: null,
        engagementRate: null,
        avgPoundsLost: null,
        goalCompletion: null,
        retention: null,
      },
      invitation,
    });
  } catch (error) {
    req.log?.error({ err: error }, "provider account create failed");
    res.status(502).json({ error: "Could not finish creating the provider account." });
  }
});

/**
 * Re-send the owner welcome email to an office whose owner has never signed
 * in. Limited per office so a stuck button (or a curious admin) cannot turn
 * it into a mail cannon; the limiter is process-local, which is enough for a
 * manual, HQ-only action.
 */
const welcomeResendLimit = createLimiter({
  burst: 3, refillPerMinute: 0.2, maxConcurrent: 5, dailyBudget: 500,
  dailyMessage: "Too many welcome emails were re-sent today. Try again tomorrow.",
  busyMessage: "The email service is busy. Try again in a moment.",
  rapidMessage: "This welcome email was just re-sent. Wait a few minutes before sending it again.",
});

router.post("/provider-accounts/:id/welcome/resend", requireHqPermission("provider_manage"), async (req, res) => {
  const accountId = String(req.params.id ?? "").trim();
  if (!accountId) {
    res.status(404).json({ error: "Provider account not found." });
    return;
  }
  const slot = welcomeResendLimit(accountId);
  if (!slot.ok) {
    res.status(429).json({ error: slot.message });
    return;
  }
  try {
    const actor = res.locals.staff as StaffIdentity;
    const id = encodeURIComponent(accountId);
    const [providers, locks] = await Promise.all([
      supabaseAdmin(
        "GET",
        `/rest/v1/providers?provider_id=eq.${id}&select=provider_id,provider_name,office_name,email,onboarding_code,auth_user_id,access_disabled,offboarding_status&limit=1`,
      ),
      supabaseAdmin("GET", `/rest/v1/provider_account_locks?account_id=in.(${id},acct-${id})&select=account_id&limit=1`),
    ]);
    if (providers.status >= 300 || !Array.isArray(providers.json) || locks.status >= 300 || !Array.isArray(locks.json)) {
      throw new Error(`provider welcome resend read failed (${providers.status}/${locks.status})`);
    }
    const row = providers.json[0] as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: "Provider account not found." });
      return;
    }
    if (row.auth_user_id) {
      res.status(409).json({ error: "The owner has already signed in, so there is no welcome email to re-send." });
      return;
    }
    if (offboardingStatusOf(row.offboarding_status) !== "active") {
      res.status(409).json({ error: "This office is being offboarded, so its welcome email cannot be re-sent." });
      return;
    }
    if (row.access_disabled === true || locks.json.length > 0) {
      res.status(409).json({ error: "This office is locked. Unlock it before re-sending the welcome email." });
      return;
    }
    const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
    const providerCode = effectiveProviderCode(row.onboarding_code, row.provider_id);
    if (!email || !providerCode) {
      res.status(409).json({ error: "This office has no owner email or patient code on file. Edit the office details first." });
      return;
    }
    const invitation = await deliverProviderWelcome(req, email, {
      officeName: String(row.office_name ?? row.provider_name ?? "Your office"),
      providerName: String(row.provider_name ?? "Provider"),
      providerCode,
    });
    await recordAdminAuditEvent({
      action: "provider_welcome_resent", actorUserId: actor.userId, actorKind: "hq", providerId: accountId,
      targetKind: "provider_account", targetId: accountId, requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { invitation },
    }).catch(error => req.log?.error({ err: error }, "provider welcome resend audit failed"));
    res.json({ invitation });
  } catch (error) {
    req.log?.error({ err: error }, "provider welcome resend failed");
    res.status(502).json({ error: "Could not re-send the welcome email right now. Try again in a moment." });
  } finally {
    slot.release();
  }
});

router.patch("/provider-accounts/:id", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = AccountInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({
      error: issue?.message ?? "Check the account form and try again.",
      field: typeof issue?.path?.[0] === "string" ? issue.path[0] : undefined,
    });
    return;
  }
  try {
    const callerId = (res.locals.staff as StaffIdentity).userId;
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_update_provider_account", {
      p_updated_by: callerId,
      p_provider_id: req.params.id,
      p_office_name: parsed.data.officeName,
      p_provider_name: parsed.data.providerName,
      p_provider_role: parsed.data.providerRole,
      p_email: parsed.data.email.toLowerCase(),
      p_phone: parsed.data.phone,
      p_address_line_1: parsed.data.address1,
      p_address_line_2: parsed.data.address2,
      p_city: parsed.data.city,
      p_state: parsed.data.state,
      p_postal_code: parsed.data.postalCode,
      p_plan: parsed.data.plan,
    });
    if (result.status === 404) {
      res.status(404).json({ error: "Provider account not found." });
      return;
    }
    if (result.status === 409 || result.status === 400 || result.status === 422) {
      res.status(409).json({ error: errorMessage(result.json) });
      return;
    }
    if (result.status >= 300 || !result.json) {
      throw new Error(`provider update failed (${result.status})`);
    }

    const snapshot = await loadAccounts(false);
    const account = snapshot.accounts.find((item) => item.id === req.params.id);
    if (!account) {
      res.status(404).json({ error: "Provider account not found." });
      return;
    }
    const providerId = String(req.params.id);
    await recordAdminAuditEvent({ action: "provider_account_updated", actorUserId: callerId, actorKind: "hq", providerId, targetKind: "provider_account", targetId: providerId, requestId: req.headers["x-request-id"]?.toString() ?? null }).catch(error => req.log?.error({ err: error }, "provider account update audit failed"));
    res.json({ account });
  } catch (error) {
    req.log?.error({ err: error }, "provider account update failed");
    res.status(502).json({ error: "Could not save this provider account right now." });
  }
});

export default router;