import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import bloodworkRouter from "../routes/bloodwork";
import { admitPatient } from "./authorization";
import { resetRecordAccessCache } from "../lib/record-access-audit";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";

type Row = Record<string, unknown>;
type AdminResult = { status: number; json: unknown; contentRange: string | null };

const mocks = vi.hoisted(() => ({
  fetchAuthUser: vi.fn(),
  supabaseAdmin: vi.fn(),
  resolveOfficeScope: vi.fn(),
  storage: {
    bloodworkUploadURL: vi.fn(),
    readObjectBounded: vi.fn(),
    saveBufferImmutable: vi.fn(),
    deleteObjectStrict: vi.fn(),
  },
  inspectBloodworkFile: vi.fn(),
  signalJob: vi.fn(),
  renderBloodworkPage: vi.fn(),
}));

vi.mock("../jobs/scheduler", () => ({ signalJob: mocks.signalJob }));
vi.mock("../lib/supabase-admin", () => ({
  fetchAuthUser: mocks.fetchAuthUser,
  supabaseAdmin: mocks.supabaseAdmin,
}));
vi.mock("../auth/office-scope", () => ({
  resolveOfficeScope: mocks.resolveOfficeScope,
  respondOfficeScopeDenied: vi.fn(),
}));
vi.mock("../lib/objectStorage", () => ({
  objectStorage: mocks.storage,
  ObjectNotFoundError: class ObjectNotFoundError extends Error {},
  ObjectTooLargeError: class ObjectTooLargeError extends Error {},
  UPLOAD_URL_TTL_SEC: 900,
}));
vi.mock("../bloodwork/documents", () => ({
  BLOODWORK_MAX_FILE_BYTES: 20_000_000,
  inspectBloodworkFile: mocks.inspectBloodworkFile,
  renderBloodworkPage: mocks.renderBloodworkPage,
  BloodworkDocumentError: class BloodworkDocumentError extends Error {},
}));

const PATIENT = "patient-a";
const OTHER_PATIENT = "patient-b";
const USER = "user-a";
const TOKEN = "token-a";
const REPORT = "00000000-0000-4000-8000-000000000003";
const CLIENT_FILE = "00000000-0000-4000-8000-000000000004";
const PDF_DRAFT = {
  clientRequestId: "00000000-0000-4000-8000-000000000001",
  title: "Synthetic admission report",
  reportDate: null,
  transcriptionConsent: true,
  files: [{ clientFileId: CLIENT_FILE, mimeType: "application/pdf", size: 10 }],
};

let reportState: Row | null;
let readAudits: Row[] = [];
let fileState: Row | null;

function result(json: unknown, status = 200): AdminResult {
  return { status, json, contentRange: null };
}

let patient: Row;
let flags: Row[];
let consents: Row[];
let server: http.Server;
let base = "";

