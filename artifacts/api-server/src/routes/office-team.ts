/**
 * Office staff management — /api/office/team
 *
 * Self-service teammate administration for a provider office. Every route
 * resolves the caller's office through resolveOfficeScope (staff always get
 * their own office; HQ names one with `?office=` and needs provider_manage),
 * then applies the office-level authority rules:
 *
 *   * Owners and admins run the team. Plain staff get a 403 — the Team page
 *     shows a permission state instead of the roster.
 *   * Only an owner (the provider account holder, HQ, or a team owner) may
 *     grant or take away the owner role, or change an owner's status.
 *   * Nobody edits themselves: no self-demotion, self-deactivation, or
 *     self sign-out through this surface.
 *   * The last remaining active owner can never be demoted or deactivated —
 *     the database function re-checks this under a row lock, so the guard
 *     holds even for concurrent requests.
 *
 * Deactivation removes the staff pre-approval row (the trigger demotes the
 * profile — the dashboard signs the browser out on its next role check) and
 * globally invalidates the login's sessions, so API and dashboard access end
 * immediately. Reactivation restores the pre-approval; the login, team row,
 * and history are all kept, so there is nothing to re-provision.
 *
 * Every mutation writes an audit event (role/status facts only — never names
 * or email addresses in metadata; the target id resolves to a name at read
 * time).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  canManageOffice,
  isOfficeRole,
  resolveOfficeScope,
  respondOfficeScopeDenied,
  type OfficeRole,
  type OfficeScope,
} from "../auth/office-scope";
import { requireFreshCode } from "../auth/fresh-code";
import { recordAccessDenied, recordAdminAuditEvent, requestIdOf } from "../lib/admin-audit";
import { supabaseAdmin } from "../lib/supabase-admin";
import { adminLogoutAll, markRevoked, securityOverview, type RevokeReason } from "../security/ledger";
import { clearStaffSecondFactor, loadStaffSecondFactor, loadStaffSecondFactors, maskPhone } from "../auth/second-factor";
import {
  OFFICE_ROLES,
  PROVISIONING_FAILED_MESSAGE,
  StaffNameSchema,
  provisionStaffLogin,
} from "../office/staff-provisioning";

const router: IRouter = Router();
const enc = encodeURIComponent;

export const OFFICE_TEAM_PATH = "/office/team";
export const TEAM_MANAGERS_ONLY_MESSAGE = "Only office owners and admins can manage the team.";
export const OWNERS_ONLY_MESSAGE = "Only an office owner can change who owns the office.";
export const SELF_EDIT_MESSAGE = "You can't change your own access. Ask another owner or admin.";

export type TeamMemberStatus = "invited" | "active" | "disabled";

export interface OfficeTeamMemberDto {
  id: string;
  name: string;
  email: string;
  role: OfficeRole;
  status: TeamMemberStatus;
  invitedAt: string | null;
  claimedAt: string | null;
  /** True for the caller's own row. */
  isSelf: boolean;
  /** Masked verified sign-in phone (texted-code step); null when none is enrolled. */
  secondFactorPhone: string | null;
}

interface TeamMemberRow {
  id: string;
  provider_id: string | null;
  name: string | null;
  email: string | null;
  activation_status: string | null;
  office_role: string | null;
  auth_user_id: string | null;
  created_at: string | null;
  claimed_at: string | null;
}

const MEMBER_SELECT = "id,provider_id,name,email,activation_status,office_role,auth_user_id,created_at,claimed_at";

export function memberStatus(row: Pick<TeamMemberRow, "activation_status" | "auth_user_id">): TeamMemberStatus {
  if (row.activation_status === "disabled") return "disabled";
  if (!row.auth_user_id) return "invited";
  return "active";
}

function memberDto(row: TeamMemberRow, scope: OfficeScope, factorPhone: string | null = null): OfficeTeamMemberDto {
  return {
    id: String(row.id),
    name: String(row.name ?? "").trim() || "Unnamed teammate",
    email: String(row.email ?? ""),
    role: isOfficeRole(row.office_role) ? row.office_role : "staff",
    status: memberStatus(row),
    invitedAt: row.created_at ?? null,
    claimedAt: row.claimed_at ?? null,
    isSelf: scope.teamMemberId === String(row.id),
    secondFactorPhone: factorPhone,
  };
}

