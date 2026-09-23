import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Email vendor webhook: Svix signature verification, payload normalisation,
 * exactly-once ingestion into the identity-free inbox, matching to the
 * customer email ledger (straight away or later through the rematch job),
 * the delivery columns folded onto the ledger row, and the health readout.
 * The PostgREST stand-in below keeps rows per table and honours the handful
 * of filters the module uses.
 */
type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
const rpcCalls: Array<{ name: string; body: Row }> = [];

function matchesOne(row: Row, key: string, raw: string): boolean {
  if (raw === "is.null") return row[key] == null;
  if (raw === "not.is.null") return row[key] != null;
  if (raw.startsWith("eq.")) return String(row[key]) === decodeURIComponent(raw.slice(3));
  if (raw.startsWith("in.(")) return raw.slice(4, -1).split(",").map((v) => decodeURIComponent(v).replace(/^"|"$/g, "")).includes(String(row[key]));
  const bound = /^(gte|lt)\.(.*)$/.exec(raw);
  if (bound) {
    if (row[key] == null) return false;
    const compare = Math.sign(Date.parse(String(row[key])) - Date.parse(decodeURIComponent(bound[2])));
    return bound[1] === "gte" ? compare >= 0 : compare < 0;
  }
  return true;
}
const clause = (row: Row, text: string) => { const dot = text.indexOf("."); return matchesOne(row, text.slice(0, dot), text.slice(dot + 1)); };
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit"].includes(key)) continue;
    if (key === "or") { if (!raw.slice(1, -1).split(",").some((c) => clause(row, c))) return false; continue; }
    if (!matchesOne(row, key, raw)) return false;
  }
  return true;
}
function ordered(rows: Row[], params: URLSearchParams): Row[] {
  const order = params.get("order");
  if (!order) return rows;
  const [key, dir] = order.split(",")[0].split(".");
  return [...rows].sort((a, b) => { const cmp = String(a[key] ?? "").localeCompare(String(b[key] ?? "")); return dir === "desc" ? -cmp : cmp; });
}
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async (method: string, path: string, body?: unknown, prefer?: string) => {
    const url = new URL(`http://db${path}`);
    const table = url.pathname.split("/").at(-1)!;
    if (url.pathname.includes("/rpc/")) { rpcCalls.push({ name: table, body: body as Row }); return { status: 204, json: null }; }
    const rows = tables[table] ?? (tables[table] = []);
    if (method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      return { status: 200, json: ordered(rows.filter((row) => matches(row, url.searchParams)), url.searchParams).slice(0, limit) };
    }
    if (method === "PATCH") {
      const selected = rows.filter((row) => matches(row, url.searchParams));
      selected.forEach((row) => Object.assign(row, body as Row));
      return { status: 200, json: selected };
    }
    if (method === "DELETE") {
      tables[table] = rows.filter((row) => !matches(row, url.searchParams));
      return { status: 204, json: null };
    }
    if (method === "POST") {
      const input = body as Row;
      const duplicate = table === "email_vendor_events"
        ? rows.some((row) => row.vendor_event_id === input.vendor_event_id)
        : table === "billing_customer_email_events" ? rows.some((row) => row.vendor_event_id === input.vendor_event_id && row.stripe_mode === input.stripe_mode) : false;
      if (duplicate) {
        if (prefer?.includes("ignore-duplicates")) return { status: 201, json: [] };
        return { status: 409, json: { code: "23505", message: "duplicate key value violates unique constraint", details: "" } };
      }
      const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...input };
      rows.push(row);
      return { status: 201, json: [row] };
    }
    return { status: 204, json: null };
  }),
}));

import { supabaseAdmin } from "../lib/supabase-admin";
import {
  ingestVendorEvent, isWebhookConfigured, normalizeEvent, readEmailWebhookHealth, rematchUnmatchedEvents, verifySignature, WEBHOOK_SECRET_ENV,
} from "./vendor-webhook";

const SECRET_BYTES = crypto.randomBytes(24);
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const NOW = new Date("2026-09-23T15:00:00.000Z");
export function sign(body: string, options: { id?: string; timestamp?: number; secretBytes?: Buffer } = {}) {
  const id = options.id ?? "msg_evt_1";
  const timestamp = options.timestamp ?? Math.floor(NOW.getTime() / 1000);
  const signature = crypto.createHmac("sha256", options.secretBytes ?? SECRET_BYTES).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { id, timestamp: String(timestamp), signature: `v1,${signature}` };
}
const payload = (type: string, emailId: string, extra: Row = {}) => JSON.stringify({ type, created_at: "2026-09-23T14:59:30.000Z", data: { email_id: emailId, to: ["riley@example.com"], subject: "Your order", ...extra } });
const ledgerRow = (overrides: Row = {}): Row => ({
  id: crypto.randomUUID(), template_id: "order-confirmed", status: "sent", vendor_message_id: "re_abc", sent_at: "2026-09-23T14:59:00.000Z",
  stripe_mode: "live", stripe_platform_account_id: "acct_live", created_at: "2026-09-23T14:58:00.000Z", ...overrides,
});

