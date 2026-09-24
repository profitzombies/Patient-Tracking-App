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
import { appBaseUrl } from "../security/alerts";
import { createLimiter } from "../coach/limits";

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
  /** Expiry of this member's live setup invitation; null when none is open. */
  invitationExpiresAt: string | null;
  /** Masked verified sign-in phone (texted-code step); null when none is enrolled. */
  secondFactorPhone: string | null;
}

/**
 * How long a setup link lives. The invitation function refuses anything past
 * seven days, so the window stops just short of it: the few minutes of slack
 * absorb clock skew between this process and the database.
 */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;

/** Where the emailed "Set up your THINNR account" button lands. */
export function setupLinkFor(token: string): string | null {
  const base = appBaseUrl("staff");
  return base ? `${base}/hq-setup?token=${encodeURIComponent(token)}` : null;
}

/** Human expiry for the invitation email; the stored timestamp stays authoritative. */
export function expiryLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
}

const ROLE_LABELS: Record<HqRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  clinical: "Clinical",
  support: "Support",
  content: "Content",
};

/**
 * Deliver the branded invitation. Returns how it went so the caller can tell
 * the administrator the truth: the membership is already committed either way.
 */
async function deliverInvitation(
  req: Request,
  input: { email: string; name: string; role: HqRole; token: string; expiresAt: string },
): Promise<"sent" | "not_configured" | "failed" | "no_link"> {
  const setupUrl = setupLinkFor(input.token);
  if (!setupUrl) {
    req.log?.error({}, "HQ invitation has no operations base URL to link to");
    return "no_link";
  }
  try {
    await sendHqTeamInvitation(input.email, {
      name: input.name,
      role: ROLE_LABELS[input.role],
      setupUrl,
      expiresLabel: expiryLabel(input.expiresAt),
    });
    return "sent";
  } catch (error) {
    req.log?.error({ err: error }, "HQ team invitation delivery failed");
    return error instanceof DeliveryNotConfiguredError ? "not_configured" : "failed";
  }
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

/**
 * 32 random bytes encoded URL-safe; only its SHA-256 digest reaches the DB.
 * The plain token leaves this process exactly once, inside the invitation
 * email, and comes back through the setup-link lookup. Sign-in itself stays
 * passwordless: the token names the invitation, the emailed code proves the
 * person, and the pending invitation is accepted at that moment.
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
    invitationExpiresAt: null,
    secondFactorPhone: null,
  };
}

/** Live setup-link expiry per membership, so the roster can date pending invitations. */
async function loadPendingInvitationExpiries(): Promise<Map<string, string>> {
  const result = await supabaseAdmin(
    "GET",
    "/rest/v1/hq_invitations?status=eq.pending&select=membership_id,expires_at&order=created_at.desc&limit=1000",
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`HQ invitation list failed (${result.status})`);
  }
  const expiries = new Map<string, string>();
  for (const row of result.json as Array<{ membership_id?: unknown; expires_at?: unknown }>) {
    const id = String(row.membership_id ?? "");
    if (id && !expiries.has(id)) expiries.set(id, String(row.expires_at ?? ""));
  }
  return expiries;
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
  const [factors, expiries] = await Promise.all([
    loadStaffSecondFactors("hq", members.map((member: HqMember) => member.id)),
    loadPendingInvitationExpiries(),
  ]);
  for (const member of members) {
    const factor = factors.get(member.id);
    member.secondFactorPhone = factor ? maskPhone(factor.phone) : null;
    member.invitationExpiresAt = expiries.get(member.id) ?? null;
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

/**
 * What already holds an email. A stalled HQ row (an invitation never taken
 * up, or one that was cancelled before anybody signed in) is reported
 * separately: that one is recoverable by re-sending, everything else is not.
 */
export type DuplicateHit =
  | { kind: "record"; label: string }
  | { kind: "hq_stalled"; memberId: string; name: string; state: "pending" | "cancelled" };

interface HqMembershipRow {
  id: string;
  display_name?: unknown;
  status?: unknown;
  auth_user_id?: unknown;
  activated_at?: unknown;
}

async function findDuplicate(email: string): Promise<DuplicateHit | null> {
  const queries: Array<[string, string]> = [
    ["provider", `/rest/v1/providers?email=ilike.${encode(email)}&select=provider_id&limit=1`],
    ["patient", `/rest/v1/patients?email=ilike.${encode(email)}&select=id&limit=1`],
    ["provider team", `/rest/v1/team_members?email=ilike.${encode(email)}&select=id&limit=1`],
    ["profile", `/rest/v1/profiles?email=ilike.${encode(email)}&select=id&limit=1`],
    ["staff assignment", `/rest/v1/staff_role_assignments?email=ilike.${encode(email)}&select=email&limit=1`],
  ];
  const [results, hqResult, authResult] = await Promise.all([
    Promise.all(queries.map(([, path]) => supabaseAdmin("GET", path))),
    supabaseAdmin(
      "GET",
      `/rest/v1/hq_memberships?email=ilike.${encode(email)}&select=id,display_name,status,auth_user_id,activated_at&limit=2`,
    ),
    // GoTrue's admin filter is an ILIKE across the directory; the exact
    // re-check below is what decides. Targeting the one address keeps this
    // constant-time as the directory grows.
    supabaseAdmin("GET", `/auth/v1/admin/users?page=1&per_page=50&filter=${encode(email)}`),
  ]);
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status >= 300 || !Array.isArray(result.json)) {
      throw new Error(`duplicate lookup failed for ${queries[index][0]} (${result.status})`);
    }
    if (result.json.length > 0) return { kind: "record", label: queries[index][0] };
  }
  if (authResult.status >= 300 || !Array.isArray(authResult.json?.users)) {
    throw new Error(`Auth duplicate lookup failed (${authResult.status})`);
  }
  if ((authResult.json.users as Array<{ email?: unknown }>).some(
    (user) => String(user.email ?? "").trim().toLowerCase() === email,
  )) return { kind: "record", label: "login" };

  if (hqResult.status >= 300 || !Array.isArray(hqResult.json)) {
    throw new Error(`duplicate lookup failed for HQ team (${hqResult.status})`);
  }
  const rows = hqResult.json as HqMembershipRow[];
  if (rows.length > 1) return { kind: "record", label: "HQ team" };
  const row = rows[0];
  if (!row) return null;
  const status = String(row.status ?? "");
  const neverSignedIn = !row.auth_user_id && !row.activated_at;
  if (status === "invited" && neverSignedIn) {
    return { kind: "hq_stalled", memberId: String(row.id), name: String(row.display_name ?? ""), state: "pending" };
  }
  if (status === "revoked" && neverSignedIn) {
    return { kind: "hq_stalled", memberId: String(row.id), name: String(row.display_name ?? ""), state: "cancelled" };
  }
  return { kind: "record", label: status === "revoked" ? "former HQ team" : "HQ team" };
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
      const duplicate = await findDuplicate(email);
      if (duplicate?.kind === "hq_stalled") {
        // Recoverable: the email is held only by an HQ invitation nobody took
        // up. Name it and let the caller re-send instead of demanding
        // database surgery.
        res.status(409).json({
          error: duplicate.state === "cancelled"
            ? `A cancelled HQ invitation for ${duplicate.name || email} still holds that email. Re-send it to try again.`
            : `${duplicate.name || email} already has a pending HQ invitation. Re-send it to issue a new link.`,
          field: "email",
          resendable: { memberId: duplicate.memberId, name: duplicate.name, state: duplicate.state },
        });
        return;
      }
      if (duplicate) {
        res.status(409).json({
          error: `That email already belongs to a ${duplicate.label} record. Use a unique work email.`,
          field: "email",
        });
        return;
      }
      const actor = res.locals.staff as StaffIdentity;
      const setup = createSetupToken();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_invite_team_member_v2", {
        p_actor_id: actor.userId,
        p_name: parsed.data.name,
        p_email: email,
        p_title: parsed.data.title,
        p_role: parsed.data.role,
        p_token_hash: setup.tokenHash,
        p_expires_at: expiresAt,
      });
      if ([400, 409, 422].includes(result.status)) {
        // The function's own refusal is the most precise thing anyone has;
        // pass it through rather than replacing it with a house message.
        res.status(409).json({ error: rpcError(result.json, "That person cannot be invited."), source: "database" });
        return;
      }
      if (result.status >= 300 || !result.json) throw new Error(`HQ invitation commit failed (${result.status})`);
      const row = Array.isArray(result.json) ? result.json[0] : result.json;
      const invitation = await deliverInvitation(req, {
        email, name: parsed.data.name, role: parsed.data.role, token: setup.token, expiresAt,
      });
      await recordAdminAuditEvent({ action: "hq_team_invited", actorUserId: actor.userId, actorKind: "hq", providerId: null, targetKind: "hq_member", targetId: String(row.id), requestId: req.headers["x-request-id"]?.toString() ?? null, metadata: { role: parsed.data.role, invitation } }).catch(error => req.log?.error({ err: error }, "HQ invitation audit failed"));
      res.status(201).json({
        member: { ...mapMember(row), invitationExpiresAt: expiresAt },
        invitation,
      });
    } catch (error) {
      req.log?.error({ err: error }, "HQ team invitation failed");
      res.status(502).json({
        error: "Could not finish the HQ invitation. The team service did not accept the request — try again, and tell an administrator if it keeps failing.",
      });
    }
  },
);

