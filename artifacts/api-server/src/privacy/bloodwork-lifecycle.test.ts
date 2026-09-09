import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UPLOAD_SURFACES } from "../jobs/upload-intents";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  here,
  "../../../../supabase/migrations/20261006010000_patient_bloodwork_lifecycle.sql",
);
const sql = readFileSync(migrationPath, "utf8");

describe("bloodwork lifecycle integration migration", () => {
  it("admits only the dedicated bloodwork upload surface through the shared intent ledger", () => {
    expect(UPLOAD_SURFACES).toContain("bloodwork");
    expect(sql).toMatch(/storage_upload_intents_surface_check[\s\S]*'bloodwork'/);
  });

  it("keeps staging and immutable report sources in both reference directions", () => {
    expect(sql).toContain("select bf.staging_object_path");
    expect(sql).toContain("select bf.object_path");
    expect(sql).toContain("br.lifecycle_status = 'staging'");
    expect(sql).toContain("br.lifecycle_status = 'committed'");
    expect(sql).toContain("'patient_bloodwork_staging'");
    expect(sql).toContain("'patient_bloodwork_file'");
  });

  it("blocks identity reassignment whenever either kind of bound bloodwork path exists", () => {
    expect(sql).toContain("create or replace function private.reconcile_invited_patient_duplicate");
    expect(sql).toContain("(select count(*) from public.patient_bloodwork_files where patient_id = duplicate.id)");
    expect(sql).toMatch(/path_bound_count > 0[\s\S]*patient-id-bound media/);
  });

  it("prepares a PII-free tombstone before storage and leaves FK ordering to the existing row purge", () => {
    expect(sql).toContain("create or replace function public.patient_purge_prepare_tombstone");
    expect(sql).toContain("insert into patient_tombstones");
    expect(sql).toContain("on conflict (id) do nothing");
    expect(sql).toContain("grant execute on function public.patient_purge_prepare_tombstone(uuid) to service_role");
  });
});