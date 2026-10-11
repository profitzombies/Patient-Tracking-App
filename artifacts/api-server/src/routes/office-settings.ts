/**
 * Office view of the organization policy.
 *
 *   GET /office/settings?office=<hq only>            effective policy + overrides
 *   PUT /office/settings/overrides?office=<hq only>  replace the office's overrides
 *
 * Offices read every HQ policy value but may override only what HQ marks
 * office-local: quiet hours, the care-team escalation destination, and a
 * SHORTER staff idle timeout (an office can never lengthen HQ's window). The
 * response always carries the HQ default, the office's stored override and
 * the effective value with its source so the page can show them side by side.
 * Writes refuse locked offices, are versioned per office row, and audit each
 * changed field like the HQ settings do.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { UpdateOfficeSettingsOverridesBody } from "@workspace/api-zod";
import { resolveOfficeScope, type OfficeScope } from "../auth/office-scope";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import {
  IDLE_TIMEOUT_BOUNDS,
  OVERRIDES_SELECT,
  effectivePolicyFor,
  loadOfficeOverrides,
  overridesFromRow,
  policyFromRow,
  readOrgSettingsRow,
  type OfficeOverrides,
  type QuietHoursOverride,
} from "../lib/org-policy";
import { cleanEmail, cleanQuietHours, hqActorName, settingsDto } from "../lib/org-policy-edit";
import { supabaseAdmin } from "../lib/supabase-admin";
import { resolvePatientAppLinks } from "../lib/patient-app-link";

const router: IRouter = Router();
const enc = encodeURIComponent;
const SERVER_ERROR = "Office settings are unavailable right now.";
const CONFLICT = "Someone else saved these settings first. Reload to see the latest values.";

function expoGoPageUrl(): string | null {
  const resolved = resolvePatientAppLinks(null);
  return resolved.ok ? resolved.link : null;
}

function dto(scope: OfficeScope, settingsRow: Record<string, unknown>, overrides: OfficeOverrides) {
  const hq = settingsDto(settingsRow);
  const { quietHours, escalationEmail, idleTimeoutMinutes, version, updatedAt, updatedBy, updatedByName } = overrides;
  return {
    office: { providerId: scope.providerId, officeName: scope.officeName },
    hq,
    overrides: { quietHours, escalationEmail, idleTimeoutMinutes, version, updatedAt, updatedBy, updatedByName },
    effective: effectivePolicyFor(policyFromRow(settingsRow), overrides),
    // Where patients get the app today: the office "Get the app" links / QR
    // codes show a store link when HQ has one and the Expo Go page otherwise.
    patientApp: { expoGoUrl: expoGoPageUrl() },
    canEdit: true,
  };
}

async function scoped(req: Request, res: Response, requireUnlocked: boolean): Promise<OfficeScope | null> {
  const resolved = await resolveOfficeScope({
    authorization: req.headers.authorization,
    request: req,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
    hqPermission: requireUnlocked ? "provider_manage" : "provider_read",
    requireUnlocked,
  });
  if (resolved.kind !== "ok") {
    res.status(resolved.status).json({ error: resolved.message });
    return null;
  }
  return resolved.scope;
}

async function actorName(scope: OfficeScope): Promise<string | null> {
  if (scope.actorKind === "hq") return hqActorName(scope.actorUserId);
  if (scope.actorKind === "provider") return scope.providerName;
  try {
    const result = await supabaseAdmin(
      "GET",
      `/rest/v1/team_members?auth_user_id=eq.${enc(scope.actorUserId)}&select=name&limit=1`,
    );
    const row = Array.isArray(result.json) ? (result.json[0] as Record<string, unknown> | undefined) : undefined;
    return typeof row?.name === "string" && row.name.trim() ? row.name.trim() : null;
  } catch {
    return null;
  }
}

function describeQuiet(value: QuietHoursOverride): string {
  return value.mode === "custom" ? `${value.start}-${value.end}` : value.mode;
}

router.get("/office/settings", async (req, res) => {
  try {
    const scope = await scoped(req, res, false);
    if (!scope) return;
    const [settingsRow, overrides] = await Promise.all([readOrgSettingsRow(), loadOfficeOverrides(scope.providerId)]);
    res.json(dto(scope, settingsRow, overrides));
  } catch (error) {
    req.log?.error({ err: error }, "office settings read failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.put("/office/settings/overrides", async (req, res) => {
  const parsed = UpdateOfficeSettingsOverridesBody.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Check the office settings." });
    return;
  }
  const input = parsed.data;
  let quietHours: QuietHoursOverride;
  if (input.quietHours.mode === "custom") {
    if (input.quietHours.start === undefined || input.quietHours.end === undefined) {
      res.status(400).json({ error: "Quiet hours need a start and end time (HH:MM) that differ." });
      return;
    }
    const clean = cleanQuietHours({ start: input.quietHours.start, end: input.quietHours.end });
    if (!clean.ok || !clean.value) {
      res.status(400).json({ error: "Quiet hours need a start and end time (HH:MM) that differ." });
      return;
    }
    quietHours = { mode: "custom", ...clean.value };
  } else {
    quietHours = { mode: input.quietHours.mode };
  }
  const email = cleanEmail(input.escalationEmail);
  if (!email.ok) {
    res.status(400).json({ error: "Check the escalation email address." });
    return;
  }
  const idleRaw = input.idleTimeoutMinutes ?? null;
  const idleTimeout = idleRaw === null ? null : Math.round(idleRaw);
  if (idleTimeout !== null && (idleTimeout < IDLE_TIMEOUT_BOUNDS.min || idleTimeout > IDLE_TIMEOUT_BOUNDS.max)) {
    res.status(400).json({ error: `The idle timeout must be a whole number of minutes between ${IDLE_TIMEOUT_BOUNDS.min} and ${IDLE_TIMEOUT_BOUNDS.max}.` });
    return;
  }
  try {
    const scope = await scoped(req, res, true);
    if (!scope) return;
    const [settingsRow, current] = await Promise.all([readOrgSettingsRow(), loadOfficeOverrides(scope.providerId)]);
    const hqStaffIdle = policyFromRow(settingsRow).staffIdleTimeoutMinutes;
    if (idleTimeout !== null && idleTimeout > hqStaffIdle) {
      // Offices shorten, never lengthen: an override above HQ's value is refused, not clamped.
      res.status(400).json({
        error: `This office can shorten the idle timeout but not lengthen it: HQ's value is ${hqStaffIdle} minutes.`,
        field: "idleTimeoutMinutes",
        max: hqStaffIdle,
      });
      return;
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      res.status(409).json({ error: CONFLICT, version: current.version });
      return;
    }
    const changes: Array<{ field: string; from: string | null; to: string | null }> = [];
    if (describeQuiet(current.quietHours) !== describeQuiet(quietHours)) {
      changes.push({ field: "quietHours", from: describeQuiet(current.quietHours), to: describeQuiet(quietHours) });
    }
    if ((current.escalationEmail ?? null) !== email.value) {
      changes.push({ field: "escalationEmail", from: current.escalationEmail, to: email.value });
    }
    if ((current.idleTimeoutMinutes ?? null) !== idleTimeout) {
      changes.push({
        field: "idleTimeoutMinutes",
        from: current.idleTimeoutMinutes === null ? null : `${current.idleTimeoutMinutes} min`,
        to: idleTimeout === null ? null : `${idleTimeout} min`,
      });
    }
    if (changes.length === 0) {
      res.json(dto(scope, settingsRow, current));
      return;
    }
    const now = new Date().toISOString();
    const name = await actorName(scope);
    const nextVersion = current.version + 1;
    const columns = {
      provider_id: scope.providerId,
      version: nextVersion,
      quiet_hours_set: quietHours.mode !== "inherit",
      quiet_start: quietHours.mode === "custom" ? quietHours.start : null,
      quiet_end: quietHours.mode === "custom" ? quietHours.end : null,
      escalation_email: email.value,
      idle_timeout_minutes: idleTimeout,
      alert_recipient_mode: current.alertRecipientMode,
      alert_recipient_member_ids: current.alertRecipientMemberIds,
      alert_send_time: current.alertSendTime,
      alert_time_zone: current.alertTimeZone,
      updated_at: now,
      updated_by: scope.actorUserId,
      updated_by_name: name,
    };
    // version 0 = no row yet → insert; otherwise a guarded PATCH on the
    // version the caller saw (a concurrent save leaves it matching nothing).
    const result = current.version === 0
      ? await supabaseAdmin("POST", `/rest/v1/provider_policy_overrides?select=${OVERRIDES_SELECT}`, columns, "return=representation")
      : await supabaseAdmin(
          "PATCH",
          `/rest/v1/provider_policy_overrides?provider_id=eq.${enc(scope.providerId)}&version=eq.${current.version}&select=${OVERRIDES_SELECT}`,
          columns,
          "return=representation",
        );
    if (result.status === 409) {
      res.status(409).json({ error: CONFLICT, version: current.version });
      return;
    }
    if (result.status >= 300) throw new Error(`office overrides save failed (${result.status})`);
    const row = Array.isArray(result.json) ? (result.json[0] as Record<string, unknown> | undefined) : undefined;
    if (!row) {
      res.status(409).json({ error: CONFLICT, version: current.version });
      return;
    }
    const requestId = req.headers["x-request-id"]?.toString() ?? null;
    await Promise.all(
      changes.map(change =>
        recordAdminAuditEvent({
          action: "office_policy_override_updated",
          actorUserId: scope.actorUserId,
          actorKind: scope.actorKind,
          providerId: scope.providerId,
          targetKind: "office_policy_overrides",
          targetId: scope.providerId,
          requestId,
          metadata: { field: change.field, section: "office_overrides", from: change.from, to: change.to, version: nextVersion },
        }).catch(error => req.log?.error({ err: error, field: change.field }, "office override audit failed")),
      ),
    );
    res.json(dto(scope, settingsRow, overridesFromRow(row)));
  } catch (error) {
    req.log?.error({ err: error }, "office settings update failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

export default router;
