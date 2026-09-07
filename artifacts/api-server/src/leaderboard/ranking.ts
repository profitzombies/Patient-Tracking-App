/**
 * Live office leaderboard: eligibility, scores and ranks.
 *
 * Pure functions over the office's patient rows and the per-patient facts
 * from the `provider_leaderboard_facts` aggregate (one row per patient with
 * period-window activity counts and weight readings, see
 * supabase/migrations/20261001000000_office_leaderboard.sql). Nothing here is
 * invented client-side: every figure a staff member sees on the board is
 * computed by this module from stored signals, and the definition text the
 * pages show comes from `LEADERBOARD_DEFINITIONS` below.
 *
 * Periods
 *   program  program to date: loss from the recorded starting weight to the
 *            newest weigh-in; adherence over every day since program start
 *   30d/90d  rolling window ending on the patient's own local today: loss
 *            from the last reading before the window (starting weight when
 *            there is none) to the newest weigh-in inside it; adherence over
 *            the window's days (or since program start, when later)
 *
 * Eligibility — a patient is ranked only when ALL of these hold:
 *   - activation status is `activated` (not invited/unactivated, paused,
 *     discharged or disabled)
 *   - no pending deletion request
 *   - a starting weight is recorded
 *   - the program has started (at least one eligible day)
 *   - at least one weigh-in on record, and — for a rolling window — at
 *     least one weigh-in inside that window
 * Everyone else is counted under `notRankable` by reason, never as a
 * zero-score row.
 *
 * Adherence (0–100, rounded) over the period's D eligible days:
 *   40% × min(1, logged days / D)
 * + 40% × min(1, check-in days / D)
 * + 20% × min(1, water-goal days / D)
 *
 * Ranks are competition ranks (1, 2, 2, 4): tied values share a rank and the
 * next distinct value skips the shared slots. A metric that is unavailable
 * for a patient (goal completion without a valid goal) sorts after every
 * scored patient and those patients share the trailing rank.
 */

export type LeaderboardPeriod = "program" | "30d" | "90d";
export type LeaderboardMetric = "percent" | "pounds" | "goal" | "adherence";
export type LeaderboardStage = "protocol" | "maintenance";

export const LEADERBOARD_PERIODS: ReadonlyArray<LeaderboardPeriod> = ["program", "30d", "90d"];
export const LEADERBOARD_METRICS: ReadonlyArray<LeaderboardMetric> = ["percent", "pounds", "goal", "adherence"];

/** Rolling-window length per period; null = program to date. */
export const PERIOD_WINDOW_DAYS: Record<LeaderboardPeriod, number | null> = {
  program: null,
  "30d": 30,
  "90d": 90,
};

export const ADHERENCE_WEIGHTS = { logged: 0.4, checkIn: 0.4, water: 0.2 } as const;

export const DEFAULT_WATER_GOAL_OZ = 64;

/** Staff-facing definitions, returned with every leaderboard response. */
export const LEADERBOARD_DEFINITIONS = {
  adherence:
    "Adherence is 40% of days with a food log, 40% of days with a check-in and 20% of days that met the water goal, over the period's days since program start. Scored 0–100 from stored diary, check-in and water records.",
  loss:
    "Pounds and % lost measure from the period baseline to the newest weigh-in. Program to date starts at the recorded starting weight; 30 and 90 day views start at the last weight recorded before the window (the starting weight when there is none). Every figure, program day and stage is measured on each patient's own local day.",
  goal: "Goal completion is pounds lost since the starting weight as a share of the pounds between the starting and goal weights.",
  eligibility:
    "Only activated patients with a starting weight and at least one weigh-in in the period are ranked. Paused, discharged, invited and deletion-requested accounts are counted as not yet rankable.",
  ties: "Tied patients share a rank; the next distinct value skips the shared places.",
} as const;

export type NotRankableReason =
  | "not_activated"
  | "paused"
  | "discharged"
  | "deletion_requested"
  | "no_starting_weight"
  | "program_not_started"
  | "no_weigh_in"
  | "no_weigh_in_in_period"
  | "no_facts";

export const NOT_RANKABLE_LABELS: Record<NotRankableReason, string> = {
  not_activated: "Not yet activated",
  paused: "Paused",
  discharged: "Discharged",
  deletion_requested: "Deletion requested",
  no_starting_weight: "No starting weight",
  program_not_started: "Program not started",
  no_weigh_in: "No weigh-in yet",
  no_weigh_in_in_period: "No weigh-in in this period",
  no_facts: "Activity not loaded",
};

