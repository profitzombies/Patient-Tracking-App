import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ordering contract for the live suggestion context: a patient's "stop
 * suggesting products" (or "you can suggest again") is persisted FIRST, on its
 * own, before any of the optional health/billing/storefront reads. An
 * unrelated upstream failure this turn must never lose that choice.
 */

const calls = vi.hoisted(() => ({
  log: [] as string[],
  factsFail: false,
  flagsRow: null as null | { coach_product_opt_out?: boolean; coach_product_suggestions?: Record<string, string> },
  providerLookupFail: false,
  billingFail: false,
}));
vi.mock("../billing/mode-state", () => {
  class BillingModeError extends Error {}
  return {
    BillingModeError,
    getBillingModeStatus: vi.fn(async () => {
      if (calls.billingFail) throw new BillingModeError("Billing is unconfigured");
      return { mode: "test", platformAccountId: "acct_synthetic", version: 0 };
    }),
  };
});

vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === "POST" && path.startsWith("/rest/v1/patient_flags")) {
      const row = (body as Array<{ coach_product_opt_out?: boolean }>)[0];
      calls.log.push(`save-preference:${row.coach_product_opt_out}`);
      return { status: 201, json: null };
    }
    if (method === "GET" && path.startsWith("/rest/v1/patient_flags")) {
      calls.log.push("read-flags");
      return { status: 200, json: calls.flagsRow ? [calls.flagsRow] : [] };
    }
    if (method === "GET" && path.startsWith("/rest/v1/patients")) {
      calls.log.push("read-office");
      if (calls.providerLookupFail) return { status: 500, json: { message: "db down" } };
      return { status: 200, json: [{ provider_id: "office-1" }] };
    }
    throw new Error(`unexpected supabase call ${method} ${path}`);
  }),
}));

vi.mock("../billing/store", () => ({
  selectMany: vi.fn(async (table: string) => {
    calls.log.push(`read-${table}`);
    return [];
  }),
  selectOne: vi.fn(async () => {
    calls.log.push("read-connected-account");
    return { charges_enabled: true };
  }),
}));

vi.mock("../billing/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../billing/catalog")>();
  return {
    ...actual,
    officeOffering: vi.fn(async () => {
      calls.log.push("read-offering");
      return [];
    }),
  };
});

vi.mock("./product-signals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./product-signals")>();
  return {
    ...actual,
    loadSuggestionFacts: vi.fn(async () => {
      calls.log.push("read-facts");
      if (calls.factsFail) throw new Error("health facts unavailable");
      return {
        todayKey: "2026-09-17", programDay: 12, weighIns: [], entries: [], waterDays: [],
        targets: { protein: 120, waterOz: 64 }, medications: [], bloodwork: [],
      } satisfies Awaited<ReturnType<typeof actual.loadSuggestionFacts>>;
    }),
  };
});

import { loadLiveSuggestionContext } from "./product-suggestions";
import type { PatientContext } from "./prompt";
import { currentBillingIdentity } from "../billing/stripe-environment";
import { officeOffering } from "../billing/catalog";

const patient = { programDay: 12, today: null } as unknown as PatientContext;

beforeEach(() => {
  calls.log = [];
  calls.factsFail = false;
  calls.flagsRow = null;
  calls.providerLookupFail = false;
  calls.billingFail = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadLiveSuggestionContext preference persistence", () => {
  it("suppresses optional offers when billing is unconfigured and still saves opt-out", async () => {
    calls.billingFail = true;
    const result = await loadLiveSuggestionContext({ patientId: "patient-1", providerId: "office-1", patient, latestMessage: "Stop suggesting products" });
    expect(result.offers).toEqual([]);
    expect(result.storefront.available).toBe(false);
    expect(calls.log).toEqual(["save-preference:true"]);
  });
  it("pins office offering reads and restores the outer nonbilling context", async () => {
    vi.mocked(officeOffering).mockImplementationOnce(async () => {
      expect(currentBillingIdentity()).toEqual({ mode: "test", platformAccountId: "acct_synthetic", version: 0 });
      return [];
    });
    await loadLiveSuggestionContext({ patientId: "patient-1", providerId: "office-1", patient, latestMessage: "hello" });
    expect(currentBillingIdentity()).toBeUndefined();
  });
  it("persists a stop request before any optional read, so a failing read cannot lose it", async () => {
    calls.factsFail = true;
    await expect(loadLiveSuggestionContext({
      patientId: "patient-1", providerId: "office-1", patient, latestMessage: "Please stop suggesting products",
    })).rejects.toThrow("health facts unavailable");
    expect(calls.log[0]).toBe("save-preference:true");
    expect(calls.log.indexOf("save-preference:true")).toBeLessThan(calls.log.indexOf("read-facts"));
  });

  it("persists a stop request before the office lookup on the route's path (no providerId given), even when that lookup fails", async () => {
    calls.providerLookupFail = true;
    await expect(loadLiveSuggestionContext({
      patientId: "patient-1", patient, latestMessage: "Stop recommending products please",
    })).rejects.toThrow("patient office lookup failed (500)");
    expect(calls.log).toEqual(["save-preference:true", "read-office"]);
  });

  it("persists a resume request first and reports the new standing preference this turn", async () => {
    calls.flagsRow = { coach_product_opt_out: true };
    const context = await loadLiveSuggestionContext({
      patientId: "patient-1", providerId: "office-1", patient, latestMessage: "You can suggest products again",
    });
    expect(calls.log[0]).toBe("save-preference:false");
    expect(context.preferenceChange).toBe("resume");
    // The write is authoritative even though the flags read still showed the old value.
    expect(context.optOut).toBe(false);
    expect(context.storefront).toEqual({ offering: [], available: false });
  });

  it("writes nothing on an ordinary message and keeps the stored preference", async () => {
    calls.flagsRow = { coach_product_opt_out: true };
    const context = await loadLiveSuggestionContext({
      patientId: "patient-1", providerId: "office-1", patient, latestMessage: "How am I doing this week?",
    });
    expect(calls.log.some((entry) => entry.startsWith("save-preference"))).toBe(false);
    expect(context.optOut).toBe(true);
    expect(context.preferenceChange).toBeNull();
  });
});
