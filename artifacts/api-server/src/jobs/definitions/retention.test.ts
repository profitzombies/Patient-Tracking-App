import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  deleteObjectStrict: vi.fn(),
  loadOrgPolicy: vi.fn(),
  sweepExpiredExports: vi.fn(),
  sweepExpiredPatientExports: vi.fn(),
}));
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../../lib/objectStorage", () => ({ objectStorage: { deleteObjectStrict: mocks.deleteObjectStrict } }));
vi.mock("../../lib/org-policy", () => ({ loadOrgPolicy: mocks.loadOrgPolicy }));
vi.mock("../../exports/worker", () => ({ sweepExpiredExports: mocks.sweepExpiredExports }));
vi.mock("../../privacy/exports", () => ({ sweepExpiredPatientExports: mocks.sweepExpiredPatientExports }));

import {
  archiveAuditEvents,
  cutoffFor,
  KEEP_RUNS_PER_JOB,
  pruneBillingWebhookPayloads,
  retainBillingWebhooks,
  sweepExportArchives,
  sweepSessionRevocations,
  trimBillingWebhookEvents,
  trimChatTranscripts,
  trimJobLedger,
  trimNotificationHistory,
  trimSignInLedger,
} from "./retention";
import type { JobContext } from "../types";

const NOW = new Date("2026-09-07T12:00:00Z");

function ctx(dryRun = false) {
  const counts: Record<string, number> = {};
  const failures: Array<{ item: string; error: string }> = [];
  const c: JobContext = {
    dryRun,
    now: NOW,
    tally: (k, by = 1) => { counts[k] = (counts[k] ?? 0) + by; },
    failItem: (item, error) => { failures.push({ item, error: error instanceof Error ? error.message : String(error) }); },
    leaseLost: false,
    checkpoint: () => undefined,
    log: () => undefined,
  };
  return { c, counts, failures };
}

type RetentionOverrides = Partial<Record<"chatTranscriptDays" | "notificationHistoryDays" | "auditEventDays" | "jobRunDays" | "signInDays" | "webhookEventDays", unknown>>;
const policy = (retention: RetentionOverrides = {}) => ({
  retention: {
    chatTranscriptDays: 730,
    progressPhotoDays: 730,
    notificationHistoryDays: 180,
    auditEventDays: 2555,
    jobRunDays: 90,
    signInDays: 180,
    webhookEventDays: 365,
    clinicalRecordDays: 2555,
    ...retention,
  },
});

