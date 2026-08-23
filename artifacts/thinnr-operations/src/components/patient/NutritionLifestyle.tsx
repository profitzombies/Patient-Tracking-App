import { useMemo, useState } from "react";
import { CalendarRange, ChevronLeft, ChevronRight, Droplets, Smartphone } from "lucide-react";
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
  getRangeLoggingSummary,
  isLapsed,
  summarizeMeals,
} from "@/data/nutrition-data";
import { formatRangeLabel, useDateRange } from "@/contexts/date-range";
import { AdherenceTrend } from "./AdherenceTrend";
import { PhotoTimeline } from "./PhotoTimeline";
import { CHIP_COBALT, LINK_ACTION, MICRO_LABEL, PANEL, PANEL_LABEL, SectionCard } from "./heritage";

const weekdayInitial = (dateKey: string) =>
  new Date(`${dateKey}T12:00:00`).toLocaleDateString("en-US", { weekday: "narrow" });

const MOOD_BAR_COLORS: Record<1 | 2 | 3 | 4 | 5, string> = {
  5: "bg-primary",
  4: "bg-[hsl(var(--chart-2))]",
  3: "bg-[hsl(var(--chart-3))]",
  2: "bg-accent-warm",
  1: "bg-destructive",
};

function Kpi({ label, value, sub, tone = "default", children }: { label: string; value: string; sub?: string; tone?: "default" | "accent" | "risk"; children?: React.ReactNode }) {
  const valueColor = tone === "risk" ? "text-destructive" : tone === "accent" ? "text-primary" : "text-navy";
  return (
    <div className="bg-card p-4">
      <p className={MICRO_LABEL}>{label}</p>
      <p className={`mt-1 font-mono text-xl ${valueColor}`}>{value}</p>
      {children}
      {sub && <p className="mt-1 text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function TotalBar({ label, value, target, unit }: { label: string; value: number; target: number; unit: string }) {
  const over = value > target;
  const pct = Math.min(100, target ? (value / target) * 100 : 0);
  return (
    <div className="bg-paper-alt p-3">
      <p className={MICRO_LABEL}>{label}</p>
      <p className="mt-1 font-mono text-sm text-navy">
        {value.toLocaleString()}
        <span className="text-[10px] text-muted-foreground"> / {target.toLocaleString()}{unit}</span>
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${over ? "bg-accent-warm" : "bg-primary"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function NutritionLifestyle({ patient }: { patient: Patient }) {
  const profile = getNutritionProfile(patient);
  const stats = getLoggingStats(patient);
  const { range } = useDateRange();
  const rangeLabel = formatRangeLabel(range);
  const rangeLabelShort = formatRangeLabel(range, "short");
  // Range-scoped view of the same seeded days; longitudinal stats stay lifetime.
  const summary = useMemo(() => getRangeLoggingSummary(patient, range), [patient, range]);
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
  const moodTotal = ([5, 4, 3, 2, 1] as const).reduce((total, mood) => total + summary.moodCounts[mood], 0);

  const recentNotes = useMemo(
    () => [...summary.days].reverse().filter((candidate) => candidate.checkIn?.note).slice(0, 2)
      .map((candidate) => ({ dateKey: candidate.dateKey, note: candidate.checkIn!.note! })),
    [summary.days],
  );

  const lastEntryValue = stats.daysSinceLastLog === null
    ? "None"
    : stats.daysSinceLastLog === 0
      ? "Today"
      : `${stats.daysSinceLastLog}d ago`;

  return (
    <SectionCard
      title="Nutrition & lifestyle"
      sub={`What ${firstName} tracks in the THINNR companion app — meals, water, daily check-ins, and progress photos.`}
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className={CHIP_COBALT}><CalendarRange size={11} />{rangeLabelShort}</span>
          <span className={CHIP_COBALT}><Smartphone size={11} />Patient-logged in app</span>
        </div>
      }
    >
      <div className="grid gap-px border-b border-border bg-border sm:grid-cols-3 xl:grid-cols-5">
        <Kpi
          label="Days logged"
          value={summary.daysWithData ? `${summary.loggedDays}/${summary.daysWithData}` : "—"}
          sub={summary.daysWithData ? `${summary.loggedRate}% of range days` : "No app history in this range"}
          tone={summary.daysWithData ? "accent" : "default"}
        >
          {summary.daysWithData > 0 && (
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div className="h-full rounded-full bg-primary" style={{ width: `${summary.loggedRate}%` }} />
            </div>
          )}
        </Kpi>
        <Kpi
          label="Check-in rate"
          value={summary.checkInEligibleDays ? `${summary.checkInRate}%` : "—"}
          sub={summary.checkInEligibleDays ? `${summary.checkInCount} of ${summary.checkInEligibleDays} days · current streak ${stats.checkInStreak}d` : "No app history in this range"}
        />
        <Kpi label="Avg intake" value={summary.avgCalories ? `${summary.avgCalories.toLocaleString()} cal` : "—"} sub={`Target ${targets.calories.toLocaleString()} cal`} />
        <Kpi label="Avg water" value={summary.avgWater ? `${summary.avgWater} oz` : "—"} sub={`Target ${targets.waterOz} oz`} />
        <Kpi label="Last entry" value={lastEntryValue} sub={ARCHETYPE_LABELS[profile.archetype]} tone={lapsed ? "risk" : "default"} />
      </div>

      <div className="grid gap-5 p-5 xl:grid-cols-[1.08fr_1fr]">
        <div className={`overflow-hidden ${PANEL}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
            <p className={PANEL_LABEL}>Meal diary</p>
            <div className="flex items-center gap-1">
              <button
                aria-label="Previous day"
                disabled={dayIndex <= 0}
                onClick={() => setDayIndex((index) => Math.max(0, index - 1))}
                className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-foreground shadow-xs transition disabled:opacity-40 hover:enabled:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="min-w-[128px] px-1 text-center text-xs font-semibold text-navy">
                {formatDateKey(day.dateKey)}
                {day.offset === 0 && <span className="ml-1.5 rounded-sm border border-accent-border bg-accent px-1 py-0.5 text-[8px] font-bold uppercase text-primary">Today</span>}
              </span>
              <button
                aria-label="Next day"
                disabled={dayIndex >= days.length - 1}
                onClick={() => setDayIndex((index) => Math.min(days.length - 1, index + 1))}
                className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-foreground shadow-xs transition disabled:opacity-40 hover:enabled:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight size={14} />
              </button>
            </div>
            {day.offset !== 0 && (
              <button onClick={() => setDayIndex(days.length - 1)} className={`${LINK_ACTION} text-[10px]`}>
                Jump to today
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-secondary px-3 py-2">
            <span className={MICRO_LABEL}>Last 7</span>
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
                    className={`grid h-7 w-7 place-items-center rounded-md border text-[9px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : stripDay.logged
                          ? "border-accent-border bg-accent text-primary hover:border-primary"
                          : "border-[#d5a7a7] bg-[#fff0f0] text-destructive hover:border-destructive"
                    }`}
                  >
                    {weekdayInitial(stripDay.dateKey)}
                  </button>
                );
              })}
            </div>
            <span className="ml-auto text-[9px] text-muted-foreground">{stats.loggedDays7} of last 7 days logged</span>
          </div>

          {day.meals.length > 0 ? (
            <div className="divide-y divide-border">
              {MEAL_SLOTS.map((slot) => {
                const entries = day.meals.filter((entry) => entry.meal === slot);
                const slotCalories = entries.reduce((total, entry) => total + entry.calories, 0);
                return (
                  <div key={slot} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className={MICRO_LABEL}>{MEAL_LABELS[slot]}</p>
                      {entries.length > 0 && <span className="font-mono text-[10px] text-muted-foreground">{slotCalories.toLocaleString()} cal</span>}
                    </div>
                    {entries.length > 0 ? entries.map((entry) => (
                      <div key={entry.id} className="mt-2 flex items-baseline justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-foreground">{entry.name}</p>
                          <p className="text-[10px] text-muted-foreground">{entry.detail}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-mono text-xs text-foreground">{entry.calories} cal</p>
                          <p className="font-mono text-[9px] text-muted-foreground">{entry.protein}P · {entry.carbs}C · {entry.fat}F</p>
                        </div>
                      </div>
                    )) : (
                      <p className="mt-2 text-[11px] text-muted-foreground/70">{day.offset === 0 ? "Not logged yet" : "Not logged"}</p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid min-h-36 place-items-center p-6 text-center">
              <div>
                <p className="text-xs font-semibold text-destructive">No entries logged this day.</p>
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  {profile.archetype === "lapsing" && stats.daysSinceLastLog !== null && stats.daysSinceLastLog >= 1
                    ? `${firstName}'s last companion-app entry was ${stats.daysSinceLastLog === 1 ? "yesterday" : `${stats.daysSinceLastLog} days ago`}.`
                    : "The companion app has no meal entries for this date."}
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-4">
            <TotalBar label="Calories" value={totals.calories} target={targets.calories} unit=" cal" />
            <TotalBar label="Protein" value={totals.protein} target={targets.protein} unit="g" />
            <TotalBar label="Carbs" value={totals.carbs} target={targets.carbs} unit="g" />
            <TotalBar label="Fat" value={totals.fat} target={targets.fat} unit="g" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-secondary px-4 py-3">
            <div className="flex items-center gap-2">
              <Droplets size={14} className="text-primary" />
              <span className={MICRO_LABEL}>Water</span>
              <span className="flex gap-1" aria-hidden="true">
                {Array.from({ length: waterCups }).map((_, index) => (
                  <span key={index} className={`h-3.5 w-2.5 rounded-[2px] ${index < filledCups ? "bg-primary" : "border border-border bg-card"}`} />
                ))}
              </span>
            </div>
            <span className="font-mono text-xs text-navy">{day.waterOz} / {targets.waterOz} oz</span>
          </div>

          <div className="border-t border-border px-4 py-3">
            {day.checkIn ? (
              <>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <span className={MICRO_LABEL}>Check-in</span>
                  <span className="rounded-sm border border-accent-border bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.04em] text-primary">
                    Mood · {MOOD_LABELS[day.checkIn.mood]}
                  </span>
                  {day.checkIn.weight != null && (
                    <span className="font-mono text-[10px] text-foreground">{day.checkIn.weight.toFixed(1)} lbs logged</span>
                  )}
                  {day.checkIn.sideEffects.length > 0 ? day.checkIn.sideEffects.map((effect) => (
                    <span key={effect} className="rounded-sm border border-[#e8b47c] bg-[#fff4e6] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.04em] text-[#b65c22]">{effect}</span>
                  )) : (
                    <span className="text-[10px] text-muted-foreground">No side effects</span>
                  )}
                </div>
                {day.checkIn.note && (
                  <p className="mt-2 border-l-2 border-accent-border pl-2 text-[11px] italic leading-4 text-muted-foreground">“{day.checkIn.note}”</p>
                )}
              </>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                <span className={`mr-2 ${MICRO_LABEL}`}>Check-in</span>
                {day.offset === 0 ? "Still open in the app today." : "No daily check-in recorded."}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-5">
          <div className={`${PANEL} p-4`}>
            <p className={`mb-3 ${PANEL_LABEL}`}>Adherence vs target · {rangeLabelShort}</p>
            <AdherenceTrend days={summary.days} targets={targets} patientName={patient.name} rangeLabel={rangeLabel} />
          </div>

          <div className={`${PANEL} p-4`}>
            <p className={PANEL_LABEL}>Check-ins &amp; wellbeing · {rangeLabelShort}</p>
            {moodTotal > 0 ? (
              <div className="mt-3 space-y-1.5">
                {([5, 4, 3, 2, 1] as const).map((mood) => {
                  const count = summary.moodCounts[mood];
                  const pct = moodTotal ? (count / moodTotal) * 100 : 0;
                  return (
                    <div key={mood} className="flex items-center gap-2 text-[10px]">
                      <span className="w-11 shrink-0 font-semibold text-foreground">{MOOD_LABELS[mood]}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className={`h-full rounded-full ${MOOD_BAR_COLORS[mood]}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-6 shrink-0 text-right font-mono text-muted-foreground">{count}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">No check-ins recorded in this range.</p>
            )}

            <div className="mt-4 border-t border-border pt-3">
              <p className={MICRO_LABEL}>Side effects reported</p>
              {summary.topSideEffects.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {summary.topSideEffects.map((effect) => (
                    <span key={effect.name} className="rounded-sm border border-[#e8b47c] bg-[#fff4e6] px-2 py-1 text-[10px] font-semibold text-[#b65c22]">
                      {effect.name} ×{effect.count}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-muted-foreground">None reported in this range.</p>
              )}
            </div>

            {recentNotes.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <p className={MICRO_LABEL}>Recent check-in notes</p>
                <div className="mt-2 space-y-2">
                  {recentNotes.map((note) => (
                    <div key={note.dateKey}>
                      <p className="text-[10px] text-muted-foreground">{formatDateKey(note.dateKey)}</p>
                      <p className="mt-0.5 border-l-2 border-accent-border pl-2 text-[11px] italic leading-4 text-muted-foreground">“{note.note}”</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-border p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className={PANEL_LABEL}>Progress photos · {profile.photos.length} milestone{profile.photos.length === 1 ? "" : "s"} · full program</p>
          <span className="text-[10px] text-muted-foreground">Milestone photos are synthetic demo assets.</span>
        </div>
        <PhotoTimeline photos={profile.photos} patientName={patient.name} />
      </div>
    </SectionCard>
  );
}
