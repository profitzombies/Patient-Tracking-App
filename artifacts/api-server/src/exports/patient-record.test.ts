import JSZip from "jszip";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import type { PatientArchiveSections } from "../privacy/exports";
import { buildPatientRecordArchive, recordPartFileName, type PatientChartContext } from "./patient-record";
import { renderRecordSummaryPdf } from "./record-pdf";

function sections(): PatientArchiveSections {
  return {
    profile: {
      id: "p-1",
      first_name: "Jane",
      last_name: "Doe",
      email: "jane@example.com",
      phone: "+15555550100",
      date_of_birth: "1980-02-03",
      sex: "female",
      height_cm: 165,
      starting_weight: 210,
      current_weight: 188,
      goal_weight: 160,
      timezone: "America/Chicago",
      program_id: "thinnr-42",
      program_start_date: "2026-08-01",
      created_at: "2026-07-30T12:00:00.000Z",
      claimed_at: "2026-07-31T12:00:00.000Z",
    },
    consents: [],
    flags: null,
    diary: [],
    water: [],
    targets: null,
    library: {
      customFoods: [{ food_id: "f1", name: "Soup", photo_path: "/objects/patient-media/p-1/food-1.jpg" }],
      savedRecipes: [],
      favorites: [],
      recents: [],
    },
    checkIns: [
      { check_in_id: "c1", date_key: "2026-09-01", weight: 190, mood: "ok" },
      { check_in_id: "c2", date_key: "2026-09-10", weight: 188, mood: "good" },
    ],
    measurements: {
      healthImports: [{ source: "apple", kind: "steps", value: 8000, measured_at: "2026-09-10T10:00:00Z" }],
      bodyMeasurements: [{ visit_id: "v1", date_key: "2026-09-05", waist: 36.5, hips: 41, recorded_by_name: "Dr. Kim" }],
      clinicWeights: [{ weight_id: "w1", date_key: "2026-09-05", weight: 189, recorded_by_name: "Dr. Kim" }],
    },
    medications: {
      list: [{ id: "m1", name: "Semaglutide", form: "injection", dose: "0.5 mg", schedule_kind: "weekly", weekday: 1, start_date: "2026-08-01" }],
      doseLogs: [
        { id: "d1", medication_id: "m1", due_date: "2026-08-03", status: "taken" },
        { id: "d2", medication_id: "m1", due_date: "2026-08-10", status: "skipped" },
        { id: "d3", medication_id: "m1", due_date: "2026-08-17", status: "taken" },
      ],
    },
    photos: [
      { photo_id: "ph1", date_key: "2026-08-01", label: "Week 0", angle: "front", object_path: "/objects/patient-media/p-1/photo-1.jpg" },
      { photo_id: "ph2", date_key: "2026-08-15", label: "Week 2", angle: "front", object_path: "/objects/patient-media/p-1/photo-2.jpg" },
      { photo_id: "ph3", date_key: "2026-08-29", label: "Week 4", angle: "side", object_path: "/objects/patient-media/p-1/photo-3.jpg" },
      { photo_id: "ph4", date_key: "2026-09-12", label: "Week 6", angle: "side", object_path: "/objects/patient-media/p-1/photo-missing.jpg" },
    ],
    media: [],
    chat: [
      {
        conversation: { id: "conv-1", thread: "care_team", channel: "care_team", businessName: "Lakeside Med Spa", createdAt: "2026-08-02T15:00:00Z" },
        messages: [
          { clientId: "a", seq: 1, sender: "patient", attribution: "Patient", text: "Feeling nauseous after the dose 😣", createdAt: "2026-08-02T15:00:00Z" },
          { clientId: "b", seq: 2, sender: "Care Team", attribution: "Care Team", text: "Try smaller meals; call us if it lasts past tomorrow.", createdAt: "2026-08-02T15:20:00Z" },
        ],
      },
      { conversation: { id: "conv-2", thread: "coach", channel: "ai", businessName: "Lakeside Med Spa" }, messages: [{ role: "user", text: "hi" }] },
    ],
    coachMemory: { memories: [], exclusions: [] },
    bloodwork: {
      reports: [{ id: "r1", title: "Baseline panel", report_date: "2026-08-04", lifecycle_status: "committed", extraction_status: "done", reviewed_at: null }],
      files: [
        { id: "bf1", report_id: "r1", position: 1, mime_type: "application/pdf", object_path: "/objects/patient-media/p-1/bloodwork/r1/bf1.pdf", size_bytes: 100 },
        { id: "bf2", report_id: "r1", position: 2, mime_type: "image/png", object_path: null },
      ],
      results: [
        { id: "res1", report_id: "r1", test_name: "HbA1c", value_text: "5.9", units: "%", reference_range: "4.0-5.6", lab_flag: "H" },
        { id: "res2", report_id: "r1", test_name: "LDL", value_text: "120", units: "mg/dL", reference_range: "<100", lab_flag: null, corrected: true },
      ],
      corrections: [],
      incompleteTranscriptionPages: [],
    },
    billing: {
      orders: [{ order_number: "TH-100", created_at: "2026-08-05T00:00:00Z", items: [{ product_name_snapshot: "Plan", quantity: 1, unit_price_cents: 12000 }], total_cents: 13000, status: "paid", fulfillment_status: "shipped" }],
      subscriptions: [{ product: "Plan", status: "active", unit_price_cents: 12000, current_period_end: "2026-10-05T00:00:00Z" }],
    },
    appUsage: [],
  };
}

