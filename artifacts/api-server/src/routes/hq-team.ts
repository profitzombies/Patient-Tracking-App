/**
 * Live THINNR HQ team administration.
 *
 * All writes go through security-definer database functions.  The API does
 * friendly duplicate/safeguard checks, but the functions remain the
 * concurrency-safe authority. Invitation email is deliberately post-commit.
 */
import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireFreshCode } from "../auth/fresh-code";
import { requireHqPermission, requireStaff, type StaffIdentity } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { DeliveryNotConfiguredError, sendHqTeamInvitation } from "../claim/delivery";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { adminLogoutAll, markRevoked, securityOverview, type RevokeReason } from "../security/ledger";
import { clearStaffSecondFactor, loadStaffSecondFactors, maskPhone } from "../auth/second-factor";

const router: IRouter = Router();
const ROLES = ["super_admin", "admin", "clinical", "support", "content"] as const;
type HqRole = (typeof ROLES)[number];
const RoleSchema = z.preprocess(
  (value) => String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_"),
  z.enum(ROLES),
);

const InviteBody = z.object({
  name: z.string().trim().min(1, "Name is required.").max(160),
  email: z.string().trim().email("Enter a valid email address.").max(320),
  title: z.string().trim().max(160).optional().default(""),
  role: RoleSchema,
});
const UpdateBody = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  title: z.string().trim().max(160).optional(),
  role: RoleSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "Include a field to update.");
interface HqMember {
  id: string;
  authUserId: string | null;
  name: string;
  email: string;
  title: string;
  role: HqRole;
  status: string;
  invitedAt: string | null;
  joinedAt: string | null;
  /** Masked verified sign-in phone (texted-code step); null when none is enrolled. */
  secondFactorPhone: string | null;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

/**
 * 32 random bytes encoded URL-safe; only its SHA-256 digest reaches the DB.
 * The invitation RPC requires a token pair, but with passwordless login the
 * plain token never leaves this process — invited members simply sign in
 * with their email and the pending invitation is accepted at that moment.
 */
export function createSetupToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: crypto.createHash("sha256").update(token).digest("hex") };
}

function parseRole(value: unknown): HqRole | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (normalized === "owner") return "super_admin";
  return (ROLES as readonly string[]).includes(normalized) ? normalized as HqRole : null;
}

function mapMember(row: Record<string, unknown>): HqMember {
  const role = parseRole(row.role);
  if (!role) throw new Error(`HQ member ${String(row.id ?? "")} has an invalid role`);
  return {
    id: String(row.id),
    authUserId: row.auth_user_id ? String(row.auth_user_id) : null,
    name: String(row.name ?? row.display_name ?? ""),
    email: String(row.email ?? ""),
    title: String(row.title ?? ""),
    role,
    status: String(row.status ?? (row.auth_user_id ? "active" : "invited")),
    invitedAt: row.invited_at ? String(row.invited_at) : null,
    joinedAt: row.joined_at ? String(row.joined_at) : null,
    secondFactorPhone: null,
  };
}

async function loadMembers(): Promise<HqMember[]> {
  const result = await supabaseAdmin(
    "GET",
    "/rest/v1/hq_team_members?select=*&status=neq.revoked&order=created_at.asc&limit=1000",
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`HQ team list failed (${result.status})`);
  }
  const members = result.json.map((row: Record<string, unknown>) => mapMember(row));
  const factors = await loadStaffSecondFactors("hq", members.map((member: HqMember) => member.id));
  for (const member of members) {
    const factor = factors.get(member.id);
    member.secondFactorPhone = factor ? maskPhone(factor.phone) : null;
  }
  return members;
}

async function requireTeamManager(req: Request, res: Response, next: NextFunction): Promise<void> {
  const staff = res.locals.staff as StaffIdentity | undefined;
  if (!staff || staff.role !== "hq_admin") {
    res.status(403).json({ error: "Only HQ team administrators can do this." });
    return;
  }
  try {
    // This is intentionally uncached: demotion/revocation takes effect on the
    // very next request, even if the access token itself remains unexpired.
    const result = await supabaseAdmin(
      "GET",
      `/rest/v1/hq_team_members?auth_user_id=eq.${encode(staff.userId)}&status=eq.active&select=id,role&limit=1`,
    );
    if (result.status >= 300) throw new Error(`HQ permission lookup failed (${result.status})`);
    const row = Array.isArray(result.json) ? result.json[0] : null;
    const role = parseRole(row?.role);
    if (!row || (role !== "super_admin" && role !== "admin")) {
      res.status(403).json({ error: "Your HQ role cannot manage team members." });
      return;
    }
    res.locals.hqMember = { id: String(row.id), role };
    next();
  } catch (error) {
    req.log?.error({ err: error }, "HQ permission check failed");
    res.status(503).json({ error: "Could not verify your HQ permissions right now." });
  }
}

