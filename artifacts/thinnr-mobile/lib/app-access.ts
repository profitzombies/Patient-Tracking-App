/**
 * Patient app-access entitlement — the client side of the office's charge
 * for the app's premium AI features (coach chat and voice, meal/menu/label
 * photo reads, barcode lookup).
 *
 * The SERVER decides the entitlement (one pure rule shared by the patient
 * endpoint, every premium route's gate and the office roster). This module
 * only reads that decision, so nothing here re-derives "is this patient
 * free" from dates or programs: a free window, a subscription, an office
 * that does not charge, and a lock all arrive as fields on the wire.
 *
 * Two inputs reach the app:
 *   - GET /patient-data/billing/app-access on open / foreground / return
 *     from the browser (fetchPatientAppAccess below), including the public
 *     checkout URL when an upgrade is on offer.
 *   - the 402 `upgradeRequired` payload a premium route answers when a
 *     request still reaches it while locked (stale state). That answer is
 *     terminal — no retry — and carries the entitlement so the app can lock
 *     immediately without a second round trip.
 *
 * Dependency-light on purpose (no react-native, no supabase): the coach and
 * scan API clients import the parsers, and Node suites load those without
 * native stubs.
 */
import { configuredApiOrigin } from '@/lib/api-origin';

export type AppAccessCadence = '2_weeks' | 'monthly';

export type AppAccessReason =
  /** On the THINNR protocol: free through the current episode's window. */
  | 'protocol_window'
  /** On another program: inside the office's free trial. */
  | 'trial'
  /** The office does not charge for the app's premium features. */
  | 'office_not_charging'
  /** A paid app-access subscription covers today. */
  | 'subscribed'
  /** The free window ended and no subscription covers today. */
  | 'locked';

export type AppAccessSubscriptionState = 'none' | 'active' | 'past_due' | 'canceled';

/** Verbatim mobile copy of the server's AppAccessEntitlement wire shape. */
export interface AppAccessEntitlement {
  available: boolean;
  reason: AppAccessReason;
  /** The free window (last FREE local day), reported even once it has passed; null when none applies. */
  free_window: { kind: 'protocol' | 'trial'; ends_on: string } | null;
  /** Whether the office charges at all — every upgrade affordance hides when false. */
  office_charges: boolean;
  price_cents: number | null;
  cadence: AppAccessCadence | null;
  subscription: {
    state: AppAccessSubscriptionState;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
}

/** GET /patient-data/billing/app-access */
export interface PatientAppAccess extends AppAccessEntitlement {
  subscription_id: string | null;
  /** Public checkout page (short-lived token); null while an upgrade is pointless. */
  checkout_url: string | null;
}

const REASONS: ReadonlySet<string> = new Set<AppAccessReason>([
  'protocol_window',
  'trial',
  'office_not_charging',
  'subscribed',
  'locked',
]);
const SUBSCRIPTION_STATES: ReadonlySet<string> = new Set<AppAccessSubscriptionState>([
  'none',
  'active',
  'past_due',
  'canceled',
]);

function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Validates one entitlement object off the wire. Returns null for anything
 * that is not a complete entitlement — callers then keep their current
 * state rather than acting on a half-read answer.
 */
export function parseAppAccessEntitlement(value: unknown): AppAccessEntitlement | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.available !== 'boolean') return null;
  if (typeof record.reason !== 'string' || !REASONS.has(record.reason)) return null;
  if (typeof record.office_charges !== 'boolean') return null;

  let freeWindow: AppAccessEntitlement['free_window'] = null;
  if (record.free_window !== null && record.free_window !== undefined) {
    if (typeof record.free_window !== 'object') return null;
    const window = record.free_window as Record<string, unknown>;
    if ((window.kind !== 'protocol' && window.kind !== 'trial') || !isDayKey(window.ends_on)) return null;
    freeWindow = { kind: window.kind, ends_on: window.ends_on };
  }

  const priceCents =
    typeof record.price_cents === 'number' && Number.isFinite(record.price_cents) && record.price_cents >= 0
      ? Math.round(record.price_cents)
      : null;
  const cadence: AppAccessCadence | null =
    record.cadence === '2_weeks' || record.cadence === 'monthly' ? record.cadence : null;

  let subscription: AppAccessEntitlement['subscription'] = null;
  if (record.subscription !== null && record.subscription !== undefined) {
    if (typeof record.subscription !== 'object') return null;
    const sub = record.subscription as Record<string, unknown>;
    if (typeof sub.state !== 'string' || !SUBSCRIPTION_STATES.has(sub.state)) return null;
    subscription = {
      state: sub.state as AppAccessSubscriptionState,
      current_period_end: nullableString(sub.current_period_end),
      cancel_at_period_end: sub.cancel_at_period_end === true,
    };
  }

  return {
    available: record.available,
    reason: record.reason as AppAccessReason,
    free_window: freeWindow,
    office_charges: record.office_charges,
    price_cents: priceCents,
    cadence,
    subscription,
  };
}