function configureBackend(): void {
  mocks.fetchAuthUser.mockResolvedValue({ id: USER, email: null, phone: null });
  mocks.supabaseAdmin.mockImplementation(async (method: string, path: string, body?: Row) => {
    if (method === "GET" && path.includes("/rest/v1/patients?auth_user_id=eq.")) {
      const url = new URL(`http://fake${path}`);
      return result(url.searchParams.get("auth_user_id") === `eq.${USER}` ? [{ id: PATIENT }] : []);
    }
    if (method === "GET" && path.startsWith(`/rest/v1/patients?id=eq.${PATIENT}`)) {
      const url = new URL(`http://fake${path}`);
      const rows = patient && patientMatchesQuery(url) ? [patient] : [];
      return result(rows);
    }
    if (method === "GET" && path.includes("/rest/v1/patient_flags?")) {
      return result(flags);
    }
    if (method === "GET" && path.includes("/rest/v1/patient_consents?")) {
      return result(consents);
    }
    if (method === "GET" && path.includes("/rest/v1/patient_bloodwork_reports?")) {
      if (path.includes(`id=eq.${REPORT}`)) return result(reportState ? [reportState] : []);
      return result(reportState?.lifecycle_status === "committed" ? [reportState] : []);
    }
    if (method === "GET" && path.includes("/rest/v1/patient_bloodwork_files?")) {
      return result(fileState ? [fileState] : []);
    }
    if (method === "GET" && path.includes("/rest/v1/patient_bloodwork_results?")) {
      return result([]);
    }
    if (method === "PATCH" && path.includes("/rest/v1/patient_bloodwork_reports?")) {
      if (reportState?.lifecycle_status !== "committed" || reportState.extraction_status !== "completed") {
        return result([]);
      }
      Object.assign(reportState, body);
      return result([reportState]);
    }
    if (method === "POST" && path === "/rest/v1/rpc/bloodwork_create_report") {
      const manifest = (body?.p_manifest as Array<Row> | undefined) ?? [];
      const manifestFile = manifest[0] ?? {};
      reportState = {
        id: REPORT,
        patient_id: PATIENT,
        title: String(body?.p_title ?? "CBC"),
        report_date: body?.p_report_date ?? null,
        uploaded_at: "2026-09-01T00:00:00Z",
        version: 1,
        kind: "pdf",
        extraction_status: "queued",
        extraction_error: null,
        lifecycle_status: "staging",
      };
      fileState = {
        id: String(manifestFile.fileId),
        patient_id: PATIENT,
        report_id: REPORT,
        client_file_id: String(manifestFile.clientFileId ?? CLIENT_FILE),
        position: 0,
        declared_mime_type: "application/pdf",
        declared_size_bytes: 10,
        staging_object_path: `/objects/patients/${PATIENT}/bloodwork/staging/${REPORT}/${String(manifestFile.fileId)}`,
        object_path: null,
        mime_type: null,
        size_bytes: null,
        page_count: null,
        width: null,
        height: null,
      };
      return result({ reportId: REPORT, created: true });
    }
    if (method === "POST" && path === "/rest/v1/rpc/bloodwork_commit_report") {
      const files = (body?.p_files as Array<Row> | undefined) ?? [];
      if (reportState) reportState.lifecycle_status = "committed";
      if (fileState && files[0]) {
        Object.assign(fileState, {
          object_path: files[0].objectPath,
          mime_type: files[0].mimeType,
          size_bytes: files[0].size,
          page_count: files[0].pageCount,
          width: files[0].width,
          height: files[0].height,
          content_sha256: files[0].sha256,
        });
      }
      return result(true);
    }
    if (method === "POST" && path.startsWith("/rest/v1/storage_upload_intents")) {
      return result([]);
    }
    if (method === "POST" && path === "/rest/v1/rpc/record_admin_audit_event") {
      return result([]);
    }
    if (method === "POST" && path === "/rest/v1/rpc/record_admin_audit_read_event") {
      readAudits.push(body ?? {});
      return result([{ recorded: true, window_started_at: new Date().toISOString() }]);
    }
    throw new Error(`unexpected fake request: ${method} ${path}`);
  });
}

function patientMatchesQuery(url: URL): boolean {
  for (const [column, expected] of [
    ["id", PATIENT],
    ["auth_user_id", USER],
  ] as const) {
    const raw = url.searchParams.get(column);
    if (!raw) continue;
    if (raw.startsWith("eq.") && raw.slice(3) !== expected) return false;
  }
  const activation = url.searchParams.get("activation_status");
  if (activation?.startsWith("eq.") && String(patient.activation_status ?? "") !== activation.slice(3)) return false;
  const archived = url.searchParams.get("archived_at");
  if (archived === "is.null" && patient.archived_at != null) return false;
  const deletion = url.searchParams.get("deletion_requested_at");
  if (deletion === "is.null" && patient.deletion_requested_at != null) return false;
  const profile = url.searchParams.get("profile_completed_at");
  if (profile === "not.is.null" && patient.profile_completed_at == null) return false;
  const provider = url.searchParams.get("provider_id");
  if (provider?.startsWith("eq.") && String(patient.provider_id ?? "") !== provider.slice(3)) return false;
  return true;
}