export function safeguardMutation(
  actor: { id: string; role: HqRole },
  target: HqMember,
  members: HqMember[],
  action: "update" | "revoke",
  nextRole?: HqRole,
): string | null {
  if (target.id === actor.id && action === "revoke") return "You cannot revoke your own account.";
  if (target.role === "super_admin" && actor.role !== "super_admin") {
    return "Only a Super Admin can change a Super Admin.";
  }
  if (target.role === "super_admin" && (action === "revoke" || nextRole && nextRole !== "super_admin")) {
    const active = members.filter((member) => member.status === "active" && member.role === "super_admin");
    if (active.length <= 1) return "The sole Super Admin cannot be removed or demoted.";
  }
  const targetIsManager = target.role === "super_admin" || target.role === "admin";
  const nextIsManager = nextRole === "super_admin" || nextRole === "admin";
  if (targetIsManager && (action === "revoke" || nextRole && !nextIsManager)) {
    const active = members.filter((member) =>
      member.status === "active" && (member.role === "super_admin" || member.role === "admin"));
    if (active.length <= 1) return "At least one active team administrator is required.";
  }
  if (target.id === actor.id && nextRole && nextRole !== "super_admin" && nextRole !== "admin") {
    return "You cannot remove your own team-management access.";
  }
  return null;
}

async function duplicateSource(email: string): Promise<string | null> {
  const queries: Array<[string, string]> = [
    ["provider", `/rest/v1/providers?email=ilike.${encode(email)}&select=provider_id&limit=1`],
    ["patient", `/rest/v1/patients?email=ilike.${encode(email)}&select=id&limit=1`],
    ["provider team", `/rest/v1/team_members?email=ilike.${encode(email)}&select=id&limit=1`],
    ["profile", `/rest/v1/profiles?email=ilike.${encode(email)}&select=id&limit=1`],
    ["staff assignment", `/rest/v1/staff_role_assignments?email=ilike.${encode(email)}&select=email&limit=1`],
    ["HQ team", `/rest/v1/hq_team_members?email=ilike.${encode(email)}&select=id&limit=1`],
  ];
  const results = await Promise.all(queries.map(([, path]) => supabaseAdmin("GET", path)));
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status >= 300 || !Array.isArray(result.json)) {
      throw new Error(`duplicate lookup failed for ${queries[index][0]} (${result.status})`);
    }
    if (result.json.length > 0) return queries[index][0];
  }
  // GoTrue has no exact-email admin endpoint. Page through it rather than
  // checking only the first page (which would become a security hole at scale).
  for (let page = 1; page <= 100; page += 1) {
    const result = await supabaseAdmin("GET", `/auth/v1/admin/users?page=${page}&per_page=1000`);
    if (result.status >= 300 || !Array.isArray(result.json?.users)) {
      throw new Error(`Auth duplicate lookup failed (${result.status})`);
    }
    if (result.json.users.some((user: { email?: unknown }) =>
      String(user.email ?? "").trim().toLowerCase() === email)) return "login";
    if (result.json.users.length < 1000) return null;
  }
  throw new Error("Auth duplicate lookup exceeded the supported directory size");
}

function rpcError(json: unknown, fallback: string): string {
  const message = json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
    ? (json as { message: string }).message
    : "";
  return message || fallback;
}

router.get("/hq-session", requireStaff(["hq_admin"]), async (req, res): Promise<void> => {
  const staff = res.locals.staff as StaffIdentity;
  res.set("Cache-Control", "private, no-store");
  try {
    const result = await supabaseAdmin(
      "GET",
      `/rest/v1/hq_memberships?auth_user_id=eq.${encode(staff.userId)}&status=eq.active&select=display_name,job_title&limit=1`,
    );
    if (result.status >= 300) throw new Error(`HQ session lookup failed (${result.status})`);
    const row = Array.isArray(result.json) ? result.json[0] : null;
    res.json({
      departmentRole: staff.departmentRole,
      displayName: row?.display_name ? String(row.display_name) : null,
      jobTitle: row?.job_title ? String(row.job_title) : null,
    });
  } catch (error) {
    req.log?.error({ err: error }, "HQ session lookup failed");
    res.status(503).json({ error: "Could not verify your HQ session right now." });
  }
});

