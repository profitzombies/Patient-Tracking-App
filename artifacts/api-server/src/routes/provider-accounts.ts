/**
 * Live HQ provider-account directory.
 *
 * Reads never reconcile, provision, or message an existing row. Creation is
 * intentionally separate and calls the atomic database function only after the
 * caller has passed the HQ staff guard.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { sendProviderClaimInvitation } from "../claim/delivery";

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

const AccountInput = z.object({
  officeName: z.string().trim().min(1).max(200),
  providerName: z.string().trim().min(1).max(160),
  providerRole: z.string().trim().max(120).optional().default("Practitioner"),
  email: z.string().trim().email().max(320),
  // Contact-only office line — never used for sign-in, so a provider's
  // personal cell stays free for their own patient account.
  phone: z.string().trim().min(1, "Office phone is required.").max(40),
  city: z.string().trim().max(120).optional().default(""),
  state: z.string().trim().max(2).optional().default(""),
  plan: z.enum(["Core", "Plus", "Concierge"]).nullable(),
});

const PROVIDER_SELECT =
  "provider_id,provider_name,office_name,email,phone,city,state,provider_role,plan,onboarding_code,access_disabled,auth_user_id,claimed_at,created_at,provider_location";
const SUPPORT_PROVIDER_SELECT =
  "provider_id,provider_name,office_name,email,phone,city,state,provider_role,access_disabled,auth_user_id,created_at";

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
    return {
      id,
      providerId: id,
      officeName: String(row.office_name ?? row.provider_name ?? "Unnamed office"),
      providerName: row.provider_name ? String(row.provider_name) : "—",
      providerRole: row.provider_role ? String(row.provider_role) : "—",
      providerCode: effectiveProviderCode(row.onboarding_code, row.provider_id),
      status:
        row.access_disabled === true || lockMap.has(id)
          ? "locked"
          : row.auth_user_id
            ? "active"
            : "needs_setup",
      plan: row.plan ? String(row.plan) : null,
      city: row.city ? String(row.city) : "",
      state: row.state ? String(row.state) : "",
      location: row.provider_location ?? null,
      email: row.email ? String(row.email) : "—",
      phone: row.phone ? String(row.phone) : null,
      joinedKey: String(row.created_at ?? "").slice(0, 10),
      greetingName: String(row.provider_name ?? "Provider").split(/\s+/)[0] ?? "Provider",
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
    email: account.email,
    phone: account.phone,
    city: account.city,
    state: account.state,
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
      p_city: parsed.data.city,
      p_state: parsed.data.state.toUpperCase(),
      p_plan: parsed.data.plan,
    });
    if (result.status === 409 || result.status === 400 || result.status === 422) {
      res.status(409).json({ error: errorMessage(result.json) });
      return;
    }
    if (result.status >= 300 || !result.json) throw new Error(`provider create failed (${result.status})`);

    const row = Array.isArray(result.json) ? result.json[0] : result.json;
    const accountId = String(row.provider_id);
    let invitation: "sent" | "not_configured" | "failed" = "sent";
    try {
      await sendProviderClaimInvitation(parsed.data.email.toLowerCase(), {
        officeName: parsed.data.officeName,
        providerName: parsed.data.providerName,
        providerCode: String(row.onboarding_code),
      });
    } catch (error) {
      invitation = error instanceof Error && error.name === "DeliveryNotConfiguredError" ? "not_configured" : "failed";
      req.log?.error({ err: error }, "new provider claim invitation failed");
    }
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
        city: row.city ? String(row.city) : "",
        state: row.state ? String(row.state) : "",
        email: String(row.email),
        phone: row.phone ? String(row.phone) : null,
        joinedKey: String(row.created_at).slice(0, 10),
        greetingName: String(row.provider_name ?? "Provider").split(/\s+/)[0] ?? "Provider",
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

export default router;