beforeEach(() => {
  tables = { email_vendor_events: [], billing_customer_emails: [], billing_customer_email_events: [], email_webhook_health: [] };
  rpcCalls.length = 0;
  process.env[WEBHOOK_SECRET_ENV] = SECRET;
});
afterEach(() => { delete process.env[WEBHOOK_SECRET_ENV]; });

describe("verifySignature", () => {
  const body = payload("email.delivered", "re_abc");
  it("accepts a valid v1 signature within tolerance and refuses everything else", () => {
    const good = sign(body);
    expect(verifySignature(Buffer.from(body), good, SECRET, NOW)).toBe("ok");
    expect(verifySignature(Buffer.from(body), { ...good, signature: `v1,${Buffer.alloc(32).toString("base64")}` }, SECRET, NOW)).toBe("bad_signature");
    expect(verifySignature(Buffer.from(`${body} `), good, SECRET, NOW)).toBe("bad_signature");
    expect(verifySignature(Buffer.from(body), sign(body, { secretBytes: crypto.randomBytes(24) }), SECRET, NOW)).toBe("bad_signature");
    expect(verifySignature(Buffer.from(body), { ...good, signature: null }, SECRET, NOW)).toBe("missing_headers");
    expect(verifySignature(Buffer.from(body), sign(body, { timestamp: Math.floor(NOW.getTime() / 1000) - 6 * 60 }), SECRET, NOW)).toBe("stale_timestamp");
    expect(verifySignature(Buffer.from(body), good, null, NOW)).toBe("not_configured");
  });
  it("accepts any listed v1 signature (secret rotation sends two) and ignores unknown versions", () => {
    const good = sign(body);
    const rotated = `v1,${Buffer.alloc(32, 7).toString("base64")} ${good.signature} v2,abc`;
    expect(verifySignature(Buffer.from(body), { ...good, signature: rotated }, SECRET, NOW)).toBe("ok");
    expect(verifySignature(Buffer.from(body), { ...good, signature: "v2,abc" }, SECRET, NOW)).toBe("bad_signature");
  });
  it("reports whether tracking is configured from the secret alone", () => {
    expect(isWebhookConfigured()).toBe(true);
    process.env[WEBHOOK_SECRET_ENV] = "   ";
    expect(isWebhookConfigured()).toBe(false);
  });
});

describe("normalizeEvent", () => {
  it("maps vendor event types and keeps only the click link and bounce classification", () => {
    const clicked = normalizeEvent(JSON.parse(payload("email.clicked", "re_abc", { click: { link: "https://thinnr.example/orders/1", ipAddress: "10.0.0.1", userAgent: "x" } })), "evt_1");
    expect(clicked).toEqual({ kind: "event", event: { vendorEventId: "evt_1", vendorMessageId: "re_abc", eventType: "clicked", occurredAt: "2026-09-23T14:59:30.000Z", detail: { link: "https://thinnr.example/orders/1" } } });
    const bounced = normalizeEvent(JSON.parse(payload("email.bounced", "re_abc", { bounce: { type: "Permanent", subType: "General", message: "mailbox not found" } })), "evt_2");
    expect(bounced.kind === "event" && bounced.event.detail).toEqual({ type: "Permanent", sub_type: "General", message: "mailbox not found" });
    expect(normalizeEvent(JSON.parse(payload("email.scheduled", "re_abc")), "evt_3")).toEqual({ kind: "ignored", type: "email.scheduled" });
    expect(normalizeEvent(JSON.parse(payload("email.delivered", "  ")), "evt_4")).toEqual({ kind: "invalid", reason: "missing_email_id" });
    expect(normalizeEvent("nope", "evt_5")).toEqual({ kind: "invalid", reason: "not_an_object" });
  });
});