/** Validates the patient endpoint's answer (entitlement + checkout link). */
export function parsePatientAppAccess(value: unknown): PatientAppAccess | null {
  const entitlement = parseAppAccessEntitlement(value);
  if (!entitlement) return null;
  const record = value as Record<string, unknown>;
  const checkoutUrl = nullableString(record.checkout_url);
  return {
    ...entitlement,
    subscription_id: nullableString(record.subscription_id),
    checkout_url: checkoutUrl && /^https?:\/\//.test(checkoutUrl) ? checkoutUrl : null,
  };
}

/**
 * Shape of the terminal 402 a premium route answers while locked. The
 * `upgradeRequired` flag is the signal; the attached entitlement is a
 * convenience (parsed leniently — a missing one still locks the feature).
 */
export interface UpgradeRequiredReply {
  upgradeRequired: true;
  entitlement: AppAccessEntitlement | null;
}

/** Reads the upgrade-required signal out of an error body; null for every other failure. */
export function readUpgradeRequired(body: unknown): UpgradeRequiredReply | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.upgradeRequired !== true) return null;
  return { upgradeRequired: true, entitlement: parseAppAccessEntitlement(record.entitlement) };
}

/**
 * Reads the signed-in patient's entitlement. Resolves `null` when the
 * answer cannot be obtained (no token, offline, non-2xx, malformed): the
 * caller keeps its current state — the premium request itself is the
 * authority and answers 402 while locked. Infra trouble never locks the
 * app on its own.
 */
export async function fetchPatientAppAccess(
  getAuthToken: () => Promise<string | null>,
  signal?: AbortSignal,
): Promise<PatientAppAccess | null> {
  let token: string | null = null;
  try {
    token = await getAuthToken();
  } catch {
    token = null;
  }
  if (!token) return null;
  try {
    const response = await fetch(`${configuredApiOrigin()}/api/patient-data/billing/app-access`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) return null;
    return parsePatientAppAccess(await response.json());
  } catch {
    return null;
  }
}

// ─── Selectors ───────────────────────────────────────────────────────────────

/**
 * True only when the server has said the premium features are locked. An
 * unknown entitlement (null) is NOT a lock: the app never locks on silence.
 */
export function premiumLocked(access: AppAccessEntitlement | null | undefined): boolean {
  return access != null && access.available === false;
}

/** What the subscription restores — the shared premium list, in patient words. */
export const PREMIUM_FEATURES: readonly string[] = [
  'Chat and talk with your AI coach',
  'Meal and menu photo reads',
  'Barcode lookup for packaged foods',
];

export function appAccessCadenceLabel(cadence: AppAccessCadence | null): string {
  return cadence === '2_weeks' ? 'every 2 weeks' : 'a month';
}

export function appAccessMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/** "$9.99 a month" / "$4.99 every 2 weeks"; null when the office has no price on file. */
export function appAccessPriceLine(access: AppAccessEntitlement | null | undefined): string | null {
  if (!access || !access.office_charges || access.price_cents == null) return null;
  return `${appAccessMoney(access.price_cents)} ${appAccessCadenceLabel(access.cadence)}`;
}

/** Final days of a chargeable free window that still earn the quiet notice. */
export const ENDING_SOON_DAYS = 3;

export interface EndingSoonNotice {
  /** Last free local day (YYYY-MM-DD). */
  endsOn: string;
  /** 0 = ends today. */
  daysLeft: number;
  /** "$9.99 a month" — what the office charges afterwards. */
  priceLine: string;
}

function dayNumber(dayKey: string): number {
  return Math.floor(Date.parse(`${dayKey}T00:00:00Z`) / 86_400_000);
}

/**
 * The ending-soon notice for the coach surface: only inside the last
 * ENDING_SOON_DAYS days of a free window that is still open, and only when
 * the office actually charges afterwards (a non-charging office's window
 * ending changes nothing, so it earns no notice). `todayKey` is the
 * patient's local day, never the device clock sliced to a date.
 */
export function endingSoonNotice(
  access: AppAccessEntitlement | null | undefined,
  todayKey: string,
): EndingSoonNotice | null {
  if (!access || !access.available || !access.office_charges) return null;
  if (access.reason !== 'protocol_window' && access.reason !== 'trial') return null;
  if (!access.free_window || !isDayKey(todayKey)) return null;
  const priceLine = appAccessPriceLine(access);
  if (!priceLine) return null;
  const daysLeft = dayNumber(access.free_window.ends_on) - dayNumber(todayKey);
  if (!Number.isFinite(daysLeft) || daysLeft < 0 || daysLeft > ENDING_SOON_DAYS) return null;
  return { endsOn: access.free_window.ends_on, daysLeft, priceLine };
}

/** "today" / "tomorrow" / "on Oct 20" for notice copy. */
export function describeEndingDay(notice: EndingSoonNotice): string {
  if (notice.daysLeft === 0) return 'today';
  if (notice.daysLeft === 1) return 'tomorrow';
  const date = new Date(`${notice.endsOn}T00:00:00Z`);
  return `on ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
}
