// Read-only app-access state for the provider app's roster rows and patient
// record. The state itself is server-computed by the shared entitlement rule;
// these helpers only decide copy and tone so web and mobile staff screens read
// the same way. Null/undefined (family did not load) renders nothing.
import type { RosterAppAccess, RosterAppAccessState } from '@/lib/office-roster-api';

export type AppAccessTone = 'neutral' | 'good' | 'warn' | 'bad';

/** Roster chip copy: only states a staff member can act on earn a chip. */
export function appAccessChip(access: RosterAppAccess | null | undefined): { label: string; tone: AppAccessTone } | null {
  if (!access) return null;
  switch (access.state) {
    case 'lapsed': return { label: 'APP LAPSED', tone: 'bad' };
    case 'trial_ended': return { label: 'TRIAL ENDED', tone: 'bad' };
    case 'locked': return { label: 'APP LOCKED', tone: 'bad' };
    case 'past_due': return { label: 'APP PAST DUE', tone: 'warn' };
    default: return null;
  }
}

function shortDay(value: string | null): string | null {
  if (!value) return null;
  // Local calendar days arrive as YYYY-MM-DD; instants as ISO timestamps.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export const APP_ACCESS_STATE_LABEL: Record<RosterAppAccessState, string> = {
  free_protocol: 'Free (protocol)',
  free_trial: 'Free trial',
  not_charged: 'Included',
  subscribed: 'Subscribed',
  canceling: 'Cancelling',
  past_due: 'Past due',
  lapsed: 'Lapsed',
  trial_ended: 'Trial ended',
  locked: 'Locked',
};

/** Patient-record sentence (mirrors the office web app's wording). */
export function describeAppAccess(access: RosterAppAccess): string {
  const until = shortDay(access.freeUntil);
  const periodEnd = shortDay(access.currentPeriodEnd);
  switch (access.state) {
    case 'free_protocol': return until ? `Free during the THINNR protocol (through ${until})` : 'Free during the THINNR protocol';
    case 'free_trial': return until ? `Free trial (through ${until})` : 'Free trial';
    case 'not_charged': return 'Included — this office does not charge for the app';
    case 'subscribed': return periodEnd ? `Subscribed (renews ${periodEnd})` : 'Subscribed';
    case 'canceling': return periodEnd ? `Cancelled — access ends ${periodEnd}` : 'Cancelled at the end of the paid period';
    case 'past_due': return 'Renewal payment failed — Stripe is retrying; access continues through the paid period';
    case 'lapsed': return 'App subscription lapsed — premium AI features are locked';
    case 'trial_ended': return until ? `Free trial ended ${until} — premium AI features are locked` : 'Free trial ended — premium AI features are locked';
    case 'locked': return 'Premium AI features are locked until the patient subscribes';
  }
}

export function appAccessTone(state: RosterAppAccessState): AppAccessTone {
  switch (state) {
    case 'lapsed': case 'trial_ended': case 'locked': return 'bad';
    case 'past_due': case 'canceling': return 'warn';
    case 'subscribed': return 'good';
    default: return 'neutral';
  }
}
