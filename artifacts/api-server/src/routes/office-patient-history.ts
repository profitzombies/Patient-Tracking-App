/**
 * Read side of the patient record edit history.
 *
 * One office-scoped, pageable list of every change to a patient's profile,
 * status, staff weights, measurement visits, medications, and provider notes
 * with prior and new values and who made them. Read access follows the
 * patient page itself (provider_read; HQ names the office), so anyone who
 * can open the record can see how it was corrected. Locked offices are
 * still allowed to read: the history is part of the record, not an edit.
 */
import { Router, type IRouter } from "express";
import { supabaseAdmin } from "../lib/supabase-admin";
import { resolveOfficeScope, respondOfficeScopeDenied } from "../auth/office-scope";
import { EDIT_HISTORY_PAGE_MAX, isEditHistoryFamily, listPatientEditHistory } from "../lib/patient-edit-history";
import { RECORD_NOT_FOUND, SERVER_ERROR } from "./office-roster";

const router: IRouter = Router();
const enc = encodeURIComponent;

function pageNumber(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(parsed)));
}

router.get("/office/patients/:id/history", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      request: req,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "provider_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") { respondOfficeScopeDenied(req, res, resolved); return; }
    const scope = resolved.scope;
    const rawFamily = typeof req.query.family === "string" && req.query.family !== "" ? req.query.family : null;
    if (rawFamily !== null && !isEditHistoryFamily(rawFamily)) {
      res.status(400).json({ error: "Unknown history family.", field: "family" }); return;
    }
    const patientId = String(req.params.id ?? "");
    const found = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&select=id&limit=1`,
    );
    if (found.status >= 300) throw new Error(`patient record lookup failed (${found.status})`);
    if (!Array.isArray(found.json) || found.json.length === 0) { res.status(404).json({ error: RECORD_NOT_FOUND }); return; }
    const page = await listPatientEditHistory({
      providerId: scope.providerId,
      patientId,
      family: rawFamily,
      limit: pageNumber(req.query.limit, 50, EDIT_HISTORY_PAGE_MAX) || 50,
      offset: pageNumber(req.query.offset, 0, Number.MAX_SAFE_INTEGER),
    });
    res.json(page);
  } catch (error) {
    req.log?.error({ err: error }, "office patient history read failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

export default router;
