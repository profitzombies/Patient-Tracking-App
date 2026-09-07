/**
 * Server-side coach outreach: the same decision the app reaches, plus the
 * send side effects (thread seed, outbox row, nudge flags) and their gates
 * (cooldown, one send per episode, opt-out, engagement, re-evaluation).
 */
import { describe, expect, it } from "vitest";
import {
  assessNudge,
  classifyEntries,
  NUDGE_COOLDOWN_DAYS,
  shouldSeedOutreach,
  shouldSendOutreach,
} from "../../../thinnr-mobile/data/stall-nudge";
import { dayKeyInTimeZone } from "../lib/local-day";
import { MemoryNotificationStore, type MemoryPatient } from "./memory-store";
import {
  composeOutreachMessage,
  evaluateAndSendOutreach,
  evaluateOutreach,
  outreachClientId,
  outreachDedupeKey,
  runOutreachEvaluation,
  shiftDayKey,
  OUTREACH_ACCEPT,
  OUTREACH_DECLINE,
} from "./stall-outreach";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const NY = "America/New_York";
const NOW = new Date("2026-07-01T16:00:00Z");
const TODAY = dayKeyInTimeZone(NY, NOW);
const d = (offset: number) => shiftDayKey(TODAY, -offset);

/** Two weeks of half off-plan meals: chicken breast is approved, "fd_pastry" is a seeded id that is not. */
function mixedDiary(days = 14) {
  const out: MemoryPatient["entries"] = [];
  for (let offset = 0; offset < days; offset++) {
    out.push({ dateKey: d(offset), kind: "food", refId: "fd_chicken_breast" });
    out.push({ dateKey: d(offset), kind: "food", refId: "fd_chicken_breast" });
    out.push({ dateKey: d(offset), kind: "food", refId: "fd_pastry" });
    out.push({ dateKey: d(offset), kind: "food", refId: "fd_pastry" });
  }
  return out;
}

/** Three weeks wobbling ±0.2 around 170: a plateau. */
function flatWeighIns() {
  const out: NonNullable<MemoryPatient["weighIns"]> = [];
  for (let offset = 20; offset >= 0; offset -= 2) out.push({ dateKey: d(offset), weight: offset % 4 === 0 ? 170.2 : 169.8 });
  return out;
}

/** Steadily dropping: no stall. */
function fallingWeighIns() {
  const out: NonNullable<MemoryPatient["weighIns"]> = [];
  for (let offset = 20; offset >= 0; offset -= 2) out.push({ dateKey: d(offset), weight: 170 + offset * 0.3 });
  return out;
}

function patient(overrides: Partial<MemoryPatient> = {}): MemoryPatient {
  return {
    patientId: P1,
    providerId: "prov-1",
    firstName: "Dana",
    timezone: NY,
    startingWeight: 188,
    entries: mixedDiary(),
    weighIns: flatWeighIns(),
    ...overrides,
  };
}

