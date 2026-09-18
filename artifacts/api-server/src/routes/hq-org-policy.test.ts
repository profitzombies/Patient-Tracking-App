/**
 * Organization policy contract: HQ settings validation bounds, field-level
 * audit metadata, versioning (optimistic concurrency), section last-changed
 * metadata, and office override precedence — against an in-memory stand-in
 * for the two Supabase tables.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  scope: vi.fn(),
}));

const db = vi.hoisted(() => {
  const settingsRow = (): Record<string, unknown> => ({
    singleton: true,
    organization_name: "THINNR",
    support_email: null,
    support_phone: null,
    default_timezone: "America/New_York",
    updated_at: "2026-09-01T00:00:00.000Z",
    updated_by: null,
    version: 1,
    coach_available: true,
    escalation_email: null,
    app_store_url: null,
    google_play_url: null,
    default_coach_outreach: true,
    default_check_in_reminders: true,
    default_office_reminders: true,
    default_quiet_start: null,
    default_quiet_end: null,
    outreach_cooldown_days: 14,
    outreach_daily_cap: 500,
    conversation_auto_close_days: 14,
    retention_chat_days: 730,
    retention_photo_days: 730,
    retention_notification_days: 180,
    retention_audit_days: 2555,
    retention_job_run_days: 90,
    retention_sign_in_days: 180,
    retention_webhook_event_days: 365,
    export_link_hours: 24,
    section_changes: {},
  });
  const state = {
    settings: settingsRow(),
    overrides: new Map<string, Record<string, unknown>>(),
    memberships: new Map<string, string>([["00000000-0000-4000-8000-000000000001", "Avery Admin"]]),
    reset() {
      state.settings = settingsRow();
      state.overrides.clear();
    },
  };
  return state;
});

vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.authorization === "Bearer lower") {
      res.status(403).json({ error: "denied" });
      return;
    }
    res.locals.staff = { userId: "00000000-0000-4000-8000-000000000001" };
    next();
  },
}));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit }));
vi.mock("../auth/office-scope", () => ({ resolveOfficeScope: mocks.scope }));
vi.mock("../lib/objectStorage", () => ({
  UPLOAD_URL_TTL_SEC: 900,
  ObjectNotFoundError: class ObjectNotFoundError extends Error {},
  objectStorage: {},
}));
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: async (method: string, path: string, body?: Record<string, unknown>) => {
    const url = new URL(`http://x${path}`);
    const table = url.pathname.replace("/rest/v1/", "");
    const eq = (key: string) => url.searchParams.get(key)?.replace(/^eq\./, "");
    if (table === "hq_memberships") {
      const id = eq("auth_user_id") ?? "";
      const name = db.memberships.get(id);
      return { status: 200, json: name ? [{ display_name: name }] : [], contentRange: null };
    }
    if (table === "team_members") return { status: 200, json: [{ name: "Tess Team" }], contentRange: null };
    if (table === "hq_organization_settings") {
      if (method === "GET") return { status: 200, json: [db.settings], contentRange: null };
      if (method === "PATCH") {
        const version = Number(eq("version"));
        if (version !== db.settings.version) return { status: 200, json: [], contentRange: null };
        db.settings = { ...db.settings, ...body };
        return { status: 200, json: [db.settings], contentRange: null };
      }
    }
    if (table === "provider_policy_overrides") {
      const providerId = eq("provider_id");
      if (method === "GET") {
        const rows = providerId ? [db.overrides.get(providerId)].filter(Boolean) : [...db.overrides.values()];
        return { status: 200, json: rows, contentRange: null };
      }
      if (method === "POST") {
        const id = String(body?.provider_id);
        if (db.overrides.has(id)) return { status: 409, json: { message: "duplicate" }, contentRange: null };
        db.overrides.set(id, { ...body });
        return { status: 201, json: [db.overrides.get(id)], contentRange: null };
      }
      if (method === "PATCH") {
        const current = db.overrides.get(providerId ?? "");
        if (!current || Number(eq("version")) !== current.version) return { status: 200, json: [], contentRange: null };
        db.overrides.set(providerId!, { ...current, ...body });
        return { status: 200, json: [db.overrides.get(providerId!)], contentRange: null };
      }
    }
    return { status: 404, json: { message: `unmocked ${method} ${path}` }, contentRange: null };
  },
}));

import hqRouter from "./hq-settings-files";
import officeRouter from "./office-settings";
import { invalidateOrgPolicyCache, loadOrgPolicy } from "../lib/org-policy";

let server: http.Server;
let base = "";
const HQ = { authorization: "Bearer admin", "content-type": "application/json" };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(hqRouter);
  app.use(officeRouter);
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  db.reset();
  invalidateOrgPolicyCache();
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.scope.mockReset().mockResolvedValue({
    kind: "ok",
    scope: {
      providerId: "prov-1", officeName: "Riverside", providerName: "Dr. River",
      actorUserId: "00000000-0000-4000-8000-000000000009", actorKind: "provider",
    },
  });
});

const fullRetention = { chatTranscriptDays: 730, progressPhotoDays: 730, notificationHistoryDays: 180, auditEventDays: 2555, jobRunDays: 90, signInDays: 180, webhookEventDays: 365 };

async function putSettings(body: Record<string, unknown>) {
  const response = await fetch(`${base}/hq/settings`, { method: "PUT", headers: HQ, body: JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

describe("HQ organization policy", () => {
  it("reads the full policy contract with defaults and empty section metadata", async () => {
    const response = await fetch(`${base}/hq/settings`, { headers: HQ });
    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, any>;
    expect(json).toMatchObject({
      organizationName: "THINNR",
      coachAvailable: true,
      escalationEmail: null,
      defaultCategories: { coachOutreach: true, checkInReminders: true, officeReminders: true },
      defaultQuietHours: null,
      outreachCooldownDays: 14,
      outreachDailyCap: 500,
      conversationAutoCloseDays: 14,
      retention: { chatTranscriptDays: 730, progressPhotoDays: 730, notificationHistoryDays: 180, auditEventDays: 2555, jobRunDays: 90, signInDays: 180, webhookEventDays: 365 },
      exportLinkHours: 24,
      version: 1,
      sections: { organization: null, coach: null, notifications: null, conversations: null, retention: null },
    });
  });

  it("still accepts the original four-field body (backward compatible merge)", async () => {
    const { status, json } = await putSettings({
      organizationName: "THINNR Clinics", supportEmail: "Help@Thinnr.com", supportPhone: "+1 555 0100", defaultTimezone: "America/Chicago",
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ organizationName: "THINNR Clinics", supportEmail: "help@thinnr.com", defaultTimezone: "America/Chicago", version: 2 });
    // Untouched policy fields keep their values.
    expect(json.outreachDailyCap).toBe(500);
    expect(json.coachAvailable).toBe(true);
  });

  it.each([
    ["outreachCooldownDays", 0], ["outreachCooldownDays", 91], ["outreachCooldownDays", 2.5],
    ["outreachDailyCap", 0], ["outreachDailyCap", 10001],
    ["conversationAutoCloseDays", 0], ["conversationAutoCloseDays", 366],
    ["exportLinkHours", 0], ["exportLinkHours", 169],
  ])("rejects %s = %s (out of bounds)", async (field, value) => {
    const { status } = await putSettings({ [field]: value });
    expect(status).toBe(400);
    expect(db.settings.version).toBe(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rejects out-of-bounds retention periods, bad quiet hours, and bad emails", async () => {
    expect((await putSettings({ retention: { chatTranscriptDays: 29, progressPhotoDays: 730, notificationHistoryDays: 180, auditEventDays: 2555 } })).status).toBe(400);
    expect((await putSettings({ retention: { chatTranscriptDays: 730, progressPhotoDays: 730, notificationHistoryDays: 6, auditEventDays: 2555 } })).status).toBe(400);
    expect((await putSettings({ retention: { chatTranscriptDays: 730, progressPhotoDays: 730, notificationHistoryDays: 180, auditEventDays: 364 } })).status).toBe(400);
    expect((await putSettings({ retention: { chatTranscriptDays: 730, progressPhotoDays: 3651, notificationHistoryDays: 180, auditEventDays: 2555 } })).status).toBe(400);
    expect((await putSettings({ retention: { ...fullRetention, jobRunDays: 6 } })).status).toBe(400);
    expect((await putSettings({ retention: { ...fullRetention, signInDays: 29 } })).status).toBe(400);
    expect((await putSettings({ retention: { ...fullRetention, webhookEventDays: 3651 } })).status).toBe(400);
    expect((await putSettings({ retention: { ...fullRetention, jobRunDays: 30.5 } })).status).toBe(400);
    expect((await putSettings({ defaultQuietHours: { start: "22:00", end: "22:00" } })).status).toBe(400);
    expect((await putSettings({ defaultQuietHours: { start: "25:00", end: "07:00" } })).status).toBe(400);
    expect((await putSettings({ escalationEmail: "not-an-email" })).status).toBe(400);
    expect((await putSettings({ defaultTimezone: "Mars/Olympus" })).status).toBe(400);
    expect((await putSettings({ unknownField: 1 })).status).toBe(400);
    expect(db.settings.version).toBe(1);
  });

  it("accepts the boundary values", async () => {
    const { status, json } = await putSettings({
      outreachCooldownDays: 90, outreachDailyCap: 1, conversationAutoCloseDays: 365, exportLinkHours: 168,
      retention: { chatTranscriptDays: 30, progressPhotoDays: 3650, notificationHistoryDays: 7, auditEventDays: 365, jobRunDays: 7, signInDays: 30, webhookEventDays: 3650 },
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ outreachCooldownDays: 90, outreachDailyCap: 1, conversationAutoCloseDays: 365, exportLinkHours: 168 });
    expect(json.retention).toEqual({ chatTranscriptDays: 30, progressPhotoDays: 3650, notificationHistoryDays: 7, auditEventDays: 365, jobRunDays: 7, signInDays: 30, webhookEventDays: 3650 });
    expect(db.settings).toMatchObject({ retention_job_run_days: 7, retention_sign_in_days: 30, retention_webhook_event_days: 3650 });
  });

  it("audits every changed field with section/from/to/version and stamps only the touched sections", async () => {
    const { status, json } = await putSettings({
      expectedVersion: 1,
      coachAvailable: false,
      escalationEmail: "care@thinnr.com",
      defaultQuietHours: { start: "21:00", end: "08:00" },
      outreachDailyCap: 500, // unchanged → no audit row
    });
    expect(status).toBe(200);
    expect(json.version).toBe(2);
    const fields = mocks.audit.mock.calls.map(([input]) => input.metadata.field).sort();
    expect(fields).toEqual(["coachAvailable", "defaultQuietHours", "escalationEmail"]);
    const byField = Object.fromEntries(mocks.audit.mock.calls.map(([input]) => [input.metadata.field, input]));
    expect(byField.coachAvailable).toMatchObject({
      action: "hq_settings_updated", actorKind: "hq", targetKind: "organization_settings",
      metadata: { section: "coach", from: true, to: false, version: 2 },
    });
    expect(byField.defaultQuietHours.metadata).toMatchObject({
      section: "notifications", from: null, to: JSON.stringify({ start: "21:00", end: "08:00" }),
    });
    expect(json.sections.coach).toMatchObject({ changedBy: "00000000-0000-4000-8000-000000000001", changedByName: "Avery Admin" });
    expect(typeof json.sections.coach.changedAt).toBe("string");
    expect(json.sections.notifications).not.toBeNull();
    expect(json.sections.organization).toBeNull();
    expect(json.sections.retention).toBeNull();
    // A later save of another section leaves the earlier stamp intact.
    const later = await putSettings({ expectedVersion: 2, exportLinkHours: 48 });
    expect(later.json.version).toBe(3);
    expect(later.json.sections.coach.changedAt).toBe(json.sections.coach.changedAt);
    expect(later.json.sections.retention).not.toBeNull();
  });

  describe("app store links", () => {
    const APP_STORE = "https://apps.apple.com/us/app/thinnr/id6478123456";
    const PLAY = "https://play.google.com/store/apps/details?id=com.thinnr.app";

    it("reads as null until HQ adds them", async () => {
      const response = await fetch(`${base}/hq/settings`, { headers: HQ });
      expect(await response.json()).toMatchObject({ appStoreUrl: null, googlePlayUrl: null });
    });

    it("saves real store URLs through the versioned merge, stamps organization, and audits both fields", async () => {
      const { status, json } = await putSettings({ expectedVersion: 1, appStoreUrl: `  ${APP_STORE}  `, googlePlayUrl: PLAY });
      expect(status).toBe(200);
      expect(json).toMatchObject({ appStoreUrl: APP_STORE, googlePlayUrl: PLAY, version: 2 });
      expect(db.settings).toMatchObject({ app_store_url: APP_STORE, google_play_url: PLAY, version: 2 });
      expect(json.sections.organization).toMatchObject({ changedByName: "Avery Admin" });
      expect(json.sections.coach).toBeNull();
      const byField = Object.fromEntries(mocks.audit.mock.calls.map(([input]) => [input.metadata.field, input.metadata]));
      expect(byField.appStoreUrl).toMatchObject({ section: "organization", from: null, to: APP_STORE, version: 2 });
      expect(byField.googlePlayUrl).toMatchObject({ section: "organization", from: null, to: PLAY, version: 2 });
      // Offices read the same values on their settings endpoint.
      const office = await fetch(`${base}/office/settings`, { headers: { authorization: "Bearer office" } });
      expect((await office.json() as Record<string, any>).hq).toMatchObject({ appStoreUrl: APP_STORE, googlePlayUrl: PLAY });
    });

    it("blank clears a link (null) and a stale version is refused", async () => {
      await putSettings({ expectedVersion: 1, appStoreUrl: APP_STORE, googlePlayUrl: PLAY });
      const cleared = await putSettings({ expectedVersion: 2, appStoreUrl: "   ", googlePlayUrl: null });
      expect(cleared.status).toBe(200);
      expect(cleared.json).toMatchObject({ appStoreUrl: null, googlePlayUrl: null, version: 3 });
      const stale = await putSettings({ expectedVersion: 2, appStoreUrl: APP_STORE });
      expect(stale.status).toBe(409);
      expect(db.settings.app_store_url).toBeNull();
      expect(db.settings.version).toBe(3);
    });

    it.each([
      ["appStoreUrl", "https://example.com/app"],
      ["appStoreUrl", "http://apps.apple.com/us/app/thinnr/id1"],
      ["appStoreUrl", PLAY],
      ["appStoreUrl", "apps.apple.com/us/app/thinnr/id1"],
      ["appStoreUrl", "https://apps.apple.com/us/app/thinnr id1"],
      ["googlePlayUrl", "https://play.google.com/"],
      ["googlePlayUrl", "https://play.google.com/store/apps/collection/top"],
      ["googlePlayUrl", "javascript:alert(1)"],
      ["googlePlayUrl", APP_STORE],
    ])("rejects %s = %s with a field-specific message and no version bump", async (field, value) => {
      const { status, json } = await putSettings({ [field]: value });
      expect(status).toBe(400);
      expect(json.error).toContain(field === "appStoreUrl" ? "App Store link" : "Google Play link");
      expect(db.settings.version).toBe(1);
      expect(mocks.audit).not.toHaveBeenCalled();
    });

    it("rejects an over-long link at the schema", async () => {
      const { status } = await putSettings({ appStoreUrl: `https://apps.apple.com/${"a".repeat(500)}` });
      expect(status).toBe(400);
      expect(db.settings.version).toBe(1);
    });

    it("keeps the links when another section saves", async () => {
      await putSettings({ expectedVersion: 1, appStoreUrl: APP_STORE });
      const later = await putSettings({ expectedVersion: 2, exportLinkHours: 48 });
      expect(later.json.appStoreUrl).toBe(APP_STORE);
      expect(later.json.googlePlayUrl).toBeNull();
    });
  });

  it("refuses a stale expectedVersion with 409 and does not bump the version", async () => {
    await putSettings({ expectedVersion: 1, outreachCooldownDays: 7 });
    const stale = await putSettings({ expectedVersion: 1, outreachCooldownDays: 21 });
    expect(stale.status).toBe(409);
    expect(stale.json.version).toBe(2);
    expect(db.settings.outreach_cooldown_days).toBe(7);
    expect(db.settings.version).toBe(2);
  });

  it("does not bump the version or audit when nothing changed", async () => {
    const { status, json } = await putSettings({ expectedVersion: 1, outreachDailyCap: 500 });
    expect(status).toBe(200);
    expect(json.version).toBe(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("serves the saved policy to consumers immediately (cache primed on save)", async () => {
    expect((await loadOrgPolicy()).coachAvailable).toBe(true);
    await putSettings({ coachAvailable: false, conversationAutoCloseDays: 3 });
    const policy = await loadOrgPolicy();
    expect(policy.coachAvailable).toBe(false);
    expect(policy.conversationAutoCloseDays).toBe(3);
  });
});

describe("office settings and overrides", () => {
  const OFFICE = { authorization: "Bearer office", "content-type": "application/json" };
  const putOverrides = async (body: Record<string, unknown>) => {
    const response = await fetch(`${base}/office/settings/overrides`, { method: "PUT", headers: OFFICE, body: JSON.stringify(body) });
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  };

  it("shows the HQ policy, inherit-by-default overrides, and effective values sourced from HQ", async () => {
    await putSettings({ defaultQuietHours: { start: "22:00", end: "07:00" }, escalationEmail: "care@thinnr.com" });
    const response = await fetch(`${base}/office/settings`, { headers: OFFICE });
    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, any>;
    expect(json.office).toEqual({ providerId: "prov-1", officeName: "Riverside" });
    expect(json.hq.defaultQuietHours).toEqual({ start: "22:00", end: "07:00" });
    expect(json.overrides).toMatchObject({ quietHours: { mode: "inherit" }, escalationEmail: null, version: 0 });
    expect(json.effective).toEqual({
      quietHours: { start: "22:00", end: "07:00" },
      escalationEmail: "care@thinnr.com",
      source: { quietHours: "hq", escalationEmail: "hq" },
    });
  });

  it("office overrides take precedence over HQ defaults for exactly the overridable fields", async () => {
    await putSettings({ defaultQuietHours: { start: "22:00", end: "07:00" }, escalationEmail: "care@thinnr.com", outreachDailyCap: 50 });
    const custom = await putOverrides({ quietHours: { mode: "custom", start: "20:00", end: "09:00" }, escalationEmail: "Front@Riverside.com" });
    expect(custom.status).toBe(200);
    expect(custom.json.effective).toEqual({
      quietHours: { start: "20:00", end: "09:00" },
      escalationEmail: "front@riverside.com",
      source: { quietHours: "office", escalationEmail: "office" },
    });
    expect(custom.json.overrides).toMatchObject({ version: 1, updatedByName: "Dr. River" });
    // HQ default stays visible beside the effective value; non-overridable policy is HQ's.
    expect(custom.json.hq.defaultQuietHours).toEqual({ start: "22:00", end: "07:00" });
    expect(custom.json.hq.outreachDailyCap).toBe(50);

    // "none" is an explicit override: no quiet hours even though HQ has them.
    const none = await putOverrides({ expectedVersion: 1, quietHours: { mode: "none" }, escalationEmail: null });
    expect(none.json.effective).toEqual({ quietHours: null, escalationEmail: "care@thinnr.com", source: { quietHours: "office", escalationEmail: "hq" } });
    // Back to inherit: HQ's window returns.
    const inherit = await putOverrides({ expectedVersion: 2, quietHours: { mode: "inherit" }, escalationEmail: null });
    expect(inherit.json.effective.quietHours).toEqual({ start: "22:00", end: "07:00" });
    expect(inherit.json.overrides.version).toBe(3);
  });

  it("validates overrides, versions them, and audits field-level changes with the office id", async () => {
    expect((await putOverrides({ quietHours: { mode: "custom", start: "20:00" }, escalationEmail: null })).status).toBe(400);
    expect((await putOverrides({ quietHours: { mode: "custom", start: "20:00", end: "20:00" }, escalationEmail: null })).status).toBe(400);
    expect((await putOverrides({ quietHours: { mode: "inherit" }, escalationEmail: "nope" })).status).toBe(400);
    expect((await putOverrides({ quietHours: { mode: "sometimes" }, escalationEmail: null })).status).toBe(400);
    expect(mocks.audit).not.toHaveBeenCalled();

    const saved = await putOverrides({ quietHours: { mode: "none" }, escalationEmail: "front@riverside.com" });
    expect(saved.status).toBe(200);
    const fields = mocks.audit.mock.calls.map(([input]) => input.metadata.field).sort();
    expect(fields).toEqual(["escalationEmail", "quietHours"]);
    expect(mocks.audit.mock.calls[0][0]).toMatchObject({
      action: "office_policy_override_updated", actorKind: "provider", providerId: "prov-1",
      targetKind: "office_policy_overrides", targetId: "prov-1",
      metadata: { section: "office_overrides", version: 1 },
    });
    const stale = await putOverrides({ expectedVersion: 0, quietHours: { mode: "inherit" }, escalationEmail: null });
    expect(stale.status).toBe(409);
    expect(db.overrides.get("prov-1")?.quiet_hours_set).toBe(true);
  });

  it("refuses writes for locked or unavailable offices and passes the scope's status through", async () => {
    mocks.scope.mockResolvedValueOnce({ kind: "denied", status: 423, message: "This office is locked." });
    const locked = await putOverrides({ quietHours: { mode: "inherit" }, escalationEmail: null });
    expect(locked.status).toBe(423);
    expect(mocks.scope).toHaveBeenLastCalledWith(expect.objectContaining({ requireUnlocked: true, hqPermission: "provider_manage" }));
    mocks.scope.mockResolvedValueOnce({ kind: "denied", status: 404, message: "Office unavailable." });
    expect((await fetch(`${base}/office/settings`, { headers: OFFICE })).status).toBe(404);
    expect(mocks.scope).toHaveBeenLastCalledWith(expect.objectContaining({ requireUnlocked: false, hqPermission: "provider_read" }));
  });
});
