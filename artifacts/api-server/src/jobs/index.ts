/**
 * Job catalogue: registers every background job with the scheduler. Import
 * this once at boot (index.ts) and from the HQ system-health and internal
 * trigger routes so the registry is populated wherever it is read.
 */
import { drainTrainingMediaCleanup } from "../training/media-cleanup";
import { abandonedUploadsJob } from "./definitions/abandoned-uploads";
import { reconcileStorageJob } from "./definitions/reconcile-storage";
import { registerJob } from "./scheduler";
import type { JobDefinition } from "./types";
import { bloodworkExtractionJob } from "./definitions/bloodwork-extraction";
import { bloodworkCleanupJob } from "./definitions/bloodwork-cleanup";
import { coachMemoryProcessingJob } from "./definitions/coach-memory-processing";
import { coachTitleProcessingJob } from "./definitions/coach-title-processing";
import { billingReconcileJob } from "./definitions/billing-reconcile";
import { warehouseSubmitJob } from "./definitions/warehouse-submit";
import { billingRenewalRemindersJob } from "./definitions/billing-renewal-reminders";
import { staffAttentionDigestJob } from "./definitions/staff-attention-digest";
import { patientSignInMetricsJob } from "./definitions/patient-sign-in-metrics";
import { photoVariantsBackfillJob } from "./definitions/photo-variants-backfill";
import {
  retentionAuditJob,
  retentionBillingWebhooksJob,
  retentionChatJob,
  retentionExportsJob,
  retentionJobLedgerJob,
  retentionNotificationsJob,
  retentionSessionRevocationsJob,
  retentionSignInsJob,
} from "./definitions/retention";
import { appEventsBackfillJob, appEventsRollupJob } from "./definitions/app-events";
import { dataGrowthSnapshotJob } from "./definitions/data-growth-snapshot";
import { systemThresholdsJob } from "./definitions/system-thresholds";

/** Request-scoped patient upload discards; logged as user runs, never scheduled. */
export const patientMediaCleanupJob: JobDefinition = {
  name: "patient-media-cleanup",
  title: "Patient upload discards",
  description: "Uploads a patient discarded from the app before saving; each discard is logged as a user-triggered run.",
  intervalMs: null,
  leaseSeconds: 60,
  run: async () => {
    throw new Error("patient-media-cleanup only runs from the patient app");
  },
};

const HOUR_MS = 3_600_000;

export const trainingMediaCleanupJob: JobDefinition = {
  name: "training-media-cleanup",
  title: "Training media clean-up queue",
  description: "Retries deletes of replaced or abandoned training video files whose first delete was refused by storage.",
  intervalMs: HOUR_MS,
  leaseSeconds: 15 * 60,
  run: async (ctx) => {
    await drainTrainingMediaCleanup(ctx, 50);
  },
};

export const ALL_JOBS: JobDefinition[] = [
  staffAttentionDigestJob,
  appEventsRollupJob,
  appEventsBackfillJob,
  billingReconcileJob,
  billingRenewalRemindersJob,
  warehouseSubmitJob,
  coachTitleProcessingJob,
  coachMemoryProcessingJob,
  abandonedUploadsJob,
  bloodworkExtractionJob,
  bloodworkCleanupJob,
  reconcileStorageJob,
  photoVariantsBackfillJob,
  retentionExportsJob,
  retentionBillingWebhooksJob,
  retentionChatJob,
  retentionNotificationsJob,
  retentionAuditJob,
  retentionSessionRevocationsJob,
  retentionJobLedgerJob,
  retentionSignInsJob,
  trainingMediaCleanupJob,
  patientMediaCleanupJob,
  patientSignInMetricsJob,
  dataGrowthSnapshotJob,
  systemThresholdsJob,
];

let registered = false;
export function registerAllJobs(): void {
  if (registered) return;
  for (const job of ALL_JOBS) registerJob(job);
  registered = true;
}
