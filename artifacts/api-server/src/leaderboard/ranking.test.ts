/**
 * Leaderboard definitions, run against crafted facts: the adherence formula,
 * every eligibility rule, period-dependent baselines, goal completion, tie
 * handling and the stage filter.
 */
import { describe, expect, it } from "vitest";
import {
  buildLeaderboard,
  competitionRanks,
  computeAdherence,
  ineligibilityReason,
  initialsOf,
  LEADERBOARD_DEFINITIONS,
  parsePeriod,
  parseStage,
  sortByMetric,
  type LeaderboardFactRow,
  type LeaderboardPatientInput,
} from "./ranking";

function patient(overrides: Partial<LeaderboardPatientInput> & { id: string }): LeaderboardPatientInput {
  return {
    providerId: "office-1",
    name: `Patient ${overrides.id}`,
    activationStatus: "activated",
    deletionRequested: false,
    startingWeight: 200,
    goalWeight: 160,
    program: { startDate: "2026-06-01", day: 40, stage: "protocol", week: 6 },
    ...overrides,
  };
}

function fact(overrides: Partial<LeaderboardFactRow> & { patient_id: string }): LeaderboardFactRow {
  return {
    provider_id: "office-1",
    as_of_date: "2026-09-07",
    period_start: "2026-06-01",
    eligible_days: 99,
    logged_days: 50,
    check_in_days: 20,
    water_goal_days: 30,
    weigh_in_count: 5,
    period_weigh_ins: 5,
    baseline_weight: null,
    baseline_weight_date: null,
    latest_weight: 180,
    latest_weight_date: "2026-09-06",
    ...overrides,
  };
}

describe("computeAdherence", () => {
  it("weights logged, check-in and water rates 40/40/20 and rounds to a whole score", () => {
    const result = computeAdherence({ eligibleDays: 10, loggedDays: 10, checkInDays: 5, waterGoalDays: 0 });
    // 0.4*1 + 0.4*0.5 + 0.2*0 = 0.6
    expect(result.score).toBe(60);
    expect(result.loggedRate).toBe(1);
    expect(result.checkInRate).toBe(0.5);
    expect(result.waterRate).toBe(0);
  });

  it("caps each rate at 100% so duplicate rows cannot exceed a perfect score", () => {
    expect(computeAdherence({ eligibleDays: 4, loggedDays: 9, checkInDays: 9, waterGoalDays: 9 }).score).toBe(100);
  });

  it("has no score before the program has an eligible day", () => {
    const result = computeAdherence({ eligibleDays: 0, loggedDays: 3, checkInDays: 3, waterGoalDays: 3 });
    expect(result.score).toBeNull();
    expect(result.loggedRate).toBeNull();
  });

  it("rounds half up on the 0–100 scale", () => {
    // 0.4 * (1/8) = 0.05 → 5; 0.4*(1/8)+0.4*(1/8) = 0.1 → 10; 0.2*(1/8)=0.025 → 2.5 → 3
    expect(computeAdherence({ eligibleDays: 8, loggedDays: 0, checkInDays: 0, waterGoalDays: 1 }).score).toBe(3);
  });

  it("is described in the definitions staff see", () => {
    expect(LEADERBOARD_DEFINITIONS.adherence).toMatch(/40%.*40%.*20%/);
    expect(LEADERBOARD_DEFINITIONS.adherence).toMatch(/water goal/);
  });
});

describe("ineligibilityReason", () => {
  const ok = fact({ patient_id: "a" });
  it("ranks an activated patient with a starting weight and a weigh-in", () => {
    expect(ineligibilityReason(patient({ id: "a" }), ok, "program")).toBeNull();
  });
  it("names the account-state reasons first", () => {
    expect(ineligibilityReason(patient({ id: "a", deletionRequested: true }), ok, "program")).toBe("deletion_requested");
    expect(ineligibilityReason(patient({ id: "a", activationStatus: "paused" }), ok, "program")).toBe("paused");
    expect(ineligibilityReason(patient({ id: "a", activationStatus: "discharged" }), ok, "program")).toBe("discharged");
    expect(ineligibilityReason(patient({ id: "a", activationStatus: "invited" }), ok, "program")).toBe("not_activated");
    expect(ineligibilityReason(patient({ id: "a", activationStatus: "unactivated" }), ok, "program")).toBe("not_activated");
    expect(ineligibilityReason(patient({ id: "a", activationStatus: null }), ok, "program")).toBe("not_activated");
  });
  it("requires a starting weight, a started program and a weigh-in", () => {
    expect(ineligibilityReason(patient({ id: "a", startingWeight: null }), ok, "program")).toBe("no_starting_weight");
    expect(ineligibilityReason(patient({ id: "a" }), undefined, "program")).toBe("no_facts");
    expect(ineligibilityReason(patient({ id: "a" }), fact({ patient_id: "a", eligible_days: 0 }), "program")).toBe("program_not_started");
    expect(ineligibilityReason(patient({ id: "a" }), fact({ patient_id: "a", weigh_in_count: 0, latest_weight: null }), "program")).toBe("no_weigh_in");
  });
  it("needs a weigh-in inside a rolling window, but any weigh-in for program to date", () => {
    const stale = fact({ patient_id: "a", weigh_in_count: 3, period_weigh_ins: 0 });
    expect(ineligibilityReason(patient({ id: "a" }), stale, "program")).toBeNull();
    expect(ineligibilityReason(patient({ id: "a" }), stale, "30d")).toBe("no_weigh_in_in_period");
    expect(ineligibilityReason(patient({ id: "a" }), stale, "90d")).toBe("no_weigh_in_in_period");
  });
});

