/**
 * HQ Customer health — the one place the practice health score, the order-
 * recency buckets, the New rule, tied ranking and the "needs attention this
 * week" flags are defined. The HQ page and the (later) weekly email both
 * compute from here so they can never disagree.
 *
 * Inputs are the raw per-office facts from the `office_customer_health` SQL
 * function (see the migration for the data definitions); everything below is
 * pure arithmetic on those facts as of one instant.
 *
 * Score (0–100):
 *   most recent order   40  full points at <= RECENCY_FULL_DAYS days since the
 *                           last paid order, falling linearly to 0 at
 *                           RECENCY_ZERO_DAYS; no order on record = 0.
 *   app subscribers     15  weight × min(1, count ÷ target)
 *   app users           15  weight × min(1, count ÷ target)
 *   active app users    15  weight × (active 30d ÷ app users); 0 with no app users
 *   staff enrolled      15  weight × min(1, count ÷ target)
 * Bands: Healthy 70+, Watch 40–69, At risk below 40. Ties share a rank
 * (1, 1, 3 — "competition" ranking).
 */

export const HEALTH_WEIGHTS = {
  recency: 40,
  subscribers: 15,
  appUsers: 15,
  activeAppUsers: 15,
  staff: 15,
} as const;

/** Counts at or above these targets earn the full weight. */
export const HEALTH_TARGETS = {
  subscribers: 10,
  appUsers: 25,
  staff: 3,
} as const;

/** Days since the last paid order: full recency points up to this many days… */
export const RECENCY_FULL_DAYS = 30;
/** …falling linearly to zero at this many days (and beyond). */
export const RECENCY_ZERO_DAYS = 365;

/** Order-recency buckets, by days since the last paid order (inclusive upper bounds). */
export const BUCKET_BOUNDS = {
  active: 90,
  quiet3to6: 180,
  quiet6to12: 365,
} as const;

export const BAND_THRESHOLDS = {
  healthy: 70,
  watch: 40,
} as const;

/** An office created this recently with no order yet is "New", not lapsed. */
export const NEW_OFFICE_DAYS = 90;

/** Attention rules: windows (inclusive, days since last order) and the MAU drop test. */
export const ATTENTION_RULES = {
  leavingActive: { from: 60, to: 90 },
  passingSixMonths: { from: 150, to: 180 },
  activeUsersDropPct: 30,
  activeUsersDropMinPrior: 3,
} as const;

export type HealthBucket = "active" | "quiet3to6" | "quiet6to12" | "quietOverYear";
export type HealthBand = "healthy" | "watch" | "atRisk";
export type AttentionKind = "leavingActive" | "passingSixMonths" | "activeUsersDrop" | "subscriptionsCancelling" | "atRisk";

export const BUCKET_ORDER: HealthBucket[] = ["active", "quiet3to6", "quiet6to12", "quietOverYear"];

export const BUCKET_LABELS: Record<HealthBucket, string> = {
  active: "Active",
  quiet3to6: "Quiet 3–6 months",
  quiet6to12: "Quiet 6–12 months",
  quietOverYear: "Quiet over a year / never ordered",
};

export const BAND_LABELS: Record<HealthBand, string> = {
  healthy: "Healthy",
  watch: "Watch",
  atRisk: "At risk",
};

/** The raw facts for one office, as the SQL function reports them (plus the as-of instant). */
export interface OfficeHealthFacts {
  providerId: string;
  officeName: string;
  providerName: string;
  /** ISO instant the providers row was created. */
  createdAt: string | null;
  /** ISO instant of the latest paid live-mode order owned by the office; null = no order on record. */
  lastPaidOrderAt: string | null;
  activeSubscribers: number;
  cancellingSubscriptions: number;
  appUsers: number;
  activeAppUsers30d: number;
  activeAppUsersPrior30d: number;
  staffEnrolled: number;
}

export interface AttentionFlag {
  kind: AttentionKind;
  /** Plain-language reason including the days / counts involved. */
  reason: string;
}

export interface HealthScoreParts {
  recency: number;
  subscribers: number;
  appUsers: number;
  activeAppUsers: number;
  staff: number;
}