async function memberDtoWithFactor(row: TeamMemberRow, scope: OfficeScope): Promise<OfficeTeamMemberDto> {
  const factor = await loadStaffSecondFactor("team_member", String(row.id));
  return memberDto(row, scope, factor ? maskPhone(factor.phone) : null);
}

async function scoped(req: Request): Promise<Awaited<ReturnType<typeof resolveOfficeScope>>> {
  const bodyOffice =
    req.body && typeof req.body === "object" && typeof (req.body as { office?: unknown }).office === "string"
      ? String((req.body as { office: string }).office)
      : null;
  return resolveOfficeScope({
    authorization: req.headers.authorization,
    request: req,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : bodyOffice,
    hqPermission: "provider_manage",
    requireUnlocked: true,
  });
}

/** Resolve the office and require owner/admin authority; answers the refusal itself. */
async function manager(req: Request, res: Response): Promise<OfficeScope | null> {
  const resolved = await scoped(req);
  if (resolved.kind !== "ok") {
    respondOfficeScopeDenied(req, res, resolved);
    return null;
  }
  if (!canManageOffice(resolved.scope)) {
    res.status(403).json({ error: TEAM_MANAGERS_ONLY_MESSAGE });
    recordAccessDenied(req, {
      actorUserId: resolved.scope.actorUserId,
      actorKind: resolved.scope.actorKind,
      providerId: resolved.scope.providerId,
      reason: "permission",
      status: 403,
    });
    return null;
  }
  return resolved.scope;
}

async function loadMember(scope: OfficeScope, memberId: string): Promise<TeamMemberRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(memberId)) return null;
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/team_members?id=eq.${enc(memberId)}&provider_id=eq.${enc(scope.providerId)}&select=${MEMBER_SELECT}&limit=1`,
  );
  if (result.status >= 300) throw new Error(`team member lookup failed (${result.status})`);
  const rows = (Array.isArray(result.json) ? result.json : []) as TeamMemberRow[];
  return rows[0] ?? null;
}

function rpcMessage(json: unknown, fallback: string): string {
  const message =
    json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
      ? (json as { message: string }).message
      : "";
  return message || fallback;
}

/** Owner-guard raises are business refusals (409), everything else is a 502. */
function respondRpcFailure(res: Response, json: unknown, fallback: string): void {
  const message = rpcMessage(json, "");
  if (/last remaining owner/i.test(message)) {
    res.status(409).json({ error: message });
    return;
  }
  if (/not found/i.test(message)) {
    res.status(404).json({ error: "That teammate isn't on this office's team." });
    return;
  }
  res.status(502).json({ error: fallback });
}

function audit(req: Request, scope: OfficeScope, action: string, targetId: string, metadata: Record<string, string | number | boolean | null>): void {
  void recordAdminAuditEvent({
    action,
    actorUserId: scope.actorUserId,
    actorKind: scope.actorKind,
    providerId: scope.providerId,
    targetKind: "team_member",
    targetId,
    requestId: requestIdOf(req),
    metadata,
  }).catch((error) => req.log?.error({ err: error }, "office team audit failed"));
}

async function globalLogout(req: Request, authUserId: string | null, reason: "deactivated" | "office_forced"): Promise<"not_applicable" | "complete" | "failed"> {
  if (!authUserId) return "not_applicable";
  if (!(await adminLogoutAll(authUserId, reason))) {
    req.log?.error({ userId: authUserId }, "office teammate session logout failed");
    return "failed";
  }
  return "complete";
}

/** Guards shared by role and status changes on an existing teammate. */
function refuseTargetEdit(res: Response, scope: OfficeScope, target: TeamMemberRow, touchesOwner: boolean): boolean {
  if (scope.teamMemberId && scope.teamMemberId === String(target.id)) {
    res.status(403).json({ error: SELF_EDIT_MESSAGE });
    return true;
  }
  if (touchesOwner && scope.officeRole !== "owner") {
    res.status(403).json({ error: OWNERS_ONLY_MESSAGE });
    return true;
  }
  return false;
}

// ── List ─────────────────────────────────────────────────────────────────────

router.get(OFFICE_TEAM_PATH, async (req, res) => {
  try {
    const scope = await manager(req, res);
    if (!scope) return;
    const [members, provider] = await Promise.all([
      supabaseAdmin(
        "GET",
        `/rest/v1/team_members?provider_id=eq.${enc(scope.providerId)}&select=${MEMBER_SELECT}&order=created_at.asc&limit=500`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/providers?provider_id=eq.${enc(scope.providerId)}&select=provider_name,email,auth_user_id&limit=1`,
      ),
    ]);
    if (members.status >= 300 || provider.status >= 300) throw new Error("team list failed");
    const rows = (Array.isArray(members.json) ? members.json : []) as TeamMemberRow[];
    const providerRow = (Array.isArray(provider.json) ? provider.json[0] : null) as
      | { provider_name?: string | null; email?: string | null; auth_user_id?: string | null }
      | null;
    const [factors, ownerFactor] = await Promise.all([
      loadStaffSecondFactors("team_member", rows.map((row) => String(row.id))),
      loadStaffSecondFactor("provider", scope.providerId),
    ]);
    res.json({
      office: { id: scope.providerId, name: scope.officeName },
      me: { role: scope.officeRole, kind: scope.actorKind, teamMemberId: scope.teamMemberId },
      accountOwner: {
        name: String(providerRow?.provider_name ?? scope.providerName),
        email: String(providerRow?.email ?? ""),
        status: providerRow?.auth_user_id ? "active" : "invited",
        secondFactorPhone: ownerFactor ? maskPhone(ownerFactor.phone) : null,
      },
      members: rows.map((row) => {
        const factor = factors.get(String(row.id));
        return memberDto(row, scope, factor ? maskPhone(factor.phone) : null);
      }),
    });
  } catch (error) {
    req.log?.error({ err: error }, "office team list failed");
    res.status(502).json({ error: "Could not load the team right now." });
  }
});