describe("retention jobs", () => {
  beforeEach(() => {
    mocks.admin.mockReset();
    mocks.deleteObjectStrict.mockReset().mockResolvedValue(undefined);
    mocks.loadOrgPolicy.mockReset().mockResolvedValue(policy());
    mocks.sweepExpiredExports.mockReset();
    mocks.sweepExpiredPatientExports.mockReset();
  });

  it("derives the cutoff from the run instant and the policy days", () => {
    expect(cutoffFor(NOW, 730)).toBe("2024-09-07T12:00:00.000Z");
    expect(cutoffFor(NOW, 1)).toBe("2026-09-06T12:00:00.000Z");
  });

  it("reads policy fresh and refuses to trim when it is unreadable or nonsensical", async () => {
    mocks.loadOrgPolicy.mockRejectedValueOnce(new Error("settings row unreadable"));
    await expect(trimChatTranscripts(ctx().c)).rejects.toThrow("settings row unreadable");
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.loadOrgPolicy).toHaveBeenCalledWith({ fresh: true });
    mocks.loadOrgPolicy.mockResolvedValueOnce(policy({ chatTranscriptDays: 0 }));
    await expect(trimChatTranscripts(ctx().c)).rejects.toThrow("chat transcript retention period");
    mocks.loadOrgPolicy.mockResolvedValueOnce(policy({ notificationHistoryDays: Number.NaN }));
    await expect(trimNotificationHistory(ctx().c)).rejects.toThrow("notification history retention period");
    mocks.loadOrgPolicy.mockResolvedValueOnce(policy({ auditEventDays: "soon" }));
    await expect(archiveAuditEvents(ctx().c)).rejects.toThrow("audit event retention period");
    mocks.loadOrgPolicy.mockResolvedValueOnce(policy({ jobRunDays: 0 }));
    await expect(trimJobLedger(ctx().c)).rejects.toThrow("job run history retention period");
    mocks.loadOrgPolicy.mockResolvedValueOnce(policy({ signInDays: 1.5 }));
    await expect(trimSignInLedger(ctx().c)).rejects.toThrow("sign-in history retention period");
    mocks.loadOrgPolicy.mockResolvedValueOnce(policy({ webhookEventDays: undefined }));
    await expect(trimBillingWebhookEvents(ctx().c)).rejects.toThrow("webhook event retention period");
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("trims chat in batches until a short batch, deleting freed photos and recording byte failures per item", async () => {
    mocks.loadOrgPolicy.mockResolvedValue(policy({ chatTranscriptDays: 30 }));
    const batches = [
      { messages_deleted: 500, conversations_deleted: 0, media_paths: ["/objects/patient-media/p/chat-a", "/objects/patient-media/p/chat-b"] },
      { messages_deleted: 12, conversations_deleted: 3, media_paths: null },
    ];
    mocks.admin.mockImplementation(async (_m: string, path: string) => {
      expect(path).toBe("/rest/v1/rpc/retention_trim_chat_transcripts");
      return { status: 200, json: [batches.shift()] };
    });
    mocks.deleteObjectStrict.mockImplementation(async (p: string) => {
      if (p.endsWith("chat-b")) throw new Error("storage refused");
    });
    const { c, counts, failures } = ctx();
    await trimChatTranscripts(c);
    expect(mocks.admin).toHaveBeenCalledTimes(2);
    expect(mocks.admin.mock.calls[0][2]).toEqual({ p_cutoff: "2026-08-08T12:00:00.000Z", p_limit: 500, p_dry_run: false });
    expect(counts).toEqual({ messagesDeleted: 512, conversationsDeleted: 3, mediaObjectsDeleted: 1 });
    expect(failures).toEqual([{ item: "/objects/patient-media/p/chat-b", error: "storage refused" }]);
  });

  it("chat dry run asks the SQL for a dry count once and deletes nothing", async () => {
    mocks.admin.mockResolvedValue({ status: 200, json: [{ messages_deleted: 500, conversations_deleted: 4, media_paths: ["/objects/x"] }] });
    const { c, counts } = ctx(true);
    await trimChatTranscripts(c);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    expect(mocks.admin.mock.calls[0][2]).toMatchObject({ p_dry_run: true });
    expect(mocks.deleteObjectStrict).not.toHaveBeenCalled();
    expect(counts).toEqual({ messagesDue: 500, conversationsDue: 4, mediaObjectsDue: 1 });
  });

  it("trims notification history with the policy cutoff and surfaces RPC failures", async () => {
    mocks.loadOrgPolicy.mockResolvedValue(policy({ notificationHistoryDays: 180 }));
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: 500 })
      .mockResolvedValueOnce({ status: 200, json: 7 })
      .mockResolvedValueOnce({ status: 200, json: 500 })
      .mockResolvedValueOnce({ status: 200, json: 3 });
    const { c, counts } = ctx();
    await trimNotificationHistory(c);
    expect(mocks.admin.mock.calls[0][1]).toBe("/rest/v1/rpc/retention_trim_notifications");
    expect(mocks.admin.mock.calls[0][2]).toEqual({ p_cutoff: "2026-03-11T12:00:00.000Z", p_limit: 500, p_dry_run: false });
    expect(mocks.admin.mock.calls[2][1]).toBe("/rest/v1/rpc/retention_trim_staff_alerts");
    expect(mocks.admin.mock.calls[2][2]).toEqual({ p_cutoff: "2026-03-11T12:00:00.000Z", p_limit: 500, p_dry_run: false });
    expect(counts).toEqual({ notificationsDeleted: 507, staffAlertRowsDeleted: 503 });
    mocks.admin.mockReset().mockResolvedValue({ status: 500, json: null });
    await expect(trimNotificationHistory(ctx().c)).rejects.toThrow("notification trim failed (500)");
  });

  it("counts staff alert rows due without deleting during a dry run", async () => {
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: 4 })
      .mockResolvedValueOnce({ status: 200, json: 6 });
    const { c, counts } = ctx(true);
    await trimNotificationHistory(c);
    expect(counts).toEqual({ notificationsDue: 4, staffAlertRowsDue: 6 });
    expect(mocks.admin.mock.calls[1][2]).toMatchObject({ p_dry_run: true });
  });

  it("archives audit events to summaries in batches and counts summaries touched", async () => {
    mocks.loadOrgPolicy.mockResolvedValue(policy({ auditEventDays: 365 }));
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: [{ events_archived: 500, summaries_touched: 9 }] })
      .mockResolvedValueOnce({ status: 200, json: [{ events_archived: 40, summaries_touched: 2 }] });
    const { c, counts } = ctx();
    await archiveAuditEvents(c);
    expect(mocks.admin.mock.calls[0][1]).toBe("/rest/v1/rpc/retention_archive_audit_events");
    expect(mocks.admin.mock.calls[0][2]).toEqual({ p_cutoff: "2025-09-07T12:00:00.000Z", p_limit: 500, p_dry_run: false });
    expect(counts).toEqual({ eventsArchived: 540, summariesTouched: 11 });
  });

  it("export sweep delegates to both existing sweeps with the run instant, and dry-runs by counting due rows", async () => {
    mocks.sweepExpiredExports.mockResolvedValue({ expired: 2, pruned: 5 });
    mocks.sweepExpiredPatientExports.mockResolvedValue({ expired: 1, pruned: 0 });
    const live = ctx();
    await sweepExportArchives(live.c);
    expect(mocks.sweepExpiredExports).toHaveBeenCalledWith(NOW);
    expect(mocks.sweepExpiredPatientExports).toHaveBeenCalledWith(NOW);
    expect(live.counts).toEqual({ officeExpired: 2, officePruned: 5, patientExpired: 1, patientPruned: 0 });

    mocks.sweepExpiredExports.mockClear();
    mocks.admin.mockImplementation(async (_m: string, path: string) => {
      expect(path).toContain(`expires_at=lt.${encodeURIComponent(NOW.toISOString())}`);
      return { status: 200, json: path.startsWith("/rest/v1/data_exports") ? [{ id: 1 }, { id: 2 }, { id: 3 }] : [{ id: 9 }] };
    });
    const dry = ctx(true);
    await sweepExportArchives(dry.c);
    expect(mocks.sweepExpiredExports).not.toHaveBeenCalled();
    expect(dry.counts).toEqual({ officeExportsDue: 3, patientExportsDue: 1 });
  });

  it("prunes only old processed billing webhook payloads and supports dry run", async () => {
    process.env.BILLING_WEBHOOK_PAYLOAD_RETENTION_DAYS = "30";
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{ stripe_event_id: "evt_1" }] });
    const dry = ctx(true);
    await pruneBillingWebhookPayloads(dry.c);
    expect(dry.counts).toEqual({ payloadsDue: 1 });
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    expect(mocks.admin.mock.calls[0][1]).toContain("processed_at=not.is.null");
    expect(mocks.admin.mock.calls[0][1]).toContain("2026-08-08T12%3A00%3A00.000Z");

    mocks.admin.mockReset()
      .mockResolvedValueOnce({ status: 200, json: [{ stripe_event_id: "evt_1" }] })
      .mockResolvedValueOnce({ status: 204, json: null });
    const live = ctx();
    await pruneBillingWebhookPayloads(live.c);
    expect(live.counts).toEqual({ payloadsPruned: 1 });
    expect(mocks.admin.mock.calls[1]).toEqual([
      "PATCH",
      expect.stringContaining("/rest/v1/billing_webhook_events?"),
      { payload: null, payload_pruned_at: NOW.toISOString() },
    ]);
    delete process.env.BILLING_WEBHOOK_PAYLOAD_RETENTION_DAYS;
  });

  it("sweeps only revocation rows past their own expiry, counting instead of deleting on a dry run", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{ session_id: "s1" }, { session_id: "s2" }] });
    const dry = ctx(true);
    await sweepSessionRevocations(dry.c);
    expect(dry.counts).toEqual({ rowsDue: 2 });
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    expect(mocks.admin.mock.calls[0][0]).toBe("GET");
    expect(mocks.admin.mock.calls[0][1]).toContain(`/rest/v1/auth_session_revocations?expires_at=lt.${encodeURIComponent(NOW.toISOString())}`);

    mocks.admin.mockReset()
      .mockResolvedValueOnce({ status: 200, json: [{ session_id: "s1" }, { session_id: "s2" }] })
      .mockResolvedValueOnce({ status: 204, json: null, contentRange: "*/2" });
    const live = ctx();
    await sweepSessionRevocations(live.c);
    expect(live.counts).toEqual({ rowsDeleted: 2 });
    expect(mocks.admin.mock.calls[1][0]).toBe("DELETE");
    expect(mocks.admin.mock.calls[1][1]).toContain(`expires_at=lt.${encodeURIComponent(NOW.toISOString())}`);

    // Nothing due: no delete is issued at all.
    mocks.admin.mockReset().mockResolvedValueOnce({ status: 200, json: [] });
    const idle = ctx();
    await sweepSessionRevocations(idle.c);
    expect(idle.counts).toEqual({});
    expect(mocks.admin).toHaveBeenCalledTimes(1);

    // An unreadable list is a failed run, never a silent no-op.
    mocks.admin.mockReset().mockResolvedValueOnce({ status: 503, json: null });
    await expect(sweepSessionRevocations(ctx().c)).rejects.toThrow(/revocation retention scan failed/);
  });

  describe("job run ledger", () => {
    it("trims runs in batches with the policy cutoff and the keep-latest floor, counting cascaded item failures", async () => {
      mocks.loadOrgPolicy.mockResolvedValue(policy({ jobRunDays: 90 }));
      mocks.admin
        .mockResolvedValueOnce({ status: 200, json: [{ runs_deleted: 500, item_failures_deleted: 12 }] })
        .mockResolvedValueOnce({ status: 200, json: [{ runs_deleted: 41, item_failures_deleted: 0 }] });
      const { c, counts } = ctx();
      await trimJobLedger(c);
      expect(mocks.admin).toHaveBeenCalledTimes(2);
      expect(mocks.admin.mock.calls[0][1]).toBe("/rest/v1/rpc/retention_trim_job_runs");
      expect(mocks.admin.mock.calls[0][2]).toEqual({ p_cutoff: "2026-06-09T12:00:00.000Z", p_keep: KEEP_RUNS_PER_JOB, p_limit: 500, p_dry_run: false });
      expect(KEEP_RUNS_PER_JOB).toBe(50);
      expect(counts).toEqual({ runsDeleted: 541, itemFailuresDeleted: 12 });
    });

    it("dry run asks once with p_dry_run and reports due counts only", async () => {
      mocks.admin.mockResolvedValue({ status: 200, json: [{ runs_deleted: 500, item_failures_deleted: 7 }] });
      const { c, counts } = ctx(true);
      await trimJobLedger(c);
      expect(mocks.admin).toHaveBeenCalledTimes(1);
      expect(mocks.admin.mock.calls[0][2]).toMatchObject({ p_dry_run: true, p_keep: 50 });
      expect(counts).toEqual({ runsDue: 500, itemFailuresDue: 7 });
    });

    it("stops at the batch ceiling even when every batch is full, and surfaces RPC failures", async () => {
      mocks.admin.mockResolvedValue({ status: 200, json: [{ runs_deleted: 500, item_failures_deleted: 1 }] });
      const { c, counts } = ctx();
      await trimJobLedger(c);
      expect(mocks.admin).toHaveBeenCalledTimes(20);
      expect(counts).toEqual({ runsDeleted: 10_000, itemFailuresDeleted: 20 });
      mocks.admin.mockReset().mockResolvedValue({ status: 500, json: null });
      await expect(trimJobLedger(ctx().c)).rejects.toThrow("job run trim failed (500)");
      mocks.admin.mockReset().mockResolvedValue({ status: 200, json: [] });
      await expect(trimJobLedger(ctx().c)).rejects.toThrow("job run trim returned nothing");
    });
  });

  describe("sign-in ledger", () => {
    it("passes the cutoff AND the run instant (report-token guard) to one RPC per batch", async () => {
      mocks.loadOrgPolicy.mockResolvedValue(policy({ signInDays: 180 }));
      mocks.admin
        .mockResolvedValueOnce({ status: 200, json: 500 })
        .mockResolvedValueOnce({ status: 200, json: 500 })
        .mockResolvedValueOnce({ status: 200, json: 3 });
      const { c, counts } = ctx();
      await trimSignInLedger(c);
      expect(mocks.admin).toHaveBeenCalledTimes(3);
      expect(mocks.admin.mock.calls[0][1]).toBe("/rest/v1/rpc/retention_trim_sign_ins");
      expect(mocks.admin.mock.calls[0][2]).toEqual({
        p_cutoff: "2026-03-11T12:00:00.000Z",
        p_now: "2026-09-07T12:00:00.000Z",
        p_limit: 500,
        p_dry_run: false,
      });
      expect(counts).toEqual({ signInsDeleted: 1003 });
    });

    it("dry run counts due rows once without a second batch and never a live delete", async () => {
      mocks.admin.mockResolvedValue({ status: 200, json: 500 });
      const { c, counts } = ctx(true);
      await trimSignInLedger(c);
      expect(mocks.admin).toHaveBeenCalledTimes(1);
      expect(mocks.admin.mock.calls[0][2]).toMatchObject({ p_dry_run: true });
      expect(counts).toEqual({ signInsDue: 500 });
      mocks.admin.mockReset().mockResolvedValue({ status: 403, json: null });
      await expect(trimSignInLedger(ctx().c)).rejects.toThrow("sign-in trim failed (403)");
    });
  });

  describe("billing webhook event rows", () => {
    it("deletes final rows past the policy window in batches, and the job runs the payload prune first", async () => {
      mocks.loadOrgPolicy.mockResolvedValue(policy({ webhookEventDays: 365 }));
      mocks.admin
        .mockResolvedValueOnce({ status: 200, json: [] }) // payload prune scan: nothing due
        .mockResolvedValueOnce({ status: 200, json: 500 })
        .mockResolvedValueOnce({ status: 200, json: 9 });
      const { c, counts } = ctx();
      await retainBillingWebhooks(c);
      expect(mocks.admin).toHaveBeenCalledTimes(3);
      expect(mocks.admin.mock.calls[0][0]).toBe("GET");
      expect(mocks.admin.mock.calls[0][1]).toContain("/rest/v1/billing_webhook_events?processed_at=not.is.null");
      expect(mocks.admin.mock.calls[1][1]).toBe("/rest/v1/rpc/retention_trim_billing_webhook_events");
      expect(mocks.admin.mock.calls[1][2]).toEqual({ p_cutoff: "2025-09-07T12:00:00.000Z", p_limit: 500, p_dry_run: false });
      expect(counts).toEqual({ payloadsPruned: 0, eventRowsDeleted: 509 });
    });

    it("dry run reports rows due, deletes nothing, and a failed RPC fails the run", async () => {
      mocks.admin
        .mockResolvedValueOnce({ status: 200, json: [{ stripe_event_id: "evt_1" }] })
        .mockResolvedValueOnce({ status: 200, json: 500 });
      const { c, counts } = ctx(true);
      await retainBillingWebhooks(c);
      expect(mocks.admin).toHaveBeenCalledTimes(2);
      expect(mocks.admin.mock.calls.every(([method]) => method !== "PATCH" && method !== "DELETE")).toBe(true);
      expect(counts).toEqual({ payloadsDue: 1, eventRowsDue: 500 });
      mocks.admin.mockReset().mockResolvedValue({ status: 500, json: null });
      await expect(trimBillingWebhookEvents(ctx().c)).rejects.toThrow("webhook event trim failed (500)");
    });
  });
});
