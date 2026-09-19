/**
 * Shared office staff provisioning — the one place a new office sign-in is
 * made, used by HQ (POST /api/staff-logins from a provider account page)
 * and by office owners/admins (POST /api/office/team/invitations).
 *
 * There is no password anywhere: the new staff member signs in with a
 * one-time email code, and their auth user is created and linked on that
 * first login. What provisioning does is deliberately small:
 *
 *   1. Refuse duplicates — the email must not already be a provider, team
 *      member, HQ member, or existing login. Existing imported rows are
 *      identities; never create or message a duplicate.
 *   2. Upsert the pre-approval row (email → provider_staff @ office). At
 *      first code login the signup trigger reads it, elevates the profile,
 *      and links/creates the office's training-roster row.
 *   3. Materialize the canonical team_members row (unlinked — auth_user_id
 *      lands at first login) with its office role, then send a best-effort
 *      invitation email telling the person to sign in with their address.
 *
 * On any failure everything this call created is deleted so a retry starts
 * clean — no silent half-provisioned logins.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";
import { OFFICE_STATUS_COLUMNS, officeIsActive } from "../lib/office-status";
import { sendStaffLoginInvitation } from "../claim/delivery";
import type { OfficeRole } from "../auth/office-scope";

export const OFFICE_ROLES: readonly OfficeRole[] = ["owner", "admin", "staff"];

export const StaffNameSchema = {
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
};

export function providerAcceptsNewStaff(rows: unknown, locks: unknown = []): boolean {
  return (
    Array.isArray(rows) &&
    rows.length === 1 &&
    officeIsActive(rows[0]) &&
    Array.isArray(locks) &&
    locks.length === 0
  );
}

export interface ProvisionedStaffLogin {
  id: string;
  name: string;
  email: string;
  accountId: string;
  officeRole: OfficeRole;
  status: "invited";
}

export type ProvisionStaffResult =
  | { kind: "created"; staff: ProvisionedStaffLogin }
  | { kind: "rejected"; status: number; message: string; field?: "accountId" | "email" };

const enc = encodeURIComponent;

/**
 * Provision an office sign-in. Throws only on infrastructure failure (after
 * rolling back what it wrote); business refusals come back as `rejected`.
 */
export async function provisionStaffLogin(input: {
  accountId: string;
  firstName: string;
  lastName: string;
  email: string;
  officeRole: OfficeRole;
  log?: { warn: (obj: unknown, msg: string) => void };
}): Promise<ProvisionStaffResult> {
  const accountId = input.accountId;
  const name = `${input.firstName} ${input.lastName}`.replace(/\s+/g, " ").trim();
  const email = input.email.trim().toLowerCase();

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
          `/rest/v1/providers?provider_id=eq.${enc(accountId)}&select=provider_id,${OFFICE_STATUS_COLUMNS}&limit=2`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/provider_account_locks?or=(account_id.eq.${enc(accountId)},account_id.eq.${enc(`acct-${accountId}`)})&select=account_id&limit=1`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/providers?email=ilike.${enc(email)}&select=provider_id,auth_user_id&limit=1`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/team_members?email=ilike.${enc(email)}&select=id,auth_user_id&limit=1`,
        ),
        supabaseAdmin(
          "GET",
          `/rest/v1/hq_memberships?email=ilike.${enc(email)}&select=id,status&limit=3`,
        ),
        supabaseAdmin("GET", "/auth/v1/admin/users?page=1&per_page=1000"),
        supabaseAdmin(
          "GET",
          `/rest/v1/providers?provider_id=eq.${enc(accountId)}&select=office_name,provider_name&limit=1`,
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
      return {
        kind: "rejected",
        status: 409,
        message: "Choose an existing provider account with active access.",
        field: "accountId",
      };
    }
    if (Array.isArray(providerMatch.json) && providerMatch.json.length > 0) {
      return {
        kind: "rejected",
        status: 409,
        message: "That person already has a provider record with their own sign-in.",
        field: "email",
      };
    }
    if (Array.isArray(staffMatch.json) && staffMatch.json.length > 0) {
      return {
        kind: "rejected",
        status: 409,
        message: "That staff member already exists — they sign in with their email address.",
        field: "email",
      };
    }
    const hqRows = Array.isArray(hqMatch.json) ? hqMatch.json : [];
    if (hqRows.some((m: { status?: string }) => m.status === "active" || m.status === "invited")) {
      return {
        kind: "rejected",
        status: 409,
        message: "That email belongs to an HQ team member — staff sign-ins need their own address.",
        field: "email",
      };
    }
    // Staff sign in by email code, so the email must not already belong to
    // any login (demo signups included) — first login would collide there.
    const existingUsers = Array.isArray(authUsers.json?.users) ? authUsers.json.users : [];
    if (
      existingUsers.some(
        (user: { email?: string | null }) => String(user?.email ?? "").toLowerCase() === email,
      )
    ) {
      return {
        kind: "rejected",
        status: 409,
        message: "That email already has a login — each staff member needs their own address.",
        field: "email",
      };
    }

    // Remember any pre-existing (dangling) pre-approval for this email so a
    // failed request can restore it exactly.
    const prior = await supabaseAdmin(
      "GET",
      `/rest/v1/staff_role_assignments?email=eq.${enc(email)}&select=role,provider_account_code`,
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
    const teamMember = await supabaseAdmin("POST", "/rest/v1/team_members", {
      id: teamMemberId,
      provider_id: accountId,
      name,
      email,
      activation_status: "activated",
      office_role: input.officeRole,
      created_at: new Date().toISOString(),
    });
    if (teamMember.status >= 300) {
      throw new Error(`provider staff row create failed (${teamMember.status})`);
    }

    // 3. Best-effort invitation — the sign-in works whether or not this
    // email lands, so delivery failures only get logged.
    const officeRow = Array.isArray(office.json) ? office.json[0] : null;
    const officeName = String(officeRow?.office_name ?? officeRow?.provider_name ?? "your office");
    void sendStaffLoginInvitation(email, { name, officeName }).catch((error) => {
      input.log?.warn({ err: error }, "staff invitation email failed");
    });

    return {
      kind: "created",
      staff: { id: teamMemberId, name, email, accountId, officeRole: input.officeRole, status: "invited" },
    };
  } catch (error) {
    // Undo what this call created so a retry starts clean.
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
          await supabaseAdmin("DELETE", `/rest/v1/staff_role_assignments?email=eq.${enc(email)}`);
        }
      }
    } catch {
      /* cleanup is best-effort; the caller's response is what matters */
    }
    throw error;
  }
}

export const PROVISIONING_FAILED_MESSAGE =
  "Could not finish creating the sign-in — nothing was left half-made. Try again in a moment.";
