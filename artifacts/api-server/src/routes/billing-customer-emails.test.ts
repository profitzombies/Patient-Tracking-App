import crypto from "node:crypto";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staff ledger routes over an in-memory PostgREST stand-in: office scoping,
 * HQ free-text search, preview, resend / send-to-other, contacts, and the
 * audit events each write emits. Delivery itself is covered by
 * ../billing/customer-emails.test.ts.
 */
type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
function matchesOne(row: Row, key: string, raw: string): boolean {
  if (raw === "is.null") return row[key] == null;
  if (raw === "not.is.null") return row[key] != null;
  if (raw === "is.true") return row[key] === true;
  if (raw === "is.false") return row[key] === false;
  if (raw.startsWith("eq.")) return String(row[key]) === decodeURIComponent(raw.slice(3));
  if (raw.startsWith("in.(")) return raw.slice(4, -1).split(",").map((v) => decodeURIComponent(v).replace(/^"|"$/g, "")).includes(String(row[key]));
  if (raw.startsWith("ilike.")) return String(row[key] ?? "").toLowerCase().includes(decodeURIComponent(raw.slice(6)).replace(/^\*|\*$/g, "").toLowerCase());
  const bound = /^(gte|lte|lt)\.(.*)$/.exec(raw);
  if (bound) {
    if (row[key] == null) return false;
    const wanted = decodeURIComponent(bound[2]);
    // Timestamps compare as instants, like Postgres, not as strings.
    const compare = key.endsWith("_at") ? Math.sign(Date.parse(String(row[key])) - Date.parse(wanted)) : String(row[key]).localeCompare(wanted);
    return bound[1] === "gte" ? compare >= 0 : bound[1] === "lte" ? compare <= 0 : compare < 0;
  }
  return true;
}
function splitClauses(text: string): string[] {
  const parts: string[] = []; let depth = 0; let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1; if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}
const clause = (row: Row, text: string) => { const dot = text.indexOf("."); return matchesOne(row, text.slice(0, dot), text.slice(dot + 1)); };
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit"].includes(key)) continue;
    if (key === "or") {
      if (!splitClauses(raw.slice(1, -1)).some((c) => c.startsWith("and(") ? splitClauses(c.slice(4, -1)).every((inner) => clause(row, inner)) : clause(row, c))) return false;
      continue;
    }
    if (!matchesOne(row, key, raw)) return false;
  }
  return true;
}
function ordered(rows: Row[], params: URLSearchParams): Row[] {
  const order = params.get("order");
  if (!order) return rows;
  const keys = order.split(",").map((part) => { const [key, dir] = part.split("."); return { key, desc: dir === "desc" }; });
  return [...rows].sort((a, b) => {
    for (const { key, desc } of keys) {
      const cmp = String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
      if (cmp !== 0) return desc ? -cmp : cmp;
    }
    return 0;
  });
}
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://db${path}`);
    const table = url.pathname.split("/").at(-1)!;
    const rows = tables[table] ?? (tables[table] = []);
    if (method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      return { status: 200, json: ordered(rows.filter((row) => matches(row, url.searchParams)), url.searchParams).slice(0, limit) };
    }
    if (method === "PATCH") {
      const selected = rows.filter((row) => matches(row, url.searchParams));
      selected.forEach((row) => Object.assign(row, body as Row, { updated_at: new Date().toISOString() }));
      return { status: 200, json: selected };
    }
    if (method === "POST") {
      const input = body as Row;
      if (table === "billing_notification_contacts" && rows.some((row) => row.active && row.payer_id === input.payer_id && row.email === input.email)) {
        return { status: 409, json: { code: "23505", message: "duplicate key value violates unique constraint \"billing_notification_contacts_active_unique\"", details: "" } };
      }
      const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...input };
      rows.push(row);
      return { status: 201, json: [row] };
    }
    return { status: 204, json: null };
  }),
}));
vi.mock("../lib/staff-auth", async (original) => {
  const actual = await original<typeof import("../lib/staff-auth")>();
  return {
    ...actual,
    requireHqPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = String(req.headers.authorization ?? "").replace("Bearer ", "");
      if (!token.startsWith("hq")) { res.status(401).json({ error: "Sign in to continue." }); return; }
      if (permission === "provider_manage" && token !== "hq-manager") { res.status(403).json({ error: "No." }); return; }
      res.locals.staff = { userId: "hq-user", role: "hq_admin", departmentRole: "admin" };
      next();
    },
  };
});
vi.mock("../billing/auth", async (original) => {
  const actual = await original<typeof import("../billing/auth")>();
  return {
    ...actual,
    requireOfficeBillingScope: async (req: express.Request, res: express.Response, options: { write: boolean }) => {
      const token = String(req.headers.authorization ?? "").replace("Bearer ", "");
      if (!token.startsWith("office")) { res.status(401).json({ error: "Sign in to continue." }); return null; }
      if (options.write && token === "office-staff") { res.status(403).json({ error: "Only office owners and admins can manage payments." }); return null; }
      const providerId = token === "office-b" ? "office-b" : "office-a";
      return { providerId, officeName: providerId, actorUserId: `${token}-user`, isHq: false, officeRole: "owner", canManage: true };
    },
  };
});
vi.mock("../lib/admin-audit", async (original) => {
  const actual = await original<typeof import("../lib/admin-audit")>();
  return { ...actual, recordAdminAuditEvent: vi.fn(async () => undefined) };
});

