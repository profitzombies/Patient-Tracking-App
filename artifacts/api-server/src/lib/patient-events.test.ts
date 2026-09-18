import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), warn: vi.fn() }));
vi.mock("./supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("./logger", () => ({ logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() } }));

import { recordPatientEvent, writePatientEvent } from "./patient-events";

describe("patient app event recorder", () => {
  beforeEach(() => {
    mocks.admin.mockReset();
    mocks.warn.mockReset();
  });

  it("writes one row per counted action through the local-time RPC with the request platform", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: 3 });
    const at = new Date("2026-09-18T14:05:00Z");
    await expect(writePatientEvent("pat-1", "food_log", { headers: { "x-thinnr-platform": "ios" }, count: 3, at })).resolves.toBe(3);
    expect(mocks.admin).toHaveBeenCalledWith("POST", "/rest/v1/rpc/patient_app_event_record", {
      p_patient_id: "pat-1",
      p_feature: "food_log",
      p_platform: "ios",
      p_at: at.toISOString(),
      p_count: 3,
    });
  });

  it("defaults to platform unknown and a single event when no headers ride along", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: 1 });
    await writePatientEvent("pat-1", "order");
    expect(mocks.admin.mock.calls[0][2]).toMatchObject({ p_platform: "unknown", p_count: 1 });
  });

  it("skips empty batches without touching the database", async () => {
    await expect(writePatientEvent("pat-1", "coach_message", { count: 0 })).resolves.toBe(0);
    expect(recordPatientEvent("pat-1", "coach_message", { count: 0 })).toBe(false);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("never throws into the caller: a refused write is logged with the feature", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 500, json: null });
    expect(recordPatientEvent("pat-1", "weigh_in", { headers: {} })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: "pat-1", feature: "weigh_in" }),
      "patient app event write failed",
    );
  });
});
