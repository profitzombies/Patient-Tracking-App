/**
 * hq_reorder_drive_items, run on a real PostgreSQL.
 *
 * Boots a throwaway cluster, applies the folder + archive + ordering
 * migrations verbatim on top of a minimal hq_private_files, and checks that
 * one call writes contiguous positions for exactly the active children of
 * the given parent (root included), ignores strangers, leaves updated_at
 * alone (file replacement's CAS guard), and is service-role only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  "20261015000000_hq_file_folders.sql",
  "20261016000000_hq_file_archive.sql",
  "20261018000000_hq_drive_ordering.sql",
].map(name => path.resolve(here, "../../../../supabase/migrations", name));

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("hq-drive-order.sql.test: PostgreSQL binaries not on PATH — suite skipped");
}

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.hq_private_files (
  id uuid primary key,
  name text not null,
  content_type text not null default 'application/pdf',
  size_bytes bigint not null default 1,
  object_path text not null unique,
  created_at timestamptz not null default now(),
  created_by uuid not null default '00000000-0000-4000-8000-000000000001',
  updated_at timestamptz not null default '2026-01-01T00:00:00Z'
);
`;

let dir = "";
let dataDir = "";
const PORT = 54_800 + (process.pid % 1000);

function psql(sql: string, role = "postgres"): string {
  return execFileSync(
    "psql",
    ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", `set role ${role}; ${sql}`],
    { encoding: "utf8", env: { ...process.env, PGPASSWORD: "" } },
  );
}
function rows<T = Record<string, unknown>>(sql: string, role = "postgres"): T[] {
  return JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`, role).trim() || "[]") as T[];
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reorder = (kind: string, parent: string | null, ids: string[], role = "service_role") =>
  Number(psql(`select public.hq_reorder_drive_items('${kind}', ${parent ? `'${parent}'` : "null"}, array[${ids.map(id => `'${id}'`).join(",")}]::uuid[])`, role).trim());

function seed() {
  psql(`truncate public.hq_private_files, public.hq_file_folders cascade;
    insert into public.hq_file_folders (id, name, parent_id, created_by) values
      ('${uuid(1)}', 'Root A', null, '${uuid(99)}'),
      ('${uuid(2)}', 'Root B', null, '${uuid(99)}'),
      ('${uuid(3)}', 'Child of A', '${uuid(1)}', '${uuid(99)}');
    insert into public.hq_private_files (id, name, object_path) values
      ('${uuid(11)}', 'root-1.pdf', '/objects/hq-files/${uuid(11)}/file-${uuid(11)}'),
      ('${uuid(12)}', 'root-2.pdf', '/objects/hq-files/${uuid(12)}/file-${uuid(12)}');
    insert into public.hq_private_files (id, name, object_path, folder_id) values
      ('${uuid(13)}', 'a-1.pdf', '/objects/hq-files/${uuid(13)}/file-${uuid(13)}', '${uuid(1)}'),
      ('${uuid(14)}', 'a-2.pdf', '/objects/hq-files/${uuid(14)}/file-${uuid(14)}', '${uuid(1)}');
    insert into public.hq_private_files (id, name, object_path, folder_id, archived_at) values
      ('${uuid(15)}', 'a-archived.pdf', '/objects/hq-files/${uuid(15)}/file-${uuid(15)}', '${uuid(1)}', now());`);
}

describe.skipIf(!POSTGRES_AVAILABLE)("hq_reorder_drive_items (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hqo-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, ...MIGRATIONS]) {
      execFileSync(
        "psql",
        ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file],
        { stdio: "pipe", encoding: "utf8" },
      );
    }
  });
  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("orders the root folders and root files in one statement each", () => {
    seed();
    expect(reorder("folders", null, [uuid(2), uuid(1)])).toBe(2);
    expect(rows("select id, position from public.hq_file_folders where parent_id is null order by position"))
      .toEqual([{ id: uuid(2), position: 0 }, { id: uuid(1), position: 1 }]);
    expect(reorder("files", null, [uuid(12), uuid(11)])).toBe(2);
    expect(rows("select id, position, updated_at from public.hq_private_files where folder_id is null order by position"))
      .toEqual([
        { id: uuid(12), position: 0, updated_at: "2026-01-01T00:00:00+00:00" },
        { id: uuid(11), position: 1, updated_at: "2026-01-01T00:00:00+00:00" },
      ]);
  });

  it("ignores ids that are not active children of the parent (caller sees a short count)", () => {
    seed();
    // A root file and an archived file slipped into folder A's list.
    expect(reorder("files", uuid(1), [uuid(14), uuid(11), uuid(15), uuid(13)])).toBe(2);
    expect(rows("select id, position from public.hq_private_files where folder_id = '" + uuid(1) + "' order by id"))
      .toEqual([{ id: uuid(13), position: 3 }, { id: uuid(14), position: 0 }, { id: uuid(15), position: null }]);
    expect(rows("select position from public.hq_private_files where id = '" + uuid(11) + "'")).toEqual([{ position: null }]);
    // A child folder cannot be ordered as a root folder.
    expect(reorder("folders", null, [uuid(3), uuid(1)])).toBe(1);
    expect(rows("select id, position from public.hq_file_folders order by id"))
      .toEqual([{ id: uuid(1), position: 1 }, { id: uuid(2), position: null }, { id: uuid(3), position: null }]);
  });

  it("rejects unknown kinds and non-service roles", () => {
    seed();
    expect(() => reorder("things", null, [uuid(1)])).toThrow(/unknown kind/);
    expect(() => reorder("folders", null, [uuid(1)], "authenticated")).toThrow(/permission denied/);
    expect(() => reorder("folders", null, [uuid(1)], "anon")).toThrow(/permission denied/);
  });
});
