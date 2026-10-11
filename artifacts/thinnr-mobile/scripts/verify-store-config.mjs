#!/usr/bin/env node
/**
 * Store-readiness assertions for the patient app config.
 *
 * Resolves the real Expo config (app.json + app.config.js + every config
 * plugin, exactly what `eas build` prebuilds from) twice — once with the Tap
 * to Pay flag off (store default) and once with it on — and asserts the
 * settings the App Store and Google Play reject a submission without:
 * identifiers, icons, splash, updates/runtime policy, encryption exemption,
 * privacy manifest, Health entitlements, every permission string, and that
 * the Tap to Pay entitlement + Stripe Terminal module appear ONLY behind the
 * flag. Also checks eas.json's profiles and that production can only reach
 * the published API origin.
 *
 * Permission strings that config plugins write into Info.plist (camera,
 * photos, motion, Face ID) are asserted on the plugin options: `expo config`
 * resolves plugins but does not run their prebuild mods, so they are not yet
 * in ios.infoPlist here. Health strings and the encryption flag live directly
 * in infoPlist and are asserted there.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:store-config
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

function resolveConfig(env) {
  const base = { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" };
  delete base.EAS_PROJECT_ID;
  delete base.EXPO_OWNER;
  delete base.TAP_TO_PAY_ENABLED;
  delete base.THINNR_BUILD_PROFILE;
  const out = execFileSync("pnpm", ["exec", "expo", "config", "--type", "prebuild", "--json"], {
    cwd: root,
    env: { ...base, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out.slice(out.indexOf("{")));
}

const pluginName = (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin);
const pluginProps = (config, name) => {
  const hit = (config.plugins ?? []).find((plugin) => pluginName(plugin) === name);
  return Array.isArray(hit) ? (hit[1] ?? {}) : hit ? {} : null;
};
/** Width, height and whether the PNG carries transparency (alpha channel or a tRNS chunk). */
const pngSize = (relPath) => {
  if (!relPath) return null;
  const file = resolve(root, relPath);
  if (!existsSync(file)) return null;
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const colorType = b[25];
  let alpha = colorType === 4 || colorType === 6;
  let off = 8;
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    if (type === "tRNS") {
      const data = b.subarray(off + 8, off + 8 + len);
      if (colorType !== 3 || [...data].some((v) => v < 255)) alpha = true;
    }
    off += 12 + len;
  }
  return { width, height, alpha };
};
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 20;