router.get("/hq-team", requireHqPermission("team_manage"), async (req, res): Promise<void> => {
  try {
    res.json({ members: await loadMembers() });
  } catch (error) {
    req.log?.error({ err: error }, "HQ team list failed");
    res.status(502).json({ error: "Could not load the HQ team right now." });
  }
});

router.post(
  ["/hq-team", "/hq-team/invitations"],
  requireHqPermission("team_manage"),
  requireTeamManager,
  async (req, res): Promise<void> => {
    const parsed = InviteBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({ error: issue?.message ?? "Check the invitation.", field: issue?.path[0] });
      return;
    }
    const email = parsed.data.email.toLowerCase();
    try {
      const source = await duplicateSource(email);
      if (source) {
        res.status(409).json({
          error: `That email already belongs to a ${source} record. Use a unique work email.`,
          field: "email",
        });
        return;
      }
      const actor = res.locals.staff as StaffIdentity;
      const setup = createSetupToken();
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_invite_team_member_v2", {
        p_actor_id: actor.userId,
        p_name: parsed.data.name,
        p_email: email,
        p_title: parsed.data.title,
        p_role: parsed.data.role,
        p_setup_token_hash: setup.tokenHash,
      });
      if ([400, 409, 422].includes(result.status)) {
        res.status(409).json({ error: rpcError(result.json, "That person cannot be invited.") });
        return;
      }
      if (result.status >= 300 || !result.json) throw new Error(`HQ invitation commit failed (${result.status})`);
      const row = Array.isArray(result.json) ? result.json[0] : result.json;
      let invitation: "sent" | "not_configured" | "failed" = "sent";
      try {
        await sendHqTeamInvitation(email, { name: parsed.data.name, role: parsed.data.role });
      } catch (error) {
        invitation = error instanceof DeliveryNotConfiguredError ? "not_configured" : "failed";
        req.log?.error({ err: error }, "HQ team invitation delivery failed");
      }
      await recordAdminAuditEvent({ action: "hq_team_invited", actorUserId: actor.userId, actorKind: "hq", providerId: null, targetKind: "hq_member", targetId: String(row.id), requestId: req.headers["x-request-id"]?.toString() ?? null, metadata: { role: parsed.data.role } }).catch(error => req.log?.error({ err: error }, "HQ invitation audit failed"));
      res.status(201).json({ member: mapMember(row), invitation });
    } catch (error) {
      req.log?.error({ err: error }, "HQ team invitation failed");
      res.status(502).json({ error: "Could not finish the HQ invitation." });
    }
  },
);

router.patch(
  "/hq-team/:id",
  requireHqPermission("team_manage"),
  requireTeamManager,
  async (req, res): Promise<void> => {
    const parsed = UpdateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the update." });
      return;
    }
    try {
      const members = await loadMembers();
      const target = members.find((member) => member.id === String(req.params.id));
      if (!target) {
        res.status(404).json({ error: "HQ team member not found." });
        return;
      }
      const actor = res.locals.hqMember as { id: string; role: HqRole };
      const blocked = safeguardMutation(actor, target, members, "update", parsed.data.role);
      if (blocked) {
        res.status(409).json({ error: blocked });
        return;
      }
      // Role changes need a fresh code; a name/title-only edit does not.
      if (parsed.data.role !== undefined && parsed.data.role !== target.role) {
        if (!(await requireFreshCode(req, res, (res.locals.staff as StaffIdentity).userId))) return;
      }
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_update_team_member", {
        p_actor_id: (res.locals.staff as StaffIdentity).userId,
        p_member_id: target.id,
        p_name: parsed.data.name ?? null,
        p_title: parsed.data.title ?? null,
        p_role: parsed.data.role ?? null,
      });
      if ([400, 409, 422].includes(result.status)) {
        res.status(409).json({ error: rpcError(result.json, "That team member cannot be updated.") });
        return;
      }
      if (result.status >= 300 || !result.json) throw new Error(`HQ update failed (${result.status})`);
      await recordAdminAuditEvent({ action: "hq_team_updated", actorUserId: (res.locals.staff as StaffIdentity).userId, actorKind: "hq", providerId: null, targetKind: "hq_member", targetId: target.id, requestId: req.headers["x-request-id"]?.toString() ?? null, metadata: parsed.data.role ? { role: parsed.data.role } : {} }).catch(error => req.log?.error({ err: error }, "HQ update audit failed"));
      res.json({ member: mapMember(Array.isArray(result.json) ? result.json[0] : result.json) });
    } catch (error) {
      req.log?.error({ err: error }, "HQ team update failed");
      res.status(502).json({ error: "Could not update that HQ team member." });
    }
  },
);

