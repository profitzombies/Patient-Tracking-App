/**
 * office-bundle-export: builds whole-office record bundles (HQ export kind
 * `office_bundle`) one at a time. Every run advances the oldest queued or
 * running bundle for a bounded wall-clock budget, committing after each
 * finished ZIP part, then signals itself again while work remains. A server
 * restart mid-bundle costs at most the part that was being written: the next
 * run resumes from the last committed patient.
 *
 * Dry runs only count the patients the current bundle still has to pack.
 */
import { runOfficeBundleStep } from "../../exports/office-bundle";
import { signalJob } from "../scheduler";
import type { JobContext, JobDefinition } from "../types";

export const OFFICE_BUNDLE_JOB_NAME = "office-bundle-export";

export async function runOfficeBundleExport(ctx: JobContext): Promise<void> {
  const result = await runOfficeBundleStep({
    dryRun: ctx.dryRun,
    tally: (key, by) => ctx.tally(key, by),
    log: (event, detail) => ctx.log(event, detail),
    checkpoint: () => ctx.checkpoint(),
  });
  if (result.moreWork && !ctx.dryRun) {
    ctx.log("office_bundle_continues", { jobId: result.jobId });
    signalJob(OFFICE_BUNDLE_JOB_NAME);
  }
}

export const officeBundleExportJob: JobDefinition = {
  name: OFFICE_BUNDLE_JOB_NAME,
  title: "Office record bundles",
  description: "Packs an entire office's patient records and business CSVs into numbered ZIP parts for an HQ export request; resumes from the last finished part after a restart.",
  intervalMs: 60_000,
  leaseSeconds: 15 * 60,
  run: runOfficeBundleExport,
};
