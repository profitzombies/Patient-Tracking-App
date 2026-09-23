import crypto from "node:crypto";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/email/webhooks/resend: raw-body signature check, refusals counted
 * on the health row, unknown event types acknowledged, verified events handed
 * to ingestion, replays reported as duplicates, storage failures as 5xx so
 * the vendor retries.
 */
const ingest = vi.fn();
const noteRejection = vi.fn(async () => undefined);
vi.mock("../email/vendor-webhook", async (original) => ({
  ...(await original<typeof import("../email/vendor-webhook")>()),
  ingestVendorEvent: (...args: unknown[]) => ingest(...args),
  noteRejection: () => noteRejection(),
}));

import router from "./email-webhooks";
import { WEBHOOK_SECRET_ENV } from "../email/vendor-webhook";

const SECRET_BYTES = crypto.randomBytes(24);
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
let server: http.Server;
let base = "";

function headers(body: string, options: { id?: string; secretBytes?: Buffer; timestamp?: number } = {}) {
  const id = options.id ?? `evt_${crypto.randomUUID()}`;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", options.secretBytes ?? SECRET_BYTES).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${signature}` };
}
const post = (body: string, extra: Record<string, string>) => fetch(`${base}/resend`, { method: "POST", headers: extra, body });
const payload = (type: string, emailId = "re_abc") => JSON.stringify({ type, created_at: "2026-09-23T14:59:30.000Z", data: { email_id: emailId, to: ["riley@example.com"] } });

beforeAll(async () => {
  const app = express();
  app.use(router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  process.env[WEBHOOK_SECRET_ENV] = SECRET;
  ingest.mockReset();
  ingest.mockResolvedValue({ outcome: "stored", matched: true });
  noteRejection.mockClear();
});
afterEach(() => { delete process.env[WEBHOOK_SECRET_ENV]; });

describe("email vendor webhook route", () => {
  it("accepts a signed delivery event and reports whether it matched a ledger row", async () => {
    const body = payload("email.delivered");
    const res = await post(body, headers(body, { id: "evt_1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: false, matched: true });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][0]).toEqual({ vendorEventId: "evt_1", vendorMessageId: "re_abc", eventType: "delivered", occurredAt: "2026-09-23T14:59:30.000Z", detail: {} });
    expect(noteRejection).not.toHaveBeenCalled();
  });

  it("reports a replay as a duplicate without failing", async () => {
    ingest.mockResolvedValueOnce({ outcome: "duplicate", matched: false });
    const body = payload("email.opened");
    const res = await post(body, headers(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true, matched: false });
  });

  it("refuses bad, stale, or missing signatures with 400 and counts each refusal", async () => {
    const body = payload("email.delivered");
    const forged = await post(body, headers(body, { secretBytes: crypto.randomBytes(24) }));
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ error: "Invalid webhook signature." });
    const tampered = await post(`${body} `, headers(body));
    expect(tampered.status).toBe(400);
    const stale = await post(body, headers(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 }));
    expect(stale.status).toBe(400);
    const bare = await post(body, { "content-type": "application/json" });
    expect(bare.status).toBe(400);
    expect(noteRejection).toHaveBeenCalledTimes(4);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("answers 503 (and counts nothing) while the signing secret is not configured", async () => {
    delete process.env[WEBHOOK_SECRET_ENV];
    const body = payload("email.delivered");
    const res = await post(body, headers(body));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Email tracking is not enabled." });
    expect(noteRejection).not.toHaveBeenCalled();
  });

  it("acknowledges unknown event types and rejects unusable payloads", async () => {
    const scheduled = payload("email.scheduled");
    const ignored = await post(scheduled, headers(scheduled));
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({ received: true, ignored: true });
    const missing = JSON.stringify({ type: "email.delivered", data: {} });
    const invalid = await post(missing, headers(missing));
    expect(invalid.status).toBe(400);
    const malformed = await post("{not json", headers("{not json"));
    expect(malformed.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("returns 500 when storage fails so the vendor retries the delivery", async () => {
    ingest.mockRejectedValueOnce(new Error("inbox insert failed (503)"));
    const body = payload("email.clicked");
    const res = await post(body, headers(body));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Webhook processing failed." });
  });
});
