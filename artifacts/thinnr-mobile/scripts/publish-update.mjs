#!/usr/bin/env node
/**
 * Publish an over-the-air (OTA) update with the SAME configuration a build of
 * that profile would carry, and only when a build exists that can run it.
 *
 *   pnpm --filter @workspace/thinnr-mobile run release:update <profile> --message "…" [extra eas update flags]
 *
 * Why a wrapper instead of a bare `eas update`:
 *
 *   • The JS bundle reads EXPO_PUBLIC_DOMAIN (API origin) and
 *     EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY (sign-in)
 *     at bundle time. `eas build` gets them from the profile's `env` block in
 *     eas.json plus the EAS environment named by the profile's `environment`
 *     field; `eas update` applies NEITHER unless told to. A bundle published
 *     without them throws "EXPO_PUBLIC_DOMAIN is not set" on every phone.
 *   • `eas update` happily publishes a bundle whose runtime version
 *     (fingerprint of the native code) matches NO build on the channel. It
 *     prints a warning, nothing more — and no phone ever receives the update,
 *     so the fix silently never ships. That situation means a store build is
 *     required instead.
 *
 * This script therefore:
 *
 *   1. checks the project is linked to EAS (app.json extra.eas.projectId from
 *      `eas init --id …`, or EAS_PROJECT_ID in the environment);
 *   2. reads eas.json and applies the profile's `env` (and base `env`) to the
 *      process, exactly like a build of that profile;
 *   3. checks the profile's EAS environment defines every variable the bundle
 *      needs (`eas env:list`) and stops if one is missing;
 *   4. resolves the runtime version this checkout would produce for each
 *      platform (`expo-updates runtimeversion:resolve`, with the profile env
 *      applied, because TAP_TO_PAY_ENABLED changes the native fingerprint) and
 *      confirms a finished build with that runtime version exists on the
 *      profile's channel (`eas build:list`); stops with "store build required"
 *      otherwise;
 *   5. runs `eas update --channel <profile channel> --environment <profile
 *      environment>` so the server-side variables are loaded for the export.
 *
 * Escape hatches, each printed loudly: `--skip-env-check` if `eas env:list`
 * itself is unavailable, `--skip-build-check` if `eas build:list` is (for
 * example a brand-new project whose first build is still running).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILES = ["development", "preview", "production"];
const PLATFORMS = ["ios", "android"];
const PUBLISHED_API_DOMAIN = "app.trythinnr.com";
/** Variables the JS bundle must find at export time (beyond the eas.json profile env). */
export const REQUIRED_ENVIRONMENT_VARIABLES = [
  "EXPO_PUBLIC_SUPABASE_URL",
  "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
];
/** Only needed in the EAS environment when app.json carries no project id. */
export const PROJECT_ID_VARIABLE = "EAS_PROJECT_ID";

function fail(message) {
  console.error(`\nrelease:update stopped — ${message}`);
  process.exit(1);
}

export function profileEnvironment(easJson, profile) {
  const build = easJson.build?.[profile];
  if (!build) throw new Error(`eas.json has no build profile "${profile}"`);
  const chain = [];
  for (let cursor = build; cursor; cursor = cursor.extends ? easJson.build[cursor.extends] : null) chain.unshift(cursor);
  const env = Object.assign({}, ...chain.map((p) => p.env ?? {}));
  return { channel: build.channel, environment: build.environment, env };
}

/** The project id `eas init` wrote into app.json, or null when the project is not linked yet. */
export function committedProjectId(appJson) {
  const id = appJson?.expo?.extra?.eas?.projectId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Which variables the profile's EAS environment must define: the Supabase
 * pair always, and the project id only when app.json does not carry it.
 */
export function requiredEnvironmentVariables({ projectIdCommitted }) {
  return projectIdCommitted ? [...REQUIRED_ENVIRONMENT_VARIABLES] : [PROJECT_ID_VARIABLE, ...REQUIRED_ENVIRONMENT_VARIABLES];
}

export function missingEnvironmentVariables(envListOutput, required = REQUIRED_ENVIRONMENT_VARIABLES) {
  return required.filter((name) => !new RegExp(`(^|[^A-Z0-9_])${name}([^A-Z0-9_]|$)`, "m").test(envListOutput));
}

/** Parses `expo-updates runtimeversion:resolve` output (JSON, possibly after log lines). */
export function parseRuntimeVersion(output) {
  const start = output.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(output.slice(start));
    return typeof parsed.runtimeVersion === "string" && parsed.runtimeVersion ? parsed.runtimeVersion : null;
  } catch {
    return null;
  }
}

/** Parses `eas build:list --json` output into the number of builds returned. */
export function finishedBuildCount(output) {
  const start = output.search(/[[{]/);
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(output.slice(start));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.builds) ? parsed.builds : null;
    return list ? list.length : null;
  } catch {
    return null;
  }
}

/** Platforms an update targets: `--platform ios|android|all` (default all). */
export function targetPlatforms(args) {
  const index = args.findIndex((arg) => arg === "--platform" || arg === "-p");
  const inline = args.find((arg) => arg.startsWith("--platform="));
  const value = index >= 0 ? args[index + 1] : inline ? inline.slice("--platform=".length) : "all";
  if (value === "all" || value === undefined) return [...PLATFORMS];
  if (!PLATFORMS.includes(value)) throw new Error(`--platform must be ios, android or all (got "${value}")`);
  return [value];
}

/** `eas` when the CLI is installed globally, otherwise `npx eas-cli` (same as the guide's alternative). */
function easCommand() {
  const probe = spawnSync("eas", ["--version"], { cwd: root, stdio: "ignore" });
  return probe.error ? ["npx", "--yes", "eas-cli"] : ["eas"];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8", env: options.env ?? process.env });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  return result;
}

