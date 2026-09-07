/**
 * Idempotency receipts for patient write routes.
 *
 * The mobile app queues writes while offline and replays them when the
 * connection returns. A replayed request whose FIRST attempt actually landed
 * (the response was lost on the way back) must not apply twice: an entry
 * batch would duplicate its recents bump, a photo grid write would re-run
 * its deletes, and any write that is not a pure natural-key upsert would
 * drift. So every queued write carries a client-generated `Idempotency-Key`
 * header, and each route stores its successful response under
 * (patient, key). A replay is answered from the receipt without touching
 * the data tables, and flagged with `Idempotency-Replayed: true`.
 *
 * The receipt is CLAIMED BEFORE the write, not recorded after it. The row
 * is inserted in state `pending` first (the primary key makes that claim
 * exclusive), the route then applies the write, and `finish` flips the row
 * to `done` with the response. A replay therefore always finds a row:
 *   - `done`     → replay the stored response, nothing is applied again;
 *   - `pending`  → the first attempt is still running (or died mid-way):
 *                  answer 503 + Retry-After so the queue backs off; once the
 *                  claim is older than PENDING_TTL_MS the replay takes the
 *                  claim over and applies the write itself (every route's
 *                  own natural-key upsert makes that re-apply safe).
 * A receipt insert that fails happens BEFORE any data write, so the request
 * simply fails closed (502) and the client retries — there is no window in
 * which a write landed but no durable, operation-keyed record of it exists.
 *
 * Contract:
 *   - No header → passthrough (nothing stored, nothing looked up). Existing
 *     callers and every other route fake in the test-suite are unaffected.
 *   - Header present → key must be 1–128 chars of [A-Za-z0-9_.:-]; anything
 *     else is a 400 (a malformed key is a client bug, not a retry).
 *   - Receipt found for another route → 409: one key names one operation.
 *   - Receipt claim/lookup failure → 502: never risk a double apply because
 *     the receipts table was unreachable.
 *   - Only 2xx responses are kept. A route that answers anything else (or
 *     throws) releases its pending claim when the response ends, so a
 *     corrected or retried request runs for real.
 *   - Keys are scoped per patient (primary key is patient_id + key); a key
 *     replayed under a different account is simply a fresh write there.
 */
import type { Request, Response } from "express";
import { supabaseAdmin } from "./supabase-admin";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_REPLAYED_HEADER = "Idempotency-Replayed";
/** A pending claim older than this is presumed dead and may be taken over. */
export const PENDING_TTL_MS = 45_000;
/** Retry-After (seconds) sent while a twin request is still in flight. */
const IN_FLIGHT_RETRY_AFTER_SEC = 2;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const enc = encodeURIComponent;
const RECEIPTS = "/rest/v1/patient_write_receipts";
const UNAVAILABLE = "Couldn't confirm this save right now. Please try again.";
const IN_FLIGHT = "This save is still being processed. Please try again in a moment.";

export interface IdempotentWrite {
  /** True when the response was already sent (replay, or a key problem). */
  handled: boolean;
  /** Sends `body` with `status` and records it when 2xx. */
  finish(res: Response, status: number, body: unknown): Promise<void>;
}

const PASSTHROUGH: IdempotentWrite = {
  handled: false,
  async finish(res, status, body) {
    res.status(status).json(body);
  },
};

const HANDLED: IdempotentWrite = { handled: true, finish: async () => {} };

