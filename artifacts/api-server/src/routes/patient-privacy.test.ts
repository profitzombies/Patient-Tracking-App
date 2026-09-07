/**
 * Patient privacy routes over HTTP against an in-memory Supabase double:
 * consent gating and versioning, export request → archive → download → 410,
 * scoping between patients, and the deletion request / cancel lifecycle.
 * The export worker runs for real against the fake storage so the archive
 * contents are asserted here too.
 */
import express from "express";
import JSZip from "jszip";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, fakeUuid } from "../privacy/fake-supabase";

const mocks = vi.hoisted(() => {
  // Every request here comes from loopback; lift the per-IP write burst.
  process.env.PATIENT_PRIVACY_WRITE_BURST = "1000";
  return {
  resolvePatient: vi.fn(),
  enqueue: vi.fn(),
  saved: new Map<string, { buffer: Buffer; contentType: string }>(),
  supabase: null as unknown as ReturnType<typeof import("../privacy/fake-supabase").createFakeSupabase>,
  };
});
vi.mock("../lib/patient-auth", () => ({ resolvePatient: mocks.resolvePatient }));
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: (method: string, path: string, body?: unknown, prefer?: string) => mocks.supabase.handler(method, path, body, prefer),
}));
vi.mock("../notifications/store", () => ({ supabaseNotificationStore: { enqueue: mocks.enqueue } }));
vi.mock("../lib/objectStorage", () => ({
  objectStorage: {
    async saveBuffer(objectPath: string, buffer: Buffer, contentType: string) {
      mocks.saved.set(objectPath, { buffer, contentType });
    },
    async signedDownloadURL(objectPath: string, ttl: number) {
      return `https://signed.example/${encodeURIComponent(objectPath)}?ttl=${ttl}`;
    },
    async deleteObjectStrict(objectPath: string) {
      mocks.saved.delete(objectPath);
    },
    async deletePrefixStrict(prefix: string) {
      let n = 0;
      for (const key of [...mocks.saved.keys()]) if (key.startsWith(prefix)) { mocks.saved.delete(key); n += 1; }
      return n;
    },
    async entityFile(objectPath: string) {
      const hit = mocks.saved.get(objectPath);
      if (!hit) throw new Error("missing object");
      return { download: async () => [hit.buffer] };
    },
  },
}));

mocks.supabase = createFakeSupabase();

import router from "./patient-privacy";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";
import { drainPatientExports, sweepExpiredPatientExports } from "../privacy/exports";

const P1 = fakeUuid(1);
const P2 = fakeUuid(2);
let server: http.Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  mocks.supabase.reset();
  mocks.saved.clear();
  mocks.enqueue.mockReset().mockResolvedValue({ id: "n-1" });
  mocks.resolvePatient.mockReset().mockResolvedValue({ ok: true, patientId: P1, authUserId: "auth-1" });
  mocks.supabase.tables.patients.push(
    { id: P1, provider_id: "office-1", auth_user_id: "auth-1", activation_status: "activated", program_id: "thinnr", program_start_date: "2026-06-01", first_name: "Pat", last_name: "Example", email: "pat@example.com", deletion_requested_at: null },
    { id: P2, provider_id: "office-1", auth_user_id: "auth-2", activation_status: "activated", program_id: "glp", first_name: "Other", deletion_requested_at: null },
  );
  for (const table of ["patient_diary_entries", "patient_water_days", "patient_target_overrides", "patient_food_prefs", "patient_custom_foods", "patient_saved_recipes", "patient_check_ins", "patient_health_measurements", "patient_body_measurements", "patient_staff_weights", "patient_medications", "patient_medication_dose_logs", "patient_progress_photos", "patient_media", "patient_chat_conversations", "patient_chat_messages", "patient_flags"]) {
    mocks.supabase.tables[table] = [];
  }
  mocks.supabase.tables.patient_diary_entries.push(
    { patient_id: P1, entry_id: "e1", date_key: "2026-09-01", name: "Eggs", calories: 140 },
    { patient_id: P2, entry_id: "e2", date_key: "2026-09-01", name: "SECRET OTHER FOOD", calories: 900 },
  );
  mocks.supabase.tables.patient_progress_photos.push({ patient_id: P1, photo_id: "ph1", date_key: "2026-09-01", object_path: `/objects/patient-media/${P1}/photo-1.jpg` });
  mocks.supabase.tables.patient_flags.push({ patient_id: P1, onboarding_answers: { goal: "lose", password: "hunter2" }, notification_prefs: {} });
  mocks.supabase.tables.patient_medications.push(
    { id: fakeUuid(701), patient_id: P1, name: "THINNR Protocol drops", form: "drops", schedule_kind: "daily", times: ["08:00"], start_date: "2026-09-01" },
    { id: fakeUuid(702), patient_id: P2, name: "SECRET OTHER MED", form: "other", schedule_kind: "daily", times: ["08:00"], start_date: "2026-09-01" },
  );
  mocks.supabase.tables.patient_medication_dose_logs.push(
    { id: fakeUuid(711), patient_id: P1, medication_id: fakeUuid(701), due_date: "2026-09-01", due_time: "08:00", status: "taken" },
    { id: fakeUuid(712), patient_id: P2, medication_id: fakeUuid(702), due_date: "2026-09-01", due_time: "08:00", status: "taken" },
  );
  mocks.supabase.tables.patient_chat_conversations.push({ id: fakeUuid(501), patient_id: P1, thread: "coach" });
  mocks.supabase.tables.patient_chat_messages.push({ conversation_id: fakeUuid(501), client_id: "m1", seq: 1, role: "user", text: "hello coach", photo: { path: `/objects/patient-media/${P1}/chat-1.jpg` } });
  mocks.saved.set(`/objects/patient-media/${P1}/photo-1.jpg`, { buffer: Buffer.from("PHOTO-BYTES"), contentType: "image/jpeg" });
  mocks.saved.set(`/objects/patient-media/${P1}/chat-1.jpg`, { buffer: Buffer.from("CHAT-BYTES"), contentType: "image/jpeg" });
});

