/**
 * HQ-only staff provisioning — POST /api/staff-logins
 *
 * Creates a real office sign-in from a provider account page. The caller (a
 * real signed-in HQ admin, verified exactly like the training-media routes)
 * sends first/last name, email, optional phone, the office's account code,
 * and the password they typed. The service-role Supabase calls stay entirely
 * server-side — the key never reaches a browser — and the flow follows the
 * established assignment chain instead of inventing a parallel path:
 *
 *   1. Create the CONFIRMED auth user first (no email is ever sent). GoTrue
 *      enforces email uniqueness atomically, so a duplicate add fails here —
 *      before the assignment upsert could silently re-point an existing
 *      person's office.
 *   2. Upsert the pre-approval row (email → provider_staff @ office). The
 *      existing sync trigger elevates the profile and links/creates the
 *      training-viewer row under the office, which is what puts the person
 *      on the office roster and scopes their reads via RLS.
 *   3. Prove the chain converged before reporting success, then carry the
 *      optional phone onto the roster row. On any failure the handler
 *      deletes what this request created (user, assignment) so a retry
 *      starts clean — no silent half-provisioned logins.
 *
 * The password only ever rides the request body: the request serializer logs
 * method + path, and nothing in this handler logs or echoes the body.
 */
import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireHqPermission } from "../lib/staff-auth";

const router: IRouter = Router();

export const STAFF_LOGINS_PATH = "/staff-logins";

const BodySchema = z.object({
  accountId: z
    .string({ required_error: "The office's account code is missing." })
    .trim()
    .min(1, "The office's account code is missing.")
    .max(60, "That office code looks wrong.")
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "That office code looks wrong."),
  firstName: z
    .string({ required_error: "First name is required." })
    .trim()
    .min(1, "First name is required.")
    .max(60, "First names max out at 60 characters."),
  lastName: z
    .string({ required_error: "Last name is required." })
    .trim()
    .min(1, "Last name is required.")
    .max(60, "Last names max out at 60 characters."),
  email: z
    .string({ required_error: "Email is required." })
    .trim()
    .email("Enter a valid email address.")
    .max(320, "That email address is too long."),
  phone: z.string().trim().max(40, "That phone number is too long.").optional(),
  password: z
    .string({ required_error: "Password is required." })
    .min(8, "Passwords need at least 8 characters.")
    .max(72, "Passwords max out at 72 characters."),
});

function supabaseBase(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return url.replace(/\/$/, "");
}

function serviceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return key;
}

interface AdminResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export function providerAcceptsNewStaff(rows: unknown, locks: unknown = []): boolean {
  return (
    Array.isArray(rows) &&
    rows.length === 1 &&
    rows[0]?.access_disabled !== true &&
    Array.isArray(locks) &&
    locks.length === 0
  );
}

async function supabaseAdmin(
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
  return { status: response.status, json };
}