export interface OfficeHealth {
  providerId: string;
  officeName: string;
  providerName: string;
  rank: number;
  score: number;
  band: HealthBand;
  parts: HealthScoreParts;
  bucket: HealthBucket;
  isNew: boolean;
  /** Date key (YYYY-MM-DD, UTC) of the last paid order, or null. */
  lastOrderDate: string | null;
  lastOrderAt: string | null;
  daysSinceLastOrder: number | null;
  officeAgeDays: number | null;
  activeSubscribers: number;
  cancellingSubscriptions: number;
  appUsers: number;
  activeAppUsers30d: number;
  activeAppUsersPrior30d: number;
  staffEnrolled: number;
  flags: AttentionFlag[];
}

export interface CustomerHealthSummary {
  generatedAt: string;
  offices: OfficeHealth[];
  bucketCounts: Record<HealthBucket, number>;
  bandCounts: Record<HealthBand, number>;
  /** Flagged offices, worst score first (ties by rank, then name). */
  attention: OfficeHealth[];
}

const DAY_MS = 86_400_000;

/** Whole days elapsed from `from` to `asOf` (floor; never negative); null when `from` is missing or unparseable. */
export function daysBetween(from: string | null, asOf: Date): number | null {
  if (!from) return null;
  const t = Date.parse(from);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((asOf.getTime() - t) / DAY_MS));
}

export function recencyPoints(daysSinceLastOrder: number | null): number {
  if (daysSinceLastOrder === null) return 0;
  if (daysSinceLastOrder <= RECENCY_FULL_DAYS) return HEALTH_WEIGHTS.recency;
  if (daysSinceLastOrder >= RECENCY_ZERO_DAYS) return 0;
  const span = RECENCY_ZERO_DAYS - RECENCY_FULL_DAYS;
  return HEALTH_WEIGHTS.recency * (1 - (daysSinceLastOrder - RECENCY_FULL_DAYS) / span);
}

function saturating(count: number, target: number, weight: number): number {
  if (!(count > 0)) return 0;
  return weight * Math.min(1, count / target);
}

export function bucketFor(daysSinceLastOrder: number | null): HealthBucket {
  if (daysSinceLastOrder === null) return "quietOverYear";
  if (daysSinceLastOrder <= BUCKET_BOUNDS.active) return "active";
  if (daysSinceLastOrder <= BUCKET_BOUNDS.quiet3to6) return "quiet3to6";
  if (daysSinceLastOrder <= BUCKET_BOUNDS.quiet6to12) return "quiet6to12";
  return "quietOverYear";
}

export function bandFor(score: number): HealthBand {
  if (score >= BAND_THRESHOLDS.healthy) return "healthy";
  if (score >= BAND_THRESHOLDS.watch) return "watch";
  return "atRisk";
}