async function call(path: string, method = "GET", body?: unknown) {
  return fetch(base + path, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer patient-jwt", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 200)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const consentBody = (overrides: Record<string, unknown> = {}) => ({
  policyVersion: CONSENT_POLICY_VERSION, terms: true, privacy: true, healthData: true, photoAnalysis: true, appVersion: "1.4.0", platform: "ios", ...overrides,
});

describe("consent", () => {
  it("starts unsatisfied, records the current version, and reports it in the privacy state", async () => {
    let res = await call("/patient-data/privacy");
    expect(res.status).toBe(200);
    let body = await res.json() as { consent: Record<string, unknown>; export: unknown; deletion: unknown };
    expect(body.consent).toEqual({ requiredVersion: CONSENT_POLICY_VERSION, recordedVersion: null, satisfied: false, photoAnalysis: null, recordedAt: null });
    expect(body.export).toBeNull();
    expect(body.deletion).toBeNull();

    res = await call("/patient-data/consent", "PUT", consentBody());
    expect(res.status).toBe(200);
    const saved = await res.json() as { consent: Record<string, unknown> };
    expect(saved.consent).toMatchObject({ recordedVersion: CONSENT_POLICY_VERSION, satisfied: true, photoAnalysis: true });
    expect(mocks.supabase.tables.patient_consents).toHaveLength(1);
    expect(mocks.supabase.tables.patient_consents[0]).toMatchObject({ patient_id: P1, policy_version: CONSENT_POLICY_VERSION, app_version: "1.4.0", platform: "ios", health_data_accepted: true });

    body = await (await call("/patient-data/privacy")).json() as typeof body;
    expect(body.consent).toMatchObject({ satisfied: true, recordedVersion: CONSENT_POLICY_VERSION });
    expect(mocks.supabase.tables.admin_audit_events.map((e) => e.p_action)).toEqual(["patient_consent_recorded"]);
    expect(mocks.supabase.tables.admin_audit_events[0]).toMatchObject({ p_actor_kind: "patient", p_actor_user_id: "auth-1", p_target_id: P1 });
  });

  it("rejects missing required agreements and stale policy versions, and re-recording updates the same row", async () => {
    expect((await call("/patient-data/consent", "PUT", consentBody({ healthData: false }))).status).toBe(400);
    expect((await call("/patient-data/consent", "PUT", consentBody({ terms: undefined }))).status).toBe(400);
    const stale = await call("/patient-data/consent", "PUT", consentBody({ policyVersion: "2020-01-01" }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "POLICY_VERSION_OUTDATED", requiredVersion: CONSENT_POLICY_VERSION });
    expect(mocks.supabase.tables.patient_consents).toHaveLength(0);
    // An older recorded version leaves the patient unsatisfied until the current one lands.
    mocks.supabase.tables.patient_consents.push({ id: "c-old", patient_id: P1, policy_version: "2020-01-01", terms_accepted: true, privacy_accepted: true, health_data_accepted: true, photo_analysis_accepted: false, recorded_at: "2020-01-02T00:00:00Z" });
    let body = await (await call("/patient-data/privacy")).json() as { consent: Record<string, unknown> };
    expect(body.consent).toMatchObject({ satisfied: false, recordedVersion: "2020-01-01", photoAnalysis: false });
    await call("/patient-data/consent", "PUT", consentBody({ photoAnalysis: false }));
    await call("/patient-data/consent", "PUT", consentBody({ photoAnalysis: true }));
    expect(mocks.supabase.tables.patient_consents.filter((c) => c.policy_version === CONSENT_POLICY_VERSION)).toHaveLength(1);
    body = await (await call("/patient-data/privacy")).json() as typeof body;
    expect(body.consent).toMatchObject({ satisfied: true, photoAnalysis: true });
  });

  it("is closed to anyone without a linked patient row", async () => {
    mocks.resolvePatient.mockResolvedValue({ ok: false, status: 403, error: "This account is not linked to a patient record." });
    for (const [path, method, body] of [
      ["/patient-data/privacy", "GET", undefined],
      ["/patient-data/consent", "PUT", consentBody()],
      ["/patient-data/export", "POST", undefined],
      ["/patient-data/deletion", "POST", { confirm: "DELETE" }],
      ["/patient-data/deletion", "DELETE", undefined],
    ] as const) {
      expect((await call(path, method, body)).status, `${method} ${path}`).toBe(403);
    }
    expect(mocks.supabase.tables.patient_consents).toHaveLength(0);
    expect(mocks.supabase.tables.patient_deletion_requests).toHaveLength(0);
  });
});

