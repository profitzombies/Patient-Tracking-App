import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Droplets, Smartphone } from "lucide-react";
import type { Patient } from "@/data/mock-data";
import {
  ARCHETYPE_LABELS,
  MEAL_LABELS,
  MEAL_SLOTS,
  MOOD_LABELS,
  WATER_CUP_OZ,
  formatDateKey,
  getLoggingStats,
  getNutritionProfile,
  isLapsed,
  summarizeMeals,
} from "@/data/nutrition-data";
import { AdherenceTrend } from "./AdherenceTrend";
import { PhotoTimeline } from "./PhotoTimeline";

const weekdayInitial = (dateKey: string) =>
  new Date(`${dateKey}T12:00:00`).toLocaleDateString("en-US", { weekday: "narrow" });

const MOOD_BAR_COLORS: Record<1 | 2 | 3 | 4 | 5, string> = {
  5: "bg-[#315fc0]",
  4: "bg-[#5576c2]",
  3: "bg-[#8da4d6]",
  2: "bg-[#bc821e]",
  1: "bg-[#a04646]",
};

function Kpi({ label, value, sub, tone = "default", children }: { label: string; value: string; sub?: string; tone?: "default" | "accent" | "risk"; children?: React.ReactNode }) {
  const valueColor = tone === "risk" ? "text-[#a04646]" : tone === "accent" ? "text-[#315fc0]" : "text-[#172c56]";
  return (
    <div className="bg-[#fbfcff] p-4">
      <p className="text-[9px] font-bold uppercase tracking-[.11em] text-[#8793a8]">{label}</p>
      <p className={`mt-1 font-mono text-xl ${valueColor}`}>{value}</p>
      {children}
      {sub && <p className="mt-1 text-[10px] text-[#7b879d]">{sub}</p>}
    </div>
  );
}

