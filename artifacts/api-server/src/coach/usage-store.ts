/**
 * Where the coach's concurrency + daily counters live.
 *
 * Two implementations of one contract:
 *
 * - `database` — the `coach_usage_reserve` / `coach_usage_release` RPCs
 *   (supabase/migrations/20261027000000_coach_usage_limits.sql). Counters
 *   are shared by every API server copy and survive restarts; the RPC
 *   serializes reservations of a kind under an advisory lock and prunes
 *   expired leases so a crashed server frees its own slots.
 * - `memory` — the same rules kept in this process. It is the reference
 *   implementation the unit tests exercise, and the only mode available
 *   when Supabase is not configured (a loud startup log says so, because
 *   process-local counters cannot hold across copies).
 *
 * The choice is made once per process: COACH_LIMITS_STORE=memory|database
 * wins when set; otherwise `database` whenever the service-role Supabase
 * credentials are configured. Tests pin `memory` in vitest's setup file so
 * route suites never reach a live project.
 */
import { supabaseAdmin } from "../lib/supabase-admin";

export type UsageKind = "chat" | "photo" | "image";

/** Caps for one reservation; `null` disables a tier, `0` denies it outright. */
export interface UsageCaps {
  scopeConcurrent: number | null;
  scopeDaily: number | null;
  officeConcurrent: number | null;
  globalConcurrent: number | null;
  globalDaily: number | null;
  /** How long a held slot counts before the store treats it as abandoned. */
  leaseSeconds: number;
}

export interface ReserveInput {
  kind: UsageKind;
  /** `account:<patient id>` for signed-in patients, `ip:<address>` otherwise. */
  scope: string;
  /** The patient's practice (provider id); null for anonymous demo traffic. */
  office: string | null;
  /** UTC calendar day the daily unit lands on (YYYY-MM-DD). */
  day: string;
  caps: UsageCaps;
}

export type UsageTier = "scope" | "office" | "global";

export type ReserveResult =
  | { outcome: "reserved"; lease: string }
  | { outcome: "daily"; tier: Exclude<UsageTier, "office">; used: number }
  | { outcome: "busy"; tier: UsageTier; active: number };

export interface UsageStore {
  readonly mode: "memory" | "database";
  reserve(input: ReserveInput): Promise<ReserveResult>;
  /** Frees a held slot; true when the lease was still counted. */
  release(lease: string): Promise<boolean>;
}

// ── Memory store ────────────────────────────────────────────────────────────

interface MemoryLease {
  id: string;
  kind: UsageKind;
  scope: string;
  office: string | null;
  leaseUntil: number;
}

/**
 * Process-local reference implementation. Reservations of a kind run one at
 * a time behind a promise chain, exactly as the RPC's advisory lock
 * serializes them: the read-then-write below yields between the two
 * (mirroring the RPC's round trip), so without the gate two concurrent
 * callers would both read the last free slot and both take it.
 */
export function createMemoryUsageStore(clock: () => number = Date.now): UsageStore {
  const leases = new Map<string, MemoryLease>();
  const daily = new Map<string, number>();
  const gates = new Map<UsageKind, Promise<void>>();
  let sequence = 0;

  const dailyKey = (kind: UsageKind, scope: string, day: string) => `${kind}\u0000${scope}\u0000${day}`;

  async function serialized<T>(kind: UsageKind, work: () => Promise<T>): Promise<T> {
    const previous = gates.get(kind) ?? Promise.resolve();
    let done!: () => void;
    const turn = new Promise<void>((resolve) => {
      done = resolve;
    });
    gates.set(kind, previous.then(() => turn));
    await previous;
    try {
      return await work();
    } finally {
      done();
    }
  }

  function prune(kind: UsageKind, day: string, now: number): void {
    for (const [id, lease] of leases) {
      if (lease.kind === kind && lease.leaseUntil <= now) leases.delete(id);
    }
    for (const key of daily.keys()) {
      const [keyKind, , keyDay] = key.split("\u0000");
      if (keyKind === kind && keyDay < previousDay(day)) daily.delete(key);
    }
  }

  function active(kind: UsageKind, match: (lease: MemoryLease) => boolean): number {
    let count = 0;
    for (const lease of leases.values()) {
      if (lease.kind === kind && match(lease)) count += 1;
    }
    return count;
  }

  return {
    mode: "memory",
    reserve(input) {
      return serialized(input.kind, async () => {
        const { kind, scope, office, day, caps } = input;
        const now = clock();
        prune(kind, day, now);
        const scopeUsed = daily.get(dailyKey(kind, scope, day)) ?? 0;
        const globalUsed = daily.get(dailyKey(kind, "*", day)) ?? 0;
        const scopeActive = active(kind, (lease) => lease.scope === scope);
        const officeActive = office === null ? 0 : active(kind, (lease) => lease.office === office);
        const globalActive = active(kind, () => true);
        // The store's "round trip": every count above was read before this
        // yield, and the write below lands after it.
        await Promise.resolve();

        if (caps.scopeDaily !== null && scopeUsed >= caps.scopeDaily) {
          return { outcome: "daily", tier: "scope", used: scopeUsed };
        }
        if (caps.globalDaily !== null && globalUsed >= caps.globalDaily) {
          return { outcome: "daily", tier: "global", used: globalUsed };
        }
        if (caps.scopeConcurrent !== null && scopeActive >= caps.scopeConcurrent) {
          return { outcome: "busy", tier: "scope", active: scopeActive };
        }
        if (office !== null && caps.officeConcurrent !== null && officeActive >= caps.officeConcurrent) {
          return { outcome: "busy", tier: "office", active: officeActive };
        }
        if (caps.globalConcurrent !== null && globalActive >= caps.globalConcurrent) {
          return { outcome: "busy", tier: "global", active: globalActive };
        }

        sequence += 1;
        const id = `lease-${sequence}`;
        leases.set(id, { id, kind, scope, office, leaseUntil: now + clampLeaseSeconds(caps.leaseSeconds) * 1000 });
        daily.set(dailyKey(kind, scope, day), scopeUsed + 1);
        daily.set(dailyKey(kind, "*", day), globalUsed + 1);
        return { outcome: "reserved", lease: id };
      });
    },
    async release(lease) {
      return leases.delete(lease);
    },
  };
}

