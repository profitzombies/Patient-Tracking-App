/**
 * Per-surface model knobs.
 *
 * Every AI surface names its model through here, so a tier change is one
 * environment variable per surface (staging can point one surface at a
 * cheaper or broken model without touching the others) and the default is
 * always what production ships today. Knobs are read at call time, not
 * import time, so an override applied by a restart is honored and tests can
 * stub the environment.
 *
 * Tier decisions are made by harness evidence, never by this file: see
 * docs/ai-model-tiers.md for the recorded coach-chat and meal-photo runs.
 * The photo, label, and menu surfaces stay on their defaults by rule —
 * lower tiers degraded real plate reads (2026-08).
 */

export const AI_SURFACES = [
  "coach.chat",
  "coach.recipe",
  "coach.meal_makeover",
  "coach.back_on_track",
  "coach.title",
  "coach.meal_photo",
  "coach.photo_classify",
  "coach.safety_screen",
  "coach.menu_scan",
  "coach.label_scan",
  "coach.recipe_image",
  "support.chat",
  "knowledge.summary",
] as const;

export type AiSurface = (typeof AI_SURFACES)[number];

/** Production defaults per surface (the current models, unchanged). */
export const DEFAULT_MODELS: Record<AiSurface, string> = {
  "coach.chat": "gpt-5.6-terra",
  "coach.recipe": "gpt-5.6-terra",
  "coach.meal_makeover": "gpt-5.6-terra",
  "coach.back_on_track": "gpt-5.6-terra",
  "coach.title": "gpt-5-nano",
  "coach.meal_photo": "gpt-5.6-luna",
  "coach.photo_classify": "gpt-5-nano",
  "coach.safety_screen": "gpt-5-nano",
  "coach.menu_scan": "gpt-5-nano",
  "coach.label_scan": "gpt-5-nano",
  "coach.recipe_image": "gpt-image-1",
  "support.chat": "gpt-5.6-terra",
  "knowledge.summary": "gpt-5-nano",
};

/** Environment variable that overrides one surface: `AI_MODEL_COACH_CHAT`, ... */
export function modelKnobName(surface: AiSurface): string {
  return `AI_MODEL_${surface.toUpperCase().replace(/[.\-]/g, "_")}`;
}

/**
 * The model a surface should call right now: its knob when set to a
 * non-blank value, otherwise the production default. A blank knob is the
 * same as an unset one (an empty string must never become a model name).
 */
export function modelFor(surface: AiSurface, env: NodeJS.ProcessEnv = process.env): string {
  const override = (env[modelKnobName(surface)] ?? "").trim();
  return override.length > 0 ? override : DEFAULT_MODELS[surface];
}

/** Every surface with its active model — for the startup log and HQ. */
export function modelAssignments(env: NodeJS.ProcessEnv = process.env): { surface: AiSurface; model: string; overridden: boolean }[] {
  return AI_SURFACES.map((surface) => {
    const model = modelFor(surface, env);
    return { surface, model, overridden: model !== DEFAULT_MODELS[surface] };
  });
}