function runEas(easArgs, options = {}) {
  const [command, ...prefix] = easCommand();
  return run(command, [...prefix, ...easArgs], options);
}

function main(argv) {
  const [profile, ...rest] = argv;
  if (!PROFILES.includes(profile)) fail(`first argument must be one of ${PROFILES.join(", ")} (got "${profile ?? ""}")`);
  const skipEnvCheck = rest.includes("--skip-env-check");
  const skipBuildCheck = rest.includes("--skip-build-check");
  const passthrough = rest.filter((arg) => arg !== "--skip-env-check" && arg !== "--skip-build-check");
  if (!passthrough.includes("--message") && !passthrough.some((arg) => arg.startsWith("--message=")) && !passthrough.includes("-m")) {
    fail('a --message "…" describing the fix is required');
  }
  if (passthrough.some((arg) => arg === "--channel" || arg.startsWith("--channel=") || arg === "--environment" || arg.startsWith("--environment=") || arg === "--branch" || arg.startsWith("--branch="))) {
    fail("channel, branch and environment come from the profile; do not pass them");
  }
  let platforms;
  try {
    platforms = targetPlatforms(passthrough);
  } catch (error) {
    fail(error.message);
  }

  const eas = JSON.parse(readFileSync(resolve(root, "eas.json"), "utf8"));
  const appJson = JSON.parse(readFileSync(resolve(root, "app.json"), "utf8"));
  const { channel, environment, env } = profileEnvironment(eas, profile);
  if (!channel || !environment) fail(`profile "${profile}" needs both "channel" and "environment" in eas.json`);
  if (env.EXPO_PUBLIC_DOMAIN !== PUBLISHED_API_DOMAIN) fail(`profile "${profile}" must pin EXPO_PUBLIC_DOMAIN to ${PUBLISHED_API_DOMAIN} (got "${env.EXPO_PUBLIC_DOMAIN ?? ""}")`);
  const childEnv = { ...process.env, ...env };

  const projectId = committedProjectId(appJson);
  const projectIdFromEnv = (process.env[PROJECT_ID_VARIABLE] || "").trim();
  if (!projectId && !projectIdFromEnv) {
    fail(`the project is not linked to EAS yet: app.json has no extra.eas.projectId and ${PROJECT_ID_VARIABLE} is not set. From artifacts/thinnr-mobile run "eas init --id <Project ID from expo.dev>" once and commit the app.json change (docs/mobile-release.md § 1).`);
  }
  const required = requiredEnvironmentVariables({ projectIdCommitted: !!projectId });

  console.log(`Publishing an OTA update for profile "${profile}" (channel ${channel}, EAS environment ${environment}, platforms ${platforms.join("+")}).`);
  console.log(`  project id: ${projectId ? `${projectId} (app.json)` : `${projectIdFromEnv} (${PROJECT_ID_VARIABLE})`}`);
  console.log(`  bundle-time env from eas.json: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")}`);

  if (skipEnvCheck) {
    console.warn(`  WARNING: skipping the check that the "${environment}" EAS environment defines ${required.join(", ")}.`);
  } else {
    const list = runEas(["env:list", "--environment", environment, "--format", "short"], { capture: true, env: childEnv });
    if (list.status !== 0) fail(`"eas env:list --environment ${environment}" failed (exit ${list.status}); sign in (eas login / EXPO_TOKEN) and retry`);
    const missing = missingEnvironmentVariables(list.stdout ?? "", required);
    if (missing.length) {
      fail(`the "${environment}" EAS environment is missing ${missing.join(", ")}. Add them at expo.dev → project → Environment variables (see docs/mobile-release.md § Secrets and environment variables) and retry.`);
    }
    console.log(`  ok  "${environment}" environment defines ${required.join(", ")}`);
  }

  if (skipBuildCheck) {
    console.warn(`  WARNING: skipping the check that a finished ${channel} build can run this update; phones only receive it if one exists.`);
  } else {
    for (const platform of platforms) {
      const resolved = run("npx", ["expo-updates", "runtimeversion:resolve", "--platform", platform], { capture: true, env: { ...childEnv, CI: "1" } });
      const runtimeVersion = resolved.status === 0 ? parseRuntimeVersion(resolved.stdout ?? "") : null;
      if (!runtimeVersion) fail(`could not resolve the ${platform} runtime version (expo-updates runtimeversion:resolve exit ${resolved.status})`);
      const builds = runEas(["build:list", "--platform", platform, "--channel", channel, "--runtime-version", runtimeVersion, "--status", "finished", "--limit", "1", "--json", "--non-interactive"], { capture: true, env: childEnv });
      const count = builds.status === 0 ? finishedBuildCount(builds.stdout ?? "") : null;
      if (count === null) fail(`"eas build:list --channel ${channel} --platform ${platform}" failed (exit ${builds.status}); sign in (eas login / EXPO_TOKEN) and retry`);
      if (count === 0) {
        fail(`no finished ${platform} build on the "${channel}" channel has runtime version ${runtimeVersion}. The native code changed since the last build (new native package, app.json / app.config.js change, permission string, Expo SDK upgrade, Tap to Pay flag) — a STORE BUILD is required instead: eas build --profile ${profile} --platform ${platform} (docs/mobile-release.md § 7).`);
      }
      console.log(`  ok  ${platform}: a finished ${channel} build runs runtime version ${runtimeVersion}`);
    }
  }

  const args = ["update", "--channel", channel, "--environment", environment, ...passthrough];
  console.log(`  running: eas ${args.join(" ")}`);
  const update = runEas(args, { env: childEnv });
  process.exit(update.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
