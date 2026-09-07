/**
 * Server-side coach stall outreach for real accounts.
 *
 * The trigger math is the mobile app's own module, imported directly
 * (artifacts/thinnr-mobile/data/stall-nudge.ts): classified diary entries plus
 * the check-in weigh-in series, assessed as of the patient's local day, gated
 * by the persisted nudge flags (opt-out, engaged, last sent / last crossing).
 * That keeps the server and the app in literal agreement rather than parity
 * by convention; the verify suite runs both copies on one fixture anyway.
 *
 * When an episode is due the evaluator does three things, in this order:
 *   1. seeds the outreach bubble into the patient's persisted coach thread
 *      (client id `coach-outreach:<crossing>`, with the accept/decline chips)
 *      so the notification opens onto a thread that already holds it;
 *   2. enqueues the push (dedupe key per patient + episode, category
 *      coach_outreach) — the sender applies preferences and quiet hours;
 *   3. stamps the nudge flags exactly the way the app's recordNudgeSent does
 *      (lastSentKey = today, lastCrossingKey = episode, engaged = false), so
 *      the app's own gate sees the episode as already sent.
 * The demo persona never reaches this path: it keeps its local, session-only
 * seeding in CoachChatContext.
 */
import {
  assessNudge,
  BACK_ON_TRACK_OFFER,
  classifyEntries,
  CROSSING_LOOKBACK_DAYS,
  shouldSendOutreach,
  STALL_WINDOW_DAYS,
  type NudgeAssessment,
  type OutreachGateState,
} from "../../../thinnr-mobile/data/stall-nudge";
import { dayKeyInTimeZone } from "../lib/local-day";
import type { NotificationStore, OutreachFacts } from "./store";

export const OUTREACH_KIND = "coach_outreach";
export const OUTREACH_TITLE = "A note from your coach";
export const OUTREACH_ACCEPT = "Yes, set me up";
export const OUTREACH_DECLINE = "Not right now";
export const OUTREACH_ROUTE = "/coach-chat";
/** Re-evaluate a patient at most this often. */
export const OUTREACH_EVALUATION_INTERVAL_MS = 6 * 60 * 60_000;
/** Diary lookback handed to the assessment (window + crossing trace + slack). */
export const OUTREACH_LOOKBACK_DAYS = STALL_WINDOW_DAYS + CROSSING_LOOKBACK_DAYS + 7;

export function outreachClientId(crossingKey: string): string {
  return `coach-outreach:${crossingKey}`;
}

export function outreachDedupeKey(patientId: string, crossingKey: string): string {
  return `coach_outreach:${patientId}:${crossingKey}`;
}

