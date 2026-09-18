#!/usr/bin/env node
/**
 * External scheduler tick for the production API server.
 *
 * Production runs as an autoscale deployment with the in-process timers off
 * (JOBS_DISABLED=1, NOTIFICATIONS_DISABLED=1). A Replit Scheduled Deployment
 * (or any cron with outbound HTTP) runs this script every minute; it POSTs
 * the two internal tick routes with the shared bearer so reminders, staff
 * digests, exports, purges, and retention keep running while nobody is using
 * the app. See replit.md → "Production background work".
 *
 *   INTERNAL_TICK_API_URL        e.g. https://app.trythinnr.com/api  (no trailing slash needed)
 *   NOTIFICATIONS_INTERNAL_TOKEN the bearer both routes require
 *   INTERNAL_TICK_TIMEOUT_MS     optional per-request cap (default 240000)
 *
 * Plain Node (>= 18), no dependencies, no build step:
 *
 *   node artifacts/api-server/scripts/external-tick.mjs
 *
 * Exit code 0 when both ticks answered 2xx (a 429 "already running" also
 * counts as fine: the previous tick is still draining). Exit code 1 when
 * configuration is missing or any tick failed, so the scheduler run shows red.
 */
import { pathToFileURL } from "node:url";

export const TICK_PATHS = ["/internal/jobs/tick", "/internal/notifications/tick"];
const DEFAULT_TIMEOUT_MS = 240_000;

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

async function postTick({ url, token, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "thinnr-external-tick/1" },
      body: "{}",
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 200);
    }
    const ms = Date.now() - startedAt;
    if (response.ok) return { ok: true, status: response.status, ms, body };
    // 429 = the previous tick is still running behind the route's single slot.
    if (response.status === 429) return { ok: true, busy: true, status: 429, ms, body };
    return { ok: false, status: response.status, ms, body };
  } catch (error) {
    const ms = Date.now() - startedAt;
    const message = error && error.name === "AbortError" ? `timed out after ${timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    return { ok: false, status: null, ms, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST both tick routes in order (jobs first: exports and purges are
 * user-visible). Never throws; every outcome is in the returned list.
 */
export async function runExternalTick({ baseUrl, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const results = [];
  for (const path of TICK_PATHS) {
    const url = `${trimSlash(baseUrl)}${path}`;
    const result = await postTick({ url, token, timeoutMs, fetchImpl });
    results.push({ path, ...result });
    if (result.ok) {
      log(`${path} ${result.busy ? "busy (429)" : `ok (${result.status})`} in ${result.ms} ms${summarize(result.body)}`);
    } else {
      log(`${path} FAILED${result.status ? ` (${result.status})` : ""} after ${result.ms} ms: ${result.error ?? summarize(result.body)}`);
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

function summarize(body) {
  if (!body || typeof body !== "object") return "";
  if (Array.isArray(body.results)) {
    const ran = body.results.filter((r) => r && r.outcome && r.outcome.kind === "ran").length;
    const drains = body.drains && typeof body.drains === "object"
      ? ` drains office=${body.drains.officeExports ?? 0} patient=${body.drains.patientExports ?? 0} purges=${body.drains.purges ?? 0}`
      : "";
    return ` — ${ran}/${body.results.length} due job(s) ran${drains}`;
  }
  if (body.outbox && typeof body.outbox === "object") {
    return ` — outbox claimed=${body.outbox.claimed ?? 0} sent=${body.outbox.sent ?? 0}`;
  }
  if (typeof body.error === "string") return ` — ${body.error}`;
  return "";
}

export async function main(env = process.env, log = (line) => console.log(line)) {
  const baseUrl = (env.INTERNAL_TICK_API_URL ?? "").trim();
  const token = (env.NOTIFICATIONS_INTERNAL_TOKEN ?? "").trim();
  if (!baseUrl || !token) {
    log("external-tick: INTERNAL_TICK_API_URL and NOTIFICATIONS_INTERNAL_TOKEN must both be set");
    return 1;
  }
  const rawTimeout = Number(env.INTERNAL_TICK_TIMEOUT_MS ?? "");
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;
  const outcome = await runExternalTick({ baseUrl, token, timeoutMs, log: (line) => log(`external-tick: ${line}`) });
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error("external-tick: unexpected failure", error);
      process.exit(1);
    },
  );
}
