/**
 * Body-area vocabulary for staff-recorded measurement visits.
 *
 * ONE ordered list drives the API contract (wire keys), the storage columns
 * on patient_body_measurements, and the validation range. The web and mobile
 * apps each carry a mirror of the same keys/labels; keep the three in
 * lockstep when adding or renaming an area (the migration must add the
 * column first).
 */
export const BODY_AREAS = [
  { key: "neck", column: "neck", label: "Neck" },
  { key: "chest", column: "chest", label: "Chest" },
  { key: "leftArm", column: "left_arm", label: "Left arm" },
  { key: "rightArm", column: "right_arm", label: "Right arm" },
  { key: "waist", column: "waist", label: "Waist" },
  { key: "hips", column: "hips", label: "Hips" },
  { key: "leftThigh", column: "left_thigh", label: "Left thigh" },
  { key: "rightThigh", column: "right_thigh", label: "Right thigh" },
  { key: "leftCalf", column: "left_calf", label: "Left calf" },
  { key: "rightCalf", column: "right_calf", label: "Right calf" },
] as const;

export type BodyAreaKey = (typeof BODY_AREAS)[number]["key"];
export type BodyMeasurementValues = Partial<Record<BodyAreaKey, number>>;

/** Plausible tape-measure range in inches for any single area. */
export const INCHES_MIN = 1;
export const INCHES_MAX = 120;

export const MEASUREMENT_COLUMNS = BODY_AREAS.map((area) => area.column).join(",");

/**
 * Positive, at most one decimal, inside the plausible range. Returns the
 * normalized value (rounded to a tenth) or a field message.
 */
export function inchesIssue(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Enter the measurement in inches.";
  if (value <= 0) return "Measurements must be greater than zero.";
  if (Math.abs(Math.round(value * 10) - value * 10) > 1e-6) return "Use at most one decimal place.";
  if (value < INCHES_MIN || value > INCHES_MAX) return `Measurements must be between ${INCHES_MIN} and ${INCHES_MAX} inches.`;
  return null;
}