export function isNewOffice(officeAgeDays: number | null, daysSinceLastOrder: number | null): boolean {
  return daysSinceLastOrder === null && officeAgeDays !== null && officeAgeDays < NEW_OFFICE_DAYS;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The attention flags for one office, in a fixed display order. */
export function attentionFlags(input: {
  daysSinceLastOrder: number | null;
  activeAppUsers30d: number;
  activeAppUsersPrior30d: number;
  cancellingSubscriptions: number;
  band: HealthBand;
  isNew: boolean;
}): AttentionFlag[] {
  const flags: AttentionFlag[] = [];
  const days = input.daysSinceLastOrder;
  if (days !== null && days >= ATTENTION_RULES.leavingActive.from && days <= ATTENTION_RULES.leavingActive.to) {
    flags.push({
      kind: "leavingActive",
      reason: `Last order ${plural(days, "day")} ago — about to leave Active (${BUCKET_BOUNDS.active}-day mark).`,
    });
  }
  if (days !== null && days >= ATTENTION_RULES.passingSixMonths.from && days <= ATTENTION_RULES.passingSixMonths.to) {
    flags.push({
      kind: "passingSixMonths",
      reason: `Last order ${plural(days, "day")} ago — about to pass six months without an order.`,
    });
  }
  const prior = input.activeAppUsersPrior30d;
  if (prior >= ATTENTION_RULES.activeUsersDropMinPrior) {
    const dropPct = Math.round(((prior - input.activeAppUsers30d) / prior) * 100);
    if (dropPct >= ATTENTION_RULES.activeUsersDropPct) {
      flags.push({
        kind: "activeUsersDrop",
        reason: `Active app users down ${dropPct}% — ${input.activeAppUsers30d} in the last 30 days vs ${prior} in the 30 days before.`,
      });
    }
  }
  if (input.cancellingSubscriptions > 0) {
    flags.push({
      kind: "subscriptionsCancelling",
      reason: `${plural(input.cancellingSubscriptions, "active subscription")} set to cancel at period end.`,
    });
  }
  if (input.band === "atRisk" && !input.isNew) {
    flags.push({ kind: "atRisk", reason: "Health score is At risk (below 40) and the office is not new." });
  }
  return flags;
}

/** Score one office. Rank is filled in by `summarizeCustomerHealth`. */
export function scoreOffice(facts: OfficeHealthFacts, asOf: Date): Omit<OfficeHealth, "rank"> {
  const daysSinceLastOrder = daysBetween(facts.lastPaidOrderAt, asOf);
  const officeAgeDays = daysBetween(facts.createdAt, asOf);
  const parts: HealthScoreParts = {
    recency: recencyPoints(daysSinceLastOrder),
    subscribers: saturating(facts.activeSubscribers, HEALTH_TARGETS.subscribers, HEALTH_WEIGHTS.subscribers),
    appUsers: saturating(facts.appUsers, HEALTH_TARGETS.appUsers, HEALTH_WEIGHTS.appUsers),
    activeAppUsers:
      facts.appUsers > 0 ? HEALTH_WEIGHTS.activeAppUsers * Math.min(1, facts.activeAppUsers30d / facts.appUsers) : 0,
    staff: saturating(facts.staffEnrolled, HEALTH_TARGETS.staff, HEALTH_WEIGHTS.staff),
  };
  const raw = parts.recency + parts.subscribers + parts.appUsers + parts.activeAppUsers + parts.staff;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const band = bandFor(score);
  const isNew = isNewOffice(officeAgeDays, daysSinceLastOrder);
  return {
    providerId: facts.providerId,
    officeName: facts.officeName,
    providerName: facts.providerName,
    score,
    band,
    parts: {
      recency: round1(parts.recency),
      subscribers: round1(parts.subscribers),
      appUsers: round1(parts.appUsers),
      activeAppUsers: round1(parts.activeAppUsers),
      staff: round1(parts.staff),
    },
    bucket: bucketFor(daysSinceLastOrder),
    isNew,
    lastOrderDate: facts.lastPaidOrderAt ? new Date(Date.parse(facts.lastPaidOrderAt)).toISOString().slice(0, 10) : null,
    lastOrderAt: facts.lastPaidOrderAt,
    daysSinceLastOrder,
    officeAgeDays,
    activeSubscribers: facts.activeSubscribers,
    cancellingSubscriptions: facts.cancellingSubscriptions,
    appUsers: facts.appUsers,
    activeAppUsers30d: facts.activeAppUsers30d,
    activeAppUsersPrior30d: facts.activeAppUsersPrior30d,
    staffEnrolled: facts.staffEnrolled,
    flags: attentionFlags({
      daysSinceLastOrder,
      activeAppUsers30d: facts.activeAppUsers30d,
      activeAppUsersPrior30d: facts.activeAppUsersPrior30d,
      cancellingSubscriptions: facts.cancellingSubscriptions,
      band,
      isNew,
    }),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Worst first: lowest score, then rank, then name — the "Pay attention this week" order. */
export function compareWorstFirst(a: OfficeHealth, b: OfficeHealth): number {
  return a.score - b.score || a.rank - b.rank || a.officeName.localeCompare(b.officeName) || a.providerId.localeCompare(b.providerId);
}

/** Score, rank (ties share a rank) and summarize every office as of one instant. */
export function summarizeCustomerHealth(facts: OfficeHealthFacts[], asOf: Date): CustomerHealthSummary {
  const scored = facts
    .map((f) => scoreOffice(f, asOf))
    .sort((a, b) => b.score - a.score || a.officeName.localeCompare(b.officeName) || a.providerId.localeCompare(b.providerId));
  const offices: OfficeHealth[] = [];
  scored.forEach((row, index) => {
    const rank = index > 0 && scored[index - 1].score === row.score ? offices[index - 1].rank : index + 1;
    offices.push({ ...row, rank });
  });
  const bucketCounts: Record<HealthBucket, number> = { active: 0, quiet3to6: 0, quiet6to12: 0, quietOverYear: 0 };
  const bandCounts: Record<HealthBand, number> = { healthy: 0, watch: 0, atRisk: 0 };
  for (const office of offices) {
    bucketCounts[office.bucket] += 1;
    bandCounts[office.band] += 1;
  }
  const attention = offices.filter((office) => office.flags.length > 0).sort(compareWorstFirst);
  return { generatedAt: asOf.toISOString(), offices, bucketCounts, bandCounts, attention };
}
