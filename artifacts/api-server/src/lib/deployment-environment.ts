/**
 * Published-app guard: the deployment must never start on development
 * settings. See replit.md → "Production vs development".
 *
 * Development values live in `.replit` → `[userenv.development]` and the
 * `DEV_*` secrets; the published app reads production values from
 * `[userenv.production]` and Publishing → Production app secrets. If a
 * development value ever reaches a deployment (`REPLIT_DEPLOYMENT=1`), the
 * server refuses to start. A failed publish keeps the previous version
 * serving; a started one would sign real staff into the development project
 * and put production uploads under development storage.
 *
 * The workspace has the mirror-image guard in `scripts/dev-environment.mjs`
 * (refuses the production project), which deployments skip.
 */
export const DEVELOPMENT_SUPABASE_REF = "hempvunqnyutzbrgcaqr";
export const DEVELOPMENT_BILLING_DEPLOYMENT_ID = "thinnr-development";

const SUPABASE_URL_KEYS = ["SUPABASE_URL", "VITE_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_URL"] as const;
/** Development storage is the `dev/` prefix beside production's `.private/` in each bucket: `/<bucket>/dev/…`. */
const OBJECT_DIR_KEYS = ["PRIVATE_OBJECT_DIR", "TRAINING_OBJECT_DIR"] as const;

/** Names of the settings that carry a development value. Empty outside a deployment. */
export function developmentSettingsInDeployment(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.REPLIT_DEPLOYMENT !== "1") return [];
  const found: string[] = [];
  for (const key of SUPABASE_URL_KEYS) {
    if ((env[key] ?? "").includes(DEVELOPMENT_SUPABASE_REF)) found.push(key);
  }
  for (const key of OBJECT_DIR_KEYS) {
    if ((env[key] ?? "").split("/").filter(Boolean)[1] === "dev") found.push(key);
  }
  if ((env.BILLING_DEPLOYMENT_ID ?? "").trim() === DEVELOPMENT_BILLING_DEPLOYMENT_ID) found.push("BILLING_DEPLOYMENT_ID");
  return found;
}
