import JSZip from "jszip";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PatientArchiveSections } from "../privacy/exports";
import { runOfficeBundleStep, bundlePartFileName, type OfficeBundleDeps, type OfficeBundleManifest } from "./office-bundle";
import { planPatientRecord, type PatientChartContext } from "./patient-record";
import type { ExportJobRow } from "./worker";

const OFFICE = "prov-1";
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const STEM = "thinnr_office-bundle_lakeside_2026-09-19";
const PATIENTS = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", created_at: "2026-07-01T00:00:00.000Z", name: ["Ann", "Lee"], status: "activated" },
  { id: "bbbbbbbb-0000-4000-8000-000000000002", created_at: "2026-07-02T00:00:00.000Z", name: ["Bob", "Ray"], status: "activated" },
  // A sealed chart: the record still ships, marked closed.
  { id: "cccccccc-0000-4000-8000-000000000003", created_at: "2026-07-02T00:00:00.000Z", name: ["Cy", "Vale"], status: "closed" },
];
const OBJECTS: Record<string, Buffer> = Object.fromEntries(
  PATIENTS.map((patient, index) => [`/objects/patient-media/${patient.id}/photo-1.jpg`, Buffer.alloc(40_000 + index, index + 1)]),
);

function sectionsFor(patient: (typeof PATIENTS)[number]): PatientArchiveSections {
  return {
    profile: {
      id: patient.id, first_name: patient.name[0], last_name: patient.name[1], email: `${patient.name[0].toLowerCase()}@example.com`,
      phone: "+15555550100", date_of_birth: "1980-02-03", sex: "female", height_cm: 165, starting_weight: 210, current_weight: 188,
      goal_weight: 160, timezone: "America/Chicago", program_id: "thinnr-42", program_start_date: "2026-08-01", created_at: patient.created_at, claimed_at: null,
    },
    consents: [], flags: null, diary: [], water: [], targets: null,
    library: { customFoods: [], savedRecipes: [], favorites: [], recents: [] },
    checkIns: [{ check_in_id: `c-${patient.id}`, date_key: "2026-09-01", weight: 190, mood: "ok" }],
    measurements: { healthImports: [], bodyMeasurements: [], clinicWeights: [] },
    medications: { list: [], doseLogs: [] },
    photos: [{ photo_id: `ph-${patient.id}`, date_key: "2026-08-01", label: "Week 0", angle: "front", object_path: `/objects/patient-media/${patient.id}/photo-1.jpg` }],
    media: [], chat: [], coachMemory: { memories: [], exclusions: [] },
    bloodwork: { reports: [], files: [], results: [], corrections: [], incompleteTranscriptionPages: [] },
    billing: { orders: [], subscriptions: [] },
    appUsage: [], recordAccess: [], editHistory: [],
  } satisfies PatientArchiveSections as PatientArchiveSections;
}