/** Mirrors the RPC's clamp: at least 10 s, at most an hour, default 10 min. */
export function clampLeaseSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 600;
  return Math.min(Math.max(Math.trunc(seconds), 10), 3600);
}

function previousDay(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

// ── Database store ──────────────────────────────────────────────────────────

/** Row shape the reserve RPC returns (jsonb). */
interface ReserveRpcRow {
  outcome?: unknown;
  tier?: unknown;
  lease?: unknown;
  used?: unknown;
  active?: unknown;
}

function parseReserveRow(json: unknown): ReserveResult {
  const row = (json ?? {}) as ReserveRpcRow;
  if (row.outcome === "reserved" && typeof row.lease === "string" && row.lease.length > 0) {
    return { outcome: "reserved", lease: row.lease };
  }
  if (row.outcome === "daily" && (row.tier === "scope" || row.tier === "global")) {
    return { outcome: "daily", tier: row.tier, used: Number(row.used ?? 0) };
  }
  if (row.outcome === "busy" && (row.tier === "scope" || row.tier === "office" || row.tier === "global")) {
    return { outcome: "busy", tier: row.tier, active: Number(row.active ?? 0) };
  }
  throw new Error(`coach_usage_reserve returned an unexpected row: ${JSON.stringify(json).slice(0, 200)}`);
}

export function createDatabaseUsageStore(
  rpc: typeof supabaseAdmin = supabaseAdmin,
): UsageStore {
  return {
    mode: "database",
    async reserve(input) {
      const result = await rpc("POST", "/rest/v1/rpc/coach_usage_reserve", {
        p_kind: input.kind,
        p_scope: input.scope,
        p_office: input.office,
        p_day: input.day,
        p_scope_concurrent: input.caps.scopeConcurrent,
        p_scope_daily: input.caps.scopeDaily,
        p_office_concurrent: input.caps.officeConcurrent,
        p_global_concurrent: input.caps.globalConcurrent,
        p_global_daily: input.caps.globalDaily,
        p_lease_seconds: clampLeaseSeconds(input.caps.leaseSeconds),
      });
      if (result.status !== 200) {
        throw new Error(`coach_usage_reserve failed (${result.status})`);
      }
      return parseReserveRow(result.json);
    },
    async release(lease) {
      const result = await rpc("POST", "/rest/v1/rpc/coach_usage_release", { p_lease: lease });
      if (result.status !== 200) {
        throw new Error(`coach_usage_release failed (${result.status})`);
      }
      return result.json === true;
    },
  };
}

// ── Process-wide selection ──────────────────────────────────────────────────

export type UsageStoreMode = UsageStore["mode"];

/**
 * Which store this process should use. Explicit knob first; otherwise the
 * database whenever the service-role credentials exist. Exported so the
 * startup log and tests can state the decision without building a store.
 */
export function resolveUsageStoreMode(env: NodeJS.ProcessEnv = process.env): UsageStoreMode {
  const knob = (env.COACH_LIMITS_STORE ?? "").trim().toLowerCase();
  if (knob === "memory" || knob === "database") return knob;
  if (knob.length > 0) {
    throw new Error(`COACH_LIMITS_STORE must be "memory" or "database" (got "${env.COACH_LIMITS_STORE}")`);
  }
  const configured = (env.SUPABASE_URL ?? "").trim().length > 0 && (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim().length > 0;
  return configured ? "database" : "memory";
}

let shared: UsageStore | null = null;

/** The process's one usage store (built on first use). */
export function usageStore(): UsageStore {
  if (shared === null) {
    shared = resolveUsageStoreMode() === "database" ? createDatabaseUsageStore() : createMemoryUsageStore();
  }
  return shared;
}
