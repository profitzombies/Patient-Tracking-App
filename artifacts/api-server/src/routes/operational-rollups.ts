import { Router, type IRouter } from "express";
import { resolveOfficeScope } from "../auth/office-scope";
import { requireHqPermission } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";

const router: IRouter = Router();

export function operationalMetrics(row: Record<string, unknown> | undefined) {
  const n = (key: string) => {
    const value = Number(row?.[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    providerCount: n("provider_count"),
    totalPatients: n("total_patients"),
    activePatients: n("active_patients"),
    enrollments30d: n("enrollments_30d"),
    engaged7d: n("engaged_7d"),
    needsAttention: n("needs_attention"),
    inactive: n("inactive"),
    invited: n("invited"),
    watchlist: n("watchlist"),
    loggingLapsed: n("logging_lapsed"),
    checkInsOverdue: n("check_ins_overdue"),
    avgPoundsLost: row?.avg_pounds_lost == null ? null : n("avg_pounds_lost"),
  };
}

async function load(providerId: string | null) {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/nonfinancial_operational_rollup", {
    p_provider_id: providerId,
    p_as_of: new Date().toISOString().slice(0, 10),
  });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`operational rollup failed (${result.status})`);
  }
  return operationalMetrics(result.json[0] as Record<string, unknown> | undefined);
}

router.get("/office/overview", async (req, res) => {
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "provider_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }
    res.json({
      scope: { kind: "office", providerId: resolved.scope.providerId, officeName: resolved.scope.officeName },
      asOf: new Date().toISOString(),
      metrics: await load(resolved.scope.providerId),
    });
  } catch (error) {
    req.log?.error({ err: error }, "office rollup failed");
    res.status(502).json({ error: "Could not load the office overview right now." });
  }
});

router.get("/hq/overview", requireHqPermission("analytics_read"), async (req, res) => {
  try {
    res.json({
      scope: { kind: "hq", providerId: null, officeName: null },
      asOf: new Date().toISOString(),
      metrics: await load(null),
    });
  } catch (error) {
    req.log?.error({ err: error }, "HQ rollup failed");
    res.status(502).json({ error: "Could not load the HQ overview right now." });
  }
});

export default router;