// ── Invite ───────────────────────────────────────────────────────────────────

const InviteSchema = z.object({
  ...StaffNameSchema,
  role: z.enum(OFFICE_ROLES as [string, ...string[]]).default("staff"),
});

router.post(`${OFFICE_TEAM_PATH}/invitations`, async (req, res) => {
  try {
    const scope = await manager(req, res);
    if (!scope) return;
    const parsed = InviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = typeof issue?.path?.[0] === "string" ? issue.path[0] : undefined;
      res.status(400).json({ error: issue?.message ?? "Check the form and try again.", field });
      return;
    }
    const role = parsed.data.role as OfficeRole;
    if (role === "owner" && scope.officeRole !== "owner") {
      res.status(403).json({ error: OWNERS_ONLY_MESSAGE });
      return;
    }
    let result;
    try {
      result = await provisionStaffLogin({
        accountId: scope.providerId,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        email: parsed.data.email,
        officeRole: role,
        log: req.log,
      });
    } catch (error) {
      req.log?.error({ err: error }, "office invite provisioning failed");
      res.status(502).json({ error: PROVISIONING_FAILED_MESSAGE });
      return;
    }
    if (result.kind === "rejected") {
      res.status(result.status).json({ error: result.message, field: result.field });
      return;
    }
    audit(req, scope, "office_team_invited", result.staff.id, { role });
    res.status(201).json({
      member: {
        id: result.staff.id,
        name: result.staff.name,
        email: result.staff.email,
        role,
        status: "invited",
        invitedAt: new Date().toISOString(),
        claimedAt: null,
        isSelf: false,
        secondFactorPhone: null,
      } satisfies OfficeTeamMemberDto,
    });
  } catch (error) {
    req.log?.error({ err: error }, "office invite failed");
    res.status(502).json({ error: PROVISIONING_FAILED_MESSAGE });
  }
});

// ── Role ─────────────────────────────────────────────────────────────────────

const RoleSchema = z.object({ role: z.enum(OFFICE_ROLES as [string, ...string[]]) });