async function api(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: response.status, json: { raw: text } };
  }
}

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use("/api", bloodworkRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  patient = {
    id: PATIENT,
    auth_user_id: USER,
    provider_id: "provider-a",
    activation_status: "activated",
    archived_at: null,
    deletion_requested_at: null,
    profile_completed_at: null,
  };
  flags = [{ patient_id: PATIENT, onboarding_complete: true }];
  consents = [{
    patient_id: PATIENT,
    policy_version: CONSENT_POLICY_VERSION,
    terms_accepted: true,
    privacy_accepted: true,
    health_data_accepted: true,
    photo_analysis_accepted: true,
    recorded_at: "2026-09-01T00:00:00Z",
  }];
  readAudits = [];
  resetRecordAccessCache();
  mocks.fetchAuthUser.mockReset();
  mocks.supabaseAdmin.mockReset();
  mocks.resolveOfficeScope.mockReset().mockResolvedValue({
    kind: "ok",
    scope: { providerId: "provider-a", actorUserId: "provider-user", actorKind: "provider" },
  });
  for (const mock of Object.values(mocks.storage)) mock.mockReset();
  mocks.inspectBloodworkFile.mockReset();
  mocks.signalJob.mockReset();
  mocks.renderBloodworkPage.mockReset().mockResolvedValue({
    bytes: Buffer.from("page"), mimeType: "image/png", width: 1, height: 1,
  });
  reportState = null;
  fileState = null;
  configureBackend();
  mocks.storage.bloodworkUploadURL.mockResolvedValue({
    uploadUrl: "https://upload.invalid/staged",
    objectPath: `/objects/patients/${PATIENT}/bloodwork/staging/report/file`,
  });
  mocks.storage.readObjectBounded.mockResolvedValue({ bytes: Buffer.alloc(10), sizeBytes: 10 });
  mocks.storage.saveBufferImmutable.mockResolvedValue(undefined);
  mocks.storage.deleteObjectStrict.mockResolvedValue(undefined);
  mocks.inspectBloodworkFile.mockResolvedValue({
    mimeType: "application/pdf",
    pageCount: 1,
    width: null,
    height: null,
    sha256: "a".repeat(64),
  });
});

