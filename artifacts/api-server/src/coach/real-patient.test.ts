/**
 * Real-patient grounding units — the live-account counterpart of the demo
 * seed. Pins the date/day/name helpers, the live "today so far" context
 * builder (diary sums, water, target overrides, honest failures), and the
 * prompt line the coach actually reads, so a signed-in patient is always
 * spoken to from THEIR numbers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TARGETS,
  firstNameOf,
  isDateKey,
  programDayFor,
  realPatientContext,
  type PatientProfile,
} from "./real-patient";
import { patientContextLine, type PatientContext } from "./prompt";
import { phaseNameForDay } from "./demo-patient";

const FAKE_SUPABASE = "http://fake.supabase.local";

type Row = Record<string, unknown>;

/** Per-test data the fake REST surface answers from. */
const store = {
  profile: null as Row | null,
  entries: [] as Row[],
  water: [] as Row[],
  overrides: [] as Row[],
  episodes: [] as Row[],
  activity: [] as Row[],
  /** pathname substrings that fail once with a 500 */
  failOnce: new Set<string>(),
  /** date_key filters observed per table */
  seenDateKeys: new Map<string, string>(),
};

function resetStore() {
  store.profile = {
    name: "Riley Chen",
    program_start_date: "2026-08-10",
    created_at: "2026-08-10T09:00:00Z",
  };
  store.entries = [];
  store.water = [];
  store.overrides = [];
  store.episodes = [];
  store.activity = [];
  store.failOnce.clear();
  store.seenDateKeys.clear();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(() => {
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname !== "fake.supabase.local") return realFetch(input as string, init);

    for (const key of store.failOnce) {
      if (url.pathname.includes(key)) {
        store.failOnce.delete(key);
        return Promise.resolve(json(500, { message: "fake upstream failure" }));
      }
    }
    const dateKey = url.searchParams.get("date_key");
    if (dateKey?.startsWith("eq.")) {
      store.seenDateKeys.set(url.pathname, dateKey.slice(3));
    }
    if (url.pathname === "/rest/v1/patients") {
      return Promise.resolve(json(200, store.profile ? [store.profile] : []));
    }
    if (url.pathname === "/rest/v1/patient_diary_entries") {
      return Promise.resolve(json(200, store.entries));
    }
    if (url.pathname === "/rest/v1/patient_water_days") {
      return Promise.resolve(json(200, store.water));
    }
    if (url.pathname === "/rest/v1/patient_target_overrides") {
      return Promise.resolve(json(200, store.overrides));
    }
    if (url.pathname === "/rest/v1/patient_protocol_episodes") {
      return Promise.resolve(json(200, store.episodes));
    }
    if (url.pathname === "/rest/v1/patient_activity_levels") {
      return Promise.resolve(json(200, store.activity));
    }
    return Promise.resolve(json(404, { message: `fake: no route ${url.pathname}` }));
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(resetStore);

describe("isDateKey", () => {
  it("accepts a real calendar date in the sane window", () => {
    expect(isDateKey("2026-08-22")).toBe(true);
    expect(isDateKey("2020-01-01")).toBe(true);
    expect(isDateKey("2035-12-31")).toBe(true);
  });

  it("rejects malformed, impossible, and out-of-window values", () => {
    for (const bad of [
      "2026-8-22",
      "2026-13-01",
      "2026-02-30",
      "2019-12-31",
      "2036-01-01",
      "22-08-2026",
      20260822,
      null,
      undefined,
      "",
    ]) {
      expect(isDateKey(bad), String(bad)).toBe(false);
    }
  });
});

describe("firstNameOf", () => {
  it("takes the first word of the clinical name", () => {
    expect(firstNameOf("Riley Chen")).toBe("Riley");
    expect(firstNameOf("  Ana Maria Ruiz  ")).toBe("Ana");
    expect(firstNameOf("Cher")).toBe("Cher");
  });

  it('falls back to "there" when the row has no usable name', () => {
    expect(firstNameOf("")).toBe("there");
    expect(firstNameOf("   ")).toBe("there");
    expect(firstNameOf(null)).toBe("there");
    expect(firstNameOf(undefined)).toBe("there");
  });
});

describe("programDayFor", () => {
  const profile = (overrides: Partial<PatientProfile> = {}): PatientProfile => ({
    name: "Riley Chen",
    program_start_date: "2026-08-10",
    created_at: "2026-08-01T10:00:00Z",
    ...overrides,
  });

  it("counts days since the program start, enrollment day reading as day 1", () => {
    expect(programDayFor(profile(), "2026-08-10")).toBe(1);
    expect(programDayFor(profile(), "2026-08-22")).toBe(12);
  });

  it("falls back to created_at, then stays at day 1 with no dates at all", () => {
    expect(programDayFor(profile({ program_start_date: null }), "2026-08-22")).toBe(21);
    expect(
      programDayFor(profile({ program_start_date: null, created_at: null }), "2026-08-22"),
    ).toBe(1);
  });

  it("never yields day 0, negatives, garbage, or beyond the clamp", () => {
    expect(programDayFor(profile(), "2026-08-05")).toBe(1);
    expect(programDayFor(profile({ program_start_date: "not-a-date" }), "2026-08-22")).toBe(1);
    expect(programDayFor(profile({ program_start_date: "2020-01-01" }), "2026-08-22")).toBe(2000);
  });
});

describe("realPatientContext", () => {
  it("builds the live context: sums, water, overrides merged over defaults", async () => {
    store.entries = [
      { calories: 300, protein: 30, carbs: 20, fat: 10 },
      { calories: 200.4, protein: 20, carbs: 10, fat: 5 },
    ];
    store.water = [{ oz: 40 }];
    store.overrides = [{ calories: 1400, protein: null, carbs: null, fat: null, water_oz: null }];

    const ctx = await realPatientContext("p-1", "2026-08-22");
    expect(ctx.firstName).toBe("Riley");
    expect(ctx.programDay).toBe(12);
    expect(ctx.phaseName).toBe(phaseNameForDay(12));
    expect(ctx.today).toBeDefined();
    expect(ctx.today!.dateKey).toBe("2026-08-22");
    expect(ctx.today!.calories).toBeCloseTo(500.4, 5);
    expect(ctx.today!.protein).toBe(50);
    expect(ctx.today!.carbs).toBe(30);
    expect(ctx.today!.fat).toBe(15);
    expect(ctx.today!.waterOz).toBe(40);
    // Overridden calories, defaults everywhere the row is null.
    expect(ctx.today!.targets).toEqual({ ...DEFAULT_TARGETS, calories: 1400 });
    // The diary and water lookups were filtered to the requested day.
    expect(store.seenDateKeys.get("/rest/v1/patient_diary_entries")).toBe("2026-08-22");
    expect(store.seenDateKeys.get("/rest/v1/patient_water_days")).toBe("2026-08-22");
  });

  it("reads an untouched day as zeros against pure defaults", async () => {
    const ctx = await realPatientContext("p-1", "2026-08-22");
    expect(ctx.today!.calories).toBe(0);
    expect(ctx.today!.protein).toBe(0);
    expect(ctx.today!.waterOz).toBe(0);
    expect(ctx.today!.targets).toEqual(DEFAULT_TARGETS);
  });

  it("falls back to the server's UTC date when the client sends no usable day", async () => {
    const ctx = await realPatientContext("p-1", "not-a-date");
    expect(ctx.today!.dateKey).toBe(new Date().toISOString().slice(0, 10));
  });

  it("THROWS on lookup failures — never silently grounds on wrong data", async () => {
    store.failOnce.add("patient_diary_entries");
    await expect(realPatientContext("p-1", "2026-08-22")).rejects.toThrow(
      /patient diary lookup failed/,
    );
    store.profile = null;
    await expect(realPatientContext("p-1", "2026-08-22")).rejects.toThrow(
      /patient profile lookup failed/,
    );
  });
});

describe("patientContextLine", () => {
  const base: PatientContext = {
    firstName: "Riley",
    programDay: 12,
    phaseName: phaseNameForDay(12),
  };

  it("stays a single demo-identical line without a today block", () => {
    const line = patientContextLine(base);
    expect(line).toContain("Riley is on day 12");
    expect(line).not.toContain("Today so far");
    expect(line).not.toContain("\n");
  });

  it("adds the live today line with whole-number figures for real accounts", () => {
    const line = patientContextLine({
      ...base,
      today: {
        dateKey: "2026-08-22",
        calories: 500.4,
        protein: 50,
        carbs: 30,
        fat: 15,
        waterOz: 40,
        targets: { ...DEFAULT_TARGETS, calories: 1400 },
      },
    });
    expect(line).toContain("Today so far (2026-08-22)");
    expect(line).toContain("500 of 1400 calories");
    expect(line).toContain("50g of 120g protein");
    expect(line).toContain("30g of 130g carbs");
    expect(line).toContain("15g of 50g fat");
    expect(line).toContain("40 of 64 oz water");
    expect(line).toContain("never invent different ones");
  });
});
