/**
 * patient-sign-in-metrics: once an hour, read text-message login codes per
 * active patient for the current and previous UTC month and log them on the
 * run, so the ratio is visible per tick in the job ledger (and in the logs)
 * even when nobody opens System health.
 *
 * Read-only: it never writes anything, so dry runs and real runs are the
 * same. An unreadable ledger fails the run — a silent zero would look like
 * the cost problem was solved.
 */
import { readPatientSignInMetrics } from "../../security/sign-in-metrics";
import type { JobContext, JobDefinition } from "../types";

const HOUR_MS = 3_600_000;

export async function runPatientSignInMetrics(ctx: JobContext): Promise<void> {
  const months = await readPatientSignInMetrics(2);
  for (const month of months) {
    ctx.log("patient_sign_in_metrics", {
      month: month.month,
      smsSignIns: month.smsSignIns,
      patientsWithSmsSignIn: month.patientsWithSmsSignIn,
      newDeviceSmsSignIns: month.newDeviceSmsSignIns,
      signups: month.signups,
      activePatients: month.activePatients,
      smsPerActivePatient: month.smsPerActivePatient,
    });
  }
  const current = months[0];
  if (current) {
    ctx.tally("smsSignInsThisMonth", current.smsSignIns);
    ctx.tally("activePatientsThisMonth", current.activePatients);
    ctx.tally("newDeviceSmsSignInsThisMonth", current.newDeviceSmsSignIns);
  }
}

export const patientSignInMetricsJob: JobDefinition = {
  name: "patient-sign-in-metrics",
  title: "Login codes per active patient",
  description: "Logs how many text-message login codes patients redeemed this month against how many patients used the app; read-only.",
  intervalMs: HOUR_MS,
  leaseSeconds: 5 * 60,
  run: runPatientSignInMetrics,
};