/**
 * Re-send a stalled invitation: a new token, a new expiry, a fresh email.
 * Cancelled-but-never-used invitations are revived here too, which is the
 * recovery path for an invite that was withdrawn by mistake.
 */
router.post(
  "/hq-team/:id/invitations/resend",
  requireHqPermission("team_manage"),
  requireTeamManager,
  async (req, res): Promise<void> => {
    try {
      const actor = res.locals.staff as StaffIdentity;
      const setup = createSetupToken();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_resend_team_invitation", {
        p_actor_id: actor.userId,
        p_member_id: String(req.params.id),
        p_token_hash: setup.tokenHash,
        p_expires_at: expiresAt,
      });
      if ([400, 409, 422].includes(result.status)) {
        res.status(409).json({ error: rpcError(result.json, "That invitation cannot be re-sent."), source: "database" });
        return;
      }
      if (result.status === 404) {
        res.status(404).json({ error: "HQ team member not found." });
        return;
      }
      if (result.status >= 300 || !result.json) throw new Error(`HQ invitation resend failed (${result.status})`);
      const row = Array.isArray(result.json) ? result.json[0] : result.json;
      const member = mapMember(row);
      const invitation = await deliverInvitation(req, {
        email: member.email, name: member.name, role: member.role, token: setup.token, expiresAt,
      });
      await recordAdminAuditEvent({ action: "hq_team_invite_resent", actorUserId: actor.userId, actorKind: "hq", providerId: null, targetKind: "hq_member", targetId: member.id, requestId: req.headers["x-request-id"]?.toString() ?? null, metadata: { role: member.role, invitation } }).catch(error => req.log?.error({ err: error }, "HQ invitation resend audit failed"));
      res.json({ member: { ...member, invitationExpiresAt: expiresAt }, invitation });
    } catch (error) {
      req.log?.error({ err: error }, "HQ team invitation resend failed");
      res.status(502).json({
        error: "Could not re-send that invitation. The team service did not accept the request — try again in a moment.",
      });
    }
  },
);

