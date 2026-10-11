/**
 * Public legal documents — the text behind the consent version.
 *
 *  - GET /legal/documents          every document + version/effective date/status
 *  - GET /legal/documents/:slug    one document (privacy | terms | health-data)
 *  - GET /legal/support            public support contact (HQ-configured, with a default)
 *
 * Open routes (the app stores and the consent screen read them before any
 * sign-in), cache-friendly, and free of per-request state. The payload is the
 * same bundle the mobile app ships offline, so a stale bundle is detected by
 * comparing `version`.
 */
import { Router, type IRouter } from "express";
import {
  isLegalDocumentSlug,
  legalDocument,
  legalDocumentsBundle,
} from "@workspace/legal-documents";
import { DEFAULT_ORG_POLICY, loadOrgPolicy } from "../lib/org-policy";

const router: IRouter = Router();

export const LEGAL_DOCUMENTS_PATH = "/legal/documents";
export const LEGAL_SUPPORT_PATH = "/legal/support";
/** Fallback when HQ has not entered a support address in Organization settings. */
export const DEFAULT_SUPPORT_EMAIL = "support@trythinnr.com";

const PUBLIC_CACHE = "public, max-age=300, stale-while-revalidate=3600";

router.get(LEGAL_DOCUMENTS_PATH, (_req, res) => {
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json(legalDocumentsBundle());
});

router.get(`${LEGAL_DOCUMENTS_PATH}/:slug`, (req, res) => {
  const slug = req.params.slug;
  if (!isLegalDocumentSlug(slug)) {
    res.status(404).json({ error: "No such document." });
    return;
  }
  const bundle = legalDocumentsBundle();
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json({
    version: bundle.version,
    effectiveDate: bundle.effectiveDate,
    status: bundle.status,
    document: legalDocument(slug),
  });
});

router.get(LEGAL_SUPPORT_PATH, async (req, res) => {
  // A policy outage must not take the public support page down: fall back to
  // the default contact rather than erroring.
  const policy = await loadOrgPolicy().catch((error) => {
    req.log?.warn({ err: error }, "support contact policy read failed; using defaults");
    return DEFAULT_ORG_POLICY;
  });
  res.setHeader("Cache-Control", PUBLIC_CACHE);
  res.json({
    organizationName: policy.organizationName,
    email: policy.supportEmail || DEFAULT_SUPPORT_EMAIL,
    phone: policy.supportPhone || null,
  });
});

export default router;
