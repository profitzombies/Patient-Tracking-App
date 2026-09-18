/**
 * External tick heartbeat.
 *
 * Production runs the API server as an autoscale deployment, so nothing is
 * guaranteed to be alive between requests. The in-process tickers are turned
 * off there (JOBS_DISABLED=1 / NOTIFICATIONS_DISABLED=1) and a scheduled
 * trigger POSTs the two internal tick routes every minute. Each authenticated
 * tick records itself here — one row per tick kind, overwritten each time —
 * so HQ → System health can show "last external tick" and warn when the
 * trigger has gone quiet for more than EXTERNAL_TICK_STALE_MS.
 *
 * Recording is best-effort by design: a failed write must never fail the
 * tick that did the real work. The health page then shows the stale warning,
 * which is exactly the signal an operator wants.
 */
import { logger } from "../lib/logger";
import { supabaseAdmin } from "../lib/supabase-admin";
import { jobsDisabled } from "./scheduler";

/** Same flag the notification worker honours; read here so this module stays free of the push import graph. */
function notificationTimersDisabled(): boolean {
  const raw = process.env.NOTIFICATIONS_DISABLED;
  return raw === "1" || raw === "true";
}

export type ExternalTickKind = "jobs" | "notifications";
export const EXTERNAL_TICK_KINDS: readonly ExternalTickKind[] = ["jobs", "notifications"];

/** Warn once no tick of a kind has landed for this long (5 minutes). */
export const EXTERNAL_TICK_STALE_MS = 5 * 60_000;

export type ExternalTickStatus = "ok" | "stale" | "never";

export interface ExternalTickRecord {
  kind: ExternalTickKind;
  lastAt: string;
  owner: string | null;
  lastResult: "succeeded" | "failed";
  summary: Record<string, number>;
  error: string | null;
}

export interface ExternalTickStore {
  record(input: {
    kind: ExternalTickKind;
    at: Date;
    owner: string;
    result: "succeeded" | "failed";
    summary: Record<string, number>;
    error: string | null;
  }): Promise<void>;
  list(): Promise<ExternalTickRecord[]>;
}

export interface ExternalTickHealth {
  kind: ExternalTickKind;
  status: ExternalTickStatus;
  lastAt: string | null;
  owner: string | null;
  lastResult: "succeeded" | "failed" | null;
  summary: Record<string, number> | null;
  error: string | null;
}

export interface ExternalTriggerHealth {
  staleAfterMs: number;
  /** Whether THIS process runs its own timers (development) or relies on the trigger (production). */
  inProcessTimers: { jobs: boolean; notifications: boolean };
  ticks: ExternalTickHealth[];
}

function summaryOf(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function recordFromRow(row: Record<string, unknown>): ExternalTickRecord {
  return {
    kind: row.kind as ExternalTickKind,
    lastAt: String(row.last_at),
    owner: typeof row.owner === "string" ? row.owner : null,
    lastResult: row.status === "failed" ? "failed" : "succeeded",
    summary: summaryOf(row.summary),
    error: typeof row.error === "string" ? row.error : null,
  };
}

const TICK_SELECT = "kind,last_at,owner,status,summary,error";

export const supabaseExternalTickStore: ExternalTickStore = {
  async record(input) {
    const r = await supabaseAdmin(
      "POST",
      "/rest/v1/system_external_ticks?on_conflict=kind",
      {
        kind: input.kind,
        last_at: input.at.toISOString(),
        owner: input.owner.slice(0, 160),
        status: input.result,
        summary: input.summary,
        error: input.error ? input.error.slice(0, 500) : null,
        updated_at: input.at.toISOString(),
      },
      "resolution=merge-duplicates,return=minimal",
    );
    if (r.status >= 300) throw new Error(`external tick record failed (${r.status})`);
  },
  async list() {
    const r = await supabaseAdmin("GET", `/rest/v1/system_external_ticks?select=${TICK_SELECT}&order=kind.asc`);
    if (r.status >= 300 || !Array.isArray(r.json)) throw new Error(`external tick read failed (${r.status})`);
    return (r.json as Record<string, unknown>[]).map(recordFromRow);
  },
};

/** In-memory heartbeat store for unit tests (same contract as the SQL table). */
export function createMemoryExternalTickStore(): ExternalTickStore & { rows: Map<ExternalTickKind, ExternalTickRecord>; reset(): void } {
  const rows = new Map<ExternalTickKind, ExternalTickRecord>();
  return {
    rows,
    reset() {
      rows.clear();
    },
    async record(input) {
      rows.set(input.kind, {
        kind: input.kind,
        lastAt: input.at.toISOString(),
        owner: input.owner,
        lastResult: input.result,
        summary: { ...input.summary },
        error: input.error,
      });
    },
    async list() {
      return [...rows.values()].map((r) => ({ ...r, summary: { ...r.summary } })).sort((a, b) => a.kind.localeCompare(b.kind));
    },
  };
}

/**
 * Write the heartbeat without ever throwing: the tick's real work already
 * happened, and a missing heartbeat surfaces as "stale" on the health page.
 */
export async function recordExternalTick(
  store: ExternalTickStore,
  input: Parameters<ExternalTickStore["record"]>[0],
): Promise<boolean> {
  try {
    await store.record(input);
    return true;
  } catch (error) {
    logger.error({ err: error, kind: input.kind }, "external tick heartbeat not recorded");
    return false;
  }
}

export function externalTickStatus(lastAt: string | null, now: Date, staleAfterMs = EXTERNAL_TICK_STALE_MS): ExternalTickStatus {
  if (!lastAt) return "never";
  const last = new Date(lastAt).getTime();
  // An unreadable timestamp must not read as healthy (NaN compares false).
  if (Number.isNaN(last)) return "never";
  return now.getTime() - last > staleAfterMs ? "stale" : "ok";
}

/** The health-page view of the heartbeat: one entry per kind, even when no tick has ever landed. */
export function toExternalTriggerHealth(records: ExternalTickRecord[], now: Date): ExternalTriggerHealth {
  const byKind = new Map(records.map((r) => [r.kind, r]));
  return {
    staleAfterMs: EXTERNAL_TICK_STALE_MS,
    inProcessTimers: { jobs: !jobsDisabled(), notifications: !notificationTimersDisabled() },
    ticks: EXTERNAL_TICK_KINDS.map((kind) => {
      const record = byKind.get(kind) ?? null;
      return {
        kind,
        status: externalTickStatus(record?.lastAt ?? null, now),
        lastAt: record?.lastAt ?? null,
        owner: record?.owner ?? null,
        lastResult: record?.lastResult ?? null,
        summary: record?.summary ?? null,
        error: record?.error ?? null,
      };
    }),
  };
}