console.log("store config — default (Tap to Pay off)");
const config = resolveConfig({});
{
  check("name and slug", config.name === "THINNR" && config.slug === "thinnr");
  check("semantic marketing version (build numbers come from EAS remote source)", /^\d+\.\d+\.\d+$/.test(config.version) && config.ios.buildNumber === undefined && config.android.versionCode === undefined, { version: config.version, buildNumber: config.ios.buildNumber, versionCode: config.android.versionCode });
  check("iOS bundle id and Android package match", config.ios.bundleIdentifier === "com.thinnr.app" && config.android.package === "com.thinnr.app");
  check("URL scheme", config.scheme === "thinnr");
  check("portrait, light UI, phones only", config.orientation === "portrait" && config.userInterfaceStyle === "light" && config.ios.supportsTablet === false);

  // Icons and splash.
  const icon = pngSize(config.icon);
  check("iOS icon is a 1024×1024 opaque PNG", icon && icon.width === 1024 && icon.height === 1024 && !icon.alpha, icon);
  const fg = pngSize(config.android.adaptiveIcon?.foregroundImage);
  check("Android adaptive foreground is a 1024×1024 PNG with transparency", fg && fg.width === 1024 && fg.height === 1024 && fg.alpha, fg);
  check("Android adaptive background is the brand navy", config.android.adaptiveIcon?.backgroundColor === "#203b64");
  const splash = pluginProps(config, "expo-splash-screen");
  const splashImage = splash ? pngSize(splash.image) : null;
  check("splash: brand background, contained mark rendered from a 2×+ source", splash && splash.backgroundColor === "#203b64" && splash.resizeMode === "contain" && splashImage && splashImage.alpha && splashImage.width >= 2 * (splash.imageWidth ?? 200), { splash, splashImage });
  const notif = pluginProps(config, "expo-notifications");
  const notifIcon = notif ? pngSize(notif.icon) : null;
  check("Android notification icon is a transparent PNG with a brand colour", notif && notifIcon && notifIcon.alpha && notif.color === "#203b64", notif);

  // Updates / runtime.
  check("over-the-air updates on, checked on load, fingerprint runtime policy", config.updates?.enabled === true && config.updates?.checkAutomatically === "ON_LOAD" && config.runtimeVersion?.policy === "fingerprint", { updates: config.updates, runtimeVersion: config.runtimeVersion });
  // Before `eas init --id …` runs, nothing is baked in; afterwards the id it
  // committed into app.json must drive both the extra and the updates URL.
  const linked = JSON.parse(readFileSync(resolve(root, "app.json"), "utf8")).expo?.extra?.eas?.projectId;
  check(
    linked ? "committed project id drives extra.eas.projectId and the updates URL" : "unlinked checkout bakes in no project id or updates URL",
    linked ? config.extra?.eas?.projectId === linked && config.updates?.url === `https://u.expo.dev/${linked}` : !config.extra?.eas?.projectId && !config.updates?.url,
    { extra: config.extra, updates: config.updates },
  );

  // iOS store requirements.
  const plist = config.ios.infoPlist ?? {};
  check("encryption exemption declared", plist.ITSAppUsesNonExemptEncryption === false);
  const camera = pluginProps(config, "expo-camera") ?? {};
  const picker = pluginProps(config, "expo-image-picker") ?? {};
  const media = pluginProps(config, "expo-media-library") ?? {};
  const sensors = pluginProps(config, "expo-sensors") ?? {};
  const localAuth = pluginProps(config, "expo-local-authentication") ?? {};
  const health = pluginProps(config, "react-native-health") ?? {};
  const strings = {
    "camera (expo-camera)": camera.cameraPermission,
    "camera (expo-image-picker)": picker.cameraPermission,
    "photo library (expo-image-picker)": picker.photosPermission,
    "photo library (expo-media-library)": media.photosPermission,
    "motion (expo-sensors)": sensors.motionPermission,
    "Face ID (expo-local-authentication)": localAuth.faceIDPermission,
    "Face ID (infoPlist)": plist.NSFaceIDUsageDescription,
    "Health share (react-native-health)": health.healthSharePermission,
    "Health share (infoPlist)": plist.NSHealthShareUsageDescription,
    "Health update (react-native-health)": health.healthUpdatePermission,
    "Health update (infoPlist)": plist.NSHealthUpdateUsageDescription,
  };
  for (const [label, value] of Object.entries(strings)) {
    check(`iOS permission string present and names THINNR: ${label}`, nonEmpty(value) && /THINNR/.test(value), value ?? "(missing)");
  }
  check("camera string explains every camera use (meals, menus, labels, labs, progress photos)", ["meal", "menu", "label", "lab report", "progress photo"].every((w) => (camera.cameraPermission ?? "").includes(w)) && picker.cameraPermission === camera.cameraPermission);
  check("Health strings: read-only weight & steps, no writes, identical in plugin and plist", /weight and step/.test(plist.NSHealthShareUsageDescription ?? "") && /does not write/.test(plist.NSHealthUpdateUsageDescription ?? "") && health.healthSharePermission === plist.NSHealthShareUsageDescription && health.healthUpdatePermission === plist.NSHealthUpdateUsageDescription);
  check("no microphone use anywhere (camera, picker, audio decline it)", camera.microphonePermission === false && picker.microphonePermission === false && (pluginProps(config, "expo-audio") ?? {}).microphonePermission === false && plist.NSMicrophoneUsageDescription === undefined);
  check("media library: photos only, no saving, no location", media.savePhotosPermission === false && media.isAccessMediaLocationEnabled === false && Array.isArray(media.granularPermissions) && media.granularPermissions.join() === "photo");
  const ent = config.ios.entitlements ?? {};
  check("HealthKit entitlement present", ent["com.apple.developer.healthkit"] === true && Array.isArray(ent["com.apple.developer.healthkit.access"]));
  check("push notifications plugin present (adds aps-environment at prebuild)", pluginProps(config, "expo-notifications") !== null);
  check("Tap to Pay entitlement ABSENT by default", ent["com.apple.developer.proximity-reader.payment.acceptance"] === undefined, ent);
  check("Stripe Terminal plugin ABSENT by default", pluginProps(config, "@stripe/stripe-terminal-react-native") === null);
  check("no location string when Tap to Pay is off", plist.NSLocationWhenInUseUsageDescription === undefined && plist.NSLocationAlwaysAndWhenInUseUsageDescription === undefined);
  const pm = config.ios.privacyManifests ?? {};
  const apiTypes = new Set((pm.NSPrivacyAccessedAPITypes ?? []).map((row) => row.NSPrivacyAccessedAPIType));
  check("privacy manifest: no tracking, required-reason APIs declared", pm.NSPrivacyTracking === false && ["NSPrivacyAccessedAPICategoryUserDefaults", "NSPrivacyAccessedAPICategoryFileTimestamp", "NSPrivacyAccessedAPICategorySystemBootTime", "NSPrivacyAccessedAPICategoryDiskSpace"].every((t) => apiTypes.has(t)) && (pm.NSPrivacyAccessedAPITypes ?? []).every((row) => Array.isArray(row.NSPrivacyAccessedAPITypeReasons) && row.NSPrivacyAccessedAPITypeReasons.length > 0), pm);

  // Android.
  const perms = new Set(config.android.permissions ?? []);
  for (const key of ["android.permission.POST_NOTIFICATIONS", "android.permission.CAMERA", "android.permission.health.READ_WEIGHT", "android.permission.health.READ_STEPS", "android.permission.USE_BIOMETRIC", "android.permission.INTERNET"]) {
    check(`Android permission: ${key}`, perms.has(key));
  }
  for (const key of ["android.permission.RECORD_AUDIO", "android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION", "android.permission.NFC"]) {
    check(`Android permission absent by default: ${key}`, !perms.has(key), [...perms]);
  }
  check("audio/video media permissions blocked", ["android.permission.RECORD_AUDIO", "android.permission.READ_MEDIA_AUDIO", "android.permission.READ_MEDIA_VIDEO"].every((p) => (config.android.blockedPermissions ?? []).includes(p)));
  check("camera plugin declines Android audio recording", pluginProps(config, "expo-camera")?.recordAudioAndroid === false);
  check("Health Connect plugin present", pluginProps(config, "react-native-health-connect") !== null);
  check("Stripe card form plugin present with the merchant id", pluginProps(config, "@stripe/stripe-react-native")?.merchantIdentifier === "merchant.com.thinnr.mobile");
  check("secure store backs up on Android", pluginProps(config, "expo-secure-store")?.configureAndroidBackup === true);
}

