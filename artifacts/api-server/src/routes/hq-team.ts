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
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { DeliveryNotConfiguredError, sendHqSetupInvitation } from "../claim/delivery";
import { passwordIssue } from "../claim/normalize";
import { createLimiter, envLimit } from "../coach/limits";

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
const SetupTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "That setup link is invalid or has expired.");
const SetupCompleteBody = z.object({
  token: SetupTokenSchema,
  password: z.string(),
  passwordConfirm: z.string(),
});
const acquireSetupInspectSlot = createLimiter({
  burst: envLimit("HQ_SETUP_INSPECT_BURST", 8), refillPerMinute: 4, maxConcurrent: 10,
  dailyBudget: envLimit("HQ_SETUP_INSPECT_DAILY_BUDGET", 500),
  dailyMessage: "Too many setup attempts today. Please try again tomorrow.",
  busyMessage: "Setup is busy right now. Please try again in a moment.",
  rapidMessage: "Too many setup attempts. Please wait a moment and try again.",
});
const acquireSetupCompleteSlot = createLimiter({
  burst: envLimit("HQ_SETUP_COMPLETE_BURST", 5), refillPerMinute: 2, maxConcurrent: 4,
  dailyBudget: envLimit("HQ_SETUP_COMPLETE_DAILY_BUDGET", 200),
  dailyMessage: "Too many setup attempts today. Please try again tomorrow.",
  busyMessage: "Setup is busy right now. Please try again in a moment.",
  rapidMessage: "Too many setup attempts. Please wait a moment and try again.",
});

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
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

/** 32 random bytes encoded URL-safe; only its SHA-256 digest reaches the DB. */
export function createSetupToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: crypto.createHash("sha256").update(token).digest("hex") };
}

export function hashSetupToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
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
  return result.json.map((row: Record<string, unknown>) => mapMember(row));
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