function chartFor(patient: (typeof PATIENTS)[number]): PatientChartContext {
  return {
    patientId: patient.id, officeName: "Lakeside Med Spa", providerId: OFFICE, activationStatus: patient.status,
    activationReason: patient.status === "closed" ? "left_practice" : null, activationUpdatedAt: "2026-09-01T00:00:00Z", programId: "thinnr-42", deletionRequestedAt: null,
  };
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** One fake office: an in-memory export row, patient list, tombstones, and object store. */
function office(options: { includeTombstones?: boolean } = {}) {
  const row: ExportJobRow = {
    id: JOB_ID, kind: "office_bundle", status: "queued", requested_by: "hq-user", requester_kind: "hq", requester_role: "admin",
    provider_id: OFFICE, params: { officeName: "Lakeside Med Spa", includeTombstones: options.includeTombstones === true },
    file_name: `${STEM}.zip`, object_path: null, size_bytes: null, row_count: null, error: null, attempts: 0,
    created_at: "2026-09-19T10:00:00Z", started_at: null, completed_at: null, expires_at: "2026-09-26T10:00:00Z",
    download_count: 0, last_downloaded_at: null, parts: null, cancel_requested_at: null,
  } as ExportJobRow;
  const objects = new Map<string, Buffer>(Object.entries(OBJECTS));
  const planned: string[] = [];
  let clock = Date.parse("2026-09-19T12:00:00Z");
  const dbCalls: string[] = [];
  const db = (async (method: string, path: string, body?: unknown, prefer?: string) => {
    dbCalls.push(`${method} ${path}`);
    if (method === "GET" && prefer === "count=exact") {
      const total = path.startsWith("/rest/v1/patient_tombstones") ? 1 : PATIENTS.length;
      return { status: 200, json: [], contentRange: `0-0/${total}` };
    }
    if (method === "GET" && path.startsWith("/rest/v1/data_exports?kind=eq.office_bundle")) {
      const statuses = ["running", "queued"];
      return { status: 200, json: statuses.includes(row.status) && Date.parse(row.expires_at) > clock ? [row] : [], contentRange: null };
    }
    if (method === "GET" && path.startsWith(`/rest/v1/data_exports?id=eq.${JOB_ID}&select=status,cancel_requested_at`)) {
      return { status: 200, json: [{ status: row.status, cancel_requested_at: row.cancel_requested_at }], contentRange: null };
    }
    if (method === "PATCH" && path.startsWith(`/rest/v1/data_exports?id=eq.${JOB_ID}&status=eq.`)) {
      const expected = decodeURIComponent(/status=eq\.([^&]+)/.exec(path)![1]);
      if (row.status !== expected) return { status: 200, json: [], contentRange: null };
      if (path.includes("cancel_requested_at=is.null") && row.cancel_requested_at) return { status: 200, json: [], contentRange: null };
      Object.assign(row, structuredClone(body));
      return { status: 200, json: [structuredClone(row)], contentRange: null };
    }
    if (method === "GET" && path.startsWith(`/rest/v1/patients?provider_id=eq.${OFFICE}`)) {
      const after = /created_at\.gt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.gt\.([^)]+)\)/.exec(decodeURIComponent(path));
      const list = PATIENTS.filter((p) => !after || p.created_at > after[1] || (p.created_at === after[2] && p.id > after[3]))
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      const limit = Number(/limit=(\d+)/.exec(path)?.[1] ?? 50);
      return { status: 200, json: list.slice(0, limit).map(({ id, created_at }) => ({ id, created_at })), contentRange: null };
    }
    if (method === "GET" && path.startsWith("/rest/v1/patient_tombstones?")) {
      return { status: 200, json: [{ id: "dddddddd-0000-4000-8000-000000000004", requested_at: "2026-06-01T00:00:00Z", purged_at: "2026-07-01T00:00:00Z", was_activated: true, program_id: "thinnr-42", enrolled_on: "2026-01-05" }], contentRange: null };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as unknown as OfficeBundleDeps["db"];
  const deps: Partial<OfficeBundleDeps> = {
    db,
    storage: {
      saveStream: async (objectPath, source) => {
        const chunks: Buffer[] = [];
        for await (const chunk of source as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
        const buffer = Buffer.concat(chunks);
        objects.set(objectPath, buffer);
        return { sizeBytes: buffer.byteLength };
      },
      saveBuffer: async (objectPath, content) => { objects.set(objectPath, Buffer.from(content)); },
      readObject: async (objectPath) => {
        const found = objects.get(objectPath);
        if (!found) throw new Error(`missing ${objectPath}`);
        return found;
      },
      deleteObjectStrict: async (objectPath) => {
        if (!objects.delete(objectPath)) throw new Error(`missing ${objectPath}`);
      },
    },
    planRecord: (patientId, options) => {
      planned.push(patientId);
      const patient = PATIENTS.find((p) => p.id === patientId)!;
      return planPatientRecord(patientId, {
        ...options,
        sections: sectionsFor(patient),
        chart: chartFor(patient),
        generatedAt: new Date("2026-09-19T12:00:00Z"),
        statMedia: async (path) => {
          const object = objects.get(path);
          if (!object) throw new Error("not found");
          return object.byteLength;
        },
      });
    },
    readMedia: async (path) => objects.get(path)!,
    officeSheets: async (scope) => {
      expect(scope.providerId).toBe(OFFICE);
      expect(scope.range?.end).toBe("2026-09-19");
      return ["orders", "payments", "refunds", "shipments", "subscriptions", "staff-team", "audit-events", "patient-activity"].map((name) => ({
        file: `office/${name}.csv`,
        sheet: { header: ["Sheet", "Office"], rows: [[name, scope.officeName ?? ""]] },
      }));
    },
    ttlHours: async () => 48,
    partBudgetBytes: 10 * 1024 * 1024,
    fixedBytesCap: 64 * 1024 * 1024,
    patientsPerPart: 2,
    runBudgetMs: 60_000,
    patientPageSize: 2,
    now: () => new Date(clock),
  };
  const tallies: Record<string, number> = {};
  const ctx = {
    dryRun: false,
    tally: (key: string, by = 1) => { tallies[key] = (tallies[key] ?? 0) + by; },
    log: () => undefined,
    checkpoint: () => undefined,
  };
  const step = (dryRun = false) => runOfficeBundleStep({ ...ctx, dryRun, deps });
  return { row, objects, planned, tallies, step, deps, dbCalls, advance: (ms: number) => { clock += ms; }, get clock() { return clock; } };
}

async function zipOf(objects: Map<string, Buffer>, path: string) {
  return JSZip.loadAsync(objects.get(path)!);
}
function fileNames(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
}

describe("office bundle job", () => {
  it("packs a folder per patient into numbered parts, then the office CSVs, tombstones, and a checksummed manifest", async () => {
    const fx = office({ includeTombstones: true });
    const result = await fx.step();
    expect(result).toEqual({ moreWork: false, jobId: JOB_ID });
    expect(fx.planned).toEqual(PATIENTS.map((p) => p.id));

    const row = fx.row;
    expect(row.status).toBe("ready");
    expect(row.attempts).toBe(1);
    // Two patients per part, so [A, B], [C], then the office part on its own.
    const parts = row.parts as Array<{ part: number; fileName: string; objectPath: string; sizeBytes: number; fileCount: number; sha256: string }>;
    expect(parts.map((part) => part.part)).toEqual([1, 2, 3]);
    expect(parts.map((part) => part.fileName)).toEqual([1, 2, 3].map((n) => bundlePartFileName(STEM, n)));
    expect(parts[0].fileName).toBe(`${STEM}_part-001.zip`);
    expect(row.object_path).toBe(parts[0].objectPath);
    expect(row.size_bytes).toBe(parts.reduce((sum, part) => sum + part.sizeBytes, 0));
    // Ready bundles live by the export-link policy, not the build allowance.
    expect(row.expires_at).toBe(new Date(fx.clock + 48 * 3_600_000).toISOString());
    for (const part of parts) {
      const bytes = fx.objects.get(part.objectPath)!;
      expect(bytes.byteLength).toBe(part.sizeBytes);
      expect(sha(bytes)).toBe(part.sha256);
    }

    const part1 = await zipOf(fx.objects, parts[0].objectPath);
    const part2 = await zipOf(fx.objects, parts[1].objectPath);
    const part3 = await zipOf(fx.objects, parts[2].objectPath);
    const folders = (zip: JSZip) => [...new Set(fileNames(zip).map((name) => name.split("/").slice(0, 2).join("/")))];
    expect(folders(part1)).toEqual([`patients/${PATIENTS[0].id}`, `patients/${PATIENTS[1].id}`]);
    expect(folders(part2)).toEqual([`patients/${PATIENTS[2].id}`]);
    expect(fileNames(part1)).toContain(`patients/${PATIENTS[0].id}/record-summary.pdf`);
    expect(fileNames(part1)).toContain(`patients/${PATIENTS[0].id}/media/photo-1.jpg`);
    expect(fileNames(part1)).toContain(`patients/${PATIENTS[0].id}/manifest.json`);
    expect(fileNames(part2)).toContain(`patients/${PATIENTS[2].id}/record-summary.pdf`);
    expect(fileNames(part3)).toEqual([
      "README.txt", "manifest.json", "office/audit-events.csv", "office/orders.csv", "office/patient-activity.csv", "office/payments.csv",
      "office/refunds.csv", "office/shipments.csv", "office/staff-team.csv", "office/subscriptions.csv", "office/tombstones.csv",
    ]);
    const tombstones = await part3.file("office/tombstones.csv")!.async("string");
    expect(tombstones).toContain("Former patient ID");
    expect(tombstones).toContain("dddddddd-0000-4000-8000-000000000004");
    expect(tombstones).not.toMatch(/Ann|Lee|@example/);

    const manifest = JSON.parse(await part3.file("manifest.json")!.async("string")) as OfficeBundleManifest;
    expect(manifest).toMatchObject({ format: "thinnr-office-bundle/1", exportId: JOB_ID, officeId: OFFICE, officeName: "Lakeside Med Spa", includeTombstones: true, patientsTotal: 3, patientsIncluded: 3, tombstoneCount: 1, partCount: 3 });
    expect(manifest.parts.map((part) => part.sha256)).toEqual([parts[0].sha256, parts[1].sha256, null]);
    expect(manifest.patients.map((patient) => patient.patientId)).toEqual(PATIENTS.map((p) => p.id));
    // The sealed chart's record is included, marked closed in the patient list.
    expect(manifest.patients.map((patient) => patient.chartStatus)).toEqual(["activated", "activated", "closed"]);
    expect(manifest.patients[2]).toMatchObject({ parts: [2], omittedFiles: 0 });
    // Every file in every part is listed once with a checksum that matches its bytes.
    const zips = new Map<number, JSZip>([[1, part1], [2, part2], [3, part3]]);
    const listed = new Set<string>();
    for (const entry of manifest.files) {
      expect(listed.has(entry.file)).toBe(false);
      listed.add(entry.file);
      const bytes = await zips.get(entry.part)!.file(entry.file)!.async("nodebuffer");
      expect({ file: entry.file, sha: sha(bytes), size: bytes.byteLength }).toEqual({ file: entry.file, sha: entry.sha256, size: entry.sizeBytes });
    }
    // Everything except the manifest itself (which cannot carry its own hash).
    const allNames = [1, 2, 3].flatMap((n) => fileNames(zips.get(n)!)).filter((name) => name !== "manifest.json");
    expect([...listed].sort()).toEqual(allNames.sort());
    expect(manifest.fileCount).toBe(row.row_count);
    // Sidecars were folded in and removed; only parts and patient media remain.
    expect([...fx.objects.keys()].filter((path) => path.includes("bundle-files"))).toEqual([]);
    expect(fx.tallies).toMatchObject({ bundlesClaimed: 1, partsWritten: 3, patientsPacked: 3, bundlesReady: 1, bundlePatientsDone: 3, bundlePatientsTotal: 3, bundleBytesWritten: row.size_bytes });
  });

  it("resumes from the last landed patient after an interrupted run and never rebuilds packed patients", async () => {
    const fx = office();
    // Run 1 spends its budget as soon as part 1 (patients A and B) lands.
    const storage = fx.deps.storage!;
    const originalSave = storage.saveStream;
    storage.saveStream = async (path, source, type) => {
      const saved = await originalSave(path, source, type);
      fx.advance(fx.deps.runBudgetMs! + 1);
      return saved;
    };
    const first = await fx.step();
    expect(first).toEqual({ moreWork: true, jobId: JOB_ID });
    expect(fx.row.status).toBe("running");
    expect((fx.row.parts as unknown[]).length).toBe(1);
    const state = (fx.row.params as { bundle: { cursor: { id: string }; patientsDone: number; patientsTotal: number; bytesWritten: number; stage: string; fileLists: string[] } }).bundle;
    expect(state).toMatchObject({ stage: "patients", patientsDone: 2, patientsTotal: 3, cursor: { id: PATIENTS[1].id } });
    expect(state.bytesWritten).toBeGreaterThan(0);
    expect(state.fileLists).toHaveLength(1);
    expect(fx.planned).toEqual([PATIENTS[0].id, PATIENTS[1].id]);
    expect(fx.tallies).toMatchObject({ bundlePatientsDone: 2, bundlePatientsTotal: 3, bundleBytesWritten: state.bytesWritten });

    // A new process (fresh step, same row) continues with patient C only.
    storage.saveStream = originalSave;
    fx.planned.length = 0;
    const second = await fx.step();
    expect(second).toEqual({ moreWork: false, jobId: JOB_ID });
    expect(fx.planned).toEqual([PATIENTS[2].id]);
    expect(fx.row.status).toBe("ready");
    const parts = fx.row.parts as Array<{ part: number; objectPath: string }>;
    expect(parts.map((part) => part.part)).toEqual([1, 2, 3]);
    const manifest = JSON.parse(await (await zipOf(fx.objects, parts[2].objectPath)).file("manifest.json")!.async("string")) as OfficeBundleManifest;
    expect(manifest.patients.map((patient) => patient.patientId)).toEqual(PATIENTS.map((p) => p.id));
    expect(manifest.patientsIncluded).toBe(3);
    expect(fileNames(await zipOf(fx.objects, parts[2].objectPath))).not.toContain("office/tombstones.csv");
    expect(fx.tallies.bundlesClaimed).toBe(1);
  });

  it("counts remaining patients on a dry run and stops cleanly when the row is no longer running", async () => {
    const fx = office();
    expect(await fx.step(true)).toEqual({ moreWork: false, jobId: JOB_ID });
    expect(fx.tallies).toMatchObject({ bundlesSeen: 1, patientsRemaining: 3 });
    expect(fx.row.status).toBe("queued");
    expect(fx.planned).toEqual([]);

    // The row expires (sweep flips it) while part 1 is being written: the part
    // is withdrawn, nothing else is built, and the step ends without error.
    const storage = fx.deps.storage!;
    const originalSave = storage.saveStream;
    storage.saveStream = async (path, source, type) => {
      const saved = await originalSave(path, source, type);
      fx.row.status = "expired";
      return saved;
    };
    expect(await fx.step()).toEqual({ moreWork: false, jobId: JOB_ID });
    expect(fx.row.status).toBe("expired");
    expect([...fx.objects.keys()].filter((path) => path.startsWith("/objects/exports/"))).toEqual([]);
    expect(fx.planned).toEqual([PATIENTS[0].id, PATIENTS[1].id]);
  });

  it("honours a cancel request between patients: withdraws every written part and sidecar, flips the row to cancelled, never ready", async () => {
    const fx = office();
    // Staff hit Cancel while part 1 streamed; the next patient boundary (after
    // the throttle window) sees it.
    const storage = fx.deps.storage!;
    const originalSave = storage.saveStream;
    storage.saveStream = async (path, source, type) => {
      const saved = await originalSave(path, source, type);
      fx.row.cancel_requested_at = new Date(fx.clock).toISOString();
      fx.advance(6_000);
      return saved;
    };
    expect(await fx.step()).toEqual({ moreWork: true, jobId: JOB_ID });
    expect(fx.row.status).toBe("cancelled");
    expect(fx.row).toMatchObject({ object_path: null, parts: null, size_bytes: null, row_count: null, error: null });
    expect(fx.row.completed_at).not.toBeNull();
    expect([...fx.objects.keys()].filter((path) => path.startsWith("/objects/exports/"))).toEqual([]);
    // Part 1 (patients A and B) was the last thing built; C was never planned.
    expect(fx.planned).toEqual([PATIENTS[0].id, PATIENTS[1].id]);
    expect(fx.tallies.bundlesCancelled).toBe(1);
    expect(fx.tallies.bundlesReady).toBeUndefined();
    // Nothing is left for a later run to pick up.
    expect(await fx.step()).toEqual({ moreWork: false, jobId: null });
  });

  it("cancels a bundle left running by an earlier run before packing anything else", async () => {
    const fx = office();
    fx.row.status = "running";
    fx.row.cancel_requested_at = "2026-09-19T11:59:00Z";
    fx.row.parts = [{ part: 1, fileName: "x_part-01.zip", objectPath: "/objects/exports/old/part-01.zip", sizeBytes: 3, fileCount: 1 }];
    fx.objects.set("/objects/exports/old/part-01.zip", Buffer.from("zip"));
    fx.objects.set("/objects/exports/old/files-01.json", Buffer.from("[]"));
    fx.row.params = { ...(fx.row.params as object), bundle: { stage: "patients", patientsTotal: 3, patientsDone: 2, bytesWritten: 3, fileCount: 1, omittedFiles: 0, cursor: null, fileLists: ["/objects/exports/old/files-01.json"], tombstoneCount: null } };
    expect(await fx.step()).toEqual({ moreWork: true, jobId: JOB_ID });
    expect(fx.row.status).toBe("cancelled");
    expect(fx.planned).toEqual([]);
    expect(fx.objects.has("/objects/exports/old/part-01.zip")).toBe(false);
    expect(fx.objects.has("/objects/exports/old/files-01.json")).toBe(false);
    expect(fx.tallies).toMatchObject({ bundlesSeen: 1, bundlesCancelled: 1 });
  });

  it("does nothing when no bundle is waiting", async () => {
    const fx = office();
    fx.row.status = "ready";
    expect(await fx.step()).toEqual({ moreWork: false, jobId: null });
    expect(fx.tallies).toEqual({});
  });
});