console.log("store config — TAP_TO_PAY_ENABLED=1");
{
  const ttp = resolveConfig({ TAP_TO_PAY_ENABLED: "1", EAS_PROJECT_ID: "00000000-0000-4000-8000-000000000000", THINNR_BUILD_PROFILE: "development" });
  const ent = ttp.ios.entitlements ?? {};
  const plist = ttp.ios.infoPlist ?? {};
  const perms = new Set(ttp.android.permissions ?? []);
  check("Tap to Pay entitlement present behind the flag", ent["com.apple.developer.proximity-reader.payment.acceptance"] === true);
  const terminal = pluginProps(ttp, "@stripe/stripe-terminal-react-native");
  check("Stripe Terminal plugin present behind the flag with its permission strings", terminal !== null && /Tap to Pay/.test(terminal?.locationWhenInUsePermission ?? "") && nonEmpty(terminal?.bluetoothAlwaysUsagePermission));
  check("location string present behind the flag and names Tap to Pay", /Tap to Pay/.test(plist.NSLocationWhenInUseUsageDescription ?? ""));
  check("Android NFC + location permissions present behind the flag", perms.has("android.permission.NFC") && perms.has("android.permission.ACCESS_FINE_LOCATION"));
  check("EAS project id reaches extra.eas.projectId and the updates URL", ttp.extra?.eas?.projectId === "00000000-0000-4000-8000-000000000000" && ttp.updates?.url === "https://u.expo.dev/00000000-0000-4000-8000-000000000000");
  check("build profile is exposed for diagnostics", ttp.extra?.thinnr?.buildProfile === "development" && ttp.extra?.thinnr?.tapToPay === true);
}

console.log("project id bootstrap (app.config.js)");
{
  // `eas init --id <id>` writes extra.eas.projectId into app.json; the config
  // must pick it up with no EAS_PROJECT_ID set, and let the variable override it.
  const { createRequire } = await import("node:module");
  const appConfig = createRequire(import.meta.url)(resolve(root, "app.config.js"));
  const saved = { EAS_PROJECT_ID: process.env.EAS_PROJECT_ID, TAP_TO_PAY_ENABLED: process.env.TAP_TO_PAY_ENABLED };
  delete process.env.EAS_PROJECT_ID;
  delete process.env.TAP_TO_PAY_ENABLED;
  const committedId = "11111111-2222-4333-8444-555555555555";
  const fromAppJson = appConfig({ config: { extra: { eas: { projectId: committedId } }, plugins: [] } });
  check("committed app.json project id reaches extra.eas.projectId and the updates URL without EAS_PROJECT_ID", fromAppJson.extra?.eas?.projectId === committedId && fromAppJson.updates?.url === `https://u.expo.dev/${committedId}`, fromAppJson.extra);
  process.env.EAS_PROJECT_ID = "99999999-8888-4777-8666-555555555555";
  const overridden = appConfig({ config: { extra: { eas: { projectId: committedId } }, plugins: [] } });
  check("EAS_PROJECT_ID overrides the committed id", overridden.extra?.eas?.projectId === process.env.EAS_PROJECT_ID && overridden.updates?.url === `https://u.expo.dev/${process.env.EAS_PROJECT_ID}`);
  delete process.env.EAS_PROJECT_ID;
  const unlinked = appConfig({ config: { plugins: [] } });
  check("an unlinked checkout resolves with no project id and no updates URL (push registration then reports it)", unlinked.extra?.eas?.projectId === undefined && unlinked.updates === undefined, unlinked.extra);
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
}