const chart: PatientChartContext = {
  patientId: "p-1",
  officeName: "Lakeside Med Spa",
  providerId: "prov-1",
  activationStatus: "paused",
  activationReason: "travel",
  activationUpdatedAt: "2026-09-01T00:00:00Z",
  programId: "thinnr-42",
  deletionRequestedAt: null,
};

/** Synthetic stored objects: sizes chosen so a 2.5 MB budget forces a split. */
const OBJECTS: Record<string, Buffer> = {
  "/objects/patient-media/p-1/photo-1.jpg": Buffer.alloc(900_000, 1),
  "/objects/patient-media/p-1/photo-2.jpg": Buffer.alloc(900_000, 2),
  "/objects/patient-media/p-1/photo-3.jpg": Buffer.alloc(900_000, 3),
  "/objects/patient-media/p-1/food-1.jpg": Buffer.alloc(3_000_000, 4), // larger than the whole budget
  "/objects/patient-media/p-1/bloodwork/r1/bf1.pdf": Buffer.from("%PDF-1.4 fake"),
};

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("patient record archive", () => {
  it("splits into numbered parts, lists every file in the manifest, and never silently omits", async () => {
    const written = new Map<string, Buffer>();
    const readOrder: Array<{ path: string; duringPart: number }> = [];
    let currentPart = 0;
    const result = await buildPatientRecordArchive("p-1", {
      sections: sections(),
      chart,
      exportId: "exp-1",
      fileNameStem: "thinnr_patient-record_jane-doe_2026-09-19",
      partBudgetBytes: 2_500_000,
      generatedAt: new Date("2026-09-19T12:00:00.000Z"),
      statMedia: async (path) => {
        const object = OBJECTS[path];
        if (!object) throw new Error("not found");
        return object.byteLength;
      },
      readMedia: async (path) => {
        readOrder.push({ path, duringPart: currentPart });
        return OBJECTS[path];
      },
      writePart: async (part, stream) => {
        currentPart = part.part;
        const buffer = await collect(stream);
        written.set(part.fileName, buffer);
        return { sizeBytes: buffer.byteLength };
      },
    });

    const { manifest, parts } = result;
    // 3 × 0.9 MB photos + one 3 MB file + a tiny pdf against a 2.5 MB budget:
    // part 1 = fixed files + photo-1 + photo-2 (≈2.3 MB), photo-3 opens part 2,
    // food-1 (3 MB > budget) gets part 3 alone, the bloodwork pdf lands in part 4.
    expect(parts.map((part) => part.part)).toEqual([1, 2, 3, 4]);
    expect(parts.map((part) => part.fileName)).toEqual([1, 2, 3, 4].map((n) => recordPartFileName("thinnr_patient-record_jane-doe_2026-09-19", n, 4)));
    expect(parts[0].fileName).toBe("thinnr_patient-record_jane-doe_2026-09-19_part-01-of-04.zip");
    expect(manifest.partCount).toBe(4);
    expect(manifest.parts[2].oversized).toBe(true);
    for (const part of parts) {
      // Every part stays within budget except the one holding a single oversized file.
      if (part.part !== 3) expect(part.sizeBytes).toBeLessThan(2_500_000);
    }

    // Every stored file that exists is somewhere; the two that do not are named with a reason.
    const placed = new Map(manifest.files.map((entry) => [entry.file, entry.part]));
    expect(placed.get("media/photo-1.jpg")).toBe(1);
    expect(placed.get("media/photo-2.jpg")).toBe(1);
    expect(placed.get("media/photo-3.jpg")).toBe(2);
    expect(placed.get("media/food-1.jpg")).toBe(3);
    expect(placed.get("bloodwork/files/r1/01-bf1.pdf")).toBe(4);
    expect(placed.get("record-summary.pdf")).toBe(1);
    expect(placed.get("bloodwork.json")).toBe(1);
    expect(manifest.omitted).toEqual([
      { file: "media/photo-missing.jpg", objectPath: "/objects/patient-media/p-1/photo-missing.jpg", source: "media", reason: "source_unavailable" },
      { file: "bloodwork/files/r1/02-bf2.png", objectPath: null, source: "bloodwork", reason: "not_committed" },
    ]);
    const plannedStored = Object.keys(OBJECTS).length;
    expect(manifest.files.filter((entry) => entry.objectPath).length).toBe(plannedStored);
    expect(manifest.fileCount).toBe(manifest.files.length);

    // The ZIP bytes agree with the manifest, part by part.
    for (const part of manifest.parts) {
      const zip = await JSZip.loadAsync(written.get(part.fileName)!);
      const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
      expect(names).toEqual([...part.files].sort());
      const packedManifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
      expect(packedManifest).toEqual(JSON.parse(JSON.stringify(manifest)));
      for (const entry of manifest.files.filter((file) => file.part === part.part && file.objectPath)) {
        const bytes = await zip.file(entry.file)!.async("nodebuffer");
        expect(bytes.equals(OBJECTS[entry.objectPath!])).toBe(true);
      }
    }
    const part1 = await JSZip.loadAsync(written.get(parts[0].fileName)!);
    const media = JSON.parse(await part1.file("media.json")!.async("string"));
    expect(media.files.find((f: { objectPath: string }) => f.objectPath.endsWith("photo-3.jpg"))).toEqual({
      objectPath: "/objects/patient-media/p-1/photo-3.jpg",
      file: "media/photo-3.jpg",
      part: 2,
    });
    expect(media.omitted).toHaveLength(1);
    const bloodwork = JSON.parse(await part1.file("bloodwork.json")!.async("string"));
    expect(bloodwork.files.map((f: { archiveFile: string | null; part: number | null; omittedReason: string | null }) => [f.archiveFile, f.part, f.omittedReason])).toEqual([
      ["bloodwork/files/r1/01-bf1.pdf", 4, null],
      [null, null, "not_committed"],
    ]);
    const readme = await part1.file("README.txt")!.async("string");
    expect(readme).toContain("Parts: 4");
    expect(readme).toContain("record-summary.pdf");
    const summary = await part1.file("record-summary.pdf")!.async("nodebuffer");
    expect(summary.subarray(0, 5).toString()).toBe("%PDF-");

    // Bytes are fetched lazily while the owning part is being written, never up front.
    expect(readOrder.every((read) => read.duringPart > 0)).toBe(true);
    for (const read of readOrder) {
      const expectedPart = manifest.files.find((entry) => entry.objectPath === read.path)!.part;
      expect(read.duringPart).toBe(expectedPart);
    }
  });

  it("fits a small record in one part named without a split suffix collision", async () => {
    const small = sections();
    small.photos = [];
    small.library.customFoods = [];
    small.bloodwork.files = [];
    const result = await buildPatientRecordArchive("p-1", {
      sections: small,
      chart,
      fileNameStem: "thinnr_patient-record_jane-doe_2026-09-19",
      statMedia: async () => 0,
      readMedia: async () => Buffer.alloc(0),
      writePart: async (_part, stream) => ({ sizeBytes: (await collect(stream)).byteLength }),
    });
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].fileName).toBe("thinnr_patient-record_jane-doe_2026-09-19_part-01-of-01.zip");
    expect(result.manifest.omitted).toEqual([]);
  });

  it("fails the build (rather than dropping a file) when a stored object cannot be read mid-stream", async () => {
    await expect(
      buildPatientRecordArchive("p-1", {
        sections: sections(),
        chart,
        fileNameStem: "x",
        statMedia: async () => 10,
        readMedia: async () => {
          throw new Error("storage hiccup");
        },
        writePart: async (_part, stream) => ({ sizeBytes: (await collect(stream)).byteLength }),
      }),
    ).rejects.toThrow(/storage hiccup/);
  });
});