describe("data export", () => {
  it("queues one job at a time, builds a scoped archive, notifies, signs a short download, and expires", async () => {
    let res = await call("/patient-data/export", "POST");
    expect(res.status).toBe(202);
    const queued = (await res.json() as { export: { id: string; status: string; expiresAt: string } }).export;
    expect(queued.status === "queued" || queued.status === "running" || queued.status === "ready").toBe(true);
    // The route kicks the drain; wait for it and make sure a second request while in flight is refused.
    await drainPatientExports();
    const ready = (await (await call("/patient-data/export")).json() as { export: Record<string, unknown> }).export;
    expect(ready).toMatchObject({ id: queued.id, status: "ready", error: null });
    expect(Number(ready.sizeBytes)).toBeGreaterThan(0);
    const row = mocks.supabase.tables.patient_data_exports[0];
    expect(String(row.object_path)).toMatch(new RegExp(`^/objects/patient-media/${P1}/export-[0-9a-f-]{36}\\.zip$`));
    expect(mocks.saved.get(String(row.object_path))?.contentType).toBe("application/zip");

    // Archive contents: every section present, only P1's rows, password stripped, media bytes included.
    const zip = await JSZip.loadAsync(mocks.saved.get(String(row.object_path))!.buffer);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(expect.arrayContaining([
      "README.txt", "profile.json", "consents.json", "preferences.json", "diary.json", "water.json", "targets.json", "library.json",
      "check-ins.json", "measurements.json", "medications.json", "photos.json", "chat.json", "media.json", "media/photo-1.jpg", "media/chat-1.jpg",
    ]));
    const diary = JSON.parse(await zip.file("diary.json")!.async("string")) as Array<{ name: string }>;
    expect(diary.map((d) => d.name)).toEqual(["Eggs"]);
    const medications = JSON.parse(await zip.file("medications.json")!.async("string")) as { list: Array<{ name: string }>; doseLogs: Array<{ status: string }> };
    expect(medications.list.map((m) => m.name)).toEqual(["THINNR Protocol drops"]);
    expect(medications.doseLogs.map((d) => d.status)).toEqual(["taken"]);
    const all = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => zip.file(n)!.async("string")));
    expect(all.join("\n")).not.toMatch(/SECRET OTHER FOOD|SECRET OTHER MED|hunter2/);
    expect(await zip.file("preferences.json")!.async("string")).toContain('"goal": "lose"');
    expect(await zip.file("media/photo-1.jpg")!.async("string")).toBe("PHOTO-BYTES");
    const chat = JSON.parse(await zip.file("chat.json")!.async("string")) as Array<{ messages: Array<{ text: string }> }>;
    expect(chat[0].messages[0].text).toBe("hello coach");
    expect(JSON.parse(await zip.file("profile.json")!.async("string"))).toMatchObject({ id: P1, first_name: "Pat" });

    // Ready notification rides the account category with a dedupe key; audit trail complete.
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({ patientId: P1, category: "account", kind: "data_export_ready", dedupeKey: `data_export_ready:${queued.id}` });
    expect(mocks.supabase.tables.admin_audit_events.map((e) => e.p_action)).toEqual(["patient_export_requested", "patient_export_ready"]);

    // Download: signed for five minutes, counted, audited.
    res = await call(`/patient-data/export/${queued.id}/download-url`);
    expect(res.status).toBe(200);
    const link = await res.json() as { url: string; expiresInSeconds: number; fileName: string };
    expect(link.expiresInSeconds).toBe(300);
    expect(link.url).toContain("ttl=300");
    expect(link.fileName).toMatch(/\.zip$/);
    expect(mocks.supabase.tables.patient_data_exports[0].download_count).toBe(1);

    // Another patient cannot see or download it.
    mocks.resolvePatient.mockResolvedValue({ ok: true, patientId: P2, authUserId: "auth-2" });
    expect((await call(`/patient-data/export/${queued.id}/download-url`)).status).toBe(404);
    expect((await (await call("/patient-data/export")).json() as { export: unknown }).export).toBeNull();
    mocks.resolvePatient.mockResolvedValue({ ok: true, patientId: P1, authUserId: "auth-1" });

    // Expiry: the sweep deletes the archive and the link answers 410.
    mocks.supabase.tables.patient_data_exports[0].expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await call(`/patient-data/export/${queued.id}/download-url`)).status).toBe(410);
    const swept = await sweepExpiredPatientExports();
    expect(swept.expired).toBe(1);
    expect(mocks.saved.has(String(row.object_path))).toBe(false);
    expect(mocks.supabase.tables.patient_data_exports[0]).toMatchObject({ status: "expired", object_path: null });
    const latest = (await (await call("/patient-data/export")).json() as { export: { status: string } }).export;
    expect(latest.status).toBe("expired");
    // A new request is allowed once the old one is terminal.
    expect((await call("/patient-data/export", "POST")).status).toBe(202);
  });

  it("refuses a second export while one is in flight and records a failed build honestly", async () => {
    mocks.supabase.tables.patient_data_exports.push({ id: fakeUuid(700), patient_id: P1, status: "running", expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: new Date().toISOString(), attempts: 1, download_count: 0, object_path: null, size_bytes: null, error: null, started_at: null, completed_at: null, notified_at: null, last_downloaded_at: null });
    const res = await call("/patient-data/export", "POST");
    expect(res.status).toBe(409);
    expect((await call(`/patient-data/export/${fakeUuid(700)}/download-url`)).status).toBe(409);
    // A failing read marks the job failed with a short, url-free error and no notification.
    mocks.supabase.tables.patient_data_exports[0].status = "queued";
    mocks.supabase.failNext = { match: /GET \/rest\/v1\/patient_diary_entries/, status: 500 };
    await drainPatientExports();
    expect(mocks.supabase.tables.patient_data_exports[0]).toMatchObject({ status: "failed" });
    expect(String(mocks.supabase.tables.patient_data_exports[0].error)).toMatch(/diary read failed/);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    const latest = (await (await call("/patient-data/export")).json() as { export: { status: string; error: string } }).export;
    expect(latest).toMatchObject({ status: "failed" });
    expect(latest.error).toMatch(/diary/);
  });
});

