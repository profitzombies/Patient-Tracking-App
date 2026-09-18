import { Router, type IRouter, type Request, type Response } from "express";
import { resolveOfficeScope, respondOfficeScopeDenied, type OfficeScope } from "../auth/office-scope";
import {
  listHqFiles,
  searchHqFiles,
  sendHqFileContent,
  sendHqFileDownload,
} from "../lib/hq-files-read";

const router: IRouter = Router();

async function withOfficeScope(
  req: Request,
  res: Response,
  handler: (scope: OfficeScope) => Promise<void>,
) {
  const resolved = await resolveOfficeScope({
    authorization: req.headers.authorization,
    request: req,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
    hqPermission: "settings_manage",
    requireUnlocked: false,
  });
  if (resolved.kind !== "ok") {
    respondOfficeScopeDenied(req, res, resolved);
    return;
  }
  await handler(resolved.scope);
}

function options(scope: OfficeScope) {
  return {
    includeArchived: false,
    actor: {
      userId: scope.actorUserId,
      kind: scope.actorKind,
      providerId: scope.providerId,
    },
  } as const;
}

router.get("/office/files", (req, res) =>
  withOfficeScope(req, res, scope => listHqFiles(req, res, options(scope))));

router.get("/office/files/search", (req, res) =>
  withOfficeScope(req, res, scope => searchHqFiles(req, res, options(scope))));

router.get("/office/files/:fileId/download-url", (req, res) =>
  withOfficeScope(req, res, scope => sendHqFileDownload(req, res, options(scope))));

router.get("/office/files/:fileId/content", (req, res) =>
  withOfficeScope(req, res, scope => sendHqFileContent(req, res, options(scope))));

export default router;