router.patch(`${OFFICE_TEAM_PATH}/:memberId`, async (req, res) => {
  try {
    const scope = await manager(req, res);
    if (!scope) return;
    const parsed = RoleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Choose owner, admin, or staff.", field: "role" });
      return;
    }
    const target = await loadMember(scope, String(req.params.memberId));
    if (!target) {
      res.status(404).json({ error: "That teammate isn't on this office's team." });
      return;
    }
    const nextRole = parsed.data.role as OfficeRole;
    const currentRole = isOfficeRole(target.office_role) ? target.office_role : "staff";
    if (refuseTargetEdit(res, scope, target, nextRole === "owner" || currentRole === "owner")) return;
    if (nextRole === currentRole) {
      res.json({ member: memberDto(target, scope) });
      return;
    }
    if (!(await requireFreshCode(req, res, scope.actorUserId))) return;
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/office_set_team_member_role", {
      p_member_id: target.id,
      p_role: nextRole,
    });
    if (result.status >= 300) {
      respondRpcFailure(res, result.json, "Could not change that role right now.");
      return;
    }
    const updated = { ...target, ...(result.json as Partial<TeamMemberRow>) } as TeamMemberRow;
    audit(req, scope, "office_team_role_changed", target.id, { from: currentRole, to: nextRole });
    res.json({ member: memberDto(updated, scope) });
  } catch (error) {
    req.log?.error({ err: error }, "office role change failed");
    res.status(502).json({ error: "Could not change that role right now." });
  }
});

// ── Status ───────────────────────────────────────────────────────────────────

async function setStatus(req: Request, res: Response, active: boolean): Promise<void> {
  try {
    const scope = await manager(req, res);
    if (!scope) return;
    const target = await loadMember(scope, String(req.params.memberId));
    if (!target) {
      res.status(404).json({ error: "That teammate isn't on this office's team." });
      return;
    }
    if (refuseTargetEdit(res, scope, target, target.office_role === "owner")) return;
    const already = active ? target.activation_status !== "disabled" : target.activation_status === "disabled";
    if (already) {
      res.json({ member: memberDto(target, scope), sessionInvalidation: "not_applicable" });
      return;
    }
    // Deactivation (offboarding) needs a fresh code; reactivation does not.
    if (!active && !(await requireFreshCode(req, res, scope.actorUserId))) return;
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/office_set_team_member_status", {
      p_member_id: target.id,
      p_active: active,
    });
    if (result.status >= 300) {
      respondRpcFailure(res, result.json, active ? "Could not reactivate that teammate right now." : "Could not deactivate that teammate right now.");
      return;
    }
    const updated = { ...target, ...(result.json as Partial<TeamMemberRow>) } as TeamMemberRow;
    audit(req, scope, active ? "office_team_reactivated" : "office_team_deactivated", target.id, {
      role: isOfficeRole(target.office_role) ? target.office_role : "staff",
      status: memberStatus(updated),
    });
    // Deactivation ends every live session too. The pre-approval removal is
    // already committed and every guard rechecks membership, so a GoTrue
    // logout outage cannot keep API access alive — it only delays the
    // browser's own sign-out until its next role refresh.
    const sessionInvalidation = active ? "not_applicable" : await globalLogout(req, target.auth_user_id, "deactivated");
    res.json({ member: memberDto(updated, scope), sessionInvalidation });
  } catch (error) {
    req.log?.error({ err: error }, "office status change failed");
    res.status(502).json({ error: "Could not update that teammate right now." });
  }
}

router.post(`${OFFICE_TEAM_PATH}/:memberId/deactivate`, (req, res) => setStatus(req, res, false));
router.post(`${OFFICE_TEAM_PATH}/:memberId/reactivate`, (req, res) => setStatus(req, res, true));

// ── Sessions ─────────────────────────────────────────────────────────────────

/**
 * A teammate's recent sign-ins and live sessions — the same view the
 * teammate sees on their own Security page, minus the "current" marker.
 * Same authority as force sign-out (owners/admins, owner-only for owners).
 */
router.get(`${OFFICE_TEAM_PATH}/:memberId/sessions`, async (req, res) => {
  try {
    const scope = await manager(req, res);
    if (!scope) return;
    const target = await loadMember(scope, String(req.params.memberId));
    if (!target) {
      res.status(404).json({ error: "That teammate isn't on this office's team." });
      return;
    }
    if (target.office_role === "owner" && scope.officeRole !== "owner") {
      res.status(403).json({ error: OWNERS_ONLY_MESSAGE });
      return;
    }
    const overview = target.auth_user_id ? await securityOverview(target.auth_user_id, null) : { signIns: [], sessions: [] };
    audit(req, scope, "office_team_sessions_viewed", target.id, { sessions: overview.sessions.length });
    res.json({ member: await memberDtoWithFactor(target, scope), linked: Boolean(target.auth_user_id), sessions: overview.sessions, signIns: overview.signIns });
  } catch (error) {
    req.log?.error({ err: error }, "office team sessions read failed");
    res.status(502).json({ error: "Could not load that teammate's sessions right now." });
  }
});

