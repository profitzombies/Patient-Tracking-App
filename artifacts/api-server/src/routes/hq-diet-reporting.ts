/**
 * HQ Diets & restrictions — aggregate reporting over patient diets, phases,
 * allergies / restrictions, diet changes, safety blocks and pregnancy
 * conflicts, network-wide or narrowed to one enabled office.
 *
 * Same gate and office scoping as the other HQ analytics routes: analytics
 * readers only; `office` narrows to one enabled practice (404 when unknown
 * or disabled). The report is assembled by diet/restrictions-report.ts so the
 * CSV export kind renders the identical figures.
 */
import { Router, type IRouter } from "express";
import { requireHqPermission } from "../lib/staff-auth";
import { buildDietRestrictionsReport, loadReportOffice } from "../diet/restrictions-report";
import { parseRange } from "./operational-rollups";

const router: IRouter = Router();

const RANGE_ERROR = "Use valid start and end date keys spanning at most 366 days.";
const OFFICE_ERROR = "Office not found.";
const PROVIDER_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;

router.get("/hq/diet-restrictions", requireHqPermission("analytics_read"), async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const range = parseRange(query);
  if (!range) {
    res.status(400).json({ error: RANGE_ERROR });
    return;
  }
  const officeParam = typeof query.office === "string" && query.office.trim() !== "" ? query.office.trim() : null;
  if (officeParam !== null && !PROVIDER_ID_RE.test(officeParam)) {
    res.status(404).json({ error: OFFICE_ERROR });
    return;
  }
  try {
    const office = officeParam ? await loadReportOffice(officeParam) : null;
    if (officeParam && !office) {
      res.status(404).json({ error: OFFICE_ERROR });
      return;
    }
    res.json(await buildDietRestrictionsReport(range, office));
  } catch (error) {
    req.log?.error({ err: error }, "HQ diet restrictions report failed");
    res.status(502).json({ error: "Could not load the diets & restrictions report right now." });
  }
});

export default router;
