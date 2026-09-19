/**
 * Every patient-owned table must be classified for account closure.
 *
 * `patient_close_rows` deletes an explicit list of PERSONAL tables and leaves
 * the CLINICAL chart sealed until the retention window ends. A table added
 * later would silently fall into "kept" — which is the safe default for a
 * medical record, but never a decision to make by accident. This suite reads
 * every migration, finds each table that carries `patient_id`, and fails
 * unless the table is named in the migration's personal list, in the clinical
 * list below, or in the lifecycle/analytics special cases.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, "../../../../supabase/migrations");
const CLOSURE_MIGRATION = path.join(MIGRATIONS_DIR, "20261108000000_account_closure.sql");

/** Kept at closure, sealed read-only, purged when `record_retain_until` passes. */
const CLINICAL_TABLES = new Set([
  "patient_check_ins",
  "patient_staff_weights",
  "patient_body_measurements",
  "patient_health_measurements",
  "patient_medications",
  "patient_medication_dose_logs",
  "patient_bloodwork_reports",
  "patient_bloodwork_results",
  "patient_bloodwork_files",
  "patient_bloodwork_corrections",
  "patient_progress_photos",
  "patient_provider_notes",
  "patient_edit_history", // prior values of chart edits stay with the sealed record
  "patient_operational_follow_ups",
  "office_attention_seen",
  "billing_orders",
  "billing_subscriptions",
  "billing_payers",
  "billing_payment_links",
  "billing_prebuilt_carts",
  "billing_warehouse_submissions",
]);

/** Handled by dedicated statements inside `patient_close_rows`, not the personal array. */
const SPECIAL_CASE_TABLES = new Set([
  "patient_deletion_requests", // the lifecycle row itself
  "analytics_events", // append-only; detached at final purge
  "ai_usage_events", // append-only usage ledger; detached at closure
  "patient_chat_conversations", // coach/support threads deleted, care_team kept
  "patient_chat_patient_read_markers", // cascades with the conversation
  "patient_media", // food/recipe/chat objects deleted, progress kept
]);

function patientIdTables(): Set<string> {
  const tables = new Set<string>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const match of sql.matchAll(/create table(?: if not exists)?\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      if (/^\s*patient_id\b/m.test(match[2])) tables.add(match[1]);
    }
    for (const match of sql.matchAll(/alter table(?: if exists)?\s+(?:public\.)?(\w+)\s+([\s\S]*?);/gi)) {
      if (/add column(?: if not exists)?\s+patient_id\b/i.test(match[2])) tables.add(match[1]);
    }
  }
  return tables;
}

function personalTablesFromMigration(): Set<string> {
  const sql = readFileSync(CLOSURE_MIGRATION, "utf8");
  const block = sql.match(/v_personal constant text\[\] := array\[([\s\S]*?)\];/i);
  if (!block) throw new Error("patient_close_rows personal table list not found");
  return new Set(Array.from(block[1].matchAll(/'([a-z0-9_]+)'/g), (m) => m[1]));
}

describe("account closure table classification", () => {
  it("classifies every patient_id table as personal, clinical, or special-cased", () => {
    const personal = personalTablesFromMigration();
    const overlap = [...personal].filter((name) => CLINICAL_TABLES.has(name) || SPECIAL_CASE_TABLES.has(name));
    expect(overlap).toEqual([]);

    const unclassified = [...patientIdTables()]
      .filter((name) => !personal.has(name) && !CLINICAL_TABLES.has(name) && !SPECIAL_CASE_TABLES.has(name))
      .sort();
    expect(unclassified, "add new patient_id tables to the closure migration (personal) or CLINICAL_TABLES").toEqual([]);
  });

  it("never lists the retained clinical families as personal", () => {
    const personal = personalTablesFromMigration();
    for (const name of ["patient_staff_weights", "patient_medications", "patient_progress_photos", "patient_provider_notes", "billing_orders"]) {
      expect(personal.has(name), name).toBe(false);
    }
    for (const name of ["patient_diary_entries", "patient_push_tokens", "patient_consents", "patient_app_events", "billing_carts"]) {
      expect(personal.has(name), name).toBe(true);
    }
  });
});
