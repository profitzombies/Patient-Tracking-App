import { Router, type IRouter } from "express";
import { requireHqPermission } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";

const router: IRouter = Router();
router.get("/hq/staff-alerts/deliveries", requireHqPermission("provider_read"), async (req, res) => {
  try {
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(200, Math.floor(requested))) : 100;
    const result = await supabaseAdmin("GET", `/rest/v1/staff_notifications?select=id,provider_id,channel,email,status,suppression_reason,last_error,scheduled_at,sent_at,finalized_at,data,providers(provider_name)&order=created_at.desc&limit=${limit}`);
    if (result.status >= 300) throw new Error(`staff deliveries failed (${result.status})`);
    const items = (Array.isArray(result.json) ? result.json as Record<string, unknown>[] : []).map((row) => {
      const data = row.data && typeof row.data === "object" ? row.data as Record<string, unknown> : {};
      const provider = row.providers && typeof row.providers === "object" ? row.providers as Record<string, unknown> : {};
      return {
        // HQ system threshold alerts belong to no office.
        id: row.id, providerId: row.provider_id, officeName: String(provider.provider_name ?? row.provider_id ?? "THINNR HQ"),
        channel: row.channel, recipientEmail: row.email ?? null, status: row.status,
        suppressionReason: row.suppression_reason ?? null, suppressionDetail: row.suppression_reason ?? null,
        lastError: row.last_error ?? null, digestDate: data.digestDate ?? null, flaggedCount: data.flaggedCount ?? 0,
        scheduledAt: row.scheduled_at, sentAt: row.sent_at ?? null, finalizedAt: row.finalized_at ?? null,
      };
    });
    res.json({ items });
  } catch (error) { req.log?.error({ err: error }, "staff alert deliveries failed"); res.status(502).json({ error: "Staff alert deliveries are unavailable right now." }); }
});
export default router;