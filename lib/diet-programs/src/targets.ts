/**
 * Goal + BMR target calculator — pure, shared by the API and the app.
 *
 * Diet choice has NO effect here. Targets come from the patient's body
 * numbers, goal weight, activity level and program phase:
 *
 *  - BMR by Mifflin-St Jeor (kcal/day), maintenance level = BMR × activity.
 *  - Protocol days 1-2 are the loading days (≥ 4,000 kcal per the manual).
 *  - Protocol days 3-42: lose → maintenance − 750 (floored at 1,200 female /
 *    1,500 male), hold → maintenance, gain → maintenance + 300.
 *  - Maintenance (Metabolic Normalization Phase): calories step up by
 *    100 kcal every 7 maintenance days from the day-42 level toward the
 *    maintenance level, then hold there so weight stays steady. Patients who
 *    were never on the protocol (GLP-1 / tracking only) start at the goal
 *    level directly.
 *  - Macros: protocol 35 / 35 / 30, maintenance 30 / 40 / 30 (protein /
 *    carbs / fat, percent of calories). Water max(64 oz, weight lb ÷ 2),
 *    capped at 128 oz.
 *  - Patient overrides win field by field.
 */
import type { ActivityLevel } from "./vocabulary";
import type { ProgramPhase } from "./phase";

export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export const LOADING_DAY_CALORIES = 4000;
export const PROTOCOL_DEFICIT = 750;
export const GAIN_SURPLUS = 300;
export const MAINTENANCE_STEP_CALORIES = 100;
export const MAINTENANCE_STEP_DAYS = 7;
export const CALORIE_FLOOR: Record<"male" | "female", number> = { female: 1200, male: 1500 };
/** Goal weights within this band of the current weight read as "hold". */
export const HOLD_BAND_LB = 2;

export type GoalDirection = "lose" | "hold" | "gain";

export interface TargetInput {
  gender: "male" | "female" | null | undefined;
  ageYears: number | null | undefined;
  heightInches: number | null | undefined;
  weightLb: number | null | undefined;
  goalWeightLb: number | null | undefined;
  activityLevel: ActivityLevel | null | undefined;
  phase: ProgramPhase;
  /** Day N of the current protocol episode (1-based). */
  programDay: number;
  /** 1 on the first maintenance day, 0 during the protocol. */
  maintenanceDay: number;
  /** Whether the patient finished the protocol before maintenance (thinnr program) or never ran it. */
  cameFromProtocol?: boolean;
}

export interface DayTargets {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  waterOz: number;
}

export interface TargetOverrides {
  calories?: number | null;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
  waterOz?: number | null;
}

export interface CalculatedTargets {
  /** Targets before overrides. */
  calculated: DayTargets;
  /** Targets after patient overrides (what the app shows). */
  effective: DayTargets;
  /** Which fields the patient overrode. */
  overridden: Array<keyof DayTargets>;
  bmr: number | null;
  maintenanceCalories: number | null;
  goalDirection: GoalDirection;
  /** Step index reached in the maintenance ramp (0 while still in protocol). */
  rampStep: number;
  /** True while the ramp has not yet reached the maintenance level. */
  ramping: boolean;
  /** Which inputs were missing, so the UI can ask for them. */
  missing: Array<"gender" | "age" | "height" | "weight" | "activityLevel">;
}

/** Fallback used only when body numbers are missing (mirrors the app's historical defaults). */
export const FALLBACK_TARGETS: DayTargets = { calories: 1500, protein: 120, carbs: 130, fat: 50, waterOz: 64 };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Mifflin-St Jeor, inputs in pounds / inches / years. */
export function mifflinStJeor(gender: "male" | "female", ageYears: number, heightInches: number, weightLb: number): number {
  const kg = weightLb * 0.45359237;
  const cm = heightInches * 2.54;
  const base = 10 * kg + 6.25 * cm - 5 * ageYears;
  return Math.round(gender === "male" ? base + 5 : base - 161);
}

export function goalDirectionFor(weightLb: number | null | undefined, goalWeightLb: number | null | undefined): GoalDirection {
  if (!finite(weightLb) || !finite(goalWeightLb)) return "lose";
  if (goalWeightLb < weightLb - HOLD_BAND_LB) return "lose";
  if (goalWeightLb > weightLb + HOLD_BAND_LB) return "gain";
  return "hold";
}