describe("outreach evaluation parity with the app", () => {
  it("reaches the app's decision on the same fixture", async () => {
    const store = new MemoryNotificationStore(() => NOW);
    store.addPatient(patient());
    const facts = (await store.outreachFacts(P1, d(60)))!;
    const evaluation = evaluateOutreach(facts, NOW);
    const appAssessment = assessNudge(
      classifyEntries(facts.entries.map((e) => ({ kind: e.kind as "food", refId: e.refId, dateKey: e.dateKey }))),
      facts.weighIns,
      TODAY,
    );
    expect(evaluation.assessment).toEqual(appAssessment);
    expect(appAssessment.active).toBe(true);
    const gate = { optOut: false, engaged: false, lastSentKey: null, lastCrossingKey: null };
    expect(shouldSendOutreach(appAssessment, gate, TODAY)).toBe(true);
    expect(evaluation.decision).toBe("send");
  });

  it("is inactive when the scale keeps moving, and opted out when nudges are paused", async () => {
    const store = new MemoryNotificationStore(() => NOW);
    store.addPatient(patient({ weighIns: fallingWeighIns() }));
    store.addPatient(patient({ patientId: P2, flags: { nudgeOptOut: true } }));
    expect(evaluateOutreach((await store.outreachFacts(P1, d(60)))!, NOW).decision).toBe("inactive");
    expect(evaluateOutreach((await store.outreachFacts(P2, d(60)))!, NOW).decision).toBe("opt_out");
  });

  it("uses the patient's local day, not the server's", async () => {
    // 03:00Z is still "yesterday" in New York; entries/weigh-ins are keyed to NY days.
    const lateNight = new Date(`${TODAY}T03:00:00Z`);
    const store = new MemoryNotificationStore(() => lateNight);
    store.addPatient(patient());
    const evaluation = evaluateOutreach((await store.outreachFacts(P1, d(60)))!, lateNight);
    expect(evaluation.todayKey).toBe(shiftDayKey(TODAY, -1));
  });
});

