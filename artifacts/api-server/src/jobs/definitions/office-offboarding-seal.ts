/**
 * office-offboarding-seal: step 4 of the office offboarding stepper. For
 * every office whose seal was started and has not completed, the run
 *
 *   1. skips the office entirely while an office-level legal hold is active
 *      (the hold predicate is also inside every SQL statement below, this is
 *      only the early exit that keeps the log honest);
 *   2. enqueues closure (grace 0) for every unsealed chart through
 *      `office_offboarding_seal_batch` — idempotent, patient-level holds park
 *      the request as `held`;
 *   3. claims the office's queued closures with the office-scoped claim RPC
 *      and runs the SAME closure primitive a patient's own account closure
 *      uses (logins destroyed, personal families purged, clinical families
 *      sealed until retain-until);
 *   4. refreshes the progress counters on the offboarding record and stamps
 *      `seal_completed_at` once nothing is pending or failing. Charts parked
 *      behind a patient hold stay counted as held; step 5 refuses until they
 *      are released and sealed.
 *
 * Every run is wall-clock bounded and signals itself while work remains, so
 * a large office seals across several leased runs. Dry runs only count.
 */
import { supabaseAdmin } from "../../lib/supabase-admin";
import { runClosure, type DeletionRequestRow } from "../../privacy/purge";
import { signalJob } from "../scheduler";
import type { JobContext, JobDefinition } from "../types";

export const OFFICE_OFFBOARDING_SEAL_JOB_NAME = "office-offboarding-seal";

const enc = encodeURIComponent;
const LEASE_OWNER = `offboarding-seal:${process.pid}`;
const RUN_BUDGET_MS = 4 * 60_000;
const ENQUEUE_BATCH = 200;
const CLAIM_BATCH = 10;

interface SealTarget {
  provider_id: string;
  seal_retain_until: string | null;
}

export interface SealProgress {
  total: number;
  sealed: number;
  held: number;
  pending: number;
  failed: number;
  destroyed: number;
}

export async function officeHoldActive(providerId: string): Promise<boolean> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/legal_holds?target_kind=eq.provider&target_id=eq.${enc(providerId)}&lifted_at=is.null&select=id&limit=1`,
  );
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`office hold lookup failed (${res.status})`);
  return res.json.length > 0;
}

export async function loadSealProgress(providerId: string): Promise<SealProgress> {
  const res = await supabaseAdmin("POST", "/rest/v1/rpc/office_offboarding_progress", { p_provider_id: providerId });
  if (res.status >= 300) throw new Error(`seal progress failed (${res.status})`);
  const row = (Array.isArray(res.json) ? res.json[0] : res.json) as Record<string, unknown> | undefined;
  const n = (key: keyof SealProgress) => {
    const value = Number(row?.[key]);
    return Number.isFinite(value) ? value : 0;
  };
  return { total: n("total"), sealed: n("sealed"), held: n("held"), pending: n("pending"), failed: n("failed"), destroyed: n("destroyed") };
}

async function loadSealTargets(): Promise<SealTarget[]> {
  const res = await supabaseAdmin(
    "GET",
    "/rest/v1/provider_offboardings?seal_started_at=not.is.null&seal_completed_at=is.null&offboarded_at=is.null&select=provider_id,seal_retain_until&order=seal_started_at.asc&limit=50",
  );
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`seal target scan failed (${res.status})`);
  return res.json as SealTarget[];
}

async function enqueueBatch(target: SealTarget): Promise<number> {
  const res = await supabaseAdmin("POST", "/rest/v1/rpc/office_offboarding_seal_batch", {
    p_provider_id: target.provider_id,
    p_retain_until: target.seal_retain_until,
    p_limit: ENQUEUE_BATCH,
  });
  if (res.status >= 300) throw new Error(`seal enqueue failed (${res.status})`);
  const count = typeof res.json === "number" ? res.json : Number(res.json);
  return Number.isFinite(count) ? count : 0;
}

async function claimOfficeClosures(providerId: string): Promise<DeletionRequestRow[]> {
  const res = await supabaseAdmin("POST", "/rest/v1/rpc/claim_office_patient_deletions", {
    p_provider_id: providerId,
    p_owner: LEASE_OWNER,
    p_limit: CLAIM_BATCH,
    p_lease_seconds: 600,
  });
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`office closure claim failed (${res.status})`);
  return res.json as DeletionRequestRow[];
}

async function writeProgress(providerId: string, progress: SealProgress, completedAt: string | null): Promise<void> {
  const res = await supabaseAdmin("PATCH", `/rest/v1/provider_offboardings?provider_id=eq.${enc(providerId)}`, {
    seal_patients_total: progress.total,
    seal_patients_done: progress.sealed,
    seal_patients_held: progress.held,
    ...(completedAt ? { seal_completed_at: completedAt } : {}),
    updated_at: new Date().toISOString(),
  });
  if (res.status >= 300) throw new Error(`seal progress write failed (${res.status})`);
}

export async function runOfficeOffboardingSeal(ctx: JobContext): Promise<void> {
  const startedAt = Date.now();
  const targets = await loadSealTargets();
  ctx.tally("offices", targets.length);
  let moreWork = false;

  for (const target of targets) {
    ctx.checkpoint();
    const providerId = target.provider_id;
    if (await officeHoldActive(providerId)) {
      ctx.tally("offices_on_hold");
      ctx.log("office_seal_blocked_by_hold", { providerId });
      continue;
    }
    if (ctx.dryRun) {
      const progress = await loadSealProgress(providerId);
      ctx.tally("would_seal", progress.pending);
      ctx.tally("held_patients", progress.held);
      continue;
    }
    try {
      // 2. enqueue every unsealed chart (bounded so a huge office cannot pin the run).
      for (let round = 0; round < 50; round += 1) {
        const queued = await enqueueBatch(target);
        ctx.tally("queued", queued);
        if (queued < ENQUEUE_BATCH) break;
        ctx.checkpoint();
      }
      // 3. close the queued charts with the shared primitive.
      let exhausted = false;
      while (Date.now() - startedAt < RUN_BUDGET_MS) {
        const claimed = await claimOfficeClosures(providerId);
        if (claimed.length === 0) {
          exhausted = true;
          break;
        }
        for (const request of claimed) {
          const outcome = await runClosure(request);
          ctx.tally(outcome === "closed" ? "sealed" : "failed");
          if (outcome === "failed") ctx.failItem(`patient:${request.patient_id}`, new Error("closure failed"), { reportLocal: true });
          ctx.checkpoint();
        }
      }
      // 4. progress + completion.
      const progress = await loadSealProgress(providerId);
      const complete = exhausted && progress.pending === 0 && progress.failed === 0;
      await writeProgress(providerId, progress, complete ? ctx.now.toISOString() : null);
      ctx.log(complete ? "office_seal_completed" : "office_seal_progress", { providerId, ...progress });
      if (!complete) moreWork = true;
    } catch (error) {
      ctx.failItem(`office:${providerId}`, error);
      moreWork = true;
    }
  }

  if (moreWork && !ctx.dryRun) {
    ctx.log("office_seal_continues");
    signalJob(OFFICE_OFFBOARDING_SEAL_JOB_NAME);
  }
}

export const officeOffboardingSealJob: JobDefinition = {
  name: OFFICE_OFFBOARDING_SEAL_JOB_NAME,
  title: "Office offboarding seals",
  description: "Seals every patient chart of an office being offboarded through the account-closure primitive, respecting legal holds, and records progress on the offboarding record.",
  intervalMs: 60_000,
  leaseSeconds: 10 * 60,
  run: runOfficeOffboardingSeal,
};
