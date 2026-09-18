import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));

import { patientSignInMetricsJob, runPatientSignInMetrics } from "./patient-sign-in-metrics";
import type { JobContext } from "../types";

function ctx() {
  const logs: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const tallies: Record<string, number> = {};
  const context: JobContext = {
    dryRun: false,
    now: new Date("2026-09-18T10:00:00Z"),
    tally: (key: string, by: number = 1) => { tallies[key] = (tallies[key] ?? 0) + by; },
    failItem: () => { throw new Error("unexpected failItem"); },
    log: (event: string, detail?: Record<string, unknown>) => { logs.push({ event, detail }); },
    checkpoint: () => undefined,
  } as unknown as JobContext;
  return { context, logs, tallies };
}

describe("patient-sign-in-metrics job", () => {
  beforeEach(() => mocks.admin.mockReset());

  it("logs codes per active patient for the current and previous month on every tick", async () => {
    mocks.admin.mockResolvedValue({ status: 200, json: [
      { month: "2026-09-01", sms_sign_ins: "30", patients_with_sms_sign_in: "12", new_device_sms_sign_ins: "9", signups: "4", active_patients: "120" },
      { month: "2026-08-01", sms_sign_ins: 0, patients_with_sms_sign_in: 0, new_device_sms_sign_ins: 0, signups: 0, active_patients: 0 },
    ] });
    const { context, logs, tallies } = ctx();
    await runPatientSignInMetrics(context);
    expect(mocks.admin).toHaveBeenCalledWith("POST", "/rest/v1/rpc/hq_patient_sign_in_metrics", { p_months: 2 });
    expect(logs).toEqual([
      { event: "patient_sign_in_metrics", detail: { month: "2026-09-01", smsSignIns: 30, patientsWithSmsSignIn: 12, newDeviceSmsSignIns: 9, signups: 4, activePatients: 120, smsPerActivePatient: 0.25 } },
      { event: "patient_sign_in_metrics", detail: { month: "2026-08-01", smsSignIns: 0, patientsWithSmsSignIn: 0, newDeviceSmsSignIns: 0, signups: 0, activePatients: 0, smsPerActivePatient: null } },
    ]);
    expect(tallies).toEqual({ smsSignInsThisMonth: 30, activePatientsThisMonth: 120, newDeviceSmsSignInsThisMonth: 9 });
  });

  it("fails the run when the ledger cannot be read instead of logging zeros", async () => {
    mocks.admin.mockResolvedValue({ status: 500, json: null });
    const { context, logs } = ctx();
    await expect(runPatientSignInMetrics(context)).rejects.toThrow(/sign-in metrics read failed \(500\)/);
    expect(logs).toEqual([]);
  });

  it("is scheduled hourly and read-only", () => {
    expect(patientSignInMetricsJob).toMatchObject({ name: "patient-sign-in-metrics", intervalMs: 3_600_000 });
  });
});
