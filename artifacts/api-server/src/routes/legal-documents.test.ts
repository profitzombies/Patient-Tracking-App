/**
 * Public legal documents: served without a session, cache-friendly, and in
 * lockstep with the consent version the app must have on record.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  LEGAL_DOCUMENTS_EFFECTIVE_DATE,
  LEGAL_DOCUMENTS_STATUS,
  LEGAL_DOCUMENTS_VERSION,
  parseLegalMarkdown,
} from "@workspace/legal-documents";

const mocks = vi.hoisted(() => ({
  policy: { organizationName: "THINNR", supportEmail: null as string | null, supportPhone: null as string | null },
  fail: false,
}));
vi.mock("../lib/org-policy", () => ({
  DEFAULT_ORG_POLICY: { organizationName: "THINNR", supportEmail: null, supportPhone: null },
  loadOrgPolicy: vi.fn(async () => {
    if (mocks.fail) throw new Error("policy down");
    return mocks.policy;
  }),
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: vi.fn() }));

import router from "./legal-documents";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";

let server: http.Server;
let base: string;

beforeAll(() => {
  const app = express();
  app.use("/api", router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("GET /api/legal/documents", () => {
  it("serves every document with the current version, no session, cacheable", async () => {
    const res = await fetch(`${base}/api/legal/documents`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
    const body = (await res.json()) as { version: string; effectiveDate: string; status: string; documents: { slug: string; title: string; markdown: string }[] };
    expect(body.version).toBe(LEGAL_DOCUMENTS_VERSION);
    expect(body.effectiveDate).toBe(LEGAL_DOCUMENTS_EFFECTIVE_DATE);
    expect(["draft", "final"]).toContain(body.status);
    expect(body.documents.map((d: { slug: string }) => d.slug)).toEqual(["privacy", "terms", "health-data"]);
    for (const document of body.documents) {
      expect(document.markdown.startsWith(`# ${document.title}`)).toBe(true);
      expect(parseLegalMarkdown(document.markdown).length).toBeGreaterThan(3);
    }
  });

  it("serves one document by slug and 404s unknown slugs", async () => {
    const one = await fetch(`${base}/api/legal/documents/health-data`);
    expect(one.status).toBe(200);
    const body = (await one.json()) as { version: string; document: { title: string; markdown: string } };
    expect(body.version).toBe(LEGAL_DOCUMENTS_VERSION);
    expect(body.document.title).toBe("Health data notice");
    // The notice must match the platform permission strings: read-only weight + steps.
    expect(body.document.markdown).toMatch(/never writes/i);
    expect(body.document.markdown).toMatch(/\*\*Weight\*\*/);
    expect(body.document.markdown).toMatch(/\*\*Steps\*\*/);
    const missing = await fetch(`${base}/api/legal/documents/cookies`);
    expect(missing.status).toBe(404);
  });

  it("support contact prefers the HQ-entered address and falls back to the default", async () => {
    mocks.policy.supportEmail = "help@office.example";
    mocks.policy.supportPhone = "+1 555 0100";
    const set = await (await fetch(`${base}/api/legal/support`)).json();
    expect(set).toEqual({ organizationName: "THINNR", email: "help@office.example", phone: "+1 555 0100" });
    mocks.policy.supportEmail = null;
    mocks.policy.supportPhone = null;
    const unset = (await (await fetch(`${base}/api/legal/support`)).json()) as { email: string; phone: string | null };
    expect(unset.email).toBe("support@trythinnr.com");
    expect(unset.phone).toBeNull();
    mocks.fail = true;
    const down = await fetch(`${base}/api/legal/support`);
    expect(down.status).toBe(200);
    expect(((await down.json()) as { email: string }).email).toBe("support@trythinnr.com");
    mocks.fail = false;
  });
});

describe("consent version lockstep", () => {
  it("the consent policy version IS the published document version", () => {
    expect(CONSENT_POLICY_VERSION).toBe(LEGAL_DOCUMENTS_VERSION);
    expect(LEGAL_DOCUMENTS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(LEGAL_DOCUMENTS_STATUS === "draft" || LEGAL_DOCUMENTS_STATUS === "final").toBe(true);
  });

  it("the generated bundle matches the markdown sources (run build:documents after editing)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = path.resolve(here, "../../../../lib/legal-documents/scripts/build-documents.mjs");
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