/** Raw counts from the SQL aggregate, one row per patient. */
export interface LeaderboardFactRow {
  patient_id: string;
  provider_id: string;
  as_of_date: string;
  period_start: string;
  eligible_days: number;
  logged_days: number;
  check_in_days: number;
  water_goal_days: number;
  weigh_in_count: number;
  period_weigh_ins: number;
  baseline_weight: number | null;
  baseline_weight_date: string | null;
  latest_weight: number | null;
  latest_weight_date: string | null;
}

/** The slice of a `patients` row the ranking needs. */
export interface LeaderboardPatientInput {
  id: string;
  providerId: string;
  name: string;
  activationStatus: string | null;
  deletionRequested: boolean;
  startingWeight: number | null;
  goalWeight: number | null;
  program: { startDate: string | null; day: number | null; stage: LeaderboardStage | null; week: number | null };
}

export interface AdherenceInput {
  eligibleDays: number;
  loggedDays: number;
  checkInDays: number;
  waterGoalDays: number;
}

export interface AdherenceBreakdown extends AdherenceInput {
  /** 0–100, or null when the period has no eligible days. */
  score: number | null;
  loggedRate: number | null;
  checkInRate: number | null;
  waterRate: number | null;
}

export interface LeaderboardRow {
  id: string;
  providerId: string;
  name: string;
  initials: string;
  program: LeaderboardPatientInput["program"];
  asOfDate: string;
  periodStart: string;
  baselineWeight: number;
  baselineWeightDate: string | null;
  latestWeight: number;
  latestWeightDate: string | null;
  poundsLost: number;
  percentLost: number;
  /** Program-to-date share of the starting→goal gap covered; null without a valid goal. */
  goalCompletion: number | null;
  adherence: AdherenceBreakdown;
  ranks: Record<LeaderboardMetric, number>;
}

export interface LeaderboardResult {
  rows: LeaderboardRow[];
  notRankable: { total: number; reasons: Partial<Record<NotRankableReason, number>> };
}

const rate = (count: number, days: number): number | null => (days > 0 ? Math.min(1, Math.max(0, count / days)) : null);

/** The documented adherence formula; score is null until the program has an eligible day. */
export function computeAdherence(input: AdherenceInput): AdherenceBreakdown {
  const days = Math.max(0, Math.floor(input.eligibleDays));
  const loggedRate = rate(input.loggedDays, days);
  const checkInRate = rate(input.checkInDays, days);
  const waterRate = rate(input.waterGoalDays, days);
  const score =
    loggedRate == null || checkInRate == null || waterRate == null
      ? null
      : Math.round(
          100 * (ADHERENCE_WEIGHTS.logged * loggedRate + ADHERENCE_WEIGHTS.checkIn * checkInRate + ADHERENCE_WEIGHTS.water * waterRate),
        );
  return { ...input, eligibleDays: days, score, loggedRate, checkInRate, waterRate };
}

/** Same derivation the roster tables use, so the two surfaces match letter for letter. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return name.trim().substring(0, 2).toUpperCase();
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Why a patient cannot be ranked for this period, or null when they can.
 * Order matters: account state first, then program facts, then weigh-ins.
 */
export function ineligibilityReason(
  patient: LeaderboardPatientInput,
  fact: LeaderboardFactRow | undefined,
  period: LeaderboardPeriod,
): NotRankableReason | null {
  if (patient.deletionRequested) return "deletion_requested";
  if (patient.activationStatus === "paused") return "paused";
  if (patient.activationStatus === "discharged") return "discharged";
  if (patient.activationStatus !== "activated") return "not_activated";
  if (patient.startingWeight == null || !(patient.startingWeight > 0)) return "no_starting_weight";
  if (!fact) return "no_facts";
  if (fact.eligible_days < 1) return "program_not_started";
  if (fact.weigh_in_count < 1 || fact.latest_weight == null) return "no_weigh_in";
  if (PERIOD_WINDOW_DAYS[period] != null && fact.period_weigh_ins < 1) return "no_weigh_in_in_period";
  return null;
}