import router from "./billing-customer-emails";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { runWithBillingIdentity } from "../billing/stripe-environment";
import { __setEmailClientForTests } from "../email/transport";

const scope = { stripe_mode: "live", stripe_platform_account_id: "acct_live" };
const audit = vi.mocked(recordAdminAuditEvent);
const sent: Array<{ to: string; subject: string }> = [];
const originalFetch = global.fetch;
let server: http.Server;
let base = "";
const PAYER_A = "0a1b2c3d-0000-4000-8000-00000000aa01";
const PAYER_B = "0a1b2c3d-0000-4000-8000-00000000bb02";
const ORDER_A = "0a1b2c3d-0000-4000-8000-00000000aa10";
const PATIENT_A = "0a1b2c3d-0000-4000-8000-00000000aa20";
const EMAIL_1 = "0a1b2c3d-0000-4000-8000-00000000ee01";
const EMAIL_2 = "0a1b2c3d-0000-4000-8000-00000000ee02";
const EMAIL_3 = "0a1b2c3d-0000-4000-8000-00000000ee03";
const variables = { name: "Riley", productName: "Control", officeName: "Harbor Health", manageLink: "" };
const emailRow = (over: Row): Row => ({
  ...scope, kind: "automatic", parent_id: null, contact_id: null, status: "sent", error: null, recipient: "riley@example.test", subject: "Paused",
  template_id: "subscription-paused", variables, attempts: 1, max_attempts: 3, last_attempt_at: "2026-09-10T00:00:00.000Z", next_attempt_at: null,
  sent_at: "2026-09-10T00:00:00.000Z", vendor_message_id: "msg_1", attempt_log: [{ at: "2026-09-10T00:00:00.000Z", outcome: "sent", error: null, vendor_message_id: "msg_1", recipient_hash: "abc", recipient_domain: "example.test" }],
  requested_by: null, subscription_id: null, order_id: null, ...over,
});
async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await originalFetch(`${base}${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
beforeAll(async () => {
  process.env.RESEND_API_KEY = "test";
  process.env.CLAIM_EMAIL_FROM = "THINNR <hello@example.test>";
  __setEmailClientForTests({ async send(message) { sent.push({ to: message.to, subject: message.subject }); return { id: `msg_${sent.length + 1}` }; } });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => runWithBillingIdentity({ mode: req.headers["x-mode"] === "test" ? "test" : "live", platformAccountId: req.headers["x-mode"] === "test" ? "acct_test" : "acct_live" }, next));
  app.use(router);
  server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  __setEmailClientForTests(null);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => {
  sent.length = 0;
  audit.mockClear();
  tables = {
    billing_payers: [
      { ...scope, id: PAYER_A, provider_id: "office-a", patient_id: PATIENT_A, name: "Riley Example", email: "riley@example.test", phone: "+15125550100", created_at: "2026-09-01T00:00:00.000Z" },
      { ...scope, id: PAYER_B, provider_id: "office-b", patient_id: null, name: "Morgan Other", email: "morgan@other.test", phone: null, created_at: "2026-09-01T00:00:00.000Z" },
    ],
    billing_orders: [{ ...scope, id: ORDER_A, order_number: "TH-ABCD2345", provider_id: "office-a", payer_id: PAYER_A, livemode: true }],
    providers: [
      { provider_id: "office-a", office_name: "Harbor Health", provider_name: "Dr. Harbor", auth_user_id: "office-a-user" },
      { provider_id: "office-b", office_name: "Bayside Clinic", provider_name: "Dr. Bay", auth_user_id: "office-b-user" },
    ],
    billing_customer_emails: [
      emailRow({ id: EMAIL_1, dedupe_key: "shipped:a", template_id: "order-shipped", provider_id: "office-a", payer_id: PAYER_A, order_id: ORDER_A, subject: "Shipped", created_at: "2026-09-10T00:00:00.000Z",
        delivered_at: "2026-09-10T00:00:30.000Z", opened_at: "2026-09-10T01:00:00.000Z", last_event_type: "opened", last_event_at: "2026-09-10T01:00:00.000Z",
        variables: { name: "Riley", officeName: "Harbor Health", orderNumber: "TH-ABCD2345", carrier: "UPS", trackingNumber: "1Z", trackingLink: "", items: "Control", shipTo: "Austin", manageLink: "" } }),
      emailRow({ id: EMAIL_2, dedupe_key: "paused:a", provider_id: "office-a", payer_id: PAYER_A, created_at: "2026-09-11T00:00:00.000Z", status: "failed", error: "Resend send failed (500) (gave up after 3 attempts)", attempts: 3 }),
      emailRow({ id: EMAIL_3, dedupe_key: "paused:b", provider_id: "office-b", payer_id: PAYER_B, recipient: "morgan@other.test", created_at: "2026-09-12T00:00:00.000Z",
        bounced_at: "2026-09-12T00:01:00.000Z", last_event_type: "bounced", last_event_at: "2026-09-12T00:01:00.000Z" }),
    ],
    billing_notification_contacts: [],
    billing_customer_email_events: [{ ...scope, id: "evt-1", email_id: EMAIL_1, vendor_message_id: "msg_1", event_type: "opened", occurred_at: "2026-09-10T01:00:00.000Z" }],
  };
});

describe("office ledger routes", () => {
  it("lists an order's emails with joined order number, payer, office, and events only on detail", async () => {
    const list = await call("GET", `/billing/office/emails?order_id=${ORDER_A}`, "office-a");
    expect(list.status).toBe(200);
    expect(list.json.items).toEqual([expect.objectContaining({ id: EMAIL_1, order_number: "TH-ABCD2345", payer_name: "Riley Example", office_name: "Harbor Health", patient_id: PATIENT_A, events: [] })]);
    const detail = await call("GET", `/billing/office/emails/${EMAIL_1}`, "office-a");
    expect(detail.json.email.events).toEqual([{ id: "evt-1", event_type: "opened", occurred_at: "2026-09-10T01:00:00.000Z" }]);
    expect(detail.json.email.attempt_log).toEqual([{ at: "2026-09-10T00:00:00.000Z", outcome: "sent", error: null, vendor_message_id: "msg_1", recipient_domain: "example.test" }]);
    expect(JSON.stringify(detail.json.email.attempt_log)).not.toContain("recipient_hash");
  });
  it("requires a subject filter, resolves patient ids to payers, and never shows another office's rows", async () => {
    expect((await call("GET", "/billing/office/emails", "office-a")).status).toBe(400);
    const byPatient = await call("GET", `/billing/office/emails?patient_id=${PATIENT_A}`, "office-a");
    expect(byPatient.json.items.map((row: Row) => row.id)).toEqual([EMAIL_2, EMAIL_1]);
    expect(byPatient.json.payers).toEqual([{ id: PAYER_A, name: "Riley Example", email: "riley@example.test" }]);
    const crossOffice = await call("GET", `/billing/office/emails?payer_id=${PAYER_A}`, "office-b");
    expect(crossOffice.json.items).toEqual([]);
    expect((await call("GET", `/billing/office/emails/${EMAIL_1}`, "office-b")).status).toBe(404);
    expect((await call("GET", `/billing/office/emails/${EMAIL_1}/preview`, "office-b")).status).toBe(404);
    expect((await call("GET", `/billing/office/payers/${PAYER_A}/contacts`, "office-b")).status).toBe(404);
  });
  it("renders a preview from the stored template and variables", async () => {
    const preview = await call("GET", `/billing/office/emails/${EMAIL_1}/preview`, "office-a");
    expect(preview.status).toBe(200);
    expect(preview.json.subject).toContain("TH-ABCD2345");
    expect(preview.json.html).toContain("1Z");
    expect(preview.json.text).toContain("UPS");
  });
  it("resends as a linked row and audits it; staff without manage rights are refused", async () => {
    expect((await call("POST", `/billing/office/emails/${EMAIL_2}/resend`, "office-staff")).status).toBe(403);
    const resend = await call("POST", `/billing/office/emails/${EMAIL_2}/resend`, "office-a");
    expect(resend.status).toBe(200);
    expect(resend.json).toMatchObject({ outcome: "sent", email: { kind: "resend", parent_id: EMAIL_2, recipient: "riley@example.test", status: "sent", requested_by: "office-a-user" } });
    expect(sent).toEqual([{ to: "riley@example.test", subject: expect.stringContaining("paused") }]);
    expect(tables.billing_customer_emails.find((row) => row.id === EMAIL_2)).toMatchObject({ status: "failed", attempts: 3 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "billing_customer_email_resent", actorKind: "team_member", providerId: "office-a", targetKind: "billing_customer_email",
      targetId: resend.json.email.id, metadata: expect.objectContaining({ parent_email_id: EMAIL_2, template_id: "subscription-paused", outcome: "sent" }),
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("riley@");
  });
  it("sends to another address after validating it; Test scope never reaches Live rows", async () => {
    expect((await call("POST", `/billing/office/emails/${EMAIL_1}/send-to`, "office-a", { email: "nope" })).status).toBe(400);
    const other = await call("POST", `/billing/office/emails/${EMAIL_1}/send-to`, "office-a", { email: "Spouse@Example.test" });
    expect(other.status).toBe(200);
    expect(other.json.email).toMatchObject({ kind: "send_to_other", parent_id: EMAIL_1, recipient: "spouse@example.test", order_number: "TH-ABCD2345" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "billing_customer_email_sent_to_other", targetId: other.json.email.id }));
    const res = await originalFetch(`${base}/billing/office/emails/${EMAIL_1}/send-to`, {
      method: "POST", headers: { Authorization: "Bearer office-a", "Content-Type": "application/json", "x-mode": "test" }, body: JSON.stringify({ email: "a@b.co" }),
    });
    // Live rows are invisible from the Test scope (store scoping), so the guard never even reaches sendAgain here.
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(1);
  });
  it("adds and removes notification contacts with audit events", async () => {
    const own = await call("POST", `/billing/office/payers/${PAYER_A}/contacts`, "office-a", { email: "RILEY@example.test" });
    expect(own.status).toBe(400);
    const added = await call("POST", `/billing/office/payers/${PAYER_A}/contacts`, "office-a", { email: " Spouse@Example.test ", label: "Spouse" });
    expect(added.status).toBe(201);
    // The adding staff member is named so the UI can show "added by"; resolution is best-effort.
    expect(added.json.contact).toMatchObject({ payer_id: PAYER_A, email: "spouse@example.test", label: "Spouse", active: true, added_by_name: "Dr. Harbor" });
    expect(added.json.contacts).toHaveLength(1);
    expect(tables.billing_notification_contacts[0]).toMatchObject({ provider_id: "office-a", created_by: "office-a-user" });
    expect((await call("POST", `/billing/office/payers/${PAYER_A}/contacts`, "office-a", { email: "spouse@example.test" })).status).toBe(409);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "billing_notification_contact_added", targetKind: "billing_notification_contact", targetId: added.json.contact.id, metadata: { payer_id: PAYER_A } }));
    const listed = await call("GET", `/billing/office/payers/${PAYER_A}/contacts`, "office-a");
    expect(listed.json).toEqual({ payer: { id: PAYER_A, name: "Riley Example", email: "riley@example.test" }, contacts: [expect.objectContaining({ email: "spouse@example.test", added_by_name: "Dr. Harbor" })] });
    const removed = await call("DELETE", `/billing/office/payers/${PAYER_A}/contacts/${added.json.contact.id}`, "office-a");
    expect(removed.status).toBe(200);
    expect(removed.json.contact).toMatchObject({ active: false, removed_at: expect.any(String) });
    expect(removed.json.contacts).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "billing_notification_contact_removed", targetId: added.json.contact.id }));
    expect((await call("DELETE", `/billing/office/payers/${PAYER_A}/contacts/${added.json.contact.id}`, "office-a")).status).toBe(404);
    // Re-adding after removal works because the unique index only covers active rows.
    expect((await call("POST", `/billing/office/payers/${PAYER_A}/contacts`, "office-a", { email: "spouse@example.test" })).status).toBe(201);
  });
});

describe("HQ ledger routes", () => {
  it("searches across payer name, office name, phone, recipient, and order number, with template/status/date filters and paging", async () => {
    const all = await call("GET", "/billing/hq/emails", "hq-reader");
    expect(all.json.items.map((row: Row) => row.id)).toEqual([EMAIL_3, EMAIL_2, EMAIL_1]);
    expect(all.json.next_cursor).toBeNull();
    for (const [q, ids] of [["riley", [EMAIL_2, EMAIL_1]], ["Bayside", [EMAIL_3]], ["5125550100", [EMAIL_2, EMAIL_1]], ["morgan@other", [EMAIL_3]], ["abcd2345", [EMAIL_1]], ["nobody", []]] as const) {
      const result = await call("GET", `/billing/hq/emails?q=${encodeURIComponent(q)}`, "hq-reader");
      expect(result.json.items.map((row: Row) => row.id), q).toEqual(ids);
    }
    expect((await call("GET", "/billing/hq/emails?template=order-shipped", "hq-reader")).json.items.map((row: Row) => row.id)).toEqual([EMAIL_1]);
    expect((await call("GET", "/billing/hq/emails?status=failed", "hq-reader")).json.items.map((row: Row) => row.id)).toEqual([EMAIL_2]);
    expect((await call("GET", "/billing/hq/emails?provider_id=office-b", "hq-reader")).json.items.map((row: Row) => row.id)).toEqual([EMAIL_3]);
    expect((await call("GET", "/billing/hq/emails?from=2026-09-11&to=2026-09-11", "hq-reader")).json.items.map((row: Row) => row.id)).toEqual([EMAIL_2]);
    expect((await call("GET", "/billing/hq/emails?template=bogus", "hq-reader")).status).toBe(400);
    const first = await call("GET", "/billing/hq/emails?limit=2", "hq-reader");
    expect(first.json.items.map((row: Row) => row.id)).toEqual([EMAIL_3, EMAIL_2]);
    const second = await call("GET", `/billing/hq/emails?limit=2&cursor=${encodeURIComponent(first.json.next_cursor)}`, "hq-reader");
    expect(second.json.items.map((row: Row) => row.id)).toEqual([EMAIL_1]);
    expect(second.json.next_cursor).toBeNull();
  });
  it("carries folded delivery facts per row, filters on delivery outcomes, and sums the whole filter for the outbox strip", async () => {
    const all = await call("GET", "/billing/hq/emails?summary=1&limit=1", "hq-reader");
    expect(all.json.items).toHaveLength(1);
    expect(all.json.items[0].delivery).toEqual({ delivered_at: null, delayed_at: null, bounced_at: "2026-09-12T00:01:00.000Z", complained_at: null, opened_at: null, clicked_at: null, last_event_type: "bounced", last_event_at: "2026-09-12T00:01:00.000Z" });
    // The strip counts every matching row, not just the one on this page.
    expect(all.json.summary).toEqual({ total: 3, sent: 2, failed: 1, bounced: 1, opened: 1, clicked: 0, truncated: false });
    // Tracking state rides along so the page can say "not enabled" instead of showing zeros: no secret in this suite, no event row.
    expect(all.json.tracking).toEqual({ vendor: "resend", configured: false, last_event_at: null });
    tables.email_webhook_health = [{ vendor: "resend", last_event_at: "2026-09-12T00:01:00.000Z" }];
    expect((await call("GET", "/billing/hq/emails?summary=1", "hq-reader")).json.tracking).toEqual({ vendor: "resend", configured: false, last_event_at: "2026-09-12T00:01:00.000Z" });
    expect((await call("GET", "/billing/hq/emails", "hq-reader")).json.summary).toBeUndefined();
    expect((await call("GET", "/billing/hq/emails", "hq-reader")).json.tracking).toBeUndefined();
    expect((await call("GET", "/billing/hq/emails?status=bounced", "hq-reader")).json.items.map((row: Row) => row.id)).toEqual([EMAIL_3]);
    expect((await call("GET", "/billing/hq/emails?status=opened", "hq-reader")).json.items.map((row: Row) => row.id)).toEqual([EMAIL_1]);
    expect((await call("GET", "/billing/hq/emails?status=clicked", "hq-reader")).json.items).toEqual([]);
    const scoped = await call("GET", "/billing/hq/emails?summary=1&provider_id=office-a&status=sent", "hq-reader");
    expect(scoped.json.items.map((row: Row) => row.id)).toEqual([EMAIL_1]);
    expect(scoped.json.summary).toEqual({ total: 1, sent: 1, failed: 0, bounced: 0, opened: 1, clicked: 0, truncated: false });
    expect((await call("GET", "/billing/hq/emails?status=weird", "hq-reader")).status).toBe(400);
  });
  it("reads with financial_read and acts with provider_manage, auditing as HQ", async () => {
    expect((await call("GET", `/billing/hq/emails/${EMAIL_3}/preview`, "hq-reader")).status).toBe(200);
    expect((await call("POST", `/billing/hq/emails/${EMAIL_3}/resend`, "hq-reader")).status).toBe(403);
    const resend = await call("POST", `/billing/hq/emails/${EMAIL_3}/resend`, "hq-manager");
    expect(resend.status).toBe(200);
    expect(resend.json.email).toMatchObject({ kind: "resend", parent_id: EMAIL_3, provider_id: "office-b", office_name: "Bayside Clinic" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "billing_customer_email_resent", actorKind: "hq", providerId: "office-b" }));
    const added = await call("POST", `/billing/hq/payers/${PAYER_B}/contacts`, "hq-manager", { email: "kin@other.test" });
    expect(added.status).toBe(201);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "billing_notification_contact_added", actorKind: "hq", providerId: "office-b" }));
    const listed = await call("GET", `/billing/hq/payers/${PAYER_B}/contacts`, "hq-reader");
    expect(listed.json.contacts).toHaveLength(1);
  });
});
