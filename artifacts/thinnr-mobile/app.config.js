/**
 * Store-complete Expo config.
 *
 * app.json holds the static manifest (name, ids, permission strings, plugins).
 * This file layers the parts that depend on the build environment so an EAS
 * build needs no manual edits:
 *
 *   EAS_PROJECT_ID        Expo project id override. The normal source is
 *                         app.json extra.eas.projectId, written once by
 *                         `eas init --id <project id>` (the id is public, not
 *                         a credential). Either source threads into
 *                         extra.eas.projectId (push token registration reads
 *                         it) and the over-the-air updates URL; the variable
 *                         wins when both exist so a build can target another
 *                         project without editing the manifest.
 *   EXPO_OWNER            Expo account/organization that owns the project
 *                         (optional; needed when the build token belongs to a
 *                         different account than the project).
 *   TAP_TO_PAY_ENABLED    "1" adds the Apple Tap to Pay entitlement and the
 *                         Stripe Terminal plugin. Off by default so the first
 *                         App Store submission does not request an entitlement
 *                         Apple has not granted yet (see docs/mobile-release.md).
 *   THINNR_BUILD_PROFILE  development | preview | production (set by eas.json);
 *                         exposed under extra.thinnr for diagnostics only.
 *
 * Runtime behaviour knobs (API origin, Supabase project) are EXPO_PUBLIC_*
 * variables: EXPO_PUBLIC_DOMAIN comes from the eas.json profile env, the
 * Supabase pair from the EAS environment each profile
 * names. They reach the JS bundle at export time, so over-the-air updates
 * must be published with the same profile env + environment as a build —
 * see scripts/publish-update.mjs; never a bare `eas update`.
 */

const TAP_TO_PAY_ENTITLEMENT = "com.apple.developer.proximity-reader.payment.acceptance";
const STRIPE_TERMINAL_PLUGIN = "@stripe/stripe-terminal-react-native";
const TAP_TO_PAY_ANDROID_PERMISSIONS = [
  "android.permission.NFC",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
];
const TAP_TO_PAY_IOS_STRINGS = ["NSLocationWhenInUseUsageDescription"];

function flag(value) {
  return value === "1" || value === "true";
}

function pluginName(plugin) {
  return Array.isArray(plugin) ? plugin[0] : plugin;
}

module.exports = ({ config }) => {
  const committedProjectId =
    ((config.extra && config.extra.eas && config.extra.eas.projectId) || "").trim();
  const projectId = (process.env.EAS_PROJECT_ID || "").trim() || committedProjectId;
  const owner = (process.env.EXPO_OWNER || "").trim();
  const tapToPay = flag(process.env.TAP_TO_PAY_ENABLED);
  const buildProfile = (process.env.THINNR_BUILD_PROFILE || "").trim() || null;

  const ios = { ...(config.ios || {}) };
  const android = { ...(config.android || {}) };
  let plugins = [...(config.plugins || [])];

  if (!tapToPay) {
    const entitlements = { ...(ios.entitlements || {}) };
    delete entitlements[TAP_TO_PAY_ENTITLEMENT];
    ios.entitlements = entitlements;
    const infoPlist = { ...(ios.infoPlist || {}) };
    for (const key of TAP_TO_PAY_IOS_STRINGS) delete infoPlist[key];
    ios.infoPlist = infoPlist;
    android.permissions = (android.permissions || []).filter(
      (permission) => !TAP_TO_PAY_ANDROID_PERMISSIONS.includes(permission),
    );
    plugins = plugins.filter((plugin) => pluginName(plugin) !== STRIPE_TERMINAL_PLUGIN);
  }

  return {
    ...config,
    ...(owner ? { owner } : {}),
    ios,
    android,
    plugins,
    ...(projectId
      ? {
          updates: {
            ...(config.updates || {}),
            url: `https://u.expo.dev/${projectId}`,
          },
        }
      : {}),
    extra: {
      ...(config.extra || {}),
      eas: {
        ...((config.extra && config.extra.eas) || {}),
        ...(projectId ? { projectId } : {}),
      },
      thinnr: {
        ...((config.extra && config.extra.thinnr) || {}),
        tapToPay,
        ...(buildProfile ? { buildProfile } : {}),
      },
    },
  };
};