export function ageFromDateOfBirth(dateOfBirth: string | null | undefined, todayKey: string): number | null {
  if (!dateOfBirth) return null;
  const dob = String(dateOfBirth).slice(0, 10);
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = todayKey.slice(0, 10).split("-").map(Number);
  if (![y, m, d, ty, tm, td].every(Number.isFinite)) return null;
  let age = ty - y;
  if (tm < m || (tm === m && td < d)) age -= 1;
  return age >= 0 && age <= 130 ? age : null;
}

function goalCalories(maintenance: number, direction: GoalDirection, gender: "male" | "female"): number {
  if (direction === "lose") return Math.max(CALORIE_FLOOR[gender], maintenance - PROTOCOL_DEFICIT);
  if (direction === "gain") return maintenance + GAIN_SURPLUS;
  return maintenance;
}

function macrosFor(calories: number, phase: ProgramPhase, weightLb: number | null): Pick<DayTargets, "protein" | "carbs" | "fat"> {
  const split = phase === "protocol" ? { p: 0.35, c: 0.35, f: 0.3 } : { p: 0.3, c: 0.4, f: 0.3 };
  return {
    protein: Math.round((calories * split.p) / 4),
    carbs: Math.round((calories * split.c) / 4),
    fat: Math.round((calories * split.f) / 9),
  };
}

function waterFor(weightLb: number | null): number {
  if (!weightLb) return 64;
  return Math.min(128, Math.max(64, Math.round(weightLb / 2)));
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** Pure calculation; see the module comment for the rules. */
export function calculateTargets(input: TargetInput, overrides: TargetOverrides = {}): CalculatedTargets {
  const missing: CalculatedTargets["missing"] = [];
  if (input.gender !== "male" && input.gender !== "female") missing.push("gender");
  if (!finite(input.ageYears)) missing.push("age");
  if (!finite(input.heightInches)) missing.push("height");
  if (!finite(input.weightLb)) missing.push("weight");
  if (!input.activityLevel || !(input.activityLevel in ACTIVITY_FACTORS)) missing.push("activityLevel");

  const direction = goalDirectionFor(input.weightLb, input.goalWeightLb);
  const weight = finite(input.weightLb) ? input.weightLb : null;
  let calculated: DayTargets;
  let bmr: number | null = null;
  let maintenance: number | null = null;
  let rampStep = 0;
  let ramping = false;

  if (missing.length === 0) {
    const gender = input.gender as "male" | "female";
    bmr = mifflinStJeor(gender, input.ageYears as number, input.heightInches as number, input.weightLb as number);
    maintenance = roundTo(bmr * ACTIVITY_FACTORS[input.activityLevel as ActivityLevel], 10);
    const goal = roundTo(goalCalories(maintenance, direction, gender), 10);
    let calories: number;
    if (input.phase === "protocol") {
      calories = input.programDay <= 2 ? LOADING_DAY_CALORIES : goal;
    } else {
      // Normalization: raise intake step by step from the protocol level to the
      // maintenance level. Patients who never ran the protocol start at goal.
      // The ramp's ceiling is the goal level (maintenance for "hold", the
      // deficit for a patient still losing, the surplus for "gain").
      const fromProtocol = input.cameFromProtocol ?? true;
      const start = fromProtocol ? roundTo(goalCalories(maintenance, "lose", gender), 10) : goal;
      rampStep = Math.max(0, Math.floor((Math.max(1, input.maintenanceDay) - 1) / MAINTENANCE_STEP_DAYS));
      const stepped = start + rampStep * MAINTENANCE_STEP_CALORIES;
      calories = Math.min(stepped, Math.max(goal, start));
      ramping = calories < goal;
    }
    calculated = { calories, ...macrosFor(calories, input.phase, weight), waterOz: waterFor(weight) };
  } else {
    calculated = { ...FALLBACK_TARGETS, waterOz: waterFor(weight) };
  }

  const effective: DayTargets = { ...calculated };
  const overridden: Array<keyof DayTargets> = [];
  for (const key of ["calories", "protein", "carbs", "fat", "waterOz"] as const) {
    const value = overrides[key];
    if (finite(value)) {
      effective[key] = Math.round(value);
      overridden.push(key);
    }
  }
  return { calculated, effective, overridden, bmr, maintenanceCalories: maintenance, goalDirection: direction, rampStep, ramping, missing };
}