function TotalBar({ label, value, target, unit }: { label: string; value: number; target: number; unit: string }) {
  const over = value > target;
  const pct = Math.min(100, target ? (value / target) * 100 : 0);
  return (
    <div className="bg-[#fbfcff] p-3">
      <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">{label}</p>
      <p className="mt-1 font-mono text-sm text-[#172c56]">
        {value.toLocaleString()}
        <span className="text-[10px] text-[#8793a8]"> / {target.toLocaleString()}{unit}</span>
      </p>
      <div className="mt-2 h-1.5 bg-[#e4e9f2]">
        <div className={`h-full ${over ? "bg-[#bc821e]" : "bg-[#315fc0]"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function NutritionLifestyle({ patient }: { patient: Patient }) {
  const profile = getNutritionProfile(patient);
  const stats = getLoggingStats(patient);
  const { days, targets } = profile;
  const [dayIndex, setDayIndex] = useState(days.length - 1);
  const day = days[Math.min(dayIndex, days.length - 1)];
  const totals = summarizeMeals(day.meals);
  const strip = days.slice(-7);
  const stripStart = days.length - strip.length;
  const firstName = patient.name.split(" ")[0];
  const lapsed = isLapsed(stats);
  const waterCups = Math.round(targets.waterOz / WATER_CUP_OZ);
  const filledCups = Math.min(waterCups, Math.round(day.waterOz / WATER_CUP_OZ));
  const moodTotal = ([5, 4, 3, 2, 1] as const).reduce((total, mood) => total + stats.moodCounts[mood], 0);

  const recentNotes = useMemo(
    () => [...days].reverse().filter((candidate) => candidate.checkIn?.note).slice(0, 2)
      .map((candidate) => ({ dateKey: candidate.dateKey, note: candidate.checkIn!.note! })),
    [days],
  );

  const lastEntryValue = stats.daysSinceLastLog === null
    ? "None"
    : stats.daysSinceLastLog === 0
      ? "Today"
      : `${stats.daysSinceLastLog}d ago`;

  return (
    <section className="border border-[#bdc9dc] bg-[#fbfcff]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#bdc9dc] p-5">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-[.14em] text-[#74839d]">Nutrition &amp; lifestyle</h2>
          <p className="mt-1 text-xs text-[#718099]">What {firstName} tracks in the THINNR companion app — meals, water, daily check-ins, and progress photos.</p>
        </div>
        <span className="flex items-center gap-1.5 border border-[#aebfe0] bg-[#eef3fc] px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-[#3156a2]">
          <Smartphone size={11} />Patient-logged in app
        </span>
      </div>

      <div className="grid gap-px border-b border-[#bdc9dc] bg-[#dfe5ef] sm:grid-cols-3 xl:grid-cols-5">
        <Kpi label="7-day logging" value={`${stats.loggedDays7}/7`} tone={lapsed ? "risk" : "accent"}>
          <div className="mt-1.5 flex gap-[3px]" aria-hidden="true">
            {stats.last7.map((logged, index) => (
              <span key={index} className={`h-2.5 w-2.5 ${logged ? "bg-[#315fc0]" : "border border-[#c9d3e4] bg-[#f0f3f9]"}`} />
            ))}
          </div>
        </Kpi>
        <Kpi label="Check-in streak" value={`${stats.checkInStreak}d`} sub={`${stats.checkInRate30}% check-in rate (30d)`} />
        <Kpi label="Avg intake (7d)" value={stats.avgCalories7 ? `${stats.avgCalories7.toLocaleString()} cal` : "—"} sub={`Target ${targets.calories.toLocaleString()} cal`} />
        <Kpi label="Avg water (7d)" value={stats.avgWater7 ? `${stats.avgWater7} oz` : "—"} sub={`Target ${targets.waterOz} oz`} />
        <Kpi label="Last entry" value={lastEntryValue} sub={ARCHETYPE_LABELS[profile.archetype]} tone={lapsed ? "risk" : "default"} />
      </div>

      <div className="grid gap-5 p-5 xl:grid-cols-[1.08fr_1fr]">
        <div className="border border-[#dfe5ef] bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#dfe5ef] p-3">
            <p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#74839d]">Meal diary</p>
            <div className="flex items-center gap-1">
              <button
                aria-label="Previous day"
                disabled={dayIndex <= 0}
                onClick={() => setDayIndex((index) => Math.max(0, index - 1))}
                className="grid h-7 w-7 place-items-center border border-[#bdc9dc] text-[#344c77] transition disabled:opacity-40 hover:enabled:bg-[#e9eef8]"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="min-w-[128px] px-1 text-center text-xs font-semibold text-[#172c56]">
                {formatDateKey(day.dateKey)}
                {day.offset === 0 && <span className="ml-1.5 border border-[#aebfe0] bg-[#eef3fc] px-1 py-0.5 text-[8px] font-bold uppercase text-[#3156a2]">Today</span>}
              </span>
              <button
                aria-label="Next day"
                disabled={dayIndex >= days.length - 1}
                onClick={() => setDayIndex((index) => Math.min(days.length - 1, index + 1))}
                className="grid h-7 w-7 place-items-center border border-[#bdc9dc] text-[#344c77] transition disabled:opacity-40 hover:enabled:bg-[#e9eef8]"
              >
                <ChevronRight size={14} />
              </button>
            </div>
            {day.offset !== 0 && (
              <button onClick={() => setDayIndex(days.length - 1)} className="text-[10px] font-semibold text-[#315fc0] hover:underline">
                Jump to today
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-[#dfe5ef] bg-[#f8f9fc] px-3 py-2">
            <span className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Last 7</span>
            <div className="flex gap-1">
              {strip.map((stripDay, index) => {
                const target = stripStart + index;
                const selected = target === dayIndex;
                return (
                  <button
                    key={stripDay.dateKey}
                    onClick={() => setDayIndex(target)}
                    aria-label={`View ${formatDateKey(stripDay.dateKey)} (${stripDay.logged ? "logged" : "not logged"})`}
                    aria-pressed={selected}
                    className={`grid h-7 w-7 place-items-center border text-[9px] font-bold transition ${
                      selected
                        ? "border-[#315fc0] bg-[#315fc0] text-white"
                        : stripDay.logged
                          ? "border-[#aebfe0] bg-[#dce6fa] text-[#3156a2] hover:border-[#315fc0]"
                          : "border-[#d5a7a7] bg-[#fff0f0] text-[#a04646] hover:border-[#a04646]"
                    }`}
                  >
                    {weekdayInitial(stripDay.dateKey)}
                  </button>
                );
              })}
            </div>
            <span className="ml-auto text-[9px] text-[#8793a8]">{stats.loggedDays7} of last 7 days logged</span>
          </div>

          {day.meals.length > 0 ? (
            <div className="divide-y divide-[#eef1f6]">
              {MEAL_SLOTS.map((slot) => {
                const entries = day.meals.filter((entry) => entry.meal === slot);
                const slotCalories = entries.reduce((total, entry) => total + entry.calories, 0);
                return (
                  <div key={slot} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[9px] font-bold uppercase tracking-[.11em] text-[#8793a8]">{MEAL_LABELS[slot]}</p>
                      {entries.length > 0 && <span className="font-mono text-[10px] text-[#53698f]">{slotCalories.toLocaleString()} cal</span>}
                    </div>
                    {entries.length > 0 ? entries.map((entry) => (
                      <div key={entry.id} className="mt-2 flex items-baseline justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-[#172c56]">{entry.name}</p>
                          <p className="text-[10px] text-[#7b879d]">{entry.detail}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-mono text-xs text-[#284675]">{entry.calories} cal</p>
                          <p className="font-mono text-[9px] text-[#8793a8]">{entry.protein}P · {entry.carbs}C · {entry.fat}F</p>
                        </div>
                      </div>
                    )) : (
                      <p className="mt-2 text-[11px] text-[#a4aec2]">{day.offset === 0 ? "Not logged yet" : "Not logged"}</p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid min-h-36 place-items-center p-6 text-center">
              <div>
                <p className="text-xs font-semibold text-[#a04646]">No entries logged this day.</p>
                <p className="mt-1 text-[10px] leading-4 text-[#8793a8]">
                  {profile.archetype === "lapsing" && stats.daysSinceLastLog !== null && stats.daysSinceLastLog >= 1
                    ? `${firstName}'s last companion-app entry was ${stats.daysSinceLastLog === 1 ? "yesterday" : `${stats.daysSinceLastLog} days ago`}.`
                    : "The companion app has no meal entries for this date."}
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-px border-t border-[#dfe5ef] bg-[#dfe5ef] sm:grid-cols-4">
            <TotalBar label="Calories" value={totals.calories} target={targets.calories} unit=" cal" />
            <TotalBar label="Protein" value={totals.protein} target={targets.protein} unit="g" />
            <TotalBar label="Carbs" value={totals.carbs} target={targets.carbs} unit="g" />
            <TotalBar label="Fat" value={totals.fat} target={targets.fat} unit="g" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#dfe5ef] bg-[#f8f9fc] px-4 py-3">
            <div className="flex items-center gap-2">
              <Droplets size={14} className="text-[#315fc0]" />
              <span className="text-[9px] font-bold uppercase tracking-[.11em] text-[#74839d]">Water</span>
              <span className="flex gap-1" aria-hidden="true">
                {Array.from({ length: waterCups }).map((_, index) => (
                  <span key={index} className={`h-3.5 w-2.5 ${index < filledCups ? "bg-[#315fc0]" : "border border-[#c9d3e4] bg-white"}`} />
                ))}
              </span>
            </div>
            <span className="font-mono text-xs text-[#284675]">{day.waterOz} / {targets.waterOz} oz</span>
          </div>

          <div className="border-t border-[#dfe5ef] px-4 py-3">
            {day.checkIn ? (
              <>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <span className="text-[9px] font-bold uppercase tracking-[.11em] text-[#74839d]">Check-in</span>
                  <span className="border border-[#aebfe0] bg-[#eef3fc] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.04em] text-[#3156a2]">
                    Mood · {MOOD_LABELS[day.checkIn.mood]}
                  </span>
                  {day.checkIn.weight != null && (
                    <span className="font-mono text-[10px] text-[#284675]">{day.checkIn.weight.toFixed(1)} lbs logged</span>
                  )}
                  {day.checkIn.sideEffects.length > 0 ? day.checkIn.sideEffects.map((effect) => (
                    <span key={effect} className="border border-[#d7b889] bg-[#fff6e5] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.04em] text-[#97631e]">{effect}</span>
                  )) : (
                    <span className="text-[10px] text-[#8793a8]">No side effects</span>
                  )}
                </div>
                {day.checkIn.note && (
                  <p className="mt-2 border-l-2 border-[#aebfe0] pl-2 text-[11px] italic leading-4 text-[#53698f]">“{day.checkIn.note}”</p>
                )}
              </>
            ) : (
              <p className="text-[10px] text-[#8793a8]">
                <span className="mr-2 font-bold uppercase tracking-[.11em] text-[#74839d]">Check-in</span>
                {day.offset === 0 ? "Still open in the app today." : "No daily check-in recorded."}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-5">
          <div className="border border-[#dfe5ef] bg-white p-4">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-[.12em] text-[#74839d]">Adherence vs target · last 14 days</p>
            <AdherenceTrend days={days} targets={targets} patientName={patient.name} />
          </div>

          <div className="border border-[#dfe5ef] bg-white p-4">
            <p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#74839d]">Check-ins &amp; wellbeing · last 30 days</p>
            {moodTotal > 0 ? (
              <div className="mt-3 space-y-1.5">
                {([5, 4, 3, 2, 1] as const).map((mood) => {
                  const count = stats.moodCounts[mood];
                  const pct = moodTotal ? (count / moodTotal) * 100 : 0;
                  return (
                    <div key={mood} className="flex items-center gap-2 text-[10px]">
                      <span className="w-11 shrink-0 font-semibold text-[#53698f]">{MOOD_LABELS[mood]}</span>
                      <div className="h-2 flex-1 bg-[#eef1f6]">
                        <div className={`h-full ${MOOD_BAR_COLORS[mood]}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-6 shrink-0 text-right font-mono text-[#8290a7]">{count}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-3 text-xs text-[#718099]">No check-ins recorded in the last 30 days.</p>
            )}

            <div className="mt-4 border-t border-[#e4e8f0] pt-3">
              <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Side effects reported</p>
              {stats.topSideEffects.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {stats.topSideEffects.map((effect) => (
                    <span key={effect.name} className="border border-[#d7b889] bg-[#fff6e5] px-2 py-1 text-[10px] font-semibold text-[#97631e]">
                      {effect.name} ×{effect.count}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-[#718099]">None reported in the last 30 days.</p>
              )}
            </div>

            {recentNotes.length > 0 && (
              <div className="mt-4 border-t border-[#e4e8f0] pt-3">
                <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Recent check-in notes</p>
                <div className="mt-2 space-y-2">
                  {recentNotes.map((note) => (
                    <div key={note.dateKey}>
                      <p className="text-[10px] text-[#8793a8]">{formatDateKey(note.dateKey)}</p>
                      <p className="mt-0.5 border-l-2 border-[#aebfe0] pl-2 text-[11px] italic leading-4 text-[#53698f]">“{note.note}”</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-[#bdc9dc] p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#74839d]">Progress photos · {profile.photos.length} milestone{profile.photos.length === 1 ? "" : "s"}</p>
          <span className="text-[10px] text-[#8793a8]">Milestone photos are synthetic demo assets.</span>
        </div>
        <PhotoTimeline photos={profile.photos} patientName={patient.name} />
      </div>
    </section>
  );
}