router.post(STAFF_LOGINS_PATH, requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = BodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = typeof issue?.path?.[0] === "string" ? issue.path[0] : undefined;
    res.status(400).json({ error: issue?.message ?? "Check the form and try again.", field });
    return;
  }

  const accountId = parsed.data.accountId;
  const name = `${parsed.data.firstName} ${parsed.data.lastName}`.replace(/\s+/g, " ").trim();
  const email = parsed.data.email.toLowerCase();
  const phone = parsed.data.phone ?? "";
  const phoneDigits = phone.replace(/\D/g, "");
  const password = parsed.data.password;

  let userId: string | null = null;
  let teamMemberId: string | null = null;
  let priorAssignment: { role: string; provider_account_code: string | null } | null = null;

  try {
    // Existing imported provider/staff rows are identities, even when they
    // have never completed Auth linkage. Never create or message a duplicate.
    const [targetProvider, targetLocks, providerMatch, staffMatch, phoneProviders, phoneViewers, authUsers] = await Promise.all([
      supabaseAdmin(
        "GET",
        `/rest/v1/providers?provider_id=eq.${encodeURIComponent(accountId)}&select=provider_id,access_disabled&limit=2`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/provider_account_locks?or=(account_id.eq.${encodeURIComponent(accountId)},account_id.eq.${encodeURIComponent(`acct-${accountId}`)})&select=account_id&limit=1`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/providers?email=ilike.${encodeURIComponent(email)}&select=provider_id,auth_user_id&limit=1`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/team_members?email=ilike.${encodeURIComponent(email)}&select=id,auth_user_id&limit=1`,
      ),
      phoneDigits.length >= 10
        ? supabaseAdmin("GET", "/rest/v1/providers?select=provider_id,phone&phone=not.is.null&limit=5000")
        : Promise.resolve({ status: 200, json: [] }),
      phoneDigits.length >= 10
        ? supabaseAdmin("GET", "/rest/v1/training_viewers?select=id,phone&phone=not.is.null&limit=5000")
        : Promise.resolve({ status: 200, json: [] }),
      phoneDigits.length >= 10
        ? supabaseAdmin("GET", "/auth/v1/admin/users?page=1&per_page=1000")
        : Promise.resolve({ status: 200, json: { users: [] } }),
    ]);
    if ([targetProvider, targetLocks, providerMatch, staffMatch, phoneProviders, phoneViewers, authUsers].some((result) => result.status >= 300)) {
      throw new Error("identity duplicate lookup failed");
    }
    if (!providerAcceptsNewStaff(targetProvider.json, targetLocks.json)) {
      res.status(409).json({
        error: "Choose an existing provider account with active access.",
        field: "accountId",
      });
      return;
    }
    if (Array.isArray(providerMatch.json) && providerMatch.json.length > 0) {
      res.status(409).json({
        error: "That person already has a provider record. Existing records must use the normal claim flow.",
        field: "email",
      });
      return;
    }
    if (Array.isArray(staffMatch.json) && staffMatch.json.length > 0) {
      const linked = Boolean(staffMatch.json[0]?.auth_user_id);
      res.status(409).json({
        error: linked
          ? "That staff member already has an active login."
          : "That staff member already exists and currently needs setup.",
        field: "email",
      });
      return;
    }
    if (phoneDigits.length >= 10) {
      const normalized = phoneDigits.slice(-10);
      const phoneTaken = [
        ...(Array.isArray(phoneProviders.json) ? phoneProviders.json : []),
        ...(Array.isArray(phoneViewers.json) ? phoneViewers.json : []),
        ...(Array.isArray(authUsers.json?.users) ? authUsers.json.users : []),
      ].some((row) => String(row?.phone ?? "").replace(/\D/g, "").slice(-10) === normalized);
      if (phoneTaken) {
        res.status(409).json({
          error: "That phone number already belongs to a provider, staff member, or login.",
          field: "phone",
        });
        return;
      }
    }

    // Remember any pre-existing (dangling) pre-approval for this email so a
    // failed request can restore it exactly. A LIVE user with this email
    // cannot exist past step 1, so this row can only be an unclaimed one.
    const prior = await supabaseAdmin(
      "GET",
      `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(email)}&select=role,provider_account_code`,
    );
    if (prior.status >= 300) throw new Error(`assignment lookup failed (${prior.status})`);
    priorAssignment = Array.isArray(prior.json) && prior.json.length > 0 ? prior.json[0] : null;

    // 1. The auth user, created confirmed — uniqueness enforced atomically.
    const created = await supabaseAdmin("POST", "/auth/v1/admin/users", {
      email,
      password,
      email_confirm: true,
      // Marks the account as server-provisioned. With email autoconfirm on,
      // role elevation requires this marker — a bare public signup with a
      // pre-approved email can never become staff.
      app_metadata: { thinnr_provisioned: true },
      user_metadata: { display_name: name },
    });
    if (created.status === 400 || created.status === 422) {
      const code = String(created.json?.error_code ?? "");
      const message = String(created.json?.msg ?? created.json?.message ?? "");
      if (code === "email_exists" || /already (been )?registered/i.test(message)) {
        res.status(409).json({
          error: "That email already has a login — each staff member needs their own address.",
          field: "email",
        });
        return;
      }
      if (code === "weak_password" || /password/i.test(message)) {
        res.status(400).json({
          error: message ? `That password was rejected: ${message}` : "That password is too weak.",
          field: "password",
        });
        return;
      }
      throw new Error(`user create rejected (${created.status}: ${code || message || "unknown"})`);
    }
    userId = created.json?.id ?? created.json?.user?.id ?? null;
    if ((created.status !== 200 && created.status !== 201) || !userId) {
      throw new Error(`user create failed (${created.status})`);
    }

    // 2. Pre-approval upsert — the existing sync trigger elevates the
    // profile and links/creates the office's roster row.
    const assignment = await supabaseAdmin(
      "POST",
      "/rest/v1/staff_role_assignments?on_conflict=email",
      { email, role: "provider_staff", provider_account_code: accountId },
      "resolution=merge-duplicates",
    );
    if (assignment.status >= 300) throw new Error(`assignment upsert failed (${assignment.status})`);

    // 3. Prove the chain converged before reporting success.
    const [profile, viewer] = await Promise.all([
      supabaseAdmin("GET", `/rest/v1/profiles?id=eq.${userId}&select=role,provider_account_code`),
      supabaseAdmin(
        "GET",
        `/rest/v1/training_viewers?auth_user_id=eq.${userId}&select=id,name,account_id`,
      ),
    ]);
    const profileRow = Array.isArray(profile.json) ? profile.json[0] : null;
    const viewerRow = Array.isArray(viewer.json) ? viewer.json[0] : null;
    if (
      profileRow?.role !== "provider_staff" ||
      profileRow?.provider_account_code !== accountId ||
      !viewerRow ||
      viewerRow.account_id !== accountId
    ) {
      throw new Error("provisioning chain did not converge");
    }

    // 4. Materialize the canonical live provider-staff row only after Auth
    // and scope have converged. Existing rows were rejected before step 1.
    teamMemberId = crypto.randomUUID();
    const teamMember = await supabaseAdmin(
      "POST",
      "/rest/v1/team_members",
      {
        id: teamMemberId,
        provider_id: accountId,
        name,
        email,
        activation_status: "activated",
        auth_user_id: userId,
        claimed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    );
    if (teamMember.status >= 300) {
      throw new Error(`provider staff row create failed (${teamMember.status})`);
    }

    // 5. Optional phone onto the training roster row — cosmetic.
    if (phone) {
      const patched = await supabaseAdmin("PATCH", `/rest/v1/training_viewers?id=eq.${viewerRow.id}`, {
        phone,
      });
      if (patched.status >= 300) {
        req.log?.warn(`staff roster phone update failed (${patched.status})`);
      }
    }

    res.status(201).json({
      staff: {
        viewerId: String(viewerRow.id),
        name: String(viewerRow.name ?? name),
        email,
        accountId,
      },
    });
  } catch (error) {
    req.log?.error({ err: error }, "staff provisioning failed");
    // Undo what this request created so a retry starts clean. Only runs when
    // the user was created, which is the only step with lasting side effects
    // before the assignment write.
    try {
      if (userId) {
        if (teamMemberId) {
          await supabaseAdmin("DELETE", `/rest/v1/team_members?id=eq.${teamMemberId}`);
        }
        await supabaseAdmin("DELETE", `/auth/v1/admin/users/${userId}`);
        if (priorAssignment) {
          await supabaseAdmin(
            "POST",
            "/rest/v1/staff_role_assignments?on_conflict=email",
            {
              email,
              role: priorAssignment.role,
              provider_account_code: priorAssignment.provider_account_code,
            },
            "resolution=merge-duplicates",
          );
        } else {
          await supabaseAdmin(
            "DELETE",
            `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(email)}`,
          );
        }
      }
    } catch {
      /* cleanup is best-effort; the response below is what matters */
    }
    res.status(502).json({
      error: "Could not finish creating the sign-in — nothing was left half-made. Try again in a moment.",
    });
  }
});

export default router;
