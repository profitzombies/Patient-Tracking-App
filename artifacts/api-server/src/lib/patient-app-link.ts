/**
 * Where a patient gets the THINNR app — one answer shared by the invitation
 * email, the roster invite copy, the office "Get the app" links / QR codes and
 * the launch-readiness "Patient app link" check.
 *
 * Resolution order per platform:
 *   1. The HQ store link (Organization settings → App Store / Google Play).
 *      Pre-release testing links count: a TestFlight public link or a Play
 *      internal-testing opt-in page is a real install path for the native
 *      build while the listing is still in review.
 *   2. The Expo Go page (PATIENT_INVITE_URL; see patient-invite-link.ts),
 *      which is how patients ran the app before the store builds existed.
 *
 * As soon as HQ saves either store link the invitation switches to the
 * store flow (install THINNR itself, no Expo Go). A platform whose store link
 * is still blank keeps the Expo Go page when there is one, and otherwise says
 * the app is not available on that platform yet — never a dead link.
 */
import { resolvePatientInviteLink, type PatientInviteLink } from "./patient-invite-link";

export interface StoreLinks {
  appStoreUrl: string | null;
  googlePlayUrl: string | null;
}

export type PatientAppLinkMode = "store" | "expo_go";

export type PatientAppLinks =
  | {
      ok: true;
      mode: "store";
      /** The primary link (button target): App Store, else Google Play. */
      link: string;
      appStoreUrl: string | null;
      googlePlayUrl: string | null;
      /** The Expo Go page, when configured, for the platform without a store link. */
      expoGoUrl: string | null;
      /** True when at least one store link is a TestFlight / Play testing link. */
      interim: boolean;
    }
  | {
      ok: true;
      mode: "expo_go";
      link: string;
      appStoreUrl: null;
      googlePlayUrl: null;
      expoGoUrl: string;
      interim: false;
    }
  | ({ ok: false; mode: "expo_go" } & Exclude<PatientInviteLink, { ok: true }>);

const INTERIM_STORE_LINK = /^https:\/\/(testflight\.apple\.com\/join\/|play\.google\.com\/apps\/(internaltest|testing)\/)/;

/** A TestFlight public link or a Google Play internal / closed testing page. */
export function isInterimStoreLink(url: string | null | undefined): boolean {
  return Boolean(url && INTERIM_STORE_LINK.test(url.trim()));
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolvePatientAppLinks(
  storeLinks: StoreLinks | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: { strict?: boolean } = {},
): PatientAppLinks {
  const appStoreUrl = clean(storeLinks?.appStoreUrl);
  const googlePlayUrl = clean(storeLinks?.googlePlayUrl);
  const expoGo = resolvePatientInviteLink(env, options);
  const primary = appStoreUrl ?? googlePlayUrl;
  if (primary) {
    return {
      ok: true,
      mode: "store",
      link: primary,
      appStoreUrl,
      googlePlayUrl,
      expoGoUrl: expoGo.ok ? expoGo.link : null,
      interim: isInterimStoreLink(appStoreUrl) || isInterimStoreLink(googlePlayUrl),
    };
  }
  if (expoGo.ok) {
    return {
      ok: true,
      mode: "expo_go",
      link: expoGo.link,
      appStoreUrl: null,
      googlePlayUrl: null,
      expoGoUrl: expoGo.link,
      interim: false,
    };
  }
  return { ...expoGo, mode: "expo_go" };
}

/**
 * The patient-invitation template variables for a resolved link set. The
 * template renders the Expo Go steps when neither store variable is present
 * and the store steps otherwise (see lib/email-templates).
 */
export function patientInvitationLinkVariables(links: Extract<PatientAppLinks, { ok: true }>): {
  appLink: string;
  appStoreLink?: string;
  googlePlayLink?: string;
  expoGoLink?: string;
} {
  if (links.mode === "expo_go") return { appLink: links.link };
  return {
    appLink: links.link,
    ...(links.appStoreUrl ? { appStoreLink: links.appStoreUrl } : {}),
    ...(links.googlePlayUrl ? { googlePlayLink: links.googlePlayUrl } : {}),
    ...(links.expoGoUrl ? { expoGoLink: links.expoGoUrl } : {}),
  };
}
