/**
 * Job catalogue: registers every background job with the scheduler. Import
 * this once at boot (index.ts) and from the HQ system-health and internal
 * trigger routes so the registry is populated wherever it is read.
 */
import { drainTrainingMediaCleanup } from "../training/media-cleanup";
import { abandonedUploadsJob } from "./definitions/abandoned-uploads";
import { reconcileStorageJob } from "./definitions/reconcile-storage";
import { retentionAuditJob, retentionBillingWebhooksJob, retentionChatJob, retentionExportsJob, retentionNotificationsJob } from "./definitions/retention";
import { registerJob } from "./scheduler";
import type { JobDefinition } from "./types";
import { bloodworkExtractionJob } from "./definitions/bloodwork-extraction";
import { bloodworkCleanupJob } from "./definitions/bloodwork-cleanup";
import { coachMemoryProcessingJob } from "./definitions/coach-memory-processing";
import { coachTitleProcessingJob } from "./definitions/coach-title-processing";
import { billingReconcileJob } from "./definitions/billing-reconcile";
import { billingRenewalRemindersJob } from "./definitions/billing-renewal-reminders";
import { staffAttentionDigestJob } from "./definitions/staff-attention-digest";

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

export const ALL_JOBS: JobDefinition[] = [
  staffAttentionDigestJob,
  billingReconcileJob,
  billingRenewalRemindersJob,
  coachTitleProcessingJob,
  coachMemoryProcessingJob,
  abandonedUploadsJob,
  bloodworkExtractionJob,
  bloodworkCleanupJob,
  reconcileStorageJob,
  retentionExportsJob,
  retentionBillingWebhooksJob,
  retentionChatJob,
  retentionNotificationsJob,
  retentionAuditJob,
  trainingMediaCleanupJob,
  patientMediaCleanupJob,
];

let registered = false;
export function registerAllJobs(): void {
  if (registered) return;
  for (const job of ALL_JOBS) registerJob(job);
  registered = true;
}