console.log("eas.json");
{
  const eas = JSON.parse(readFileSync(resolve(root, "eas.json"), "utf8"));
  check("remote version source + clean-tree builds", eas.cli?.appVersionSource === "remote" && eas.cli?.requireCommit === true);
  for (const profile of ["development", "preview", "production"]) {
    const p = eas.build?.[profile];
    check(`profile ${profile} exists, extends base, channel = profile`, p && p.extends === "base" && p.channel === profile, p);
  }
  check("production distributes to the store as an Android app bundle with auto-increment", eas.build.production.distribution === "store" && eas.build.production.android?.buildType === "app-bundle" && eas.build.production.autoIncrement === true);
  check("preview installs internally (APK)", eas.build.preview.distribution === "internal" && eas.build.preview.android?.buildType === "apk");
  check("development carries the dev client and Tap to Pay", eas.build.development.developmentClient === true && eas.build.development.env?.TAP_TO_PAY_ENABLED === "1");
  check("Tap to Pay is off for preview and production until Apple grants the entitlement", !eas.build.preview.env?.TAP_TO_PAY_ENABLED && !eas.build.production.env?.TAP_TO_PAY_ENABLED);
  const domains = ["base", "development", "preview", "production"].map((p) => eas.build[p].env?.EXPO_PUBLIC_DOMAIN).filter(Boolean);
  check("every build talks only to the published API origin", eas.build.base.env.EXPO_PUBLIC_DOMAIN === "app.trythinnr.com" && domains.every((d) => d === "app.trythinnr.com"), domains);
  // The EAS project id is public (it is in every update URL the phone
  // fetches) and `eas init --id …` writes it into app.json; that is the
  // supported bootstrap. Tokens, keys and the workspace host never belong in
  // any of the three files, and the updates URL is derived, never hand-written.
  const text = readFileSync(resolve(root, "eas.json"), "utf8") + readFileSync(resolve(root, "app.json"), "utf8") + readFileSync(resolve(root, "app.config.js"), "utf8");
  check("no token, key, replit.dev host or hand-written updates URL committed in build config", !/u\.expo\.dev\/[0-9a-f-]{36}|EXPO_TOKEN=|sk_live|sk_test|replit\.dev/.test(text));
  const appJson = JSON.parse(readFileSync(resolve(root, "app.json"), "utf8"));
  const committed = appJson.expo?.extra?.eas?.projectId;
  check("app.json project id, when present, is the id `eas init` writes (uuid), nothing else under extra.eas", committed === undefined || (/^[0-9a-f-]{36}$/.test(committed) && Object.keys(appJson.expo.extra.eas).join() === "projectId"), appJson.expo?.extra?.eas);
  check("node and pnpm pinned to the workspace versions", /^\d+\.\d+\.\d+$/.test(eas.build.base.node) && /^\d+\.\d+\.\d+$/.test(eas.build.base.pnpm));
  for (const profile of ["development", "preview", "production"]) {
    check(`profile ${profile} names its EAS environment (builds and OTA updates load the same variables)`, eas.build[profile].environment === profile, eas.build[profile].environment);
  }
}

