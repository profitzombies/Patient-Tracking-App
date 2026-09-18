import type { Request, Response } from "express";
import { canManageOffice, resolveOfficeScope, respondOfficeScopeDenied, type OfficeRole } from "../auth/office-scope";

export interface BillingOfficeScope {
  providerId: string;
  officeName: string;
  actorUserId: string;
  isHq: boolean;
  officeRole: OfficeRole;
  canManage: boolean;
}

export function viewerOfficeRole(scope: Pick<BillingOfficeScope, "officeRole" | "canManage">) {
  return { office_role: scope.officeRole, can_manage: scope.canManage };
}

export async function requireOfficeBillingScope(
  req: Request,
  res: Response,
  options: { write: boolean; sell?: boolean },
): Promise<BillingOfficeScope | null> {
  const bodyOffice = req.body && typeof req.body.office === "string" ? req.body.office : null;
  const resolved = await resolveOfficeScope({
    authorization: req.headers.authorization,
    request: req,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : bodyOffice,
    hqPermission: options.write ? "provider_manage" : "financial_read",
    requireUnlocked: options.write,
  });
  if (resolved.kind !== "ok") {
    respondOfficeScopeDenied(req, res, resolved);
    return null;
  }
  const manage = canManageOffice(resolved.scope);
  if (resolved.scope.actorKind !== "hq" && !manage && !options.sell) {
    res.status(403).json({ error: "Only office owners and admins can manage payments." });
    return null;
  }
  return {
    providerId: resolved.scope.providerId,
    officeName: resolved.scope.officeName,
    actorUserId: resolved.scope.actorUserId,
    isHq: resolved.scope.actorKind === "hq",
    officeRole: resolved.scope.officeRole,
    canManage: manage,
  };
}