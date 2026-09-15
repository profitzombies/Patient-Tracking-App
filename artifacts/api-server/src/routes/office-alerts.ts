/**
 * Office attention bell, digest history, and delivery settings.
 *
 * Office staff may acknowledge their own live alert signatures. HQ drill-in
 * is read-only: HQ may list alerts/digests and inspect or manage office
 * settings with the required permission, but may not write seen state or
 * personal delivery preferences.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { resolveOfficeScope, type OfficeScope } from "../auth/office-scope";
import { loadOfficeAttention } from "../lib/office-attention";
import { CLOCK_RE, OVERRIDES_SELECT, loadOfficeOverrides, loadOrgPolicy, overridesFromRow } from "../lib/org-policy";
import { supabaseAdmin } from "../lib/supabase-admin";
import { recordAdminAuditEvent } from "../lib/admin-audit";

const router: IRouter = Router();
const enc = encodeURIComponent;
const settingsBody = z.object({
  expectedVersion: z.number().int().nonnegative(),
  recipientMode: z.enum(["all", "owners_admins", "selected"]),
  recipientMemberIds: z.array(z.string()).max(500),
  sendTime: z.string().regex(CLOCK_RE),
  timeZone: z.string().nullable(),
}).strict();

async function scoped(req: Request, res: Response, manage = false): Promise<OfficeScope | null> {
  const resolved = await resolveOfficeScope({
    authorization: req.headers.authorization,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
    hqPermission: manage ? "provider_manage" : "provider_read",
    requireUnlocked: manage,
  });
  if (resolved.kind !== "ok") { res.status(resolved.status).json({ error: resolved.message }); return null; }
  return resolved.scope;
}
function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}
async function settingsDto(scope: OfficeScope) {
  const [overrides, org, provider, members, prefs] = await Promise.all([
    loadOfficeOverrides(scope.providerId), loadOrgPolicy(),
    supabaseAdmin("GET", `/rest/v1/providers?provider_id=eq.${enc(scope.providerId)}&select=provider_name,email,auth_user_id&limit=1`),
    supabaseAdmin("GET", `/rest/v1/team_members?provider_id=eq.${enc(scope.providerId)}&select=id,name,email,office_role,activation_status,auth_user_id&order=created_at.asc&limit=500`),
    supabaseAdmin("GET", `/rest/v1/staff_alert_preferences?provider_id=eq.${enc(scope.providerId)}&auth_user_id=eq.${enc(scope.actorUserId)}&limit=1`),
  ]);
  if ([provider, members, prefs].some((r) => r.status >= 300)) throw new Error("alert settings supporting data failed");
  const owner = (Array.isArray(provider.json) ? provider.json[0] : null) as Record<string, unknown> | null;
  const preference = (Array.isArray(prefs.json) ? prefs.json[0] : null) as Record<string, unknown> | null;
  const memberRows = Array.isArray(members.json) ? members.json as Record<string, unknown>[] : [];
  const meMember = memberRows.find((row) => row.auth_user_id === scope.actorUserId);
  return {
    recipientMode: overrides.alertRecipientMode,
    recipientMemberIds: overrides.alertRecipientMemberIds,
    sendTime: overrides.alertSendTime,
    timeZone: overrides.alertTimeZone ?? org.defaultTimezone,
    timeZoneSource: overrides.alertTimeZone ? "office" : "hq",
    version: overrides.version,
    canEdit: scope.actorKind === "hq" || scope.officeRole === "owner" || scope.officeRole === "admin",
    me: { emailEnabled: preference?.email_enabled !== false, pushEnabled: preference?.push_enabled !== false, email: scope.actorKind === "provider" ? String(owner?.email ?? "") || null : String(meMember?.email ?? "") || null },
    team: [
      { id: "owner", name: String(owner?.provider_name ?? scope.providerName), role: "owner", status: owner?.auth_user_id ? "active" : "invited" },
      ...memberRows.map((row) => ({
        id: String(row.id), name: String(row.name ?? "Unnamed teammate"), role: String(row.office_role ?? "staff"),
        status: row.activation_status === "disabled" ? "disabled" : row.auth_user_id ? "active" : "invited",
      })),
    ],
  };
}

router.get("/office/alerts", async (req, res) => {
  try {
    const scope = await scoped(req, res); if (!scope) return;
    const [current, seen] = await Promise.all([
      loadOfficeAttention(scope.providerId, new Date()),
      supabaseAdmin("GET", `/rest/v1/office_attention_seen?provider_id=eq.${enc(scope.providerId)}&auth_user_id=eq.${enc(scope.actorUserId)}&select=patient_id,signature&limit=500`),
    ]);
    if (seen.status >= 300) throw new Error(`attention seen load failed (${seen.status})`);
    const signatures = new Map((Array.isArray(seen.json) ? seen.json as Record<string, unknown>[] : []).map((row) => [String(row.patient_id), String(row.signature)]));
    const items = current.items.map((item) => ({ ...item, seen: signatures.get(item.patientId) === item.signature }));
    res.json({ asOf: current.asOf, count: items.filter((item) => !item.seen).length, total: items.length, items });
  } catch (error) { req.log?.error({ err: error }, "office alerts failed"); res.status(502).json({ error: "Office alerts are unavailable right now." }); }
});
router.post("/office/alerts/:patientId/seen", async (req, res) => {
  try {
    const scope = await scoped(req, res); if (!scope) return;
    if (scope.actorKind === "hq") { res.status(403).json({ error: "HQ users cannot change office alert seen state." }); return; }
    const signature = typeof req.body?.signature === "string" ? req.body.signature : "";
    if (!signature || signature.length > 512) { res.status(400).json({ error: "A current alert signature is required." }); return; }
    const patientId = String(req.params.patientId);
    const patient = await supabaseAdmin("GET", `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(scope.providerId)}&select=id&limit=1`);
    if (patient.status >= 300 || !Array.isArray(patient.json) || !patient.json[0]) { res.status(404).json({ error: "Patient not found." }); return; }
    const saved = await supabaseAdmin("POST", "/rest/v1/office_attention_seen?on_conflict=provider_id,auth_user_id,patient_id", [{ provider_id: scope.providerId, auth_user_id: scope.actorUserId, patient_id: patientId, signature, seen_at: new Date().toISOString() }], "resolution=merge-duplicates,return=minimal");
    if (saved.status >= 300) throw new Error(`attention seen save failed (${saved.status})`);
    const [current, seen] = await Promise.all([
      loadOfficeAttention(scope.providerId, new Date()),
      supabaseAdmin("GET", `/rest/v1/office_attention_seen?provider_id=eq.${enc(scope.providerId)}&auth_user_id=eq.${enc(scope.actorUserId)}&select=patient_id,signature&limit=500`),
    ]);
    if (seen.status >= 300) throw new Error(`attention seen recount failed (${seen.status})`);
    const signatures = new Map((Array.isArray(seen.json) ? seen.json as Record<string, unknown>[] : []).map((row) => [String(row.patient_id), String(row.signature)]));
    res.json({ ok: true, count: current.items.filter((item) => signatures.get(item.patientId) !== item.signature).length });
  } catch (error) { req.log?.error({ err: error }, "office alert seen failed"); res.status(502).json({ error: "Could not mark this alert seen." }); }
});
router.get("/office/alerts/digests", async (req, res) => {
  try {
    const scope = await scoped(req, res); if (!scope) return;
    const requested = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    const result = await supabaseAdmin("GET", `/rest/v1/office_attention_digests?provider_id=eq.${enc(scope.providerId)}&select=digest_date,generated_at,time_zone,flagged_count,items&order=digest_date.desc&limit=30`);
    if (result.status >= 300) throw new Error(`digest list failed (${result.status})`);
    const rows = Array.isArray(result.json) ? result.json as Record<string, unknown>[] : [];
    const selected = requested ? rows.find((row) => row.digest_date === requested) : rows[0];
    res.json({ dates: rows.map((row) => String(row.digest_date)), digest: selected ? { digestDate: selected.digest_date, generatedAt: selected.generated_at, timeZone: selected.time_zone, flaggedCount: selected.flagged_count, items: selected.items } : null, latestDate: rows[0]?.digest_date ?? null });
  } catch (error) { req.log?.error({ err: error }, "office alert digests failed"); res.status(502).json({ error: "Office alert digests are unavailable right now." }); }
});
router.get("/office/alerts/settings", async (req, res) => {
  try { const scope = await scoped(req, res); if (scope) res.json(await settingsDto(scope)); }
  catch (error) { req.log?.error({ err: error }, "office alert settings failed"); res.status(502).json({ error: "Alert settings are unavailable right now." }); }
});
router.put("/office/alerts/settings", async (req, res) => {
  const parsed = settingsBody.safeParse(req.body);
  if (!parsed.success || (parsed.data.timeZone !== null && !validZone(parsed.data.timeZone))) { res.status(400).json({ error: "Check the alert settings." }); return; }
  try {
    const scope = await scoped(req, res, true); if (!scope) return;
    if (scope.actorKind !== "hq" && scope.officeRole !== "owner" && scope.officeRole !== "admin") { res.status(403).json({ error: "Only office owners and admins can change alert settings." }); return; }
    const current = await loadOfficeOverrides(scope.providerId);
    if (current.version !== parsed.data.expectedVersion) { res.status(409).json({ error: "Someone else saved these settings first.", version: current.version }); return; }
    const columns = {
      provider_id: scope.providerId, version: current.version + 1,
      quiet_hours_set: current.quietHours.mode !== "inherit",
      quiet_start: current.quietHours.mode === "custom" ? current.quietHours.start : null,
      quiet_end: current.quietHours.mode === "custom" ? current.quietHours.end : null,
      escalation_email: current.escalationEmail,
      alert_recipient_mode: parsed.data.recipientMode, alert_recipient_member_ids: parsed.data.recipientMemberIds,
      alert_send_time: parsed.data.sendTime, alert_time_zone: parsed.data.timeZone,
      updated_at: new Date().toISOString(), updated_by: scope.actorUserId,
    };
    const result = current.version === 0
      ? await supabaseAdmin("POST", `/rest/v1/provider_policy_overrides?select=${OVERRIDES_SELECT}`, columns, "return=representation")
      : await supabaseAdmin("PATCH", `/rest/v1/provider_policy_overrides?provider_id=eq.${enc(scope.providerId)}&version=eq.${current.version}&select=${OVERRIDES_SELECT}`, columns, "return=representation");
    const row = Array.isArray(result.json) ? result.json[0] as Record<string, unknown> : null;
    if (result.status === 409 || !row) { res.status(409).json({ error: "Someone else saved these settings first.", version: current.version }); return; }
    overridesFromRow(row);
    await recordAdminAuditEvent({ action: "office_alert_settings_updated", actorUserId: scope.actorUserId, actorKind: scope.actorKind, providerId: scope.providerId, targetKind: "office_alert_settings", targetId: scope.providerId, requestId: req.headers["x-request-id"]?.toString() ?? null, metadata: { version: current.version + 1 } }).catch(() => undefined);
    res.json(await settingsDto(scope));
  } catch (error) { req.log?.error({ err: error }, "office alert settings update failed"); res.status(502).json({ error: "Could not save alert settings." }); }
});
router.put("/office/alerts/preferences", async (req, res) => {
  try {
    const scope = await scoped(req, res); if (!scope) return;
    if (scope.actorKind === "hq") { res.status(403).json({ error: "HQ users do not receive office alerts." }); return; }
    if (typeof req.body?.emailEnabled !== "boolean" || typeof req.body?.pushEnabled !== "boolean") { res.status(400).json({ error: "Email and push choices are required." }); return; }
    const result = await supabaseAdmin("POST", "/rest/v1/staff_alert_preferences?on_conflict=provider_id,auth_user_id", [{ provider_id: scope.providerId, auth_user_id: scope.actorUserId, email_enabled: req.body.emailEnabled, push_enabled: req.body.pushEnabled, updated_at: new Date().toISOString() }], "resolution=merge-duplicates,return=representation");
    if (result.status >= 300) throw new Error(`preferences save failed (${result.status})`);
    res.json({ emailEnabled: req.body.emailEnabled, pushEnabled: req.body.pushEnabled });
  } catch (error) { req.log?.error({ err: error }, "office alert preferences failed"); res.status(502).json({ error: "Could not save alert preferences." }); }
});
export default router;