describe("account deletion", () => {
  it("requires typed confirmation, schedules a grace period, surfaces it, and cancels on request", async () => {
    expect((await call("/patient-data/deletion", "POST", { confirm: "yes" })).status).toBe(400);
    process.env.PATIENT_DELETION_GRACE_DAYS = "3";
    const res = await call("/patient-data/deletion", "POST", { confirm: "DELETE" });
    delete process.env.PATIENT_DELETION_GRACE_DAYS;
    expect(res.status).toBe(202);
    const body = await res.json() as { deletion: { status: string; requestedAt: string; purgeAfter: string } };
    expect(body.deletion.status).toBe("pending");
    const graceMs = Date.parse(body.deletion.purgeAfter) - Date.parse(body.deletion.requestedAt);
    expect(Math.round(graceMs / 86_400_000)).toBe(3);
    expect(mocks.supabase.tables.patients.find((p) => p.id === P1)?.deletion_requested_at).not.toBeNull();
    // Privacy state (and therefore the app's hydration) shows the pending deletion.
    const state = await (await call("/patient-data/privacy")).json() as { deletion: { status: string } | null };
    expect(state.deletion?.status).toBe("pending");
    // Asking again is idempotent.
    expect((await call("/patient-data/deletion", "POST", { confirm: "DELETE" })).status).toBe(202);
    expect(mocks.supabase.tables.patient_deletion_requests).toHaveLength(1);
    // Cancel restores the account; a second cancel is a harmless false.
    let cancel = await call("/patient-data/deletion", "DELETE");
    expect(await cancel.json()).toEqual({ cancelled: true, deletion: null });
    expect(mocks.supabase.tables.patients.find((p) => p.id === P1)?.deletion_requested_at).toBeNull();
    cancel = await call("/patient-data/deletion", "DELETE");
    expect(await cancel.json()).toEqual({ cancelled: false, deletion: null });
    expect(mocks.supabase.tables.admin_audit_events.map((e) => e.p_action)).toEqual(["patient_deletion_requested", "patient_deletion_cancelled"]);
    expect(mocks.supabase.tables.admin_audit_events[0]).toMatchObject({ p_actor_kind: "patient", p_provider_id: "office-1", p_target_id: P1 });
  });
});
