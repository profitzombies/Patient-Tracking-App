/**
 * Audit vocabulary and metadata hygiene.
 *
 * The fixed action list is the only thing an audit reader can filter by and
 * the metadata allowlist is the only thing that leaves the store, so both
 * are pinned here: every instrumented route's action must be listed, the
 * office view must be a strict subset, and the allowlist must never admit
 * message bodies, note text, transcripts, or file contents.
 */
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_METADATA_KEYS,
  OFFICE_VISIBLE_ACTIONS,
  actorLabel,
  auditWindow,
  officeVisibleActions,
  safeMetadata,
  targetLabel,
} from "./audit-events";

const REQUIRED_ACTIONS = [
  // staff role/status changes
  "office_team_invited", "office_team_role_changed", "office_team_deactivated", "office_team_reactivated", "office_team_signed_out",
  // file downloads + knowledge library
  "hq_file_downloaded", "knowledge_document_uploaded", "knowledge_document_replaced", "knowledge_document_deleted",
  // training lifecycle
  "training_published", "training_unpublished", "training_deleted", "training_media_deleted", "training_attachment_downloaded",
  // AI support usage, transcript reads, exports, denials
  "ai_support_used", "conversation_transcript_read", "data_export_requested", "data_export_downloaded", "access_denied",
  "patient_record_export_requested", "patient_record_export_downloaded", "patient_record_export_cancelled", "data_export_cancelled",
  // record access (staff reads of a patient's chart)
  "patient_record_viewed", "patient_photos_viewed", "patient_bloodwork_viewed", "bloodwork_report_opened",
  "patient_medications_viewed", "conversation_transcript_opened",
  // staff-initiated billing changes
  "billing_refund_issued", "billing_subscription_cancelled", "billing_subscription_payment_retried",
  "billing_subscription_payment_email_sent", "billing_order_fulfillment_updated", "billing_prices_updated",
  "billing_payment_link_created", "billing_payment_link_updated", "billing_connect_started",
  "billing_connect_completed", "billing_connect_disconnected", "billing_settings_updated", "billing_sandbox_reset",
  "billing_product_created", "billing_product_updated", "billing_product_archived", "billing_product_floor_updated",
];

describe("audit action vocabulary", () => {
  it("covers every sensitive action the task instruments", () => {
    for (const action of REQUIRED_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it("office-visible actions are a strict subset that excludes HQ-only administration", () => {
    for (const action of OFFICE_VISIBLE_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
    for (const hqOnly of ["hq_team_invited", "hq_team_updated", "hq_team_revoked", "hq_settings_updated", "hq_file_uploaded", "hq_file_downloaded", "hq_file_deleted", "knowledge_document_uploaded", "training_published", "ai_support_used"]) {
      expect(officeVisibleActions.has(hqOnly)).toBe(false);
    }
    for (const officeAction of ["office_team_deactivated", "patient_note_added", "data_export_downloaded", "patient_record_export_requested", "patient_record_export_downloaded", "patient_record_export_cancelled", "access_denied", "billing_refund_issued", "billing_payment_link_created", "patient_record_viewed", "bloodwork_report_opened", "conversation_transcript_opened"]) {
      expect(officeVisibleActions.has(officeAction)).toBe(true);
    }
  });

  it("refuses filters outside the given vocabulary", () => {
    expect(auditWindow({ action: "hq_team_revoked", actions: officeVisibleActions })).toBeNull();
    expect(auditWindow({ action: "office_team_invited", actions: officeVisibleActions })).toEqual({ fromMs: null, toMs: null });
  });
});

describe("audit metadata allowlist", () => {
  it("never admits free-text or payload keys", () => {
    for (const forbidden of ["body", "text", "message", "note", "notes", "content", "transcript", "prompt", "reply", "answer", "question", "email", "phone", "name", "weight", "file", "data", "url", "token"]) {
      expect(AUDIT_METADATA_KEYS).not.toContain(forbidden);
    }
  });

  it("strips unknown keys and non-scalar values while keeping allow-listed facts", () => {
    expect(
      safeMetadata({
        reason: "permission", role: "admin", status: 403, size: 2048, contentType: "application/pdf", turn: 3, rows: 12,
        order_id: "order-1", amount_cents: 1200, active: true, reportId: "rep-1", conversationId: "conv-1", thread: "care_team", photos: 4,
        body: "patient said …", transcript: ["hi"], notes: { text: "clinical" }, fields: ["first_name"], route: "/office/team", nested: { reason: "x" },
      }),
    ).toEqual({ reason: "permission", role: "admin", status: 403, size: 2048, contentType: "application/pdf", turn: 3, rows: 12, order_id: "order-1", amount_cents: 1200, active: true, reportId: "rep-1", conversationId: "conv-1", thread: "care_team", photos: 4, route: "/office/team" });
    expect(safeMetadata(null)).toEqual({});
    expect(safeMetadata(["reason"])).toEqual({});
  });
});

describe("audit labels", () => {
  const names = { actors: new Map([["u-1", "Adam Admin"]]), offices: new Map(), targets: new Map([["patient:p-1", "Casey Ortiz"]]) };
  it("names the actor when known and falls back to a kind label", () => {
    expect(actorLabel({ actor_user_id: "u-1", actor_kind: "team_member" }, names)).toBe("Adam Admin");
    expect(actorLabel({ actor_user_id: "u-2", actor_kind: "team_member" }, names)).toBe("Office teammate");
    expect(actorLabel({ actor_user_id: null, actor_kind: "system" }, names)).toBe("System");
  });
  it("labels targets as kind + name and never echoes an unresolved id", () => {
    expect(targetLabel({ target_kind: "patient", target_id: "p-1" }, names)).toBe("Patient: Casey Ortiz");
    expect(targetLabel({ target_kind: "patient", target_id: "p-9" }, names)).toBe("Patient");
    expect(targetLabel({ target_kind: "route", target_id: "GET /office/team" }, names)).toBe("Protected route: GET /office/team");
    expect(targetLabel({ target_kind: null, target_id: null }, names)).toBeNull();
  });
});