export function shiftDayKey(dateKey: string, days: number): string {
  const ms = new Date(`${dateKey}T12:00:00.000Z`).getTime() + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export interface OutreachMessageFacts {
  firstName: string;
  startingWeight: number | null;
  currentWeight: number | null;
  offPlan: number;
}

/**
 * The outreach bubble for a real account, in the same shape as the demo's
 * fixed string but built from the patient's stored facts. Program voice, no
 * dashes, ends on the shared offer so the back-on-track turn keys off it.
 */
export function composeOutreachMessage(facts: OutreachMessageFacts): string {
  const firstName = facts.firstName.trim() || "there";
  const lost =
    facts.startingWeight !== null && facts.currentWeight !== null
      ? Math.round((facts.startingWeight - facts.currentWeight) * 10) / 10
      : null;
  const opener = `${firstName}, I was looking at your numbers today and wanted to reach out myself.`;
  const work =
    lost !== null && lost > 0
      ? `You've put in real work. ${lost} pounds down since you started, and that stands.`
      : `You've put in real work, and that stands.`;
  const level =
    facts.currentWeight !== null
      ? `The last three weeks the scale has been holding right around ${Math.round(facts.currentWeight)}, `
      : `The last three weeks the scale has been holding steady, `;
  const diary = `and the diary shows off-plan items sneaking in, ${facts.offPlan} of them in the last two weeks. That's not failure, that's a pattern, and patterns can be changed.`;
  return `${opener}\n\n${work} ${level}${diary}\n\n${BACK_ON_TRACK_OFFER}`;
}

export function outreachPushBody(firstName: string): string {
  const name = firstName.trim() || "there";
  return `${name}, I was looking at your numbers today and wanted to reach out myself. Open the chat when you have a minute.`;
}

export type OutreachDecision = "inactive" | "opt_out" | "engaged" | "standing" | "cooldown" | "send";

export interface OutreachEvaluation {
  todayKey: string;
  assessment: NudgeAssessment;
  gate: OutreachGateState;
  decision: OutreachDecision;
}

/** Pure: the same decision the app's PatientContext would reach today. */
export function evaluateOutreach(facts: OutreachFacts, now: Date): OutreachEvaluation {
  const todayKey = dayKeyInTimeZone(facts.timezone, now);
  const entries = classifyEntries(
    facts.entries.map((entry) => ({
      dateKey: entry.dateKey,
      kind: entry.kind as "food" | "recipe" | "quick",
      refId: entry.refId,
    })),
  );
  const byDay = new Map<string, number>();
  for (const weighIn of [...facts.weighIns].sort((a, b) => a.dateKey.localeCompare(b.dateKey))) {
    byDay.set(weighIn.dateKey, weighIn.weight);
  }
  const weighIns = [...byDay.entries()]
    .map(([dateKey, weight]) => ({ dateKey, weight }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const assessment = assessNudge(entries, weighIns, todayKey);
  const gate: OutreachGateState = {
    optOut: facts.flags.nudgeOptOut,
    engaged: facts.flags.nudgeEngaged,
    lastSentKey: facts.flags.nudgeLastSentKey,
    lastCrossingKey: facts.flags.nudgeLastCrossingKey,
  };
  let decision: OutreachDecision;
  if (!assessment.active || assessment.crossedOnKey === null) decision = "inactive";
  else if (gate.optOut) decision = "opt_out";
  else if (shouldSendOutreach(assessment, gate, todayKey)) decision = "send";
  else if (gate.lastCrossingKey === assessment.crossedOnKey) decision = gate.engaged ? "engaged" : "standing";
  else decision = "cooldown";
  return { todayKey, assessment, gate, decision };
}

export interface OutreachRunSummary {
  evaluated: number;
  sent: number;
  errors: number;
}

export interface OutreachRunDeps {
  store: NotificationStore;
  now?: () => Date;
  limit?: number;
  intervalMs?: number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/** Evaluates one patient and performs the send side effects when due. */
export async function evaluateAndSendOutreach(
  store: NotificationStore,
  patientId: string,
  now: Date,
): Promise<{ evaluation: OutreachEvaluation; notificationId: string | null } | null> {
  const todayGuess = dayKeyInTimeZone(null, now);
  const facts = await store.outreachFacts(patientId, shiftDayKey(todayGuess, -OUTREACH_LOOKBACK_DAYS));
  if (!facts) return null;
  const evaluation = evaluateOutreach(facts, now);
  let notificationId: string | null = null;

  if (evaluation.decision === "send" && evaluation.assessment.crossedOnKey) {
    const crossing = evaluation.assessment.crossedOnKey;
    const latest = facts.weighIns.length ? facts.weighIns[facts.weighIns.length - 1] : null;
    const text = composeOutreachMessage({
      firstName: facts.firstName,
      startingWeight: facts.startingWeight,
      currentWeight: latest?.weight ?? null,
      offPlan: evaluation.assessment.adherence.offPlan,
    });
    await store.seedCoachMessage(patientId, {
      clientId: outreachClientId(crossing),
      text,
      quickReplies: [OUTREACH_ACCEPT, OUTREACH_DECLINE],
    });
    const { row } = await store.enqueue({
      patientId,
      kind: OUTREACH_KIND,
      category: "coach_outreach",
      title: OUTREACH_TITLE,
      body: outreachPushBody(facts.firstName),
      data: { route: OUTREACH_ROUTE, crossingKey: crossing, messageClientId: outreachClientId(crossing) },
      dedupeKey: outreachDedupeKey(patientId, crossing),
      scheduledAt: now,
    });
    notificationId = row.id;
    await store.stampNudgeFlags(patientId, {
      nudgeLastSentKey: evaluation.todayKey,
      nudgeLastCrossingKey: crossing,
      nudgeEngaged: false,
    });
  } else {
    // Keep the newest outreach row linked for the roster while an episode
    // stands (standing/engaged/cooldown all refer to the stamped episode).
    const stamped = evaluation.gate.lastCrossingKey;
    if (stamped) {
      const existing = await store.listPatientNotifications(patientId, 50);
      notificationId =
        existing.find((n) => n.kind === OUTREACH_KIND && n.dedupe_key === outreachDedupeKey(patientId, stamped))?.id ??
        null;
    }
  }

  await store.saveOutreachState({
    patient_id: patientId,
    provider_id: facts.providerId,
    evaluated_at: now.toISOString(),
    as_of_date: evaluation.todayKey,
    eligible: evaluation.assessment.active,
    crossed_on_key: evaluation.assessment.crossedOnKey,
    adherence: { ...evaluation.assessment.adherence },
    stall: { ...evaluation.assessment.stall },
    decision: evaluation.decision,
    notification_id: notificationId,
  });
  return { evaluation, notificationId };
}

export async function runOutreachEvaluation(deps: OutreachRunDeps): Promise<OutreachRunSummary> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const summary: OutreachRunSummary = { evaluated: 0, sent: 0, errors: 0 };
  const cutoff = new Date(now().getTime() - (deps.intervalMs ?? OUTREACH_EVALUATION_INTERVAL_MS));
  const candidates = await deps.store.outreachCandidates(cutoff, deps.limit ?? 50);
  for (const candidate of candidates) {
    try {
      const result = await evaluateAndSendOutreach(deps.store, candidate.patientId, now());
      if (!result) continue;
      summary.evaluated += 1;
      if (result.evaluation.decision === "send") summary.sent += 1;
    } catch (error) {
      summary.errors += 1;
      log("outreach_evaluation_error", {
        patientId: candidate.patientId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
