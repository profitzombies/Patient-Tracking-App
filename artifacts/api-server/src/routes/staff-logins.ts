/**
 * HQ-only staff provisioning — POST /api/staff-logins
 *
 * Creates an office sign-in from a provider account page. The caller (a
 * real signed-in HQ admin, verified exactly like the training-media routes)
 * sends first/last name, email, and the office's account code. There is no
 * password anywhere: the new staff member signs in with a one-time email
 * code, and their auth user is created and linked on that first login.
 *
 * What this endpoint does is deliberately small:
 *
 *   1. Refuse duplicates — the email must not already be a provider, team
 *      member, HQ member, or existing login. Existing imported rows are
 *      identities; never create or message a duplicate.
 *   2. Upsert the pre-approval row (email → provider_staff @ office). At
 *      first code login the signup trigger reads it, elevates the profile,
 *      and links/creates the office's training-roster row.
 *   3. Materialize the canonical team_members row (unlinked — auth_user_id
 *      lands at first login), then send a best-effort invitation email
 *      telling the person to sign in with their address.
 *
 * On any failure the handler deletes what this request created so a retry
 * starts clean — no silent half-provisioned logins.
 */
import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireHqPermission } from "../lib/staff-auth";
import { sendStaffLoginInvitation } from "../claim/delivery";

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

  let teamMemberId: string | null = null;
  let assignmentWritten = false;
  let priorAssignment: { role: string; provider_account_code: string | null } | null = null;

  try {
    // Existing imported provider/staff rows are identities, even when they
    // have never completed Auth linkage. Never create or message a duplicate.
    const [targetProvider, targetLocks, providerMatch, staffMatch, hqMatch, authUsers, office] =
      await Promise.all([
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
        supabaseAdmin(
          "GET",
          `/rest/v1/hq_memberships?email=ilike.${encodeURIComponent(email)}&select=id,status&limit=3`,
        ),
        supabaseAdmin("GET", "/auth/v1/admin/users?page=1&per_page=1000"),
        supabaseAdmin(
          "GET",
          `/rest/v1/providers?provider_id=eq.${encodeURIComponent(accountId)}&select=office_name,provider_name&limit=1`,
        ),
      ]);
    if (
      [targetProvider, targetLocks, providerMatch, staffMatch, hqMatch, authUsers, office].some(
        (result) => result.status >= 300,
      )
    ) {
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
        error: "That person already has a provider record with their own sign-in.",
        field: "email",
      });
      return;
    }
    if (Array.isArray(staffMatch.json) && staffMatch.json.length > 0) {
      res.status(409).json({
        error: "That staff member already exists — they sign in with their email address.",
        field: "email",
      });
      return;
    }
    const hqRows = Array.isArray(hqMatch.json) ? hqMatch.json : [];
    if (hqRows.some((m: { status?: string }) => m.status === "active" || m.status === "invited")) {
      res.status(409).json({
        error: "That email belongs to an HQ team member — staff sign-ins need their own address.",
        field: "email",
      });
      return;
    }
    // Staff sign in by email code, so the email must not already belong to
    // any login (demo signups included) — first login would collide there.
    const existingUsers = Array.isArray(authUsers.json?.users) ? authUsers.json.users : [];
    if (
      existingUsers.some(
        (user: { email?: string | null }) => String(user?.email ?? "").toLowerCase() === email,
      )
    ) {
      res.status(409).json({
        error: "That email already has a login — each staff member needs their own address.",
        field: "email",
      });
      return;
    }

    // Remember any pre-existing (dangling) pre-approval for this email so a
    // failed request can restore it exactly.
    const prior = await supabaseAdmin(
      "GET",
      `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(email)}&select=role,provider_account_code`,
    );
    if (prior.status >= 300) throw new Error(`assignment lookup failed (${prior.status})`);
    priorAssignment = Array.isArray(prior.json) && prior.json.length > 0 ? prior.json[0] : null;

    // 1. Pre-approval upsert — at first code login the signup trigger reads
    // this row, elevates the profile, and links the office roster row.
    const assignment = await supabaseAdmin(
      "POST",
      "/rest/v1/staff_role_assignments?on_conflict=email",
      { email, role: "provider_staff", provider_account_code: accountId },
      "resolution=merge-duplicates",
    );
    if (assignment.status >= 300) throw new Error(`assignment upsert failed (${assignment.status})`);
    assignmentWritten = true;

    // 2. The canonical live provider-staff row, unlinked until first login.
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
        created_at: new Date().toISOString(),
      },
    );
    if (teamMember.status >= 300) {
      throw new Error(`provider staff row create failed (${teamMember.status})`);
    }

    // 3. Best-effort invitation — the sign-in works whether or not this
    // email lands, so delivery failures only get logged.
    const officeRow = Array.isArray(office.json) ? office.json[0] : null;
    const officeName = String(
      officeRow?.office_name ?? officeRow?.provider_name ?? "your office",
    );
    void sendStaffLoginInvitation(email, { name, officeName }).catch((error) => {
      req.log?.warn({ err: error }, "staff invitation email failed");
    });

    res.status(201).json({
      staff: {
        id: teamMemberId,
        name,
        email,
        accountId,
        status: "invited",
      },
    });
  } catch (error) {
    req.log?.error({ err: error }, "staff provisioning failed");
    // Undo what this request created so a retry starts clean.
    try {
      if (teamMemberId) {
        await supabaseAdmin("DELETE", `/rest/v1/team_members?id=eq.${teamMemberId}`);
      }
      if (assignmentWritten) {
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