describe("bloodwork admission", () => {
  it("records staff list and report reads as deduped record access, and nothing for the patient's own reads", async () => {
    reportState = {
      id: REPORT, patient_id: PATIENT, title: "CBC", report_date: null,
      uploaded_at: "2026-09-01T00:00:00Z", version: 1, kind: "pdf",
      extraction_status: "completed", extraction_error: null, lifecycle_status: "committed",
      reviewed_at: null, reviewed_by: null,
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    // Patient reading their own bloodwork: no record-access row.
    expect((await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: "patient-token" })).status).toBe(200);
    expect((await api("GET", `/api/bloodwork/patients/${PATIENT}/reports/${REPORT}`, { token: "patient-token" })).status).toBe(200);
    await settle();
    expect(readAudits).toEqual([]);

    mocks.fetchAuthUser.mockResolvedValue({ id: "provider-user", email: null, phone: null });
    expect((await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: "provider-token" })).status).toBe(200);
    expect((await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: "provider-token" })).status).toBe(200);
    expect((await api("GET", `/api/bloodwork/patients/${PATIENT}/reports/${REPORT}`, { token: "provider-token" })).status).toBe(200);
    expect((await api("GET", `/api/bloodwork/patients/${PATIENT}/reports/${REPORT}`, { token: "provider-token" })).status).toBe(200);
    await settle();
    expect(readAudits.map((row) => [row.p_action, row.p_actor_user_id, row.p_actor_kind, row.p_provider_id, row.p_target_id, row.p_dedupe_key, row.p_metadata])).toEqual([
      ["patient_bloodwork_viewed", "provider-user", "provider", "provider-a", PATIENT, `patient_bloodwork_viewed:patient:${PATIENT}`, {}],
      ["bloodwork_report_opened", "provider-user", "provider", "provider-a", PATIENT, `bloodwork_report_opened:patient:${PATIENT}:${REPORT}`, { reportId: REPORT }],
    ]);
  });

  it("allows staff to mark a completed report reviewed and clear the marker", async () => {
    reportState = {
      id: REPORT, patient_id: PATIENT, title: "CBC", report_date: null,
      uploaded_at: "2026-09-01T00:00:00Z", version: 1, kind: "pdf",
      extraction_status: "completed", extraction_error: null, lifecycle_status: "committed",
      reviewed_at: null, reviewed_by: null,
    };
    mocks.fetchAuthUser.mockResolvedValue({ id: "provider-user", email: null, phone: null });
    const path = `/api/bloodwork/patients/${PATIENT}/reports/${REPORT}/review`;
    const reviewed = await api("POST", path, { token: "provider-token", body: { reviewed: true } });
    expect(reviewed.status).toBe(200);
    expect(reviewed.json).toMatchObject({ reviewStatus: "reviewed" });
    expect(typeof reviewed.json.reviewedAt).toBe("string");
    expect(reportState.reviewed_by).toBe("provider-user");

    const cleared = await api("POST", path, { token: "provider-token", body: { reviewed: false } });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toMatchObject({ reviewStatus: "unreviewed", reviewedAt: null });
    expect(reportState.reviewed_at).toBeNull();
    expect(reportState.reviewed_by).toBeNull();
  });

  it("does not allow a patient actor to mark a report reviewed", async () => {
    const response = await api(
      "POST",
      `/api/bloodwork/patients/${PATIENT}/reports/${REPORT}/review`,
      { token: TOKEN, body: { reviewed: true } },
    );
    expect(response.status).toBe(403);
    expect(response.json).toEqual({ error: "Only your care team can mark a report reviewed." });
  });

  it("returns 404 when staff review targets a staging or incomplete report", async () => {
    reportState = {
      id: REPORT, patient_id: PATIENT, title: "CBC", report_date: null,
      uploaded_at: "2026-09-01T00:00:00Z", version: 1, kind: "pdf",
      extraction_status: "processing", extraction_error: null, lifecycle_status: "staging",
      reviewed_at: null, reviewed_by: null,
    };
    mocks.fetchAuthUser.mockResolvedValue({ id: "provider-user", email: null, phone: null });
    const response = await api(
      "POST",
      `/api/bloodwork/patients/${PATIENT}/reports/${REPORT}/review`,
      { token: "provider-token", body: { reviewed: true } },
    );
    expect(response.status).toBe(404);
  });

  it("persists the private admission receipt and prompts only after durable commit", async () => {
    const path = `/api/bloodwork/patients/${PATIENT}/reports`;
    await api("POST", path, { token: TOKEN, body: PDF_DRAFT });
    expect(mocks.signalJob).not.toHaveBeenCalled();
    mocks.signalJob.mockImplementation(() => {
      expect(reportState?.lifecycle_status).toBe("committed");
    });
    const committed = await api("POST", `${path}/${REPORT}/commit`, { token: TOKEN });
    expect(committed.status).toBe(200);
    expect(mocks.signalJob).toHaveBeenCalledWith("bloodwork-extraction");
    expect(fileState?.content_sha256).toBe("a".repeat(64));
    expect(JSON.stringify(committed.json)).not.toContain("sha256");
    await api("POST", `${path}/${REPORT}/commit`, { token: TOKEN });
    expect(mocks.inspectBloodworkFile).toHaveBeenCalledTimes(1);
    expect(mocks.storage.saveBufferImmutable).toHaveBeenCalledTimes(1);
    expect(mocks.signalJob).toHaveBeenCalledTimes(2);

    const fileId = String(fileState?.id);
    const page = await api("GET", `${path}/${REPORT}/files/${fileId}/pages/1`, { token: TOKEN });
    expect(page.status).toBe(200);
    expect(mocks.renderBloodworkPage).toHaveBeenCalledWith(
      expect.any(Buffer), "application/pdf", 1, undefined,
      { sha256: "a".repeat(64), pageCount: 1 },
    );
  });

  it("does not signal a denied or size-mismatched upload or inspect mismatched bytes", async () => {
    const path = `/api/bloodwork/patients/${PATIENT}/reports`;
    await api("POST", path, { token: TOKEN, body: PDF_DRAFT });
    mocks.storage.readObjectBounded.mockResolvedValue({ bytes: Buffer.alloc(9), sizeBytes: 9 });
    expect((await api("POST", `${path}/${REPORT}/commit`, { token: TOKEN })).status).toBe(422);
    expect(mocks.inspectBloodworkFile).not.toHaveBeenCalled();
    expect(mocks.signalJob).not.toHaveBeenCalled();
  });
  it.each(["activated", "active", "invited", "paused", "discharged"])(
    "admits a completed account with %s status even when profile_completed_at is null",
    async (activationStatus) => {
      patient.activation_status = activationStatus;
      const admission = await admitPatient({
        patientId: PATIENT,
        authUserId: USER,
        requireConsent: true,
      });
      expect(admission.ok).toBe(true);
    },
  );

  it.each(["paused", "discharged"])(
    "stages, commits, and reloads a PDF for a %s account with a legacy null profile timestamp",
    async (activationStatus) => {
      patient.activation_status = activationStatus;
      const body = {
        clientRequestId: "00000000-0000-4000-8000-000000000001",
        title: "CBC",
        reportDate: null,
        transcriptionConsent: true,
        files: [{
          clientFileId: CLIENT_FILE,
          mimeType: "application/pdf",
          size: 10,
        }],
      };
      const created = await api("POST", `/api/bloodwork/patients/${PATIENT}/reports`, {
        token: TOKEN,
        body,
      });
      expect(created.status).toBe(201);
      expect((created.json.uploads as unknown[]).length).toBe(1);
      expect(mocks.storage.bloodworkUploadURL).toHaveBeenCalledTimes(1);

      const committed = await api("POST", `/api/bloodwork/patients/${PATIENT}/reports/${REPORT}/commit`, {
        token: TOKEN,
      });
      expect(committed.status).toBe(200);
      expect(committed.json).toMatchObject({
        report: { id: REPORT, patientId: PATIENT, kind: "pdf", fileCount: 1, pageCount: 1 },
      });
      expect(mocks.storage.readObjectBounded).toHaveBeenCalledTimes(1);
      expect(mocks.inspectBloodworkFile).toHaveBeenCalledTimes(1);

      const history = await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: TOKEN });
      expect(history.status).toBe(200);
      expect(history.json).toMatchObject({
        reports: [{ id: REPORT, patientId: PATIENT, kind: "pdf", fileCount: 1, pageCount: 1 }],
      });
    },
  );

  it("returns setup recovery after current consent for an incomplete account", async () => {
    flags = [{ patient_id: PATIENT, onboarding_complete: false }];
    const response = await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: TOKEN });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({
      code: "PATIENT_SETUP_REQUIRED",
      recovery: "setup",
    });
    expect(mocks.supabaseAdmin.mock.calls.some(([, path]) => String(path).includes("patient_consents"))).toBe(true);
  });

  it("returns consent recovery before setup when both patient gates are missing", async () => {
    flags = [];
    consents = [];
    const response = await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: TOKEN });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ code: "CONSENT_REQUIRED", recovery: "consent" });
  });

  it("returns consent recovery only to the verified owner", async () => {
    consents = [];
    const response = await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: TOKEN });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ code: "CONSENT_REQUIRED", recovery: "consent" });
  });

  it.each([
    ["disabled", { activation_status: "disabled" }],
    ["archived", { archived_at: "2026-09-01T00:00:00Z" }],
    ["deletion pending", { deletion_requested_at: "2026-09-01T00:00:00Z" }],
  ])("blocks a %s account with account recovery", async (_label, update) => {
    Object.assign(patient, update);
    const response = await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: TOKEN });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({
      code: "PATIENT_ACCOUNT_UNAVAILABLE",
      recovery: "account",
    });
  });

  it("compares the requested id before disclosing admission or consent", async () => {
    const response = await api("GET", `/api/bloodwork/patients/${OTHER_PATIENT}/reports`, { token: TOKEN });
    expect(response.status).toBe(404);
    expect(response.json).toEqual({ error: "Patient record not found." });
    expect(mocks.supabaseAdmin.mock.calls.some(([, path]) =>
      String(path).includes("patient_flags") || String(path).includes("patient_consents"),
    )).toBe(false);
  });

  it("keeps staff admission neutral when the linked office cannot access the patient", async () => {
    mocks.resolveOfficeScope.mockResolvedValueOnce({
      kind: "ok",
      scope: { providerId: "provider-b", actorUserId: "provider-user", actorKind: "provider" },
    });
    mocks.fetchAuthUser.mockResolvedValueOnce({ id: "provider-user", email: null, phone: null });
    const response = await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: "provider-token" });
    expect(response.status).toBe(404);
    expect(response.json).toEqual({ error: "Patient record not found." });
    expect(mocks.supabaseAdmin.mock.calls.some(([, path]) => String(path).includes("patient_consents"))).toBe(false);
  });

  it("fails closed when canonical identity lookup is ambiguous", async () => {
    mocks.supabaseAdmin.mockImplementationOnce(async () => result([{ id: PATIENT }, { id: OTHER_PATIENT }]));
    const response = await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: TOKEN });
    expect(response.status).toBe(503);
    expect(response.json).toMatchObject({
      code: "ACCOUNT_LOOKUP_UNAVAILABLE",
      recovery: "retry",
    });
  });

  it("keeps create and commit recovery parity and performs no RPC on denial", async () => {
    flags = [{ patient_id: PATIENT, onboarding_complete: false }];
    const create = await api("POST", `/api/bloodwork/patients/${PATIENT}/reports`, {
      token: TOKEN,
      body: {
        clientRequestId: "00000000-0000-4000-8000-000000000001",
        title: "CBC",
        reportDate: null,
        transcriptionConsent: true,
        files: [{
          clientFileId: "00000000-0000-4000-8000-000000000002",
          mimeType: "application/pdf",
          size: 10,
        }],
      },
    });
    const commit = await api(
      "POST",
      `/api/bloodwork/patients/${PATIENT}/reports/00000000-0000-4000-8000-000000000003/commit`,
      { token: TOKEN },
    );
    const source = await api(
      "GET",
      `/api/bloodwork/patients/${PATIENT}/reports/00000000-0000-4000-8000-000000000003/files/00000000-0000-4000-8000-000000000004/source`,
      { token: TOKEN },
    );
    expect(create.status).toBe(403);
    expect(commit.status).toBe(403);
    expect(source.status).toBe(403);
    expect(create.json.code).toBe("PATIENT_SETUP_REQUIRED");
    expect(commit.json.code).toBe("PATIENT_SETUP_REQUIRED");
    expect(source.json.code).toBe("PATIENT_SETUP_REQUIRED");
    // Identity resolution leaves a fire-and-forget presence touch; no bloodwork RPC may run on denial.
    expect(mocks.supabaseAdmin.mock.calls.some(([, path]) => String(path).includes("/rpc/") && !String(path).includes("patient_app_presence_touch"))).toBe(false);
    expect(mocks.supabaseAdmin.mock.calls.some(([, path]) => String(path).includes("storage_upload_intents"))).toBe(false);
    expect(mocks.storage.bloodworkUploadURL).not.toHaveBeenCalled();
    expect(mocks.storage.readObjectBounded).not.toHaveBeenCalled();
    expect(mocks.inspectBloodworkFile).not.toHaveBeenCalled();
  });

  it.each(["cross-patient", "disabled", "archived", "deletion", "demo"] as const)(
    "denies %s creation and commit before any report, grant, or file access",
    async (reason) => {
      if (reason === "disabled") patient.activation_status = "disabled";
      if (reason === "archived") patient.archived_at = "2026-09-01T00:00:00Z";
      if (reason === "deletion") patient.deletion_requested_at = "2026-09-01T00:00:00Z";
      const patientId = reason === "cross-patient" ? OTHER_PATIENT : PATIENT;
      const token = reason === "demo" ? undefined : TOKEN;
      const path = `/api/bloodwork/patients/${patientId}/reports`;
      const created = await api("POST", path, { token, body: PDF_DRAFT });
      const committed = await api("POST", `${path}/${REPORT}/commit`, { token });
      const expectedStatus = reason === "cross-patient" ? 404 : reason === "demo" ? 401 : 403;
      expect(created.status).toBe(expectedStatus);
      expect(committed.status).toBe(expectedStatus);
      if (reason === "cross-patient") {
        expect(created.json).toEqual({ error: "Patient record not found." });
        expect(committed.json).toEqual(created.json);
      }
      expect(reportState).toBeNull();
      expect(fileState).toBeNull();
      // Only the fire-and-forget presence touch may write; nothing bloodwork-related does.
      expect(mocks.supabaseAdmin.mock.calls.some(([method, path]) => method !== "GET" && !String(path).includes("patient_app_presence_touch"))).toBe(false);
      for (const storage of Object.values(mocks.storage)) expect(storage).not.toHaveBeenCalled();
      expect(mocks.inspectBloodworkFile).not.toHaveBeenCalled();
    },
  );

  it("rechecks admission at commit and safely resumes the same stage after recovery", async () => {
    const path = `/api/bloodwork/patients/${PATIENT}/reports`;
    expect((await api("POST", path, { token: TOKEN, body: PDF_DRAFT })).status).toBe(201);
    patient.deletion_requested_at = "2026-09-01T00:00:00Z";
    const denied = await api("POST", `${path}/${REPORT}/commit`, { token: TOKEN });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe("PATIENT_ACCOUNT_UNAVAILABLE");
    expect(mocks.storage.readObjectBounded).not.toHaveBeenCalled();
    expect(mocks.storage.saveBufferImmutable).not.toHaveBeenCalled();
    expect(mocks.supabaseAdmin.mock.calls.some(([, path]) =>
      path === "/rest/v1/rpc/bloodwork_commit_report",
    )).toBe(false);

    patient.deletion_requested_at = null;
    const resumed = await api("POST", `${path}/${REPORT}/commit`, { token: TOKEN });
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({ report: { id: REPORT } });
    expect(mocks.storage.bloodworkUploadURL).toHaveBeenCalledTimes(1);
  });

  it("distinguishes session, account lookup, and unlinked callers without account disclosure", async () => {
    mocks.fetchAuthUser.mockResolvedValueOnce(null);
    const expired = await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: "expired-bearer-token" });
    expect(expired).toMatchObject({
      status: 401,
      json: { code: "SESSION_REQUIRED", recovery: "sign_in" },
    });

    mocks.fetchAuthUser.mockReset().mockRejectedValueOnce(new Error("auth outage"));
    const outage = await api("GET", `/api/bloodwork/patients/${PATIENT}/reports`, { token: TOKEN });
    expect(outage).toMatchObject({
      status: 503,
      json: { code: "ACCOUNT_LOOKUP_UNAVAILABLE", recovery: "retry" },
    });

    mocks.fetchAuthUser.mockReset().mockResolvedValueOnce({ id: "unlinked-user", email: null, phone: null });
    mocks.supabaseAdmin.mockImplementationOnce(async () => result([]));
    const unlinked = await api("POST", `/api/bloodwork/patients/${PATIENT}/reports`, {
      token: TOKEN,
      body: {
        clientRequestId: "00000000-0000-4000-8000-000000000001",
        title: "CBC",
        reportDate: null,
        transcriptionConsent: true,
        files: [{
          clientFileId: "00000000-0000-4000-8000-000000000002",
          mimeType: "application/pdf",
          size: 10,
        }],
      },
    });
    expect(unlinked.status).toBe(403);
    expect(unlinked.json).toEqual({ error: "Patient bloodwork is unavailable for this account." });
  });
});