function scoreRow(patient: LeaderboardPatientInput, fact: LeaderboardFactRow, period: LeaderboardPeriod): Omit<LeaderboardRow, "ranks"> {
  const startingWeight = patient.startingWeight as number;
  const latestWeight = fact.latest_weight as number;
  const windowed = PERIOD_WINDOW_DAYS[period] != null;
  const baselineWeight = windowed && fact.baseline_weight != null ? fact.baseline_weight : startingWeight;
  const baselineWeightDate = windowed && fact.baseline_weight != null ? fact.baseline_weight_date : null;
  const poundsLost = round1(baselineWeight - latestWeight);
  const percentLost = baselineWeight > 0 ? round1(((baselineWeight - latestWeight) / baselineWeight) * 100) : 0;
  const goalGap = patient.goalWeight != null ? startingWeight - patient.goalWeight : 0;
  const goalCompletion = goalGap > 0 ? Math.round(Math.min(100, Math.max(0, ((startingWeight - latestWeight) / goalGap) * 100))) : null;
  return {
    id: patient.id,
    providerId: patient.providerId,
    name: patient.name,
    initials: initialsOf(patient.name),
    program: patient.program,
    asOfDate: fact.as_of_date,
    periodStart: fact.period_start,
    baselineWeight,
    baselineWeightDate,
    latestWeight,
    latestWeightDate: fact.latest_weight_date,
    poundsLost,
    percentLost,
    goalCompletion,
    adherence: computeAdherence({
      eligibleDays: fact.eligible_days,
      loggedDays: fact.logged_days,
      checkInDays: fact.check_in_days,
      waterGoalDays: fact.water_goal_days,
    }),
  };
}

export function metricValue(row: Omit<LeaderboardRow, "ranks">, metric: LeaderboardMetric): number | null {
  switch (metric) {
    case "percent":
      return row.percentLost;
    case "pounds":
      return row.poundsLost;
    case "goal":
      return row.goalCompletion;
    case "adherence":
      return row.adherence.score;
  }
}

/**
 * Competition ranks for one metric: higher is better, ties share, unavailable
 * values trail. Returns a patient id → rank map.
 */
export function competitionRanks(rows: ReadonlyArray<Omit<LeaderboardRow, "ranks">>, metric: LeaderboardMetric): Map<string, number> {
  const ordered = [...rows].sort((a, b) => {
    const av = metricValue(a, metric);
    const bv = metricValue(b, metric);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
  const ranks = new Map<string, number>();
  let previous: number | null | undefined;
  let previousRank = 0;
  ordered.forEach((row, index) => {
    const value = metricValue(row, metric);
    const tied = index > 0 && value === previous;
    const rankValue = tied ? previousRank : index + 1;
    ranks.set(row.id, rankValue);
    previous = value;
    previousRank = rankValue;
  });
  return ranks;
}

/** Sort order for one metric: rank, then name — the same order for every consumer. */
export function sortByMetric(rows: LeaderboardRow[], metric: LeaderboardMetric): LeaderboardRow[] {
  return [...rows].sort((a, b) => a.ranks[metric] - b.ranks[metric] || a.name.localeCompare(b.name));
}

export interface BuildLeaderboardInput {
  patients: LeaderboardPatientInput[];
  facts: LeaderboardFactRow[];
  period: LeaderboardPeriod;
  /** Optional stage filter; ranks are computed within the filtered set. */
  stage?: LeaderboardStage | null;
}

export function buildLeaderboard({ patients, facts, period, stage }: BuildLeaderboardInput): LeaderboardResult {
  const factsById = new Map(facts.map((fact) => [fact.patient_id, fact]));
  const reasons: Partial<Record<NotRankableReason, number>> = {};
  const scored: Array<Omit<LeaderboardRow, "ranks">> = [];
  let notRankable = 0;
  for (const patient of patients) {
    if (stage && patient.program.stage !== stage) continue;
    const fact = factsById.get(patient.id);
    const reason = ineligibilityReason(patient, fact, period);
    if (reason) {
      notRankable += 1;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      continue;
    }
    scored.push(scoreRow(patient, fact as LeaderboardFactRow, period));
  }
  const rankMaps = Object.fromEntries(LEADERBOARD_METRICS.map((metric) => [metric, competitionRanks(scored, metric)])) as Record<
    LeaderboardMetric,
    Map<string, number>
  >;
  const rows = scored.map((row) => ({
    ...row,
    ranks: Object.fromEntries(LEADERBOARD_METRICS.map((metric) => [metric, rankMaps[metric].get(row.id) as number])) as Record<
      LeaderboardMetric,
      number
    >,
  }));
  return { rows: sortByMetric(rows, "percent"), notRankable: { total: notRankable, reasons } };
}

export function parsePeriod(raw: unknown): LeaderboardPeriod | null {
  if (raw == null || raw === "") return "program";
  return typeof raw === "string" && (LEADERBOARD_PERIODS as ReadonlyArray<string>).includes(raw) ? (raw as LeaderboardPeriod) : null;
}

export function parseStage(raw: unknown): LeaderboardStage | null | undefined {
  if (raw == null || raw === "" || raw === "all") return null;
  return raw === "protocol" || raw === "maintenance" ? raw : undefined;
}