router.delete(
  "/hq-team/:id",
  requireHqPermission("team_manage"),
  requireTeamManager,
  async (req, res): Promise<void> => {
    try {
      const members = await loadMembers();
      const target = members.find((member) => member.id === String(req.params.id));
      if (!target) {
        res.status(404).json({ error: "HQ team member not found." });
        return;
      }
      const actor = res.locals.hqMember as { id: string; role: HqRole };
      const blocked = safeguardMutation(actor, target, members, "revoke");
      if (blocked) {
        res.status(409).json({ error: blocked });
        return;
      }
      if (!(await requireFreshCode(req, res, (res.locals.staff as StaffIdentity).userId))) return;
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_revoke_team_member", {
        p_actor_id: (res.locals.staff as StaffIdentity).userId,
        p_member_id: target.id,
      });
      if ([400, 409, 422].includes(result.status)) {
        res.status(409).json({ error: rpcError(result.json, "That team member cannot be revoked.") });
        return;
      }
      if (result.status >= 300) throw new Error(`HQ revoke failed (${result.status})`);
      await recordAdminAuditEvent({ action: "hq_team_revoked", actorUserId: (res.locals.staff as StaffIdentity).userId, actorKind: "hq", providerId: null, targetKind: "hq_member", targetId: target.id, requestId: req.headers["x-request-id"]?.toString() ?? null }).catch(error => req.log?.error({ err: error }, "HQ revoke audit failed"));

      let sessionInvalidation: "not_applicable" | "complete" | "failed" =
        target.authUserId ? "complete" : "not_applicable";
      if (target.authUserId && !(await adminLogoutAll(target.authUserId, "hq_revoked"))) {
        sessionInvalidation = "failed";
        req.log?.error({ userId: target.authUserId }, "revoked HQ session logout failed");
      }
      // The role/profile revocation is already committed and every staff guard
      // rechecks it, so a GoTrue logout outage cannot restore API access.
      res.json({ revoked: true, sessionInvalidation });
    } catch (error) {
      req.log?.error({ err: error }, "HQ team revocation failed");
      res.status(502).json({ error: "Could not revoke that HQ team member." });
    }
  },
);

// ── Sessions ─────────────────────────────────────────────────────────────────

/**
 * An HQ member's recent sign-ins and live sessions, and a force sign-out
 * that keeps their access (unlike revoke). Super Admins are visible only to
 * Super Admins, matching the mutation safeguards.
 */
const HQ_SIGN_OUT_REASONS = ["lost_device", "suspicious_activity", "staff_request", "other"] as const;
const HqSignOutBody = z.object({ reason: z.enum(HQ_SIGN_OUT_REASONS).optional() });

router.get(
  "/hq-team/:id/sessions",
  requireHqPermission("team_manage"),
  requireTeamManager,
  async (req, res): Promise<void> => {
    try {
      const members = await loadMembers();
      const target = members.find((member) => member.id === String(req.params.id));
      if (!target) {
        res.status(404).json({ error: "HQ team member not found." });
        return;
      }
      const actor = res.locals.hqMember as { id: string; role: HqRole };
      if (target.role === "super_admin" && actor.role !== "super_admin") {
        res.status(403).json({ error: "Only a Super Admin can view a Super Admin's sessions." });
        return;
      }
      const overview = target.authUserId ? await securityOverview(target.authUserId, null) : { signIns: [], sessions: [] };
      await recordAdminAuditEvent({
        action: "hq_team_sessions_viewed",
        actorUserId: (res.locals.staff as StaffIdentity).userId,
        actorKind: "hq",
        providerId: null,
        targetKind: "hq_member",
        targetId: target.id,
        requestId: req.headers["x-request-id"]?.toString() ?? null,
        metadata: { sessions: overview.sessions.length },
      }).catch((error) => req.log?.error({ err: error }, "HQ sessions audit failed"));
      res.json({ linked: Boolean(target.authUserId), sessions: overview.sessions, signIns: overview.signIns });
    } catch (error) {
      req.log?.error({ err: error }, "HQ team sessions read failed");
      res.status(502).json({ error: "Could not load that member's sessions." });
    }
  },
);

