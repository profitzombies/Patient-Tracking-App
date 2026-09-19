/**
 * Patient edit history SQL, run for real.
 *
 * Boots a throwaway PostgreSQL cluster, applies the canonical migration over
 * a mirror of the tables it depends on, and proves the HIPAA property the
 * feature exists for: correcting a weight twice leaves BOTH prior values
 * retrievable, in order, with who changed them and the paired audit event.
 * Also covers grouping per change, the family filter and paging of the read
 * RPC, office scoping, append-only enforcement, the identity write barrier,
 * cascade on patient delete, and service-role-only grants. Skips loudly
 * without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261107000000_patient_edit_history.sql");
const available = ["initdb", "pg_ctl", "psql"].every((name) => spawnSync("which", [name], { stdio: "ignore" }).status === 0);
if (!available) console.warn("patient-edit-history.sql.test: PostgreSQL binaries unavailable — skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
alter database postgres set test.role = 'service_role';
create table public.providers (provider_id text primary key);
create table public.patients (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  archived_at timestamptz, unique (id, provider_id));
create function private.guard_patient_dependency_write() returns trigger language plpgsql security definer set search_path = '' as $$
declare target_archived_at timestamptz;
begin
  select p.archived_at into target_archived_at from public.patients p where p.id = new.patient_id for key share;
  if not found then raise exception 'cannot attach data to an unknown patient'; end if;
  if target_archived_at is not null then raise exception 'cannot attach data to an archived patient'; end if;
  return new;
end; $$;
create function private.install_patient_identity_write_guards() returns integer language plpgsql security definer set search_path = '' as $$
declare dependency record; installed integer := 0;
begin
  for dependency in select c.table_schema, c.table_name from information_schema.columns c where c.table_schema = 'public' and c.column_name = 'patient_id' order by c.table_name loop
    execute format('drop trigger if exists patient_identity_write_guard on %I.%I', dependency.table_schema, dependency.table_name);
    execute format('create trigger patient_identity_write_guard before insert or update of patient_id on %I.%I for each row execute function private.guard_patient_dependency_write()', dependency.table_schema, dependency.table_name);
    installed := installed + 1;
  end loop;
  return installed;
end; $$;
create table public.admin_audit_events (
  id bigint generated always as identity primary key, occurred_at timestamptz not null default now(),
  action text not null, actor_user_id uuid, actor_kind text not null, provider_id text references public.providers(provider_id) on delete set null,
  target_kind text, target_id text, request_id text, metadata jsonb not null default '{}'::jsonb);
create function public.reject_operational_event_mutation() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'operational event tables are append-only'; end; $$;
create function public.record_admin_audit_event(
  p_action text, p_actor_user_id uuid, p_actor_kind text, p_provider_id text default null,
  p_target_kind text default null, p_target_id text default null, p_request_id text default null, p_metadata jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin insert into admin_audit_events(action, actor_user_id, actor_kind) values (p_action, p_actor_user_id, p_actor_kind); end; $$;
insert into public.providers values ('office-1'), ('office-2');
`;

let dir = "";
let dataDir = "";
const PORT = 55_900 + (process.pid % 500);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: "pipe" }).trim();
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  return JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`) || "[]") as T[];
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PATIENT = uuid(1);
const OTHER = uuid(2);
const STAFF = uuid(9);

const audit = (action: string) =>
  psql(`select public.record_admin_audit_event('${action}', '${STAFF}', 'provider', 'office-1', 'patient', '${PATIENT}')`);
const record = (input: {
  patient?: string; family: string; recordId: string; kind: string; actorKind?: string; actorUser?: string | null;
  actorName?: string | null; auditId?: string | null; fields: Array<{ field: string; old?: unknown; new?: unknown }>;
}) =>
  psql(`select public.record_patient_edit_history('${input.patient ?? PATIENT}', '${input.family}', '${input.recordId}', '${input.kind}',
    '${input.actorKind ?? "provider"}', ${input.actorUser === null ? "null" : `'${input.actorUser ?? STAFF}'`},
    ${input.actorName === null ? "null" : `'${input.actorName ?? "Dr. Reyes"}'`}, ${input.auditId ? input.auditId : "null"},
    '${JSON.stringify(input.fields).replace(/'/g, "''")}'::jsonb)`);
type Change = {
  change_id: string; family: string; record_id: string; change_kind: string; actor_kind: string; actor_user_id: string | null;
  actor_name: string | null; audit_event_id: number | null; created_at: string; fields: Array<{ field: string; old: unknown; new: unknown }>; total: number;
};
const read = (opts: { provider?: string; patient?: string; family?: string | null; limit?: number; offset?: number } = {}) =>
  rows<Change>(`select * from public.office_patient_edit_history('${opts.provider ?? "office-1"}', '${opts.patient ?? PATIENT}',
    ${opts.family ? `'${opts.family}'` : "null"}, ${opts.limit ?? 50}, ${opts.offset ?? 0})`);

describe.skipIf(!available)("patient edit history SQL (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "peh-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"], { stdio: "ignore" });
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
    psql(`insert into public.patients (id, provider_id) values ('${PATIENT}', 'office-1'), ('${OTHER}', 'office-2')`);
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps every prior value when a weight is corrected twice, paired with its audit event", () => {
    const weightId = uuid(100);
    const created = audit("patient_weight_recorded");
    expect(Number(created)).toBeGreaterThan(0);
    record({ family: "weight", recordId: weightId, kind: "create", auditId: created, fields: [{ field: "weight", new: 182.4 }, { field: "note", new: null }] });
    const first = audit("patient_weight_updated");
    record({ family: "weight", recordId: weightId, kind: "update", auditId: first, fields: [{ field: "weight", old: 182.4, new: 181.6 }] });
    const second = audit("patient_weight_updated");
    record({ family: "weight", recordId: weightId, kind: "update", actorKind: "team_member", actorUser: uuid(10), actorName: "Front desk", auditId: second, fields: [{ field: "weight", old: 181.6, new: 180.9 }, { field: "note", old: null, new: "Re-weighed on the office scale" }] });

    const changes = read({ family: "weight" });
    expect(changes.map((c) => c.change_kind)).toEqual(["update", "update", "create"]);
    expect(changes.every((c) => c.total === 3)).toBe(true);
    // Both prior values are recoverable, newest first, each with its actor and audit id.
    expect(changes[0].fields).toEqual([
      { field: "note", old: null, new: "Re-weighed on the office scale" },
      { field: "weight", old: 181.6, new: 180.9 },
    ]);
    expect(changes[0]).toMatchObject({ actor_kind: "team_member", actor_name: "Front desk", audit_event_id: Number(second), record_id: weightId });
    expect(changes[1].fields).toEqual([{ field: "weight", old: 182.4, new: 181.6 }]);
    expect(changes[1]).toMatchObject({ actor_kind: "provider", actor_name: "Dr. Reyes", audit_event_id: Number(first) });
    expect(changes[2].fields).toEqual([{ field: "note", old: null, new: null }, { field: "weight", old: null, new: 182.4 }]);
    // Plain SQL over the row store tells the same story: three weight values, oldest first.
    expect(rows<{ v: number | null }>(`select old_value as v from public.patient_edit_history where record_id = '${weightId}' and field = 'weight' order by created_at, old_value nulls first`).map((r) => r.v)).toEqual([null, 182.4, 181.6]);
  });

  it("records deletes with the removed value and attributes patient edits without a name", () => {
    record({ family: "note", recordId: uuid(200), kind: "delete", auditId: audit("patient_note_deleted"), fields: [{ field: "body", old: "Follow up on labs", new: null }] });
    record({ family: "medication", recordId: uuid(300), kind: "update", actorKind: "patient", actorUser: null, actorName: null, auditId: null, fields: [{ field: "dose", old: "0.25 mg", new: "0.5 mg" }] });
    const [medication, note] = read({ limit: 2 });
    expect(medication).toMatchObject({ family: "medication", actor_kind: "patient", actor_user_id: null, actor_name: null, audit_event_id: null });
    expect(note).toMatchObject({ family: "note", change_kind: "delete" });
    expect(note.fields).toEqual([{ field: "body", old: "Follow up on labs", new: null }]);
  });

  it("filters by family, pages with a stable total, and scopes reads to the owning office", () => {
    const all = read();
    expect(all.length).toBe(5);
    expect(all.every((c) => c.total === 5)).toBe(true);
    expect(read({ family: "note" }).map((c) => c.family)).toEqual(["note"]);
    expect(read({ family: "status" })).toEqual([]);
    const page1 = read({ limit: 2, offset: 0 });
    const page2 = read({ limit: 2, offset: 2 });
    const page3 = read({ limit: 2, offset: 4 });
    expect([...page1, ...page2, ...page3].map((c) => c.change_id)).toEqual(all.map((c) => c.change_id));
    expect(page3[0].total).toBe(5);
    // Another office cannot read this patient's history, and the other patient has none.
    expect(read({ provider: "office-2" })).toEqual([]);
    expect(read({ patient: OTHER, provider: "office-2" })).toEqual([]);
  });

  it("rejects empty field lists, unknown families, and edits to history rows", () => {
    expect(() => record({ family: "weight", recordId: "x", kind: "update", fields: [] })).toThrow(/at least one field/);
    expect(() => record({ family: "weight", recordId: "x", kind: "update", fields: [{ old: 1, new: 2 } as never] })).toThrow(/named field/);
    expect(() => record({ family: "diary", recordId: "x", kind: "update", fields: [{ field: "a", new: 1 }] })).toThrow(/family_check/);
    expect(() => psql(`update public.patient_edit_history set new_value = '0'::jsonb`)).toThrow(/append-only/);
  });

  it("joins the identity write barrier and disappears with the patient", () => {
    expect(rows<{ n: number }>(`select count(*)::int as n from pg_trigger where tgname = 'patient_identity_write_guard' and tgrelid = 'public.patient_edit_history'::regclass`)[0].n).toBe(1);
    expect(() => record({ patient: uuid(77), family: "weight", recordId: "x", kind: "update", fields: [{ field: "weight", old: 1, new: 2 }] })).toThrow(/unknown patient/);
    psql(`update public.patients set archived_at = now() where id = '${OTHER}'`);
    expect(() => record({ patient: OTHER, family: "weight", recordId: "x", kind: "update", fields: [{ field: "weight", old: 1, new: 2 }] })).toThrow(/archived patient/);
    psql(`delete from public.patients where id = '${PATIENT}'`);
    expect(psql(`select count(*) from public.patient_edit_history`)).toBe("0");
  });

  it("keeps the table and both RPCs service-role only", () => {
    expect(rows(`select grantee from information_schema.role_table_grants where table_name = 'patient_edit_history' and grantee in ('anon','authenticated')`)).toEqual([]);
    expect(psql(`select relrowsecurity from pg_class where relname = 'patient_edit_history'`)).toBe("t");
    for (const fn of [
      "public.record_patient_edit_history(uuid,text,text,text,text,uuid,text,bigint,jsonb)",
      "public.office_patient_edit_history(text,uuid,text,integer,integer)",
      "public.record_admin_audit_event(text,uuid,text,text,text,text,text,jsonb)",
    ]) {
      expect(psql(`select has_function_privilege('anon', '${fn}', 'execute')`), fn).toBe("f");
      expect(psql(`select has_function_privilege('service_role', '${fn}', 'execute')`), fn).toBe("t");
    }
    expect(() => psql(`begin; set local test.role = 'anon'; select public.record_patient_edit_history('${OTHER}', 'weight', 'x', 'update', 'provider', null, null, null, '[{"field":"a","new":1}]'::jsonb); commit;`)).toThrow(/service role required/);
  });
});
