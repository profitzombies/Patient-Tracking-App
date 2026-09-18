/**
 * The coach usage reservation RPCs, run for real.
 *
 * coach_usage_reserve is the piece the memory twin cannot prove: two API
 * server copies must never both take the last slot or the last daily unit.
 * This suite boots a throwaway PostgreSQL cluster (unix socket only),
 * applies the canonical migration verbatim, and asserts the tier rules,
 * lease expiry, release idempotency, grants, and — with a holder lingering
 * inside an open transaction — that a concurrent caller blocks on the
 * advisory lock and then sees the committed reservation. Skips loudly
 * without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261027000000_coach_usage_limits.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("usage-limits.sql.test: PostgreSQL binaries not on PATH — reservation RPC suite skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
`;

let dir = "";
let dataDir = "";
const PORT = 54_600 + (process.pid % 1000);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];

function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8" });
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);
  return JSON.parse(out.trim() || "[]") as T[];
}

interface Caps {
  scopeConcurrent?: number | null;
  scopeDaily?: number | null;
  officeConcurrent?: number | null;
  globalConcurrent?: number | null;
  globalDaily?: number | null;
  lease?: number | null;
}
const sqlNum = (v: number | null | undefined, fallback: number | null) => {
  const value = v === undefined ? fallback : v;
  return value === null ? "null" : String(value);
};
const reserveSql = (scope: string, office: string | null, caps: Caps = {}, day = "'2026-09-18'", kind = "chat") =>
  `select public.coach_usage_reserve('${kind}', '${scope}', ${office === null ? "null" : `'${office}'`}, ${day}::date, ` +
  `${sqlNum(caps.scopeConcurrent, 2)}, ${sqlNum(caps.scopeDaily, 3)}, ${sqlNum(caps.officeConcurrent, 3)}, ` +
  `${sqlNum(caps.globalConcurrent, 4)}, ${sqlNum(caps.globalDaily, 6)}, ${sqlNum(caps.lease, 60)})`;
type Result = { outcome: string; tier?: string; lease?: string; used?: number; active?: number; scope_used?: number; global_used?: number };
const reserve = (scope: string, office: string | null, caps?: Caps, day?: string, kind?: string) =>
  JSON.parse(psql(reserveSql(scope, office, caps, day, kind)).trim()) as Result;
const release = (lease: string) => psql(`select public.coach_usage_release('${lease}')`).trim() === "t";
const reset = () => psql("truncate public.coach_usage_leases, public.coach_usage_daily");

describe.skipIf(!POSTGRES_AVAILABLE)("coach_usage_reserve / coach_usage_release (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cu-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("applies verbatim and keeps the tables and functions service-role only", () => {
    const RESERVE = "public.coach_usage_reserve(text,text,text,date,integer,integer,integer,integer,integer,integer)";
    const RELEASE = "public.coach_usage_release(uuid)";
    for (const fn of [RESERVE, RELEASE]) {
      expect(rows<{ ok: boolean }>(`select has_function_privilege('anon', '${fn}', 'execute') as ok`)[0]!.ok).toBe(false);
      expect(rows<{ ok: boolean }>(`select has_function_privilege('authenticated', '${fn}', 'execute') as ok`)[0]!.ok).toBe(false);
      expect(rows<{ ok: boolean }>(`select has_function_privilege('service_role', '${fn}', 'execute') as ok`)[0]!.ok).toBe(true);
    }
    for (const table of ["coach_usage_leases", "coach_usage_daily"]) {
      expect(rows<{ rls: boolean }>(`select relrowsecurity as rls from pg_class where relname = '${table}'`)[0]!.rls).toBe(true);
      expect(rows<{ ok: boolean }>(`select has_table_privilege('anon', 'public.${table}', 'select') as ok`)[0]!.ok).toBe(false);
      expect(rows<{ ok: boolean }>(`select has_table_privilege('authenticated', 'public.${table}', 'select') as ok`)[0]!.ok).toBe(false);
      expect(rows<{ ok: boolean }>(`select has_table_privilege('service_role', 'public.${table}', 'insert') as ok`)[0]!.ok).toBe(true);
    }
    // The migration is re-runnable.
    execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", MIGRATION], { stdio: "pipe", encoding: "utf8" });
  });

  it("counts daily units per scope and organization-wide, denying the spent tier by name and per kind", () => {
    reset();
    for (let i = 0; i < 3; i++) {
      const r = reserve("account:p1", "office-a");
      expect(r.outcome).toBe("reserved");
      expect(r.scope_used).toBe(i + 1);
      expect(release(r.lease!)).toBe(true);
    }
    expect(reserve("account:p1", "office-a")).toMatchObject({ outcome: "daily", tier: "scope", used: 3 });
    for (let i = 0; i < 3; i++) {
      const r = reserve("account:p2", "office-a");
      expect(r.outcome).toBe("reserved");
      release(r.lease!);
    }
    expect(reserve("account:p3", "office-a")).toMatchObject({ outcome: "daily", tier: "global", used: 6 });
    // Kinds keep separate books, and a new day starts fresh.
    expect(reserve("account:p3", "office-a", {}, undefined, "photo").outcome).toBe("reserved");
    expect(reserve("account:p3", "office-a", {}, "'2026-09-19'").outcome).toBe("reserved");
    expect(rows(`select * from public.coach_usage_daily where kind = 'chat' and scope = '*' and day = '2026-09-18'`)[0]).toMatchObject({ used: 6 });
    // Yesterday's counters are pruned once the day moves on two days.
    expect(rows(`select day from public.coach_usage_daily where kind = 'chat' and day = '2026-09-18'`)).not.toHaveLength(0);
    reserve("account:p9", null, {}, "'2026-09-20'");
    expect(rows(`select day from public.coach_usage_daily where kind = 'chat' and day = '2026-09-18'`)).toHaveLength(0);
  });

  it("checks concurrency scope → office → global, skips the office tier for anonymous callers, and frees on release", () => {
    reset();
    const caps: Caps = { scopeDaily: null, globalDaily: null };
    const held: string[] = [];
    const take = (scope: string, office: string | null) => {
      const r = reserve(scope, office, caps);
      if (r.lease) held.push(r.lease);
      return r;
    };
    expect(take("account:p1", "office-a").outcome).toBe("reserved");
    expect(take("account:p1", "office-a").outcome).toBe("reserved");
    expect(take("account:p1", "office-a")).toMatchObject({ outcome: "busy", tier: "scope", active: 2 });
    expect(take("account:p2", "office-a").outcome).toBe("reserved");
    expect(take("account:p3", "office-a")).toMatchObject({ outcome: "busy", tier: "office", active: 3 });
    expect(take("account:p4", "office-b").outcome).toBe("reserved");
    expect(take("account:p5", "office-b")).toMatchObject({ outcome: "busy", tier: "global", active: 4 });
    expect(take("ip:1.2.3.4", null)).toMatchObject({ outcome: "busy", tier: "global", active: 4 });
    expect(release(held[0]!)).toBe(true);
    expect(release(held[0]!)).toBe(false);
    expect(take("ip:1.2.3.4", null).outcome).toBe("reserved");
    // Zeroed caps deny outright (how the tester stages denials); null tiers are skipped.
    expect(reserve("account:z", "office-z", { globalDaily: 0 })).toMatchObject({ outcome: "daily", tier: "global", used: 5 });
    expect(reserve("account:z", "office-z", { globalDaily: 0 }, "'2030-01-01'")).toMatchObject({ outcome: "daily", tier: "global", used: 0 });
    expect(reserve("account:z", "office-z", { globalConcurrent: 0, globalDaily: null })).toMatchObject({ outcome: "busy", tier: "global" });
    expect(() => psql(reserveSql("", null))).toThrow(/usage scope is required/);
  });

  it("puts a spent day ahead of a busy slot", () => {
    reset();
    const caps: Caps = { scopeDaily: 1, scopeConcurrent: 1 };
    expect(reserve("account:p1", null, caps).outcome).toBe("reserved");
    expect(reserve("account:p1", null, caps)).toMatchObject({ outcome: "daily", tier: "scope" });
  });

  it("expires abandoned leases so a crashed server's slots free themselves", () => {
    reset();
    const caps: Caps = { scopeDaily: null, globalDaily: null, scopeConcurrent: 1, lease: 10 };
    const r = reserve("account:p1", null, caps);
    expect(r.outcome).toBe("reserved");
    expect(reserve("account:p1", null, caps).outcome).toBe("busy");
    // The lease clamps to at least 10 s; back-date it past expiry instead of waiting.
    psql(`update public.coach_usage_leases set lease_until = now() - interval '1 second' where id = '${r.lease}'`);
    expect(reserve("account:p1", null, caps).outcome).toBe("reserved");
    expect(rows(`select id from public.coach_usage_leases where id = '${r.lease}'`)).toHaveLength(0);
    expect(release(r.lease!)).toBe(false);
  });

  it("serializes concurrent servers so two cannot both take the last slot", async () => {
    reset();
    const caps: Caps = { scopeDaily: null, globalDaily: null, globalConcurrent: 1 };
    // Server A reserves the only slot inside an open transaction and lingers
    // before committing — the window in which count-then-insert would also
    // let server B through.
    const holder = spawn("psql", [
      ...PSQL_ARGS(),
      "-c",
      `begin; ${reserveSql("account:a", "office-a", caps)}; select pg_sleep(1.5); commit;`,
    ]);
    let holderOut = "";
    holder.stdout.on("data", (chunk) => (holderOut += String(chunk)));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const startedAt = Date.now();
    const b = reserve("account:b", "office-b", caps);
    const waitedMs = Date.now() - startedAt;
    await new Promise<void>((resolve) => holder.on("close", () => resolve()));
    expect(holderOut).toContain('"outcome": "reserved"');
    expect(b).toMatchObject({ outcome: "busy", tier: "global", active: 1 });
    expect(waitedMs).toBeGreaterThan(500);
    expect(rows(`select id from public.coach_usage_leases`)).toHaveLength(1);
  }, 20_000);

  it("serializes the last daily unit the same way", async () => {
    reset();
    const caps: Caps = { globalDaily: 1, scopeConcurrent: null, globalConcurrent: null };
    const holder = spawn("psql", [
      ...PSQL_ARGS(),
      "-c",
      `begin; ${reserveSql("account:a", null, caps)}; select pg_sleep(1.2); commit;`,
    ]);
    let holderOut = "";
    holder.stdout.on("data", (chunk) => (holderOut += String(chunk)));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const b = reserve("account:b", null, caps);
    await new Promise<void>((resolve) => holder.on("close", () => resolve()));
    expect(holderOut).toContain('"outcome": "reserved"');
    expect(b).toMatchObject({ outcome: "daily", tier: "global", used: 1 });
    expect(rows<{ used: number }>(`select used from public.coach_usage_daily where scope = '*'`)[0]!.used).toBe(1);
  }, 20_000);
});
