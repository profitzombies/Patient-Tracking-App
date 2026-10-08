/**
 * Development-only process preload: keeps every Node process in the workspace
 * on the DEVELOPMENT Supabase project and away from production.
 *
 * Loaded through `NODE_OPTIONS=--import /home/runner/workspace/scripts/dev-environment.mjs`,
 * which is set in the development environment only (`.replit` →
 * `[userenv.development]`). The published app never sets it, so this file
 * never runs in production. See replit.md → "Production vs development".
 *
 * 1. Secret mapping. The shared secrets keep their PRODUCTION values (the
 *    deployment reads them unchanged). Development values live in DEV_*
 *    secrets; this preload copies each DEV_* value over the canonical name
 *    for the current process (and its children). When a DEV_* value is
 *    missing, the canonical name is removed instead of falling back to the
 *    production value, so a half-configured workspace fails loudly instead of
 *    writing into production.
 * 2. Production guard. If any Supabase URL in this process still points at
 *    the production project, the process exits before running any code.
 *    Production is reached from the workspace only through the management
 *    API with the production project ref spelled out explicitly.
 */

const PRODUCTION_SUPABASE_REF = "xkdhmqexlvkipwgkaiyk";

const DEV_SECRET_MAP = {
  DEV_SUPABASE_SERVICE_ROLE_KEY: "SUPABASE_SERVICE_ROLE_KEY",
  DEV_STRIPE_TEST_PLATFORM_WEBHOOK_SECRET: "STRIPE_TEST_PLATFORM_WEBHOOK_SECRET",
  DEV_STRIPE_TEST_CONNECT_WEBHOOK_SECRET: "STRIPE_TEST_CONNECT_WEBHOOK_SECRET",
};

/**
 * Shared settings that only the published app may use. Unset in development:
 * - BILLING_PUBLIC_ORIGIN holds the PUBLISHED address, so the server falls
 *   back to the workspace's own domain (Stripe return links point back at the
 *   workspace, not at app.trythinnr.com).
 * - WAREHOUSECRAFT_* hold the LIVE warehouse tenant: its login and the
 *   WAREHOUSECRAFT_TENANT_MODE flag. The server treats the tenant as live only
 *   when the flag and the complete login are both set, and each tenant signs in
 *   with its own login only. With them stripped, development always uses the
 *   NOVEX_* test-tenant login, so the workspace can never submit a real order.
 */
const PRODUCTION_ONLY_SECRETS = [
  "BILLING_PUBLIC_ORIGIN",
  "WAREHOUSECRAFT_TENANT_MODE",
  "WAREHOUSECRAFT_API_BASE_URL",
  "WAREHOUSECRAFT_API_USERNAME",
  "WAREHOUSECRAFT_API_PASSWORD",
];

const SUPABASE_URL_KEYS = ["SUPABASE_URL", "VITE_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_URL"];

export function applyDevelopmentEnvironment(env = process.env) {
  if (env.REPLIT_DEPLOYMENT === "1") return { applied: false, reason: "deployment" };
  for (const [from, to] of Object.entries(DEV_SECRET_MAP)) {
    const value = (env[from] ?? "").trim();
    if (value) env[to] = value;
    else delete env[to];
  }
  for (const key of PRODUCTION_ONLY_SECRETS) delete env[key];
  const leaking = SUPABASE_URL_KEYS.filter((key) => (env[key] ?? "").includes(PRODUCTION_SUPABASE_REF));
  return { applied: true, leaking };
}

const outcome = applyDevelopmentEnvironment();
if (outcome.applied && outcome.leaking.length > 0) {
  process.stderr.write(
    `dev-environment: refusing to start — ${outcome.leaking.join(", ")} points at the PRODUCTION Supabase project. ` +
      "Development must use the development project (see replit.md → Production vs development).\n",
  );
  process.exit(78);
}
