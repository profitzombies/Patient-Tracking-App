/**
 * The app link a patient invitation email carries.
 *
 * PATIENT_INVITE_URL is the dedicated setting. For the Expo Go test run it is
 * the published site's Expo Go page (https://<site>/thinnr-mobile/), which
 * opens the app in Expo Go. It is kept apart from PATIENT_APP_URL because the
 * billing and security emails build web deep links (/billing, /security-report)
 * from PATIENT_APP_URL, and the Expo Go page has no such routes.
 *
 * Resolution order: PATIENT_INVITE_URL, then PATIENT_APP_URL, then (development
 * only) the workspace's Expo dev domain. In strict mode — the published site,
 * and the launch readiness check — the dev fallback is never used and a
 * configured value must be an https address that is not a development
 * preview, so the live site can never quietly email a link to a workspace.
 */

export const PATIENT_INVITE_URL_SETTING = "PATIENT_INVITE_URL";
/** Where the published site hosts the mobile app's Expo Go page. */
export const EXPO_GO_PAGE_PATH = "/thinnr-mobile/";

type LinkSetting = "PATIENT_INVITE_URL" | "PATIENT_APP_URL" | "REPLIT_EXPO_DEV_DOMAIN";

export type PatientInviteLink =
  | { ok: true; link: string; setting: LinkSetting }
  | { ok: false; problem: "missing" }
  | { ok: false; problem: "invalid" | "dev_preview"; setting: LinkSetting; value: string };

const DEV_PREVIEW_HOST = /\.replit\.dev$|\.repl\.co$/i;

export function isDevPreviewHost(hostname: string): boolean {
  return DEV_PREVIEW_HOST.test(hostname);
}

export function resolvePatientInviteLink(
  env: NodeJS.ProcessEnv = process.env,
  options: { strict?: boolean } = {},
): PatientInviteLink {
  const strict = options.strict ?? env.NODE_ENV === "production";
  for (const setting of ["PATIENT_INVITE_URL", "PATIENT_APP_URL"] as const) {
    const value = env[setting]?.trim();
    if (!value) continue;
    if (!strict) return { ok: true, link: value, setting };
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, problem: "invalid", setting, value };
    }
    if (url.protocol !== "https:") return { ok: false, problem: "invalid", setting, value };
    if (isDevPreviewHost(url.hostname)) return { ok: false, problem: "dev_preview", setting, value };
    return { ok: true, link: value, setting };
  }
  if (!strict) {
    const expo = env.REPLIT_EXPO_DEV_DOMAIN?.trim();
    if (expo) return { ok: true, link: `https://${expo}`, setting: "REPLIT_EXPO_DEV_DOMAIN" };
  }
  return { ok: false, problem: "missing" };
}

/** The Expo Go page under the published site address, when that address is known and live. */
export function suggestedPatientInviteUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.OPERATIONS_APP_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || isDevPreviewHost(url.hostname)) return null;
    return `${url.origin}${EXPO_GO_PAGE_PATH}`;
  } catch {
    return null;
  }
}