/** Service-role lookup for the public, possession-authorized setup screen. */
async function inspectSetupToken(tokenHash: string): Promise<Record<string, unknown> | null> {
  const now = encodeURIComponent(new Date().toISOString());
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/hq_invitations?token_hash=eq.${encode(tokenHash)}&status=eq.pending&expires_at=gt.${now}` +
      "&select=email,hq_memberships!inner(display_name,department_role,status)&hq_memberships.status=eq.invited&limit=1",
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`HQ setup token inspection failed (${result.status})`);
  }
  const invitation = result.json[0] as Record<string, unknown> | undefined;
  const member = invitation?.hq_memberships;
  if (!invitation || !member || Array.isArray(member)) return null;
  return { email: invitation.email, name: (member as Record<string, unknown>).display_name, role: (member as Record<string, unknown>).department_role };
}

function rpcError(json: unknown, fallback: string): string {
  const message = json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
    ? (json as { message: string }).message
    : "";
  return message || fallback;
}

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
        await sendHqSetupInvitation(email, {
          name: parsed.data.name, role: parsed.data.role, setupToken: setup.token,
        });
      } catch (error) {
        invitation = error instanceof DeliveryNotConfiguredError ? "not_configured" : "failed";
        req.log?.error({ err: error }, "HQ setup invitation delivery failed");
      }
      res.status(201).json({ member: mapMember(row), invitation });
    } catch (error) {
      req.log?.error({ err: error }, "HQ team invitation failed");
      res.status(502).json({ error: "Could not finish the HQ invitation." });
    }
  },
);

// Both endpoints are intentionally unauthenticated: possession of the
// high-entropy one-time token is the authorization. Query strings are stripped
// by the shared request logger, and neither endpoint logs its request body.
router.get("/hq-team/setup", async (req, res): Promise<void> => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const valid = SetupTokenSchema.safeParse(token);
  if (!valid.success) {
    res.status(400).json({ error: "That setup link is invalid or has expired." });
    return;
  }
  const slot = acquireSetupInspectSlot(requestIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const row = await inspectSetupToken(hashSetupToken(valid.data));
    if (!row) {
      res.status(404).json({ error: "That setup link is invalid or has expired." });
      return;
    }
    res.json({ name: String(row.name ?? ""), email: String(row.email ?? ""), role: parseRole(row.role) });
  } catch (error) {
    req.log?.error({ err: error }, "HQ setup inspection failed");
    res.status(503).json({ error: "Could not verify that setup link right now." });
  } finally {
    slot.release();
  }
});

router.post("/hq-team/setup/complete", async (req, res): Promise<void> => {
  const parsed = SetupCompleteBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the setup form." });
    return;
  }
  const passwordError = passwordIssue(parsed.data.password);
  if (passwordError) {
    res.status(400).json({ error: passwordError, field: "password" });
    return;
  }
  if (parsed.data.password !== parsed.data.passwordConfirm) {
    res.status(400).json({ error: "Both password boxes need to match.", field: "passwordConfirm" });
    return;
  }
  const slot = acquireSetupCompleteSlot(requestIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  let createdUserId: string | null = null;
  let activationCommitted = false;
  try {
    const tokenHash = hashSetupToken(parsed.data.token);
    // Validate before Auth creation. The accept RPC repeats this test and
    // atomically consumes the invitation, closing the inspect/complete race.
    const invite = await inspectSetupToken(tokenHash);
    if (!invite) {
      res.status(404).json({ error: "That setup link is invalid or has expired." });
      return;
    }
    const email = String(invite.email ?? "").trim().toLowerCase();
    const name = String(invite.name ?? "").trim();
    if (!email || !name) throw new Error("setup inspection returned incomplete invitation");
    const created = await supabaseAdmin("POST", "/auth/v1/admin/users", {
      email,
      password: parsed.data.password,
      email_confirm: true,
      app_metadata: { thinnr_provisioned: true },
      user_metadata: { display_name: name },
    });
    if (created.status === 400 || created.status === 422) {
      const msg = String(created.json?.msg ?? created.json?.message ?? "");
      if (String(created.json?.error_code ?? "") === "email_exists" || /already (been )?registered/i.test(msg)) {
        res.status(409).json({ error: "A login already exists for this invitation. Contact THINNR support." });
        return;
      }
      if (/password|weak_password/i.test(`${created.json?.error_code ?? ""} ${msg}`)) {
        res.status(400).json({ error: "That password was rejected. Choose a stronger password.", field: "password" });
        return;
      }
    }
    createdUserId = created.json?.id ?? created.json?.user?.id ?? null;
    if (created.status >= 300 || !createdUserId) throw new Error(`HQ setup Auth creation failed (${created.status})`);
    const accepted = await supabaseAdmin("POST", "/rest/v1/rpc/hq_accept_team_invitation", {
      p_token_hash: tokenHash,
      p_auth_user_id: createdUserId,
    });
    if (accepted.status >= 300 || !accepted.json) {
      throw new Error(`HQ setup activation failed (${accepted.status})`);
    }
    activationCommitted = true;
    const row = Array.isArray(accepted.json) ? accepted.json[0] : accepted.json;
    res.status(201).json({ member: mapMember(row) });
  } catch (error) {
    // An Auth record without a successfully consumed invitation would be an
    // orphan, though not an elevated one: the failed activation transaction
    // leaves the membership invited with no auth_user_id and creates no HQ
    // profile. Remove only the Auth account created by this request.
    let cleanupFailed = false;
    if (createdUserId && !activationCommitted) {
      try {
        const cleanup = await supabaseAdmin("DELETE", `/auth/v1/admin/users/${encode(createdUserId)}`);
        if (cleanup.status >= 300) {
          cleanupFailed = true;
          req.log?.error(
            { userId: createdUserId, status: cleanup.status },
            "HQ setup orphan cleanup was rejected",
          );
        }
      } catch (cleanupError) {
        cleanupFailed = true;
        req.log?.error(
          { err: cleanupError, userId: createdUserId },
          "HQ setup orphan cleanup request failed",
        );
      }
    }
    req.log?.error({ err: error }, "HQ setup completion failed");
    if (cleanupFailed) {
      // The still-pending invitation is the durable reconciliation record. It
      // retains only the setup-token digest and grants no HQ access.
      res.status(502).json({
        error: "Critical: account setup failed and the temporary login could not be removed. THINNR support must reconcile this invitation before setup can continue.",
        code: "HQ_SETUP_RECONCILIATION_REQUIRED",
        reconciliationRequired: true,
        invitationState: "pending",
        hqAccessGranted: false,
      });
      return;
    }
    if (activationCommitted) {
      res.status(502).json({
        error: "Account setup was activated, but the completed HQ account could not be returned. Contact THINNR support before trying again.",
      });
      return;
    }
    res.status(502).json({ error: "Could not finish account setup. No login was left active." });
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
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_revoke_team_member", {
        p_actor_id: (res.locals.staff as StaffIdentity).userId,
        p_member_id: target.id,
      });
      if ([400, 409, 422].includes(result.status)) {
        res.status(409).json({ error: rpcError(result.json, "That team member cannot be revoked.") });
        return;
      }
      if (result.status >= 300) throw new Error(`HQ revoke failed (${result.status})`);

      let sessionInvalidation: "not_applicable" | "complete" | "failed" =
        target.authUserId ? "complete" : "not_applicable";
      if (target.authUserId) {
        const logout = await supabaseAdmin("POST", `/auth/v1/admin/users/${encode(target.authUserId)}/logout`, {
          scope: "global",
        });
        if (logout.status >= 300) {
          sessionInvalidation = "failed";
          req.log?.error({ status: logout.status }, "revoked HQ session logout failed");
        }
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

export default router;