export function idempotencyKeyOf(req: Request): string | null {
  const raw = req.headers[IDEMPOTENCY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

type AdminResult = Awaited<ReturnType<typeof supabaseAdmin>>;

async function admin(
  req: Request,
  what: string,
  ...args: Parameters<typeof supabaseAdmin>
): Promise<AdminResult> {
  try {
    return await supabaseAdmin(...args);
  } catch (error) {
    req.log?.error({ err: error }, `idempotency receipt ${what} failed`);
    return { status: 599, json: null, contentRange: null } as AdminResult;
  }
}

interface ReceiptRow {
  route?: unknown;
  state?: unknown;
  status?: unknown;
  response?: unknown;
  claimed_at?: unknown;
}

/**
 * Opens an idempotent write for `route` on behalf of `patientId`. Call it
 * right after the patient resolves and before any validation; when
 * `handled` is true the response is already on the wire and the route must
 * return immediately. Otherwise run the write and send through `finish`.
 */
export async function openIdempotentWrite(
  req: Request,
  res: Response,
  patientId: string,
  route: string,
): Promise<IdempotentWrite> {
  const key = idempotencyKeyOf(req);
  if (key === null) return PASSTHROUGH;
  if (!KEY_RE.test(key)) {
    res.status(400).json({ error: "Idempotency key is invalid." });
    return HANDLED;
  }
  const where = `patient_id=eq.${enc(patientId)}&idempotency_key=eq.${enc(key)}`;

  // 1. Claim: an exclusive pending row under (patient, key). A duplicate is
  //    silently ignored, so an empty representation means someone else
  //    holds (or held) the key.
  const claim = await admin(
    req,
    "claim",
    "POST",
    `${RECEIPTS}?on_conflict=patient_id,idempotency_key`,
    [
      {
        patient_id: patientId,
        idempotency_key: key,
        route,
        state: "pending",
        claimed_at: new Date().toISOString(),
        status: null,
        response: null,
      },
    ],
    "resolution=ignore-duplicates,return=representation",
  );
  if (claim.status >= 300 || !Array.isArray(claim.json)) {
    res.status(502).json({ error: UNAVAILABLE });
    return HANDLED;
  }
  let owned = claim.json.length > 0;

  if (!owned) {
    // 2. Someone else claimed it: replay, wait, or take over a dead claim.
    const lookup = await admin(
      req,
      "lookup",
      "GET",
      `${RECEIPTS}?${where}&select=route,state,status,response,claimed_at&limit=1`,
    );
    if (lookup.status >= 300 || !Array.isArray(lookup.json)) {
      res.status(502).json({ error: UNAVAILABLE });
      return HANDLED;
    }
    const receipt = lookup.json[0] as ReceiptRow | undefined;
    if (!receipt) {
      // The twin released its claim between our insert and this read (its
      // write failed). Let the client retry rather than racing it here.
      res.setHeader("Retry-After", String(IN_FLIGHT_RETRY_AFTER_SEC));
      res.status(503).json({ error: IN_FLIGHT });
      return HANDLED;
    }
    if (receipt.route !== route) {
      res.status(409).json({ error: "This save key was already used for a different action." });
      return HANDLED;
    }
    if (receipt.state === "done") {
      const status = typeof receipt.status === "number" ? receipt.status : 200;
      res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, "true");
      res.status(status).json(receipt.response ?? { ok: true });
      return HANDLED;
    }
    const claimedAt = typeof receipt.claimed_at === "string" ? Date.parse(receipt.claimed_at) : NaN;
    const cutoff = Date.now() - PENDING_TTL_MS;
    if (!(Number.isFinite(claimedAt) && claimedAt < cutoff)) {
      res.setHeader("Retry-After", String(IN_FLIGHT_RETRY_AFTER_SEC));
      res.status(503).json({ error: IN_FLIGHT });
      return HANDLED;
    }
    // Dead claim: take it over atomically (the filter loses to a concurrent
    // taker, which then returns no rows).
    const takeover = await admin(
      req,
      "takeover",
      "PATCH",
      `${RECEIPTS}?${where}&state=eq.pending&claimed_at=lt.${enc(new Date(cutoff).toISOString())}`,
      { claimed_at: new Date().toISOString() },
      "return=representation",
    );
    if (takeover.status >= 300 || !Array.isArray(takeover.json)) {
      res.status(502).json({ error: UNAVAILABLE });
      return HANDLED;
    }
    if (takeover.json.length === 0) {
      res.setHeader("Retry-After", String(IN_FLIGHT_RETRY_AFTER_SEC));
      res.status(503).json({ error: IN_FLIGHT });
      return HANDLED;
    }
    owned = true;
    req.log?.error({ route }, "idempotency claim taken over from a stale pending receipt");
  }

  // 3. We own the claim. Anything but a 2xx through `finish` — including a
  //    route that throws and answers from its own catch — releases it when
  //    the response ends, so the next attempt runs for real.
  let settled = false;
  res.once("finish", () => {
    if (settled) return;
    settled = true;
    if (res.statusCode >= 200 && res.statusCode < 300) return;
    void admin(req, "release", "DELETE", `${RECEIPTS}?${where}&state=eq.pending`, undefined, "return=minimal");
  });

  return {
    handled: false,
    async finish(response, status, body) {
      if (status >= 200 && status < 300) {
        settled = true;
        // The write landed; make the receipt durable before answering. A
        // failed flip is retried a few times and then logged: the client
        // still learns the write succeeded (so it will not replay), and the
        // pending row is only ever taken over after PENDING_TTL_MS.
        let done = false;
        for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
          const flipped = await admin(
            req,
            "record",
            "PATCH",
            `${RECEIPTS}?${where}`,
            { state: "done", status, response: body ?? null },
            "return=minimal",
          );
          done = flipped.status < 300;
        }
        if (!done) req.log?.error({ route }, "idempotency receipt could not be marked done");
      }
      response.status(status).json(body);
    },
  };
}
