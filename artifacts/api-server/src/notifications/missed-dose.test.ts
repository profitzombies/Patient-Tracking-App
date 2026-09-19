/**
 * Missed-dose backup reminders: which occurrences are chased, when, and how
 * they land in the outbox (dedupe per occurrence, cap reservation, category,
 * expiry). Quiet hours and category preferences are the sender's job and are
 * covered there; this module must never pre-filter on them.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { MedicationRecord } from "../medications/schedule";
import { MemoryNotificationStore } from "./memory-store";
import { guardPushMessage } from "./push-guard";
import {
  DEFAULT_MISSED_DOSE_DAILY_CAP,
  MISSED_DOSE_CATEGORY,
  MISSED_DOSE_KIND,
  MISSED_DOSE_ROUTE,
  missedDoseDailyCap,
  missedDoseDedupeKey,
  missedDoseDelayMinutes,
  missedDosesFor,
  runMissedDoseEvaluation,
} from "./missed-dose";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const NY = "America/New_York";
const MED_DROPS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MED_SHOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function drops(over: Partial<MedicationRecord> = {}): MedicationRecord {
  return {
    id: MED_DROPS,
    name: "THINNR Protocol drops",
    form: "drops",
    dose: "1 mL under the tongue",
    scheduleKind: "daily",
    times: ["08:00", "15:00", "22:00"],
    weekday: null,
    notes: null,
    startDate: "2026-06-01",
    stopDate: null,
    source: "onboarding",
    version: null,
    ...over,
  };
}

function injection(over: Partial<MedicationRecord> = {}): MedicationRecord {
  return {
    id: MED_SHOT,
    name: "GLP-1 injection",
    form: "injection",
    dose: "0.5 mg",
    scheduleKind: "weekly",
    times: ["09:00"],
    weekday: 3, // Wednesday
    notes: null,
    startDate: "2026-06-01",
    stopDate: null,
    source: "onboarding",
    version: null,
    ...over,
  };
}

// 2026-07-01 is a Wednesday. 16:00Z = 12:00 New York (EDT).
const NOW = new Date("2026-07-01T16:00:00Z");

function facts(over: Partial<{ medications: MedicationRecord[]; logs: Array<{ medicationId: string; dueDate: string; dueTime: string; status: "taken" | "skipped" }> ; timezone: string | null; patientId: string }> = {}) {
  return {
    patientId: over.patientId ?? P1,
    providerId: "office-1",
    timezone: over.timezone === undefined ? NY : over.timezone,
    medications: over.medications ?? [drops(), injection()],
    logs: (over.logs ?? []).map((log, index) => ({
      id: `log-${index}`,
      medicationId: log.medicationId,
      dueDate: log.dueDate,
      dueTime: log.dueTime,
      status: log.status,
      source: "check_in" as const,
      loggedAt: NOW.toISOString(),
    })),
  };
}

afterEach(() => {
  delete process.env.MEDICATION_BACKUP_DELAY_MINUTES;
  delete process.env.MEDICATION_BACKUP_DAILY_CAP;
});

describe("missedDosesFor", () => {
  it("chases unlogged occurrences past the delay, in the patient's zone, and leaves logged or not-yet-late ones alone", () => {
    // Window: last 24 h up to 11:00 NY (delay 60 min). Due: yesterday 15:00 and
    // 22:00 drops, today 08:00 drops, today 09:00 injection (Wednesday). Today's
    // 15:00 drops are still ahead. Yesterday's 08:00 is older than 24 h.
    const missed = missedDosesFor(facts({ logs: [{ medicationId: MED_DROPS, dueDate: "2026-06-30", dueTime: "22:00", status: "taken" }] }), NOW, 60);
    expect(missed.map((m) => `${m.medication.name}@${m.occurrence.dueDate} ${m.occurrence.dueTime}`)).toEqual([
      "THINNR Protocol drops@2026-06-30 15:00",
      "THINNR Protocol drops@2026-07-01 08:00",
      "GLP-1 injection@2026-07-01 09:00",
    ]);
    expect(missed[1].occurrence.dueAt).toBe("2026-07-01T12:00:00.000Z");
  });

  it("respects the delay: a dose due 30 minutes ago is not chased with a 60-minute delay, but is with 15", () => {
    // 11:30 NY dose, now 12:00 NY.
    const med = drops({ times: ["11:30"] });
    expect(missedDosesFor(facts({ medications: [med] }), NOW, 60)).toHaveLength(0);
    expect(missedDosesFor(facts({ medications: [med] }), NOW, 15).map((m) => m.occurrence.dueTime)).toEqual(["11:30"]);
  });

  it("skips a skipped dose too (any decision counts) and ignores stopped or not-yet-started medications", () => {
    // The stop date is the last scheduled day, so a stop of 06-29 leaves nothing in the window.
    const stopped = drops({ stopDate: "2026-06-29" });
    const future = injection({ startDate: "2026-07-02" });
    const missed = missedDosesFor(
      facts({
        medications: [stopped, future, drops({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", times: ["08:00"] })],
        logs: [{ medicationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", dueDate: "2026-07-01", dueTime: "08:00", status: "skipped" }],
      }),
      NOW,
      60,
    );
    expect(missed).toHaveLength(0);
  });

  it("uses UTC for an account without a timezone, and the weekly day is the patient's local weekday", () => {
    // Without a zone, 09:00 UTC Wednesday is 7 hours before NOW (16:00Z): due.
    const missed = missedDosesFor(facts({ timezone: null, medications: [injection()] }), NOW, 60);
    expect(missed.map((m) => m.occurrence.dueAt)).toEqual(["2026-07-01T09:00:00.000Z"]);
    // In Auckland it is already Thursday 04:00 on 2026-07-02; Wednesday 09:00
    // NZST was 2026-06-30T21:00Z — 19 hours ago, inside the window.
    expect(missedDosesFor(facts({ timezone: "Pacific/Auckland", medications: [injection()] }), NOW, 60).map((m) => m.occurrence.dueAt)).toEqual([
      "2026-06-30T21:00:00.000Z",
    ]);
  });
});

describe("runMissedDoseEvaluation", () => {
  it("enqueues one capped, deduped check_in_reminders row per missed occurrence with a route the app can open, and never twice", async () => {
    const store = new MemoryNotificationStore(() => NOW);
    store.addPatient({ patientId: P1, providerId: "office-1", timezone: NY, medications: [drops({ times: ["08:00"] }), injection()] });
    store.addPatient({ patientId: P2, providerId: "office-1", timezone: NY, medications: [drops({ times: ["08:00"] })], doseLogs: [
      { id: "l1", medicationId: MED_DROPS, dueDate: "2026-07-01", dueTime: "08:00", status: "taken", source: "reminder", loggedAt: NOW.toISOString() },
    ] });
    const first = await runMissedDoseEvaluation({ store, now: () => NOW, delayMinutes: 60 });
    expect(first).toEqual({ patients: 2, due: 2, sent: 2, capped: 0, errors: 0 });
    const rows = [...store.notifications.values()];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.patient_id === P1 && row.kind === MISSED_DOSE_KIND && row.category === MISSED_DOSE_CATEGORY)).toBe(true);
    const shot = rows.find((row) => row.dedupe_key === missedDoseDedupeKey({ medicationId: MED_SHOT, dueDate: "2026-07-01", dueTime: "09:00" }))!;
    expect(shot.title).toBe("Time for a dose");
    expect(shot.body).toBe("Open the app to log it.");
    expect(shot.data).toEqual({ route: MISSED_DOSE_ROUTE, medicationId: MED_SHOT, dueDate: "2026-07-01", dueTime: "09:00" });
    // The push rides a vendor without a BAA: no medication, dose, or time on the lock screen.
    for (const row of rows) {
      const visible = `${row.title} ${row.body} ${JSON.stringify(row.data)}`;
      expect(visible).not.toMatch(/GLP-1|injection|drops|0\.5 mg|9:00 AM|8:00 AM/i);
      expect(guardPushMessage({ to: "ExponentPushToken[x]", title: row.title, body: row.body, data: row.data })).toEqual({ ok: true });
    }
    // 24 h past the due instant (13:00Z), not past enqueue time.
    expect(shot.expires_at).toBe("2026-07-02T13:00:00.000Z");
    expect(shot.status).toBe("queued");

    const second = await runMissedDoseEvaluation({ store, now: () => new Date(NOW.getTime() + 10 * 60_000), delayMinutes: 60 });
    expect(second).toEqual({ patients: 2, due: 2, sent: 0, capped: 0, errors: 0 });
    expect(store.notifications.size).toBe(2);
  });

  it("stops at the organization-wide daily cap for this kind and reports the remainder as capped", async () => {
    const store = new MemoryNotificationStore(() => NOW);
    store.addPatient({ patientId: P1, providerId: "office-1", timezone: NY, medications: [drops()] });
    const summary = await runMissedDoseEvaluation({ store, now: () => NOW, delayMinutes: 60, dailyCap: 1 });
    expect(summary).toMatchObject({ due: 3, sent: 1, capped: 2 });
    expect(store.notifications.size).toBe(1);
  });

  it("does not touch an inactive patient and reads the delay and cap knobs blank-safely", async () => {
    const store = new MemoryNotificationStore(() => NOW);
    store.addPatient({ patientId: P1, providerId: "office-1", timezone: NY, activated: false, medications: [drops()] });
    expect(await runMissedDoseEvaluation({ store, now: () => NOW })).toEqual({ patients: 0, due: 0, sent: 0, capped: 0, errors: 0 });

    process.env.MEDICATION_BACKUP_DELAY_MINUTES = "";
    expect(missedDoseDelayMinutes()).toBe(60);
    process.env.MEDICATION_BACKUP_DELAY_MINUTES = "15";
    expect(missedDoseDelayMinutes()).toBe(15);
    process.env.MEDICATION_BACKUP_DAILY_CAP = "0";
    expect(missedDoseDailyCap()).toBe(DEFAULT_MISSED_DOSE_DAILY_CAP);
    process.env.MEDICATION_BACKUP_DAILY_CAP = "25";
    expect(missedDoseDailyCap()).toBe(25);
  });
});
