/**
 * Record-access audit helper and the "who viewed my record" readers.
 *
 * The SQL RPC decides dedupe (proved on real PostgreSQL in the sibling
 * .sql.test); this suite covers the process side: the dedupe key shape, the
 * short-circuit cache honouring the server's window start, failures
 * surfacing (and being swallowed only by the fire-and-forget wrapper), and
 * the two export shapes — HQ with names, patient copy without.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("./supabase-admin", () => ({ supabaseAdmin: mocks.admin }));

import {
  RECORD_ACCESS_ACTIONS,
  RECORD_ACCESS_WINDOW_SEC,
  auditRecordAccess,
  recordAccessDedupeKey,
  recordRecordAccess,
  resetRecordAccessCache,
} from "./record-access-audit";
import { AUDIT_ACTIONS, OFFICE_VISIBLE_ACTIONS } from "./audit-events";
import { loadHqRecordAccess, loadPatientRecordAccess } from "../privacy/record-access";

const ACTOR = "00000000-0000-4000-8000-000000000011";
const PATIENT = "00000000-0000-4000-8000-000000000001";
const input = {
  action: "patient_record_viewed" as const,
  actorUserId: ACTOR,
  actorKind: "team_member" as const,
  providerId: "office-1",
  targetKind: "patient" as const,
  targetId: PATIENT,
  requestId: "req-1",
};
const decision = (recorded: boolean, startedAt = new Date().toISOString()) => ({ status: 200, json: [{ recorded, window_started_at: startedAt }] });

beforeEach(() => {
  resetRecordAccessCache();
  mocks.admin.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("record access actions", () => {
  it("are all allow-listed audit actions and visible to the office page", () => {
    for (const action of RECORD_ACCESS_ACTIONS) {
      expect(AUDIT_ACTIONS).toContain(action);
      expect(OFFICE_VISIBLE_ACTIONS).toContain(action);
    }
  });

  it("keys dedupe on action, target, and the optional facet", () => {
    expect(recordAccessDedupeKey(input)).toBe(`patient_record_viewed:patient:${PATIENT}`);
    expect(recordAccessDedupeKey({ ...input, action: "bloodwork_report_opened", facet: "rep-1" })).toBe(`bloodwork_report_opened:patient:${PATIENT}:rep-1`);
  });
});

describe("recordRecordAccess", () => {
  it("asks the RPC once, then short-circuits repeats until the server's window has passed", async () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    mocks.admin.mockResolvedValueOnce(decision(true, "2026-09-19T12:00:00Z"));
    expect(await recordRecordAccess(input, now)).toBe(true);
    expect(mocks.admin).toHaveBeenCalledWith("POST", "/rest/v1/rpc/record_admin_audit_read_event", {
      p_action: "patient_record_viewed", p_actor_user_id: ACTOR, p_actor_kind: "team_member", p_provider_id: "office-1",
      p_target_kind: "patient", p_target_id: PATIENT, p_request_id: "req-1", p_metadata: {},
      p_dedupe_key: `patient_record_viewed:patient:${PATIENT}`, p_window_seconds: RECORD_ACCESS_WINDOW_SEC,
    });
    expect(await recordRecordAccess(input, now + 60_000)).toBe(false);
    expect(await recordRecordAccess(input, now + RECORD_ACCESS_WINDOW_SEC * 1000 - 1)).toBe(false);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    // Window over: back to the RPC, which is the one that decides.
    mocks.admin.mockResolvedValueOnce(decision(true));
    expect(await recordRecordAccess(input, now + RECORD_ACCESS_WINDOW_SEC * 1000)).toBe(true);
    expect(mocks.admin).toHaveBeenCalledTimes(2);
  });

  it("trusts a window another instance opened: not recorded, but cached from the server's start", async () => {
    const now = Date.parse("2026-09-19T12:10:00Z");
    mocks.admin.mockResolvedValueOnce(decision(false, "2026-09-19T12:00:00Z"));
    expect(await recordRecordAccess(input, now)).toBe(false);
    // 12:14:59 is still inside the 12:00 window; 12:15 is not.
    expect(await recordRecordAccess(input, Date.parse("2026-09-19T12:14:59Z"))).toBe(false);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    mocks.admin.mockResolvedValueOnce(decision(true));
    expect(await recordRecordAccess(input, Date.parse("2026-09-19T12:15:00Z"))).toBe(true);
    expect(mocks.admin).toHaveBeenCalledTimes(2);
  });

  it("keeps actors and facets apart in the local cache", async () => {
    mocks.admin.mockResolvedValue(decision(true));
    const now = Date.now();
    expect(await recordRecordAccess(input, now)).toBe(true);
    expect(await recordRecordAccess({ ...input, actorUserId: "00000000-0000-4000-8000-000000000012" }, now)).toBe(true);
    expect(await recordRecordAccess({ ...input, action: "bloodwork_report_opened", facet: "rep-1" }, now)).toBe(true);
    expect(await recordRecordAccess({ ...input, action: "bloodwork_report_opened", facet: "rep-2" }, now)).toBe(true);
    expect(await recordRecordAccess({ ...input, action: "bloodwork_report_opened", facet: "rep-1" }, now)).toBe(false);
    expect(mocks.admin).toHaveBeenCalledTimes(4);
  });

  it("throws on store failure or a missing decision, and does not cache either", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 500, json: { message: "down" } });
    await expect(recordRecordAccess(input)).rejects.toThrow("record access audit write failed (500)");
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [] });
    await expect(recordRecordAccess(input)).rejects.toThrow("returned no decision");
    mocks.admin.mockResolvedValueOnce(decision(true));
    expect(await recordRecordAccess(input)).toBe(true);
    expect(mocks.admin).toHaveBeenCalledTimes(3);
  });
});

describe("auditRecordAccess", () => {
  it("carries the request id, never throws, and logs a warning on failure", async () => {
    const warn = vi.fn();
    mocks.admin.mockResolvedValueOnce({ status: 503, json: null });
    const req = { headers: { "x-request-id": "req-77" }, log: { warn } } as unknown as Parameters<typeof auditRecordAccess>[0];
    expect(() => auditRecordAccess(req, { ...input, requestId: undefined } as never)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mocks.admin.mock.calls[0][2]).toMatchObject({ p_request_id: "req-77" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_record_viewed" }), "record access audit write failed");
  });
});

describe("who viewed my record", () => {
  const TEAMMATE = "00000000-0000-4000-8000-000000000012";
  const HQ_USER = "00000000-0000-4000-8000-000000000013";
  const rows = [
    { id: 1, occurred_at: "2026-09-01T10:00:00Z", action: "patient_record_viewed", actor_user_id: TEAMMATE, actor_kind: "team_member", provider_id: "office-1", target_kind: "patient", target_id: PATIENT, request_id: null, metadata: {} },
    { id: 2, occurred_at: "2026-09-02T10:00:00Z", action: "conversation_transcript_opened", actor_user_id: HQ_USER, actor_kind: "hq", provider_id: "office-1", target_kind: "patient", target_id: PATIENT, request_id: null, metadata: { thread: "care_team", conversationId: "conv-1" } },
    { id: 3, occurred_at: "2026-09-03T10:00:00Z", action: "bloodwork_report_opened", actor_user_id: TEAMMATE, actor_kind: "team_member", provider_id: "office-1", target_kind: "patient", target_id: PATIENT, request_id: null, metadata: { reportId: "rep-9" } },
  ];

  beforeEach(() => {
    mocks.admin.mockImplementation(async (_method: string, path: string) => {
      if (path.startsWith("/rest/v1/admin_audit_events?")) {
        expect(path).toContain(`target_kind=eq.patient&target_id=eq.${PATIENT}`);
        expect(path).toContain(`action=in.(${RECORD_ACCESS_ACTIONS.join(",")})`);
        return { status: 200, json: rows };
      }
      if (path.startsWith("/rest/v1/hq_memberships?")) return { status: 200, json: [{ auth_user_id: HQ_USER, display_name: "Morgan HQ" }] };
      if (path.startsWith("/rest/v1/team_members?")) return { status: 200, json: [{ auth_user_id: TEAMMATE, name: "Nurse Kim" }] };
      if (path.startsWith("/rest/v1/providers?provider_id=")) return { status: 200, json: [{ provider_id: "office-1", provider_name: "Dr. Reyes", office_name: "Harbor Med Spa" }] };
      if (path.startsWith("/rest/v1/providers?")) return { status: 200, json: [] };
      if (path.startsWith("/rest/v1/patients?")) return { status: 200, json: [] };
      throw new Error(`unexpected ${path}`);
    });
  });

  it("gives HQ names, offices, and which report or conversation", async () => {
    const entries = await loadHqRecordAccess(PATIENT);
    expect(entries).toEqual([
      { occurredAt: "2026-09-01T10:00:00Z", action: "patient_record_viewed", label: "Viewed patient record", office: "Harbor Med Spa", providerId: "office-1", role: "Office teammate", actorUserId: TEAMMATE, actorName: "Nurse Kim", thread: null, reportId: null, conversationId: null },
      { occurredAt: "2026-09-02T10:00:00Z", action: "conversation_transcript_opened", label: "Opened conversation transcript", office: "Harbor Med Spa", providerId: "office-1", role: "HQ staff", actorUserId: HQ_USER, actorName: "Morgan HQ", thread: "care_team", reportId: null, conversationId: "conv-1" },
      { occurredAt: "2026-09-03T10:00:00Z", action: "bloodwork_report_opened", label: "Opened lab report", office: "Harbor Med Spa", providerId: "office-1", role: "Office teammate", actorUserId: TEAMMATE, actorName: "Nurse Kim", thread: null, reportId: "rep-9", conversationId: null },
    ]);
  });

  it("gives the patient dates, office, and role only — no staff names or ids", async () => {
    const entries = await loadPatientRecordAccess(PATIENT);
    expect(entries).toHaveLength(3);
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(["action", "label", "occurredAt", "office", "role", "thread"]);
    expect(entries[1]).toEqual({ occurredAt: "2026-09-02T10:00:00Z", action: "conversation_transcript_opened", label: "Opened conversation transcript", office: "Harbor Med Spa", role: "HQ staff", thread: "care_team" });
    expect(JSON.stringify(entries)).not.toMatch(/Nurse Kim|Morgan HQ|office-1|rep-9|conv-1/);
  });

  it("fails loudly when the audit query fails", async () => {
    mocks.admin.mockReset().mockResolvedValue({ status: 500, json: null });
    await expect(loadPatientRecordAccess(PATIENT)).rejects.toThrow("record access query failed (500)");
  });
});
