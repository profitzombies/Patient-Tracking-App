/**
 * vitest setup for the api-server package (see vitest.config.ts).
 *
 * The coach usage limiter reserves its slots in Supabase whenever the
 * service-role credentials are configured — and the workspace env carries
 * them — so route suites would otherwise meter themselves against the live
 * project (or a suite's fake, which knows nothing of the usage RPCs). Pin
 * the process-local store here; suites that test the database store build
 * it explicitly.
 */
if (!process.env.COACH_LIMITS_STORE) process.env.COACH_LIMITS_STORE = "memory";