// ── Force sign-out ───────────────────────────────────────────────────────────

export const FORCE_SIGN_OUT_REASONS = ["lost_device", "suspicious_activity", "staff_request", "other"] as const;
const SignOutBody = z.object({ reason: z.enum(FORCE_SIGN_OUT_REASONS).optional() });

router.post(`${OFFICE_TEAM_PATH}/:memberId/sign-out`, async (req, res) => {
  try {
    const scope = await manager(req, res);
    if (!scope) return;
    const parsed = SignOutBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Choose a reason for signing this teammate out.", field: "reason" });
      return;
    }
    const target = await loadMember(scope, String(req.params.memberId));
    if (!target) {
      res.status(404).json({ error: "That teammate isn't on this office's team." });
      return;
    }
    if (refuseTargetEdit(res, scope, target, target.office_role === "owner")) return;
    if (!(await requireFreshCode(req, res, scope.actorUserId))) return;
    const sessionInvalidation = await globalLogout(req, target.auth_user_id, "office_forced");
    if (sessionInvalidation === "failed") {
      res.status(502).json({ error: "Could not sign that teammate out right now." });
      return;
    }
    const reason = parsed.data.reason ?? "other";
    if (target.auth_user_id) {
      await markRevoked({ userId: target.auth_user_id, reason: (reason === "staff_request" ? "staff_forced" : reason) as RevokeReason }).catch((error) =>
        req.log?.error({ err: error }, "office sign-out ledger mark failed"),
      );
    }
    audit(req, scope, "office_team_signed_out", target.id, { status: memberStatus(target), reason });
    res.json({ member: memberDto(target, scope), sessionInvalidation });
  } catch (error) {
    req.log?.error({ err: error }, "office sign-out failed");
    res.status(502).json({ error: "Could not sign that teammate out right now." });
  }
});

// ── Sign-in phone (texted-code step) ─────────────────────────────────────────

/**
 * The office account holder's own sign-in phone. Nobody inside the office
 * outranks the account holder, so only HQ (drilled into the office) can
 * clear it. Registered before the :memberId route so the literal segment
 * wins.
 */
router.post(`${OFFICE_TEAM_PATH}/account-owner/second-factor/clear`, async (req, res) => {
  try {
    const scope = await manager(req, res);
    if (!scope) return;
    if (scope.actorKind !== "hq") {
      res.status(403).json({ error: "Only THINNR HQ can clear the account holder's sign-in phone." });
      return;
    }
    if (!(await requireFreshCode(req, res, scope.actorUserId))) return;
    const cleared = await clearStaffSecondFactor("provider", scope.providerId);
    audit(req, scope, "office_team_phone_cleared", scope.providerId, { status: cleared ? "cleared" : "none_on_file", kind: "account_owner" });
    res.json({ ok: true, cleared });
  } catch (error) {
    req.log?.error({ err: error }, "office account owner phone clear failed");
    res.status(502).json({ error: "Could not clear that sign-in phone right now." });
  }
});

/**
 * Lost phone: drop a teammate's verified sign-in phone so their next sign-in
 * re-enrols one. Same authority as force sign-out (owners/admins; owners
 * only for an owner; never yourself) — the UI offers both actions together.
 */
router.post(`${OFFICE_TEAM_PATH}/:memberId/second-factor/clear`, async (req, res) => {
  try {
    const scope = await manager(req, res);
    if (!scope) return;
    const target = await loadMember(scope, String(req.params.memberId));
    if (!target) {
      res.status(404).json({ error: "That teammate isn't on this office's team." });
      return;
    }
    if (refuseTargetEdit(res, scope, target, target.office_role === "owner")) return;
    if (!(await requireFreshCode(req, res, scope.actorUserId))) return;
    const cleared = await clearStaffSecondFactor("team_member", String(target.id));
    audit(req, scope, "office_team_phone_cleared", target.id, { status: cleared ? "cleared" : "none_on_file" });
    res.json({ member: memberDto(target, scope, null), cleared });
  } catch (error) {
    req.log?.error({ err: error }, "office phone clear failed");
    res.status(502).json({ error: "Could not clear that teammate's sign-in phone right now." });
  }
});

export default router;
