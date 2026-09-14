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

import { archiveAuditEvents, cutoffFor, pruneBillingWebhookPayloads, sweepExportArchives, trimChatTranscripts, trimNotificationHistory } from "./retention";
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

const policy = (retention: Partial<{ chatTranscriptDays: unknown; notificationHistoryDays: unknown; auditEventDays: unknown }> = {}) => ({
  retention: { chatTranscriptDays: 730, progressPhotoDays: 730, notificationHistoryDays: 180, auditEventDays: 2555, ...retention },
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
    mocks.admin.mockResolvedValueOnce({ status: 200, json: 500 }).mockResolvedValueOnce({ status: 200, json: 7 });
    const { c, counts } = ctx();
    await trimNotificationHistory(c);
    expect(mocks.admin.mock.calls[0][1]).toBe("/rest/v1/rpc/retention_trim_notifications");
    expect(mocks.admin.mock.calls[0][2]).toEqual({ p_cutoff: "2026-03-11T12:00:00.000Z", p_limit: 500, p_dry_run: false });
    expect(counts).toEqual({ notificationsDeleted: 507 });
    mocks.admin.mockReset().mockResolvedValue({ status: 500, json: null });
    await expect(trimNotificationHistory(ctx().c)).rejects.toThrow("notification trim failed (500)");
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
});