describe("outreach send side effects", () => {
  it("seeds the thread, enqueues one push per episode, and stamps the nudge flags like the app", async () => {
    const store = new MemoryNotificationStore(() => NOW);
    store.addPatient(patient());
    const result = (await evaluateAndSendOutreach(store, P1, NOW))!;
    expect(result.evaluation.decision).toBe("send");
    const crossing = result.evaluation.assessment.crossedOnKey!;

    expect(store.seededMessages).toHaveLength(1);
    const seeded = store.seededMessages[0].message;
    expect(seeded.clientId).toBe(outreachClientId(crossing));
    expect(seeded.quickReplies).toEqual([OUTREACH_ACCEPT, OUTREACH_DECLINE]);
    expect(seeded.text).toContain("Dana, I was looking at your numbers today");
    expect(seeded.text).toContain("17.8 pounds down since you started");
    expect(seeded.text).toContain("holding right around 170");
    expect(seeded.text).toContain("28 of them in the last two weeks");
    expect(seeded.text.endsWith("if you want one?")).toBe(true);
    expect(seeded.text).not.toMatch(/[—–]/);

    const rows = await store.listPatientNotifications(P1, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "coach_outreach",
      category: "coach_outreach",
      status: "queued",
      dedupe_key: outreachDedupeKey(P1, crossing),
      data: { route: "/coach-chat", crossingKey: crossing, messageClientId: outreachClientId(crossing) },
    });
    expect(result.notificationId).toBe(rows[0].id);

    const flags = store.patients.get(P1)!.flags!;
    expect(flags).toMatchObject({ nudgeLastSentKey: TODAY, nudgeLastCrossingKey: crossing, nudgeEngaged: false });
    expect(store.outreachStates.get(P1)).toMatchObject({
      eligible: true,
      crossed_on_key: crossing,
      decision: "send",
      notification_id: rows[0].id,
      as_of_date: TODAY,
    });

    // The app's own gate now sees the episode as sent (standing message, no re-send).
    const facts = (await store.outreachFacts(P1, d(60)))!;
    const gate = {
      optOut: facts.flags.nudgeOptOut,
      engaged: facts.flags.nudgeEngaged,
      lastSentKey: facts.flags.nudgeLastSentKey,
      lastCrossingKey: facts.flags.nudgeLastCrossingKey,
    };
    expect(shouldSendOutreach(result.evaluation.assessment, gate, TODAY)).toBe(false);
    expect(shouldSeedOutreach(result.evaluation.assessment, gate, TODAY)).toBe(true);

    // Re-evaluating the same episode neither re-seeds nor re-enqueues.
    const again = (await evaluateAndSendOutreach(store, P1, new Date(NOW.getTime() + 3600_000)))!;
    expect(again.evaluation.decision).toBe("standing");
    expect(again.notificationId).toBe(rows[0].id);
    expect(store.seededMessages).toHaveLength(1);
    expect(store.notifications.size).toBe(1);
  });

  it("reports engaged once the patient answered, and honors the cooldown across episodes", async () => {
    const store = new MemoryNotificationStore(() => NOW);
    store.addPatient(patient());
    const first = (await evaluateAndSendOutreach(store, P1, NOW))!;
    const crossing = first.evaluation.assessment.crossedOnKey!;
    // Patient replies -> app writes nudgeEngaged (the flags route stamps engaged_at).
    store.patients.get(P1)!.flags = { ...store.patients.get(P1)!.flags, nudgeEngaged: true };
    const engaged = (await evaluateAndSendOutreach(store, P1, NOW))!;
    expect(engaged.evaluation.decision).toBe("engaged");

    // A new episode two days later, inside the cooldown: not sent.
    store.patients.get(P1)!.flags = {
      nudgeOptOut: false,
      nudgeEngaged: false,
      nudgeLastSentKey: TODAY,
      nudgeLastCrossingKey: shiftDayKey(crossing, -30),
    };
    const soon = (await evaluateAndSendOutreach(store, P1, NOW))!;
    expect(soon.evaluation.decision).toBe("cooldown");
    expect(store.notifications.size).toBe(1);

    // Past the cooldown, a fresh episode sends again under a new dedupe key.
    store.patients.get(P1)!.flags = {
      nudgeOptOut: false,
      nudgeEngaged: false,
      nudgeLastSentKey: shiftDayKey(TODAY, -NUDGE_COOLDOWN_DAYS),
      nudgeLastCrossingKey: shiftDayKey(crossing, -30),
    };
    const later = (await evaluateAndSendOutreach(store, P1, NOW))!;
    expect(later.evaluation.decision).toBe("send");
    // Same crossing day on this fixture: the dedupe key guarantees one push
    // per episode even when the flags were reset underneath us.
    expect(store.notifications.size).toBe(1);
    expect(later.notificationId).toBe(first.notificationId);
    expect(store.patients.get(P1)!.flags).toMatchObject({ nudgeLastSentKey: TODAY, nudgeLastCrossingKey: crossing });
  });

  it("still seeds the coach message when the patient turned the push category off (the sender records opted_out)", async () => {
    const store = new MemoryNotificationStore(() => NOW);
    store.addPatient(patient({ prefs: { categories: { coachOutreach: false } } }));
    const result = (await evaluateAndSendOutreach(store, P1, NOW))!;
    expect(result.evaluation.decision).toBe("send");
    expect(store.seededMessages).toHaveLength(1);
    expect(store.notifications.size).toBe(1);
  });

  it("composes honest copy without a starting weight", () => {
    const text = composeOutreachMessage({ firstName: "", startingWeight: null, currentWeight: 201.4, offPlan: 7 });
    expect(text.startsWith("there, I was looking")).toBe(true);
    expect(text).toContain("You've put in real work, and that stands.");
    expect(text).toContain("right around 201");
    expect(text).not.toContain("pounds down");
  });

  it("evaluates only stale candidates on a run and skips paused patients", async () => {
    const store = new MemoryNotificationStore(() => NOW);
    store.addPatient(patient());
    store.addPatient(patient({ patientId: P2, activated: false }));
    let summary = await runOutreachEvaluation({ store, now: () => NOW });
    expect(summary).toEqual({ evaluated: 1, sent: 1, errors: 0 });
    // Fresh evaluation: nothing to do an hour later.
    summary = await runOutreachEvaluation({ store, now: () => new Date(NOW.getTime() + 3600_000) });
    expect(summary.evaluated).toBe(0);
    // Stale after the interval: re-evaluated, standing, no new send.
    summary = await runOutreachEvaluation({ store, now: () => new Date(NOW.getTime() + 7 * 3600_000) });
    expect(summary).toEqual({ evaluated: 1, sent: 0, errors: 0 });
  });
});