describe("ingestVendorEvent", () => {
  const event = (type: "delivered" | "opened" | "clicked" | "bounced" | "sent", id: string, at = "2026-09-23T14:59:30.000Z", messageId = "re_abc") =>
    ({ vendorEventId: id, vendorMessageId: messageId, eventType: type, occurredAt: at, detail: {} } as const);

  it("stores once, copies to the ledger's scoped events table, and folds first-seen + latest onto the ledger row", async () => {
    const ledger = ledgerRow();
    tables.billing_customer_emails.push(ledger);
    expect(await ingestVendorEvent(event("delivered", "evt_1"), NOW)).toEqual({ outcome: "stored", matched: true });
    expect(await ingestVendorEvent(event("opened", "evt_2", "2026-09-23T15:10:00.000Z"), NOW)).toEqual({ outcome: "stored", matched: true });
    // A second open keeps the first opened_at but advances the latest event.
    expect(await ingestVendorEvent(event("opened", "evt_3", "2026-09-23T15:20:00.000Z"), NOW)).toEqual({ outcome: "stored", matched: true });
    // An out-of-order older event never regresses the latest marker.
    expect(await ingestVendorEvent(event("sent", "evt_0", "2026-09-23T14:59:01.000Z"), NOW)).toEqual({ outcome: "stored", matched: true });
    expect(ledger).toMatchObject({ delivered_at: "2026-09-23T14:59:30.000Z", opened_at: "2026-09-23T15:10:00.000Z", last_event_type: "opened", last_event_at: "2026-09-23T15:20:00.000Z" });
    expect(ledger.clicked_at).toBeUndefined();
    expect(tables.billing_customer_email_events.map((row) => [row.email_id, row.event_type, row.stripe_mode, row.stripe_platform_account_id]))
      .toEqual([[ledger.id, "delivered", "live", "acct_live"], [ledger.id, "opened", "live", "acct_live"], [ledger.id, "opened", "live", "acct_live"], [ledger.id, "sent", "live", "acct_live"]]);
    expect(tables.email_vendor_events.every((row) => row.email_id === ledger.id && row.matched_at)).toBe(true);
    // Health: the last event is the newest by occurrence, noted through the atomic RPC.
    expect(rpcCalls.filter((call) => call.name === "email_webhook_note_event")).toHaveLength(4);
  });

  it("replays are duplicates: nothing is stored or folded twice", async () => {
    const ledger = ledgerRow();
    tables.billing_customer_emails.push(ledger);
    await ingestVendorEvent(event("clicked", "evt_9", "2026-09-23T15:00:00.000Z"), NOW);
    ledger.clicked_at = "1999-01-01T00:00:00.000Z"; // sentinel: a replay must not touch the row
    expect(await ingestVendorEvent(event("clicked", "evt_9", "2026-09-23T15:00:00.000Z"), NOW)).toEqual({ outcome: "duplicate", matched: false });
    expect(tables.email_vendor_events).toHaveLength(1);
    expect(tables.billing_customer_email_events).toHaveLength(1);
    expect(ledger.clicked_at).toBe("1999-01-01T00:00:00.000Z");
    // Two different events for the same message are not duplicates of each other.
    expect(await ingestVendorEvent(event("clicked", "evt_10", "2026-09-23T15:01:00.000Z"), NOW)).toEqual({ outcome: "stored", matched: true });
  });

  it("keeps an event whose ledger row does not exist yet, and the rematch job attaches it once the row appears", async () => {
    expect(await ingestVendorEvent(event("delivered", "evt_early", "2026-09-23T14:59:30.000Z", "re_late"), NOW)).toEqual({ outcome: "stored", matched: false });
    expect(tables.email_vendor_events[0].vendor_message_id).toBe("re_late");
    expect(tables.email_vendor_events[0].email_id ?? null).toBeNull();
    expect(tables.billing_customer_email_events).toHaveLength(0);
    // Nothing to match yet: the dry run and the real run both report zero.
    expect(await rematchUnmatchedEvents({ now: NOW, dryRun: false })).toEqual({ scanned: 1, matched: 0, pruned: 0 });
    const ledger = ledgerRow({ vendor_message_id: "re_late" });
    tables.billing_customer_emails.push(ledger);
    expect(await rematchUnmatchedEvents({ now: NOW, dryRun: true })).toEqual({ scanned: 1, matched: 1, pruned: 0 });
    expect(tables.billing_customer_email_events).toHaveLength(0);
    expect(ledger.delivered_at).toBeUndefined();
    expect(await rematchUnmatchedEvents({ now: NOW, dryRun: false })).toEqual({ scanned: 1, matched: 1, pruned: 0 });
    expect(tables.email_vendor_events[0]).toMatchObject({ email_id: ledger.id, matched_at: NOW.toISOString() });
    expect(tables.billing_customer_email_events.map((row) => [row.email_id, row.event_type])).toEqual([[ledger.id, "delivered"]]);
    expect(ledger).toMatchObject({ delivered_at: "2026-09-23T14:59:30.000Z", last_event_type: "delivered" });
    expect(await rematchUnmatchedEvents({ now: NOW, dryRun: false })).toEqual({ scanned: 0, matched: 0, pruned: 0 });
  });

  it("prunes unmatched events past retention (dry runs only count them)", async () => {
    tables.email_vendor_events.push(
      { id: "old", vendor_event_id: "evt_old", vendor_message_id: "re_gone", event_type: "opened", occurred_at: "2026-08-01T00:00:00.000Z", received_at: "2026-08-01T00:00:00.000Z", email_id: null },
      { id: "recent", vendor_event_id: "evt_recent", vendor_message_id: "re_soon", event_type: "opened", occurred_at: "2026-09-23T14:00:00.000Z", received_at: "2026-09-23T14:00:00.000Z", email_id: null },
    );
    expect(await rematchUnmatchedEvents({ now: NOW, dryRun: true })).toEqual({ scanned: 1, matched: 0, pruned: 1 });
    expect(tables.email_vendor_events).toHaveLength(2);
    expect(await rematchUnmatchedEvents({ now: NOW, dryRun: false })).toEqual({ scanned: 1, matched: 0, pruned: 1 });
    expect(tables.email_vendor_events.map((row) => row.id)).toEqual(["recent"]);
  });

  it("a ledger row without a billing identity is still matched in the inbox but never copied into the scoped table", async () => {
    const ledger = ledgerRow({ stripe_mode: null, stripe_platform_account_id: null });
    tables.billing_customer_emails.push(ledger);
    expect(await ingestVendorEvent(event("delivered", "evt_legacy"), NOW)).toEqual({ outcome: "stored", matched: true });
    expect(tables.billing_customer_email_events).toHaveLength(0);
    expect(tables.email_vendor_events[0].email_id).toBe(ledger.id);
  });

  it("surfaces a failed inbox insert so the vendor retries", async () => {
    vi.mocked(supabaseAdmin).mockResolvedValueOnce({ status: 503, json: { message: "db down" } } as never);
    await expect(ingestVendorEvent(event("delivered", "evt_x"), NOW)).rejects.toThrow(/inbox insert failed \(503\)/);
  });
});

