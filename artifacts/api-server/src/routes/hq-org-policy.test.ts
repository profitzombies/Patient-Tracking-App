/**
 * Organization policy contract: HQ settings validation bounds, field-level
 * audit metadata, versioning (optimistic concurrency), section last-changed
 * metadata, and office override precedence — against an in-memory stand-in
 * for the two Supabase tables.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
    retention_clinical_record_days: 2555,
    export_link_hours: 24,
    staff_idle_timeout_minutes: 15,
    hq_idle_timeout_minutes: 15,
    cold_archive_enabled: false,
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

const fullRetention = { chatTranscriptDays: 730, progressPhotoDays: 730, notificationHistoryDays: 180, auditEventDays: 2555, jobRunDays: 90, signInDays: 180, webhookEventDays: 365, clinicalRecordDays: 2555 };

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
      retention: { chatTranscriptDays: 730, progressPhotoDays: 730, notificationHistoryDays: 180, auditEventDays: 2555, jobRunDays: 90, signInDays: 180, webhookEventDays: 365, clinicalRecordDays: 2555 },
      exportLinkHours: 24,
      staffIdleTimeoutMinutes: 15,
      hqIdleTimeoutMinutes: 15,
      coldArchiveEnabled: false,
      version: 1,
      sections: { organization: null, coach: null, notifications: null, conversations: null, retention: null, security: null, archive: null },
      // The cold storage status rides the settings read: knob state plus the
      // ledger's last day / backlog (null when the ledger cannot be read).
      coldArchive: { storageConfigured: false, lastArchivedDay: null, daysPending: null },
    });
  });

  describe("cold archive toggle", () => {
    const saved = process.env.COLD_ARCHIVE_OBJECT_DIR;
    afterEach(() => {
      if (saved === undefined) delete process.env.COLD_ARCHIVE_OBJECT_DIR;
      else process.env.COLD_ARCHIVE_OBJECT_DIR = saved;
    });

    it("refuses to turn the archive on while the storage prefix is not configured, and audits nothing", async () => {
      delete process.env.COLD_ARCHIVE_OBJECT_DIR;
      const { status, json } = await putSettings({ coldArchiveEnabled: true });
      expect(status).toBe(400);
      expect(json.error).toContain("COLD_ARCHIVE_OBJECT_DIR");
      expect(db.settings.version).toBe(1);
      expect(db.settings.cold_archive_enabled).toBe(false);
      expect(mocks.audit).not.toHaveBeenCalled();
      // Turning it off (or leaving it off) never needs the prefix.
      expect((await putSettings({ coldArchiveEnabled: false })).status).toBe(200);
    });

    it("turns on once the prefix is set, stamps only the archive section, audits the change, and reports the knob", async () => {
      process.env.COLD_ARCHIVE_OBJECT_DIR = "/bucket-1/cold";
      const { status, json } = await putSettings({ expectedVersion: 1, coldArchiveEnabled: true });
      expect(status).toBe(200);
      expect(json).toMatchObject({ coldArchiveEnabled: true, version: 2, coldArchive: { storageConfigured: true, lastArchivedDay: null, daysPending: null } });
      expect(json.sections.archive).toMatchObject({ changedByName: "Avery Admin" });
      expect(json.sections.retention).toBeNull();
      expect(db.settings.cold_archive_enabled).toBe(true);
      expect(mocks.audit).toHaveBeenCalledTimes(1);
      expect(mocks.audit.mock.calls[0][0]).toMatchObject({ action: "hq_settings_updated", metadata: { section: "archive", from: false, to: true, version: 2 } });
      invalidateOrgPolicyCache();
      expect((await loadOrgPolicy()).coldArchiveEnabled).toBe(true);
      // Off again works with the prefix still set, and once it is gone.
      delete process.env.COLD_ARCHIVE_OBJECT_DIR;
      const off = await putSettings({ coldArchiveEnabled: false });
      expect(off.status).toBe(200);
      expect(off.json).toMatchObject({ coldArchiveEnabled: false, version: 3, coldArchive: { storageConfigured: false } });
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
    // Compliance floors: audit events may not drop below 6 years, the clinical record below 5
    // (the request schema and the merge share the same bounds; either one refusing is a 400).
    expect((await putSettings({ retention: { ...fullRetention, auditEventDays: 2189 } })).status).toBe(400);
    expect((await putSettings({ retention: { ...fullRetention, auditEventDays: 365 } })).status).toBe(400);
    expect((await putSettings({ retention: { ...fullRetention, clinicalRecordDays: 1824 } })).status).toBe(400);
    expect((await putSettings({ retention: { ...fullRetention, clinicalRecordDays: 3651 } })).status).toBe(400);
    expect((await putSettings({ retention: { ...fullRetention, clinicalRecordDays: 2555.5 } })).status).toBe(400);
    expect((await putSettings({ defaultQuietHours: { start: "22:00", end: "22:00" } })).status).toBe(400);
    expect((await putSettings({ defaultQuietHours: { start: "25:00", end: "07:00" } })).status).toBe(400);
    expect((await putSettings({ escalationEmail: "not-an-email" })).status).toBe(400);
    expect((await putSettings({ defaultTimezone: "Mars/Olympus" })).status).toBe(400);
    expect((await putSettings({ unknownField: 1 })).status).toBe(400);
    expect((await putSettings({ staffIdleTimeoutMinutes: 4 })).status).toBe(400);
    expect((await putSettings({ staffIdleTimeoutMinutes: 121 })).status).toBe(400);
    expect((await putSettings({ hqIdleTimeoutMinutes: 0 })).status).toBe(400);
    expect((await putSettings({ hqIdleTimeoutMinutes: 12.5 })).status).toBe(400);
    expect(db.settings.version).toBe(1);
  });

  it("saves the idle timeouts through the security section within 5–120 minutes and stamps only that section", async () => {
    const { status, json } = await putSettings({ staffIdleTimeoutMinutes: 5, hqIdleTimeoutMinutes: 120 });
    expect(status).toBe(200);
    expect(json).toMatchObject({ staffIdleTimeoutMinutes: 5, hqIdleTimeoutMinutes: 120, version: 2 });
    expect(db.settings).toMatchObject({ staff_idle_timeout_minutes: 5, hq_idle_timeout_minutes: 120 });
    expect(json.sections.security).toMatchObject({ changedByName: "Avery Admin" });
    expect(json.sections.retention).toBeNull();
    const fields = mocks.audit.mock.calls.map(([input]) => [input.metadata.section, input.metadata.field, input.metadata.from, input.metadata.to]);
    expect(fields).toEqual(expect.arrayContaining([
      ["security", "staffIdleTimeoutMinutes", 15, 5],
      ["security", "hqIdleTimeoutMinutes", 15, 120],
    ]));
  });

  it("accepts the boundary values", async () => {
    const { status, json } = await putSettings({
      outreachCooldownDays: 90, outreachDailyCap: 1, conversationAutoCloseDays: 365, exportLinkHours: 168,
      retention: { chatTranscriptDays: 30, progressPhotoDays: 3650, notificationHistoryDays: 7, auditEventDays: 2190, jobRunDays: 7, signInDays: 30, webhookEventDays: 3650, clinicalRecordDays: 1825 },
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ outreachCooldownDays: 90, outreachDailyCap: 1, conversationAutoCloseDays: 365, exportLinkHours: 168 });
    expect(json.retention).toEqual({ chatTranscriptDays: 30, progressPhotoDays: 3650, notificationHistoryDays: 7, auditEventDays: 2190, jobRunDays: 7, signInDays: 30, webhookEventDays: 3650, clinicalRecordDays: 1825 });
    expect(db.settings).toMatchObject({ retention_job_run_days: 7, retention_sign_in_days: 30, retention_webhook_event_days: 3650, retention_audit_days: 2190, retention_clinical_record_days: 1825 });
    // Upper boundaries land too.
    const upper = await putSettings({ expectedVersion: 2, retention: { ...fullRetention, auditEventDays: 3650, clinicalRecordDays: 3650 } });
    expect(upper.status).toBe(200);
    expect(upper.json.retention).toMatchObject({ auditEventDays: 3650, clinicalRecordDays: 3650 });
  });

  it("carries a separate software-only agreement and included period beside the reseller ones", async () => {
    const read = await (await fetch(`${base}/hq/settings`, { headers: HQ })).json() as Record<string, any>;
    expect(read.accessBilling).toMatchObject({ includedPeriodDays: 365, softwareIncludedPeriodDays: 30 });
    expect(read.accessBilling.softwareAgreementText).toMatch(/software/i);
    expect(read.accessBilling.softwareAgreementText).not.toBe(read.accessBilling.disclosureText);

    // The section saves whole (the contract requires every reseller field).
    const section = (overrides: Record<string, unknown>) => ({ ...read.accessBilling, ...overrides });
    const saved = await putSettings({ accessBilling: section({ softwareIncludedPeriodDays: 45, softwareAgreementText: "  Software-only terms the practice accepts.  " }) });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.accessBilling).toMatchObject({
      includedPeriodDays: 365, softwareIncludedPeriodDays: 45, softwareAgreementText: "Software-only terms the practice accepts.",
    });
    expect(db.settings).toMatchObject({ access_included_period_days: 365, access_software_included_period_days: 45, access_software_agreement_text: "Software-only terms the practice accepts." });
    const audited = mocks.audit.mock.calls.map(([input]) => input.metadata);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ section: "accessBilling", field: "accessBilling" });
    expect(String(audited[0].to)).toContain('"softwareIncludedPeriodDays":45');

    expect((await putSettings({ expectedVersion: 2, accessBilling: section({ softwareIncludedPeriodDays: 1096 }) })).status).toBe(400);
    expect((await putSettings({ expectedVersion: 2, accessBilling: section({ softwareIncludedPeriodDays: -1 }) })).status).toBe(400);
    expect((await putSettings({ expectedVersion: 2, accessBilling: section({ softwareAgreementText: "short" }) })).status).toBe(400);
    const zero = await putSettings({ expectedVersion: 2, accessBilling: section({ softwareIncludedPeriodDays: 0 }) });
    expect(zero.json, JSON.stringify(zero.json)).toMatchObject({ accessBilling: { softwareIncludedPeriodDays: 0 } });
    // A client that predates the software fields leaves them untouched.
    const { softwareIncludedPeriodDays: _d, softwareAgreementText: _t, ...legacy } = read.accessBilling;
    const old = await putSettings({ expectedVersion: 3, accessBilling: { ...legacy, gracePeriodDays: 9 } });
    expect(old.json.accessBilling).toMatchObject({ gracePeriodDays: 9, softwareIncludedPeriodDays: 0 });
  });

  it("raises a stored audit window below the 6-year floor on read and writes the floor on the next save", async () => {
    db.settings.retention_audit_days = 365;
    const read = await fetch(`${base}/hq/settings`, { headers: HQ });
    expect((await read.json() as Record<string, any>).retention.auditEventDays).toBe(2190);
    expect((await loadOrgPolicy({ fresh: true })).retention.auditEventDays).toBe(2190);
    // Offices see the floored value too.
    const office = await fetch(`${base}/office/settings`, { headers: { authorization: "Bearer office" } });
    expect((await office.json() as Record<string, any>).hq.retention.auditEventDays).toBe(2190);
    // A save of an unrelated field persists the raised value; the field audits as a change from the floor, not from 365.
    const { status, json } = await putSettings({ expectedVersion: 1, exportLinkHours: 48 });
    expect(status).toBe(200);
    expect(json.retention.auditEventDays).toBe(2190);
    expect(db.settings.retention_audit_days).toBe(2190);
    expect(mocks.audit.mock.calls.map(([input]) => input.metadata.field)).toEqual(["exportLinkHours"]);
    // A missing clinical record column (pre-migration row) reads as the 7-year default.
    delete db.settings.retention_clinical_record_days;
    invalidateOrgPolicyCache();
    const legacy = await fetch(`${base}/hq/settings`, { headers: HQ });
    expect((await legacy.json() as Record<string, any>).retention.clinicalRecordDays).toBe(2555);
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

    it("accepts TestFlight and Play testing links as interim store links", async () => {
      const TESTFLIGHT = "https://testflight.apple.com/join/AbCdEf12";
      const INTERNAL = "https://play.google.com/apps/internaltest/4700000000000000001";
      const { status, json } = await putSettings({ expectedVersion: 1, appStoreUrl: TESTFLIGHT, googlePlayUrl: INTERNAL });
      expect(status).toBe(200);
      expect(json).toMatchObject({ appStoreUrl: TESTFLIGHT, googlePlayUrl: INTERNAL });
      const closed = await putSettings({ expectedVersion: 2, googlePlayUrl: "https://play.google.com/apps/testing/com.thinnr.app" });
      expect(closed.status).toBe(200);
    });

    it.each([
      ["appStoreUrl", "https://example.com/app"],
      ["appStoreUrl", "http://apps.apple.com/us/app/thinnr/id1"],
      ["appStoreUrl", "https://testflight.apple.com/"],
      ["googlePlayUrl", "https://play.google.com/apps/"],
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
    expect(json.overrides.idleTimeoutMinutes).toBeNull();
    expect(json.effective).toEqual({
      quietHours: { start: "22:00", end: "07:00" },
      escalationEmail: "care@thinnr.com",
      idleTimeoutMinutes: 15,
      source: { quietHours: "hq", escalationEmail: "hq", idleTimeoutMinutes: "hq" },
    });
  });

  it("lets an office shorten the idle timeout but never lengthen it past HQ's staff value", async () => {
    await putSettings({ staffIdleTimeoutMinutes: 20 });
    mocks.audit.mockClear();
    const longer = await putOverrides({ quietHours: { mode: "inherit" }, escalationEmail: null, idleTimeoutMinutes: 21 });
    expect(longer.status).toBe(400);
    expect(longer.json).toMatchObject({ field: "idleTimeoutMinutes", max: 20 });
    expect((await putOverrides({ quietHours: { mode: "inherit" }, escalationEmail: null, idleTimeoutMinutes: 4 })).status).toBe(400);
    expect((await putOverrides({ quietHours: { mode: "inherit" }, escalationEmail: null, idleTimeoutMinutes: "soon" })).status).toBe(400);
    expect(mocks.audit).not.toHaveBeenCalled();

    const shorter = await putOverrides({ quietHours: { mode: "inherit" }, escalationEmail: null, idleTimeoutMinutes: 10 });
    expect(shorter.status).toBe(200);
    expect(shorter.json.overrides.idleTimeoutMinutes).toBe(10);
    expect(shorter.json.effective.idleTimeoutMinutes).toBe(10);
    expect(shorter.json.effective.source.idleTimeoutMinutes).toBe("office");
    expect(db.overrides.get("prov-1")?.idle_timeout_minutes).toBe(10);
    expect(mocks.audit.mock.calls.map(([input]) => input.metadata)).toEqual([
      expect.objectContaining({ field: "idleTimeoutMinutes", from: null, to: "10 min" }),
    ]);

    // Matching HQ exactly is allowed (it is not longer), and reads as the HQ value.
    const same = await putOverrides({ expectedVersion: 1, quietHours: { mode: "inherit" }, escalationEmail: null, idleTimeoutMinutes: 20 });
    expect(same.status).toBe(200);
    expect(same.json.effective).toMatchObject({ idleTimeoutMinutes: 20, source: { idleTimeoutMinutes: "hq" } });

    // HQ later tightens below an office's stored override: HQ's shorter value wins on read.
    await putOverrides({ expectedVersion: 2, quietHours: { mode: "inherit" }, escalationEmail: null, idleTimeoutMinutes: 12 });
    await putSettings({ expectedVersion: 2, staffIdleTimeoutMinutes: 8 });
    const tightened = await fetch(`${base}/office/settings`, { headers: OFFICE });
    const json = await tightened.json() as Record<string, any>;
    expect(json.overrides.idleTimeoutMinutes).toBe(12);
    expect(json.effective).toMatchObject({ idleTimeoutMinutes: 8, source: { idleTimeoutMinutes: "hq" } });

    // Back to inheriting clears the column.
    const inherit = await putOverrides({ expectedVersion: 3, quietHours: { mode: "inherit" }, escalationEmail: null, idleTimeoutMinutes: null });
    expect(inherit.status).toBe(200);
    expect(db.overrides.get("prov-1")?.idle_timeout_minutes).toBeNull();
    expect(inherit.json.effective.source.idleTimeoutMinutes).toBe("hq");
  });

  it("office overrides take precedence over HQ defaults for exactly the overridable fields", async () => {
    await putSettings({ defaultQuietHours: { start: "22:00", end: "07:00" }, escalationEmail: "care@thinnr.com", outreachDailyCap: 50 });
    const custom = await putOverrides({ quietHours: { mode: "custom", start: "20:00", end: "09:00" }, escalationEmail: "Front@Riverside.com" });
    expect(custom.status).toBe(200);
    expect(custom.json.effective).toEqual({
      quietHours: { start: "20:00", end: "09:00" },
      escalationEmail: "front@riverside.com",
      idleTimeoutMinutes: 15,
      source: { quietHours: "office", escalationEmail: "office", idleTimeoutMinutes: "hq" },
    });
    expect(custom.json.overrides).toMatchObject({ version: 1, updatedByName: "Dr. River" });
    // HQ default stays visible beside the effective value; non-overridable policy is HQ's.
    expect(custom.json.hq.defaultQuietHours).toEqual({ start: "22:00", end: "07:00" });
    expect(custom.json.hq.outreachDailyCap).toBe(50);

    // "none" is an explicit override: no quiet hours even though HQ has them.
    const none = await putOverrides({ expectedVersion: 1, quietHours: { mode: "none" }, escalationEmail: null });
    expect(none.json.effective).toEqual({ quietHours: null, escalationEmail: "care@thinnr.com", idleTimeoutMinutes: 15, source: { quietHours: "office", escalationEmail: "hq", idleTimeoutMinutes: "hq" } });
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