console.log("over-the-air publish path");
{
  // `eas update` applies neither eas.json `env` nor the EAS environment on its
  // own; the release script must supply both or the bundle ships without its
  // API origin / Supabase project / project id.
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  check("release:update script publishes through the guarded wrapper", pkg.scripts?.["release:update"] === "node scripts/publish-update.mjs", pkg.scripts?.["release:update"]);
  const publish = await import("./publish-update.mjs");
  const eas = JSON.parse(readFileSync(resolve(root, "eas.json"), "utf8"));
  for (const profile of ["preview", "production"]) {
    const resolved = publish.profileEnvironment(eas, profile);
    check(`wrapper resolves ${profile} → channel ${profile}, environment ${profile}, published API origin`, resolved.channel === profile && resolved.environment === profile && resolved.env.EXPO_PUBLIC_DOMAIN === "app.trythinnr.com" && resolved.env.THINNR_BUILD_PROFILE === profile, resolved);
  }
  check("wrapper always requires the Supabase pair in the EAS environment", ["EXPO_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY"].every((v) => publish.REQUIRED_ENVIRONMENT_VARIABLES.includes(v)) && !publish.REQUIRED_ENVIRONMENT_VARIABLES.includes("EAS_PROJECT_ID"));
  check("wrapper requires EAS_PROJECT_ID only when app.json carries no project id", publish.requiredEnvironmentVariables({ projectIdCommitted: false })[0] === "EAS_PROJECT_ID" && !publish.requiredEnvironmentVariables({ projectIdCommitted: true }).includes("EAS_PROJECT_ID"));
  check("wrapper reads the project id `eas init` writes into app.json", publish.committedProjectId({ expo: { extra: { eas: { projectId: " abc " } } } }) === "abc" && publish.committedProjectId({ expo: {} }) === null && publish.committedProjectId({ expo: { extra: { eas: { projectId: "" } } } }) === null);
  check("wrapper detects a missing variable in `eas env:list` output", publish.missingEnvironmentVariables("EXPO_PUBLIC_SUPABASE_URL=https://x.supabase.co\n").join() === "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY" && publish.missingEnvironmentVariables("EXPO_PUBLIC_SUPABASE_URL=2\nEXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=3\n").length === 0 && publish.missingEnvironmentVariables("EXPO_PUBLIC_SUPABASE_URL=2\nEXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=3\n", publish.requiredEnvironmentVariables({ projectIdCommitted: false })).join() === "EAS_PROJECT_ID");
  check("wrapper parses the runtime version from expo-updates output (log lines tolerated)", publish.parseRuntimeVersion('warn: something\n{"runtimeVersion":"8ccc4a2c","fingerprintSources":[]}') === "8ccc4a2c" && publish.parseRuntimeVersion("nope") === null && publish.parseRuntimeVersion('{"runtimeVersion":""}') === null);
  check("wrapper reads the finished-build count from `eas build:list --json`", publish.finishedBuildCount('[{"id":"b1","status":"FINISHED"}]') === 1 && publish.finishedBuildCount("[]") === 0 && publish.finishedBuildCount("Error: not logged in") === null);
  check("wrapper targets both platforms unless --platform narrows it", publish.targetPlatforms(["--message", "x"]).join() === "ios,android" && publish.targetPlatforms(["--platform", "ios"]).join() === "ios" && publish.targetPlatforms(["--platform=android"]).join() === "android" && publish.targetPlatforms(["-p", "all"]).join() === "ios,android");
  const wrapperText = readFileSync(resolve(root, "scripts/publish-update.mjs"), "utf8");
  check("wrapper passes --channel and --environment to eas update", /"--channel", channel, "--environment", environment/.test(wrapperText));
  check("wrapper resolves the runtime version with the profile env and requires a finished build with it on the channel before publishing", /runtimeversion:resolve/.test(wrapperText) && /"build:list", "--platform", platform, "--channel", channel, "--runtime-version", runtimeVersion, "--status", "finished"/.test(wrapperText) && /STORE BUILD is required/.test(wrapperText));
  check("wrapper stops an unlinked project with the eas init instruction", /eas init --id/.test(wrapperText));
  const guide = readFileSync(resolve(root, "../../docs/mobile-release.md"), "utf8");
  // A command line with flags must carry --environment; naming the command in
  // prose ("the underlying `eas update` command") is fine, telling the reader
  // to run it bare is not.
  const bareUpdates = [...guide.matchAll(/eas update(?!:republish)[^\n`]*/g)].map((m) => m[0]).filter((cmd) => cmd !== "eas update" && !/--environment/.test(cmd));
  check("release guide never shows a bare `eas update` without an environment", bareUpdates.length === 0 && !/run `eas update`/.test(guide), bareUpdates);
  check("release guide ships OTA fixes through release:update", /release:update (preview|production)/.test(guide));
  check("release guide links the project with `eas init --id` and says `eas update` only warns on an incompatible publish", /eas init --id/.test(guide) && !/refuses\s+to publish/.test(guide) && /does \*\*not\*\* enforce this/.test(guide) && /store build is required/i.test(guide));
}

if (failures) {
  console.error(`\n${failures} store-config check(s) failed`);
  process.exit(1);
}
console.log("\nAll store-config checks passed.");