/**
 * Cancel a pending invitation. Revoking the membership is what frees the
 * roster row; the lifecycle trigger withdraws the open invitation with it.
 * Unlike removing a teammate this needs no fresh code — nobody has access yet.
 */
router.post(
  "/hq-team/:id/invitations/cancel",
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
      if (target.status !== "invited") {
        res.status(409).json({ error: `${target.name} has already joined the team. Remove them instead of cancelling an invitation.` });
        return;
      }
      const actor = res.locals.staff as StaffIdentity;
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_revoke_team_member", {
        p_actor_id: actor.userId,
        p_member_id: target.id,
      });
      if ([400, 409, 422].includes(result.status)) {
        res.status(409).json({ error: rpcError(result.json, "That invitation cannot be cancelled."), source: "database" });
        return;
      }
      if (result.status >= 300) throw new Error(`HQ invitation cancel failed (${result.status})`);
      await recordAdminAuditEvent({ action: "hq_team_invite_cancelled", actorUserId: actor.userId, actorKind: "hq", providerId: null, targetKind: "hq_member", targetId: target.id, requestId: req.headers["x-request-id"]?.toString() ?? null }).catch(error => req.log?.error({ err: error }, "HQ invitation cancel audit failed"));
      res.json({ cancelled: true });
    } catch (error) {
      req.log?.error({ err: error }, "HQ team invitation cancel failed");
      res.status(502).json({ error: "Could not cancel that invitation right now." });
    }
  },
);

/**
 * Unauthenticated token exchange behind the emailed setup link. Every dead
 * token — used, cancelled, expired, never issued — answers 200 with its own
 * state and no identity, so the page can explain itself without the endpoint
 * ever confirming whether an unknown token belongs to anyone.
 */
const invitationLookupLimit = createLimiter({
  burst: 12, refillPerMinute: 4, maxConcurrent: 10, dailyBudget: 20_000,
  dailyMessage: "Too many invitation lookups today. Please try again tomorrow.",
  busyMessage: "The invitation service is busy. Please try again in a moment.",
  rapidMessage: "Too many invitation attempts. Please wait a moment and try again.",
});
const LookupBody = z.object({ token: z.string().trim().min(1).max(512) });

router.post("/hq-team/invitation/lookup", async (req, res): Promise<void> => {
  const slot = invitationLookupLimit(req.ip || req.socket.remoteAddress || "unknown");
  if (!slot.ok) {
    res.status(429).json({ error: slot.message });
    return;
  }
  try {
    res.set("Cache-Control", "no-store");
    const parsed = LookupBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.json({ state: "unknown" });
      return;
    }
    const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_lookup_team_invitation", {
      p_token_hash: tokenHash,
    });
    if (result.status >= 300 || !result.json) throw new Error(`HQ invitation lookup failed (${result.status})`);
    const row = (Array.isArray(result.json) ? result.json[0] : result.json) as Record<string, unknown>;
    const state = String(row?.state ?? "unknown");
    if (state !== "pending") {
      res.json({ state: ["used", "cancelled", "expired"].includes(state) ? state : "unknown" });
      return;
    }
    const role = parseRole(row.role);
    res.json({
      state: "pending",
      name: String(row.name ?? ""),
      email: String(row.email ?? ""),
      role: role ? ROLE_LABELS[role] : "",
      title: row.title ? String(row.title) : null,
      expiresAt: String(row.expiresAt ?? ""),
    });
  } catch (error) {
    req.log?.error({ err: error }, "HQ invitation lookup failed");
    res.status(503).json({ error: "Could not check that invitation right now. Please try again in a moment." });
  } finally {
    slot.release();
  }
});

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
      res.status(502).json({
        error: "Could not remove that HQ team member. The team service did not accept the request — their access is unchanged.",
      });
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