describe("buildLeaderboard", () => {
  it("scores program-to-date loss from the starting weight and goal completion from the goal gap", () => {
    const board = buildLeaderboard({
      patients: [patient({ id: "a", startingWeight: 200, goalWeight: 160 })],
      facts: [fact({ patient_id: "a", latest_weight: 180, eligible_days: 10, logged_days: 10, check_in_days: 10, water_goal_days: 10 })],
      period: "program",
    });
    expect(board.notRankable).toEqual({ total: 0, reasons: {} });
    expect(board.rows).toHaveLength(1);
    const row = board.rows[0];
    expect(row.baselineWeight).toBe(200);
    expect(row.poundsLost).toBe(20);
    expect(row.percentLost).toBe(10);
    expect(row.goalCompletion).toBe(50);
    expect(row.adherence.score).toBe(100);
    expect(row.ranks).toEqual({ percent: 1, pounds: 1, goal: 1, adherence: 1 });
    expect(row.initials).toBe("PA");
  });

  it("measures a rolling window from the last reading before it, falling back to the starting weight", () => {
    const facts = [
      fact({ patient_id: "a", baseline_weight: 190, baseline_weight_date: "2026-08-01", latest_weight: 185 }),
      fact({ patient_id: "b", baseline_weight: null, latest_weight: 185 }),
    ];
    const patients = [patient({ id: "a" }), patient({ id: "b" })];
    const windowed = buildLeaderboard({ patients, facts, period: "30d" });
    const byId = new Map(windowed.rows.map((row) => [row.id, row]));
    expect(byId.get("a")).toMatchObject({ baselineWeight: 190, baselineWeightDate: "2026-08-01", poundsLost: 5, percentLost: 2.6 });
    expect(byId.get("b")).toMatchObject({ baselineWeight: 200, baselineWeightDate: null, poundsLost: 15, percentLost: 7.5 });
    // Program to date ignores the pre-window reading entirely.
    const program = buildLeaderboard({ patients, facts, period: "program" });
    expect(program.rows.find((row) => row.id === "a")).toMatchObject({ baselineWeight: 200, poundsLost: 15 });
    // Goal completion stays program-to-date in every period.
    expect(byId.get("a")?.goalCompletion).toBe(Math.round(((200 - 185) / 40) * 100));
  });

  it("counts every ineligible patient under a reason and never as a zero row", () => {
    const board = buildLeaderboard({
      patients: [
        patient({ id: "ranked" }),
        patient({ id: "paused", activationStatus: "paused" }),
        patient({ id: "invited", activationStatus: "invited" }),
        patient({ id: "gone", deletionRequested: true }),
        patient({ id: "noweight", startingWeight: null }),
        patient({ id: "fresh" }),
        patient({ id: "stale" }),
      ],
      facts: [
        fact({ patient_id: "ranked" }),
        fact({ patient_id: "paused" }),
        fact({ patient_id: "invited" }),
        fact({ patient_id: "gone" }),
        fact({ patient_id: "noweight" }),
        fact({ patient_id: "fresh", weigh_in_count: 0, period_weigh_ins: 0, latest_weight: null }),
        fact({ patient_id: "stale", period_weigh_ins: 0 }),
      ],
      period: "30d",
    });
    expect(board.rows.map((row) => row.id)).toEqual(["ranked"]);
    expect(board.notRankable).toEqual({
      total: 6,
      reasons: { paused: 1, not_activated: 1, deletion_requested: 1, no_starting_weight: 1, no_weigh_in: 1, no_weigh_in_in_period: 1 },
    });
  });

  it("gives tied values a shared competition rank and skips the shared places", () => {
    const board = buildLeaderboard({
      patients: [patient({ id: "a" }), patient({ id: "b" }), patient({ id: "c" }), patient({ id: "d" })],
      facts: [
        fact({ patient_id: "a", latest_weight: 180 }),
        fact({ patient_id: "b", latest_weight: 180 }),
        fact({ patient_id: "c", latest_weight: 190 }),
        fact({ patient_id: "d", latest_weight: 170 }),
      ],
      period: "program",
    });
    const rank = (id: string) => board.rows.find((row) => row.id === id)?.ranks.pounds;
    expect(rank("d")).toBe(1);
    expect(rank("a")).toBe(2);
    expect(rank("b")).toBe(2);
    expect(rank("c")).toBe(4);
    // Default order is % lost rank, then name.
    expect(board.rows.map((row) => row.id)).toEqual(["d", "a", "b", "c"]);
  });

  it("ranks each metric independently and trails patients without a goal", () => {
    const board = buildLeaderboard({
      patients: [
        patient({ id: "heavy", startingWeight: 300, goalWeight: 250 }),
        patient({ id: "light", startingWeight: 150, goalWeight: 140 }),
        patient({ id: "nogoal", startingWeight: 200, goalWeight: null }),
      ],
      facts: [
        fact({ patient_id: "heavy", latest_weight: 285, logged_days: 0, check_in_days: 0, water_goal_days: 0 }),
        fact({ patient_id: "light", latest_weight: 140, logged_days: 99, check_in_days: 99, water_goal_days: 99 }),
        fact({ patient_id: "nogoal", latest_weight: 190, logged_days: 50, check_in_days: 50, water_goal_days: 50 }),
      ],
      period: "program",
    });
    const byId = new Map(board.rows.map((row) => [row.id, row]));
    // pounds: heavy 15, nogoal 10, light 10 (tie)
    expect(byId.get("heavy")?.ranks.pounds).toBe(1);
    expect(byId.get("nogoal")?.ranks.pounds).toBe(2);
    expect(byId.get("light")?.ranks.pounds).toBe(2);
    // percent: light 6.7, heavy 5, nogoal 5 (tie)
    expect(byId.get("light")?.ranks.percent).toBe(1);
    expect(byId.get("heavy")?.ranks.percent).toBe(2);
    expect(byId.get("nogoal")?.ranks.percent).toBe(2);
    // goal: light 100, heavy 30, nogoal unavailable → trails
    expect(byId.get("light")?.ranks.goal).toBe(1);
    expect(byId.get("heavy")?.ranks.goal).toBe(2);
    expect(byId.get("nogoal")?.goalCompletion).toBeNull();
    expect(byId.get("nogoal")?.ranks.goal).toBe(3);
    // adherence: light 100, nogoal 51, heavy 0
    expect(byId.get("light")?.ranks.adherence).toBe(1);
    expect(byId.get("nogoal")?.ranks.adherence).toBe(2);
    expect(byId.get("heavy")?.ranks.adherence).toBe(3);
    expect(sortByMetric(board.rows, "adherence").map((row) => row.id)).toEqual(["light", "nogoal", "heavy"]);
  });

  it("clamps goal completion to 0–100 and reports gains as negative loss", () => {
    const board = buildLeaderboard({
      patients: [patient({ id: "over", startingWeight: 200, goalWeight: 190 }), patient({ id: "gain", startingWeight: 200, goalWeight: 190 })],
      facts: [fact({ patient_id: "over", latest_weight: 170 }), fact({ patient_id: "gain", latest_weight: 205 })],
      period: "program",
    });
    const byId = new Map(board.rows.map((row) => [row.id, row]));
    expect(byId.get("over")?.goalCompletion).toBe(100);
    expect(byId.get("gain")).toMatchObject({ poundsLost: -5, percentLost: -2.5, goalCompletion: 0 });
  });

  it("applies the stage filter before ranking so ranks are within the filtered set", () => {
    const board = buildLeaderboard({
      patients: [
        patient({ id: "p1", program: { startDate: "2026-08-01", day: 10, stage: "protocol", week: 2 } }),
        patient({ id: "m1", program: { startDate: "2026-01-01", day: 250, stage: "maintenance", week: null } }),
        patient({ id: "m2", program: { startDate: "2026-01-01", day: 250, stage: "maintenance", week: null } }),
      ],
      facts: [fact({ patient_id: "p1", latest_weight: 150 }), fact({ patient_id: "m1", latest_weight: 180 }), fact({ patient_id: "m2", latest_weight: 190 })],
      period: "program",
      stage: "maintenance",
    });
    expect(board.rows.map((row) => [row.id, row.ranks.pounds])).toEqual([["m1", 1], ["m2", 2]]);
    // The filtered-out protocol patient is neither ranked nor "not rankable".
    expect(board.notRankable.total).toBe(0);
  });
});

describe("competitionRanks", () => {
  it("handles an empty board", () => {
    expect(competitionRanks([], "percent").size).toBe(0);
  });
});

describe("initialsOf", () => {
  it("matches the roster derivation: first + last initial, or the first two letters", () => {
    expect(initialsOf("Casey Ortiz")).toBe("CO");
    expect(initialsOf("Mary Ann van der Berg")).toBe("MB");
    expect(initialsOf("Cher")).toBe("CH");
  });
});

describe("query parsing", () => {
  it("defaults the period to program to date and rejects unknown values", () => {
    expect(parsePeriod(undefined)).toBe("program");
    expect(parsePeriod("")).toBe("program");
    expect(parsePeriod("30d")).toBe("30d");
    expect(parsePeriod("90d")).toBe("90d");
    expect(parsePeriod("7d")).toBeNull();
    expect(parsePeriod(["30d"])).toBeNull();
  });
  it("treats a missing or 'all' stage as no filter and rejects unknown stages", () => {
    expect(parseStage(undefined)).toBeNull();
    expect(parseStage("all")).toBeNull();
    expect(parseStage("protocol")).toBe("protocol");
    expect(parseStage("maintenance")).toBe("maintenance");
    expect(parseStage("week-3")).toBeUndefined();
  });
});