describe("record summary pdf", () => {
  it("renders the identity, medication, bloodwork, photo, transcript, order, and file-guide sections", async () => {
    const pdf = await renderRecordSummaryPdf({
      sections: sections(),
      chart,
      generatedAt: "2026-09-19T12:00:00.000Z",
      exportId: "exp-1",
      parts: ["a_part-01-of-02.zip", "a_part-02-of-02.zip"],
      photoFiles: [
        { file: "media/photo-1.jpg", part: 1, sizeBytes: 1, source: "media", objectPath: "/objects/patient-media/p-1/photo-1.jpg" },
        { file: "media/photo-2.jpg", part: 2, sizeBytes: 1, source: "media", objectPath: "/objects/patient-media/p-1/photo-2.jpg" },
      ],
      omitted: [{ file: "media/photo-missing.jpg", objectPath: "/objects/patient-media/p-1/photo-missing.jpg", source: "media", reason: "source_unavailable" }],
    });
    const proxy = await getDocumentProxy(new Uint8Array(pdf));
    const { text, totalPages } = await extractText(proxy, { mergePages: true });
    expect(totalPages).toBeGreaterThanOrEqual(1);
    for (const expected of [
      "Patient record summary",
      "Jane Doe",
      "Lakeside Med Spa",
      "Paused",
      "thinnr-42",
      "Semaglutide",
      "HbA1c",
      "5.9",
      "Week 2",
      "media/photo-2.jpg",
      "Source Unavailable",
      "Care Team",
      "Try smaller meals",
      "TH-100",
      "$130.00",
      "a_part-02-of-02.zip",
      "diary.json",
      "emoji",
    ]) {
      expect(text.replace(/\s+/g, " ")).toContain(expected);
    }
    expect(text).not.toContain("😣");
  });
});