describe("readEmailWebhookHealth", () => {
  it("reads the last event, 24h volume, unmatched backlog, rejections for the UTC day, and the last confirmed send", async () => {
    tables.email_webhook_health.push({ vendor: "resend", last_event_at: "2026-09-23T14:30:00.000Z", last_event_type: "opened", last_rejected_at: "2026-09-23T09:00:00.000Z", rejected_total: 12, rejected_day_count: 3, rejected_day: "2026-09-23" });
    tables.email_vendor_events.push(
      { id: "a", vendor_event_id: "1", vendor_message_id: "re_1", event_type: "delivered", occurred_at: "2026-09-23T14:00:00.000Z", received_at: "2026-09-23T14:00:00.000Z", email_id: "e1" },
      { id: "b", vendor_event_id: "2", vendor_message_id: "re_2", event_type: "opened", occurred_at: "2026-09-23T13:00:00.000Z", received_at: "2026-09-23T13:00:00.000Z", email_id: null },
      { id: "c", vendor_event_id: "3", vendor_message_id: "re_3", event_type: "opened", occurred_at: "2026-09-21T13:00:00.000Z", received_at: "2026-09-21T13:00:00.000Z", email_id: null },
    );
    tables.billing_customer_emails.push(ledgerRow({ sent_at: "2026-09-23T14:20:00.000Z" }), ledgerRow({ sent_at: "2026-09-22T10:00:00.000Z" }), ledgerRow({ status: "failed", vendor_message_id: null, sent_at: null }));
    expect(await readEmailWebhookHealth(NOW)).toEqual({
      vendor: "resend", configured: true, last_event_at: "2026-09-23T14:30:00.000Z", last_event_type: "opened", events_24h: 2,
      unmatched_count: 2, oldest_unmatched_at: "2026-09-21T13:00:00.000Z", last_rejected_at: "2026-09-23T09:00:00.000Z", rejected_today: 3, rejected_total: 12,
      last_email_sent_at: "2026-09-23T14:20:00.000Z",
    });
    // Yesterday's rejection tally does not count as today's.
    tables.email_webhook_health[0].rejected_day = "2026-09-22";
    delete process.env[WEBHOOK_SECRET_ENV];
    const later = await readEmailWebhookHealth(NOW);
    expect(later.rejected_today).toBe(0);
    expect(later.configured).toBe(false);
  });
});
