import { describe, expect, it } from "vitest";
import {
  ATTENTION_RULES,
  BUCKET_BOUNDS,
  HEALTH_TARGETS,
  HEALTH_WEIGHTS,
  attentionFlags,
  bandFor,
  bucketFor,
  isNewOffice,
  recencyPoints,
  scoreOffice,
  summarizeCustomerHealth,
  type OfficeHealthFacts,
} from "./scoring";

const AS_OF = new Date("2026-10-09T15:00:00Z");
const daysAgo = (n: number) => new Date(AS_OF.getTime() - n * 86_400_000).toISOString();

function facts(overrides: Partial<OfficeHealthFacts> = {}): OfficeHealthFacts {
  return {
    providerId: "office-1",
    officeName: "Alpha Clinic",
    providerName: "Dr. Alpha",
    createdAt: daysAgo(400),
    lastPaidOrderAt: null,
    activeSubscribers: 0,
    cancellingSubscriptions: 0,
    appUsers: 0,
    activeAppUsers30d: 0,
    activeAppUsersPrior30d: 0,
    staffEnrolled: 0,
    ...overrides,
  };
}

describe("weights and targets", () => {
  it("sum to 100 and match the agreed values", () => {
    expect(Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(HEALTH_WEIGHTS).toEqual({ recency: 40, subscribers: 15, appUsers: 15, activeAppUsers: 15, staff: 15 });
    expect(HEALTH_TARGETS).toEqual({ subscribers: 10, appUsers: 25, staff: 3 });
  });
});

describe("recency points", () => {
  it("is full through 30 days, starts falling at 31, and is zero from 365", () => {
    expect(recencyPoints(0)).toBe(40);
    expect(recencyPoints(29)).toBe(40);
    expect(recencyPoints(30)).toBe(40);
    expect(recencyPoints(31)).toBeLessThan(40);
    expect(recencyPoints(31)).toBeCloseTo(40 * (1 - 1 / 335), 6);
    expect(recencyPoints(364)).toBeGreaterThan(0);
    expect(recencyPoints(365)).toBe(0);
    expect(recencyPoints(366)).toBe(0);
    expect(recencyPoints(null)).toBe(0);
  });
});

describe("buckets", () => {
  it("splits at 90 / 180 / 365 inclusive and sends no-order offices to the last bucket", () => {
    expect(bucketFor(0)).toBe("active");
    expect(bucketFor(90)).toBe("active");
    expect(bucketFor(91)).toBe("quiet3to6");
    expect(bucketFor(180)).toBe("quiet3to6");
    expect(bucketFor(181)).toBe("quiet6to12");
    expect(bucketFor(365)).toBe("quiet6to12");
    expect(bucketFor(366)).toBe("quietOverYear");
    expect(bucketFor(null)).toBe("quietOverYear");
    expect(BUCKET_BOUNDS).toEqual({ active: 90, quiet3to6: 180, quiet6to12: 365 });
  });
});

describe("bands", () => {
  it("Healthy 70+, Watch 40–69, At risk below 40", () => {
    expect(bandFor(100)).toBe("healthy");
    expect(bandFor(70)).toBe("healthy");
    expect(bandFor(69)).toBe("watch");
    expect(bandFor(40)).toBe("watch");
    expect(bandFor(39)).toBe("atRisk");
    expect(bandFor(0)).toBe("atRisk");
  });
});

describe("New rule", () => {
  it("applies only to offices under 90 days old with no order", () => {
    expect(isNewOffice(0, null)).toBe(true);
    expect(isNewOffice(89, null)).toBe(true);
    expect(isNewOffice(90, null)).toBe(false);
    expect(isNewOffice(10, 3)).toBe(false);
    expect(isNewOffice(null, null)).toBe(false);
  });

  it("a New office sits in the last bucket with the badge and no At-risk flag", () => {
    const row = scoreOffice(facts({ createdAt: daysAgo(10) }), AS_OF);
    expect(row).toMatchObject({ bucket: "quietOverYear", isNew: true, score: 0, band: "atRisk", lastOrderDate: null, daysSinceLastOrder: null });
    expect(row.flags).toEqual([]);
    const old = scoreOffice(facts({ createdAt: daysAgo(90) }), AS_OF);
    expect(old.isNew).toBe(false);
    expect(old.flags.map((f) => f.kind)).toEqual(["atRisk"]);
  });
});

describe("score parts", () => {
  it("no orders, no users, no staff = honest zero with the recency part at 0", () => {
    const row = scoreOffice(facts(), AS_OF);
    expect(row.score).toBe(0);
    expect(row.parts).toEqual({ recency: 0, subscribers: 0, appUsers: 0, activeAppUsers: 0, staff: 0 });
  });

  it("saturates at the targets and gives active users as a share of app users", () => {
    const full = scoreOffice(
      facts({ lastPaidOrderAt: daysAgo(30), activeSubscribers: 10, appUsers: 25, activeAppUsers30d: 25, staffEnrolled: 3 }),
      AS_OF,
    );
    expect(full.score).toBe(100);
    expect(full.band).toBe("healthy");
    const over = scoreOffice(
      facts({ lastPaidOrderAt: daysAgo(1), activeSubscribers: 40, appUsers: 250, activeAppUsers30d: 999, staffEnrolled: 12 }),
      AS_OF,
    );
    expect(over.score).toBe(100);
    const half = scoreOffice(facts({ activeSubscribers: 5, appUsers: 10, activeAppUsers30d: 5, staffEnrolled: 1 }), AS_OF);
    expect(half.parts).toEqual({ recency: 0, subscribers: 7.5, appUsers: 6, activeAppUsers: 7.5, staff: 5 });
    expect(half.score).toBe(26);
  });

  it("active app users score 0 when the office has no app users, even with stray activity", () => {
    const row = scoreOffice(facts({ appUsers: 0, activeAppUsers30d: 4 }), AS_OF);
    expect(row.parts.activeAppUsers).toBe(0);
  });

  it("reports the last order date and days since from the paid instant", () => {
    const row = scoreOffice(facts({ lastPaidOrderAt: "2026-09-09T23:30:00Z" }), AS_OF);
    expect(row.lastOrderDate).toBe("2026-09-09");
    expect(row.daysSinceLastOrder).toBe(29);
    expect(row.parts.recency).toBe(40);
    expect(scoreOffice(facts({ lastPaidOrderAt: daysAgo(31) }), AS_OF).parts.recency).toBe(39.9);
  });
});

describe("attention flags", () => {
  const base = { activeAppUsers30d: 0, activeAppUsersPrior30d: 0, cancellingSubscriptions: 0, band: "healthy" as const, isNew: false };

  it("flags the 60–90 and 150–180 day windows inclusively with the days in the reason", () => {
    const kinds = (days: number | null) => attentionFlags({ ...base, daysSinceLastOrder: days }).map((f) => f.kind);
    expect(kinds(59)).toEqual([]);
    expect(kinds(60)).toEqual(["leavingActive"]);
    expect(kinds(90)).toEqual(["leavingActive"]);
    expect(kinds(91)).toEqual([]);
    expect(kinds(149)).toEqual([]);
    expect(kinds(150)).toEqual(["passingSixMonths"]);
    expect(kinds(180)).toEqual(["passingSixMonths"]);
    expect(kinds(181)).toEqual([]);
    expect(kinds(null)).toEqual([]);
    expect(attentionFlags({ ...base, daysSinceLastOrder: 75 })[0].reason).toBe("Last order 75 days ago — about to leave Active (90-day mark).");
    expect(attentionFlags({ ...base, daysSinceLastOrder: 1 })).toEqual([]);
  });

  it("flags a 30%+ drop in active app users only when the prior window had at least 3", () => {
    const drop = (now: number, prior: number) =>
      attentionFlags({ ...base, daysSinceLastOrder: 1, activeAppUsers30d: now, activeAppUsersPrior30d: prior });
    expect(drop(7, 10).map((f) => f.kind)).toEqual(["activeUsersDrop"]);
    expect(drop(7, 10)[0].reason).toBe("Active app users down 30% — 7 in the last 30 days vs 10 in the 30 days before.");
    expect(drop(8, 10)).toEqual([]);
    expect(drop(0, 2)).toEqual([]); // prior too small
    expect(drop(0, 3).map((f) => f.kind)).toEqual(["activeUsersDrop"]);
    expect(drop(12, 10)).toEqual([]); // growth
    expect(ATTENTION_RULES.activeUsersDropMinPrior).toBe(3);
  });

  it("flags cancelling subscriptions and At-risk (non-New) offices", () => {
    expect(attentionFlags({ ...base, daysSinceLastOrder: 1, cancellingSubscriptions: 2 })).toEqual([
      { kind: "subscriptionsCancelling", reason: "2 active subscriptions set to cancel at period end." },
    ]);
    expect(attentionFlags({ ...base, daysSinceLastOrder: 1, cancellingSubscriptions: 1 })[0].reason).toBe("1 active subscription set to cancel at period end.");
    expect(attentionFlags({ ...base, daysSinceLastOrder: null, band: "atRisk" }).map((f) => f.kind)).toEqual(["atRisk"]);
    expect(attentionFlags({ ...base, daysSinceLastOrder: null, band: "atRisk", isNew: true })).toEqual([]);
    expect(attentionFlags({ ...base, daysSinceLastOrder: null, band: "watch" })).toEqual([]);
  });

  it("stacks several reasons in a fixed order", () => {
    const flags = attentionFlags({ daysSinceLastOrder: 160, activeAppUsers30d: 1, activeAppUsersPrior30d: 5, cancellingSubscriptions: 1, band: "atRisk", isNew: false });
    expect(flags.map((f) => f.kind)).toEqual(["passingSixMonths", "activeUsersDrop", "subscriptionsCancelling", "atRisk"]);
  });
});

describe("summary", () => {
  it("ranks by score with shared ranks for ties, counts buckets and bands, and lists attention worst first", () => {
    const summary = summarizeCustomerHealth(
      [
        facts({ providerId: "a", officeName: "Alpha", lastPaidOrderAt: daysAgo(10), activeSubscribers: 10, appUsers: 25, activeAppUsers30d: 25, staffEnrolled: 3 }),
        facts({ providerId: "b", officeName: "Beta", lastPaidOrderAt: daysAgo(10), activeSubscribers: 10, appUsers: 25, activeAppUsers30d: 25, staffEnrolled: 3 }),
        facts({ providerId: "c", officeName: "Gamma", lastPaidOrderAt: daysAgo(75), appUsers: 10, activeAppUsers30d: 10 }),
        facts({ providerId: "d", officeName: "Delta", lastPaidOrderAt: daysAgo(200) }),
        facts({ providerId: "e", officeName: "Epsilon", createdAt: daysAgo(5) }),
        facts({ providerId: "f", officeName: "Zeta", lastPaidOrderAt: daysAgo(400), cancellingSubscriptions: 1 }),
      ],
      AS_OF,
    );
    expect(summary.generatedAt).toBe(AS_OF.toISOString());
    expect(summary.offices.map((o) => [o.providerId, o.rank, o.score])).toEqual([
      ["a", 1, 100],
      ["b", 1, 100],
      ["c", 3, 56], // 40 × (1 − 45/335) + 6 + 15 = 55.6
      ["d", 4, 20],
      ["e", 5, 0],
      ["f", 5, 0],
    ]);
    expect(summary.bucketCounts).toEqual({ active: 3, quiet3to6: 0, quiet6to12: 1, quietOverYear: 2 });
    expect(summary.bandCounts).toEqual({ healthy: 2, watch: 1, atRisk: 3 });
    // Epsilon is New: in the last bucket, badge on, not flagged. Zeta: cancelling + at risk. Delta: at risk. Gamma: leaving Active.
    expect(summary.offices.find((o) => o.providerId === "e")).toMatchObject({ isNew: true, bucket: "quietOverYear", flags: [] });
    expect(summary.attention.map((o) => o.providerId)).toEqual(["f", "d", "c"]);
    expect(summary.attention[0].flags.map((f) => f.kind)).toEqual(["subscriptionsCancelling", "atRisk"]);
    expect(summary.attention[2].flags.map((f) => f.kind)).toEqual(["leavingActive"]);
  });

  it("handles an empty network", () => {
    expect(summarizeCustomerHealth([], AS_OF)).toEqual({
      generatedAt: AS_OF.toISOString(),
      offices: [],
      bucketCounts: { active: 0, quiet3to6: 0, quiet6to12: 0, quietOverYear: 0 },
      bandCounts: { healthy: 0, watch: 0, atRisk: 0 },
      attention: [],
    });
  });
});