router.post(
  "/hq-team/:id/sign-out",
  requireHqPermission("team_manage"),
  requireTeamManager,
  async (req, res): Promise<void> => {
    try {
      const parsed = HqSignOutBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "Choose a reason for signing this member out.", field: "reason" });
        return;
      }
      const members = await loadMembers();
      const target = members.find((member) => member.id === String(req.params.id));
      if (!target) {
        res.status(404).json({ error: "HQ team member not found." });
        return;
      }
      const actor = res.locals.hqMember as { id: string; role: HqRole };
      if (target.id === actor.id) {
        res.status(409).json({ error: "Use your own Security page to sign out your other devices." });
        return;
      }
      if (target.role === "super_admin" && actor.role !== "super_admin") {
        res.status(403).json({ error: "Only a Super Admin can sign out a Super Admin." });
        return;
      }
      if (!(await requireFreshCode(req, res, (res.locals.staff as StaffIdentity).userId))) return;
      let sessionInvalidation: "not_applicable" | "complete" | "failed" = "not_applicable";
      const reason = parsed.data.reason ?? "other";
      if (target.authUserId) {
        if (!(await adminLogoutAll(target.authUserId, "hq_forced"))) {
          req.log?.error({ userId: target.authUserId }, "HQ member session logout failed");
          res.status(502).json({ error: "Could not sign that member out right now." });
          return;
        }
        sessionInvalidation = "complete";
        await markRevoked({ userId: target.authUserId, reason: (reason === "staff_request" ? "hq_forced" : reason) as RevokeReason }).catch((error) =>
          req.log?.error({ err: error }, "HQ sign-out ledger mark failed"),
        );
      }
      await recordAdminAuditEvent({
        action: "hq_team_signed_out",
        actorUserId: (res.locals.staff as StaffIdentity).userId,
        actorKind: "hq",
        providerId: null,
        targetKind: "hq_member",
        targetId: target.id,
        requestId: req.headers["x-request-id"]?.toString() ?? null,
        metadata: { reason, sessions: sessionInvalidation },
      }).catch((error) => req.log?.error({ err: error }, "HQ sign-out audit failed"));
      res.json({ ok: true, sessionInvalidation });
    } catch (error) {
      req.log?.error({ err: error }, "HQ team sign-out failed");
      res.status(502).json({ error: "Could not sign that member out." });
    }
  },
);

/**
 * Lost phone: drop the member's verified sign-in phone so their next sign-in
 * re-enrols one. Their current sessions are untouched — the UI offers
 * "sign out everywhere" right beside this action.
 */
router.post(
  "/hq-team/:id/second-factor/clear",
  requireHqPermission("team_manage"),
  requireTeamManager,
  async (req, res): Promise<void> => {
    try {
      const members = await loadMembers();
      const target = members.find((member) => member.id === String(req.params.id));
      if (!target) {
        res.status(404).json({ error: "HQ team member not found." });
        return;
      }
      const actor = res.locals.hqMember as { id: string; role: HqRole };
      if (target.id === actor.id) {
        res.status(409).json({ error: "Use your own Security page to change your sign-in phone." });
        return;
      }
      if (target.role === "super_admin" && actor.role !== "super_admin") {
        res.status(403).json({ error: "Only a Super Admin can clear a Super Admin's sign-in phone." });
        return;
      }
      if (!(await requireFreshCode(req, res, (res.locals.staff as StaffIdentity).userId))) return;
      const cleared = await clearStaffSecondFactor("hq", target.id);
      await recordAdminAuditEvent({
        action: "hq_team_phone_cleared",
        actorUserId: (res.locals.staff as StaffIdentity).userId,
        actorKind: "hq",
        providerId: null,
        targetKind: "hq_member",
        targetId: target.id,
        requestId: req.headers["x-request-id"]?.toString() ?? null,
        metadata: { status: cleared ? "cleared" : "none_on_file" },
      }).catch((error) => req.log?.error({ err: error }, "HQ phone clear audit failed"));
      res.json({ ok: true, cleared });
    } catch (error) {
      req.log?.error({ err: error }, "HQ team phone clear failed");
      res.status(502).json({ error: "Could not clear that member's sign-in phone." });
    }
  },
);

export default router;