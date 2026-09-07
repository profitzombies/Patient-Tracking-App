/**
 * HQ-only staff provisioning — POST /api/staff-logins
 *
 * Creates an office sign-in from a provider account page. The caller (a
 * real signed-in HQ admin, verified exactly like the training-media routes)
 * sends first/last name, email, the office's account code, and optionally
 * the office role (default staff). The actual provisioning — duplicate
 * refusal, pre-approval upsert, team row, invitation email, rollback — is
 * shared with the office-side invite in ../office/staff-provisioning.ts.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { recordAdminAuditEvent, requestIdOf } from "../lib/admin-audit";
import {
  OFFICE_ROLES,
  PROVISIONING_FAILED_MESSAGE,
  StaffNameSchema,
  provisionStaffLogin,
} from "../office/staff-provisioning";

export { providerAcceptsNewStaff } from "../office/staff-provisioning";

const router: IRouter = Router();

export const STAFF_LOGINS_PATH = "/staff-logins";

const BodySchema = z.object({
  accountId: z
    .string({ required_error: "The office's account code is missing." })
    .trim()
    .min(1, "The office's account code is missing.")
    .max(60, "That office code looks wrong.")
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "That office code looks wrong."),
  ...StaffNameSchema,
  role: z.enum(OFFICE_ROLES as [string, ...string[]]).optional(),
});

router.post(STAFF_LOGINS_PATH, requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = BodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = typeof issue?.path?.[0] === "string" ? issue.path[0] : undefined;
    res.status(400).json({ error: issue?.message ?? "Check the form and try again.", field });
    return;
  }
  const staff = res.locals.staff as StaffIdentity;
  const officeRole = (parsed.data.role ?? "staff") as (typeof OFFICE_ROLES)[number];

  let result;
  try {
    result = await provisionStaffLogin({
      accountId: parsed.data.accountId,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      email: parsed.data.email,
      officeRole,
      log: req.log,
    });
  } catch (error) {
    req.log?.error({ err: error }, "staff provisioning failed");
    res.status(502).json({ error: PROVISIONING_FAILED_MESSAGE });
    return;
  }
  if (result.kind === "rejected") {
    res.status(result.status).json({ error: result.message, field: result.field });
    return;
  }

  void recordAdminAuditEvent({
    action: "office_team_invited",
    actorUserId: staff.userId,
    actorKind: "hq",
    providerId: result.staff.accountId,
    targetKind: "team_member",
    targetId: result.staff.id,
    requestId: requestIdOf(req),
    metadata: { role: officeRole },
  }).catch((error) => req.log?.warn({ err: error }, "staff invite audit failed"));

  res.status(201).json({ staff: result.staff });
});

export default router;
