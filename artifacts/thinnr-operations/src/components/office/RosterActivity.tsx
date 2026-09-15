/**
 * Live-roster activity cells and the patient-detail engagement summary.
 *
 * Every figure here comes from the API's nullable activity signals (see
 * lib/roster-activity for the row model). Three visual states are kept
 * distinct on purpose:
 *
 *   value        — a real figure, zero included ("0/7", "0-day streak");
 *   no data yet  — the family is null because the patient has never
 *                  produced that kind of record ("No logs yet");
 *   unavailable  — the aggregate had no row for the patient at all
 *                  (dashed "Not available" placeholder, data-state="unknown").
 *
 * Only the live roster renders these; the guided demo keeps LoggingSignal.
 */
import type { ReactNode } from 'react';
import type { MoodKey, PatientActivitySignals } from '@/lib/office-roster';
import {
  MOOD_KEYS,
  NO_DATA_LABEL,
  UNAVAILABLE_LABEL,
  describeMoods,
  describeSideEffects,
  formatDayCount,
  isLiveLapsed,
  liveLastLogLabel,
  moodTotal,
  type RosterActivity,
} from '@/lib/roster-activity';

const formatDay = (dateKey: string) =>
  new Date(`${dateKey}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function UnavailableCell({ what, align = 'left' }: { what: string; align?: 'left' | 'right' }) {
  return (
    <div className={align === 'right' ? 'flex flex-col items-end' : ''} data-state="unknown" title={`${what} could not be loaded for this patient`}>
      <span className="inline-flex items-center rounded-sm border border-dashed border-border bg-secondary px-2 py-1 text-[10px] font-semibold uppercase tracking-[.05em] text-muted-foreground">
        {UNAVAILABLE_LABEL}
      </span>
      <span className="mt-1 block text-[10px] text-muted-foreground">{what} did not load</span>
    </div>
  );
}

export function LoggingDots({ days }: { days: boolean[] }) {
  return (
    <span className="flex gap-[3px]" aria-hidden="true">
      {days.map((logged, index) => (
        <span key={index} className={`h-2.5 w-2.5 rounded-[3px] ${logged ? 'bg-primary' : 'border border-border bg-secondary'}`} />
      ))}
    </span>
  );
}

export function MoodBars({ counts }: { counts: Record<MoodKey, number> | null }) {
  const label = describeMoods(counts);
  if (!counts) return <span className="text-[10px] text-muted-foreground" title={label}>Mood: {NO_DATA_LABEL.toLowerCase()}</span>;
  const total = moodTotal(counts);
  const peak = Math.max(1, ...MOOD_KEYS.map((key) => counts[key] ?? 0));
  return (
    <span className="inline-flex items-end gap-1" role="img" aria-label={label} title={label}>
      <span className="text-[9px] font-bold uppercase tracking-[.08em] text-muted-foreground">Mood</span>
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {MOOD_KEYS.map((key) => {
          const count = counts[key] ?? 0;
          const height = total === 0 ? 2 : Math.max(2, Math.round((count / peak) * 12));
          return <span key={key} className={`w-[5px] rounded-[1px] ${count > 0 ? 'bg-primary' : 'bg-border'}`} style={{ height }} />;
        })}
      </span>
      {total === 0 && <span className="text-[10px] text-muted-foreground" aria-hidden="true">none (30d)</span>}
    </span>
  );
}

export function SideEffectChips({ effects }: { effects: Array<{ name: string; count: number }> | null }) {
  const label = describeSideEffects(effects);
  if (!effects) return <span className="text-[10px] text-muted-foreground" title={label}>Side effects: {NO_DATA_LABEL.toLowerCase()}</span>;
  if (effects.length === 0) return <span className="text-[10px] text-muted-foreground" title={label}>No side effects (30d)</span>;
  return (
    <span className="flex flex-wrap gap-1" aria-label={label} title={label}>
      {effects.map((effect) => (
        <span key={effect.name} className="inline-flex items-center gap-1 rounded-sm border border-[#e8b47c] bg-[#fff4e6] px-1.5 py-0.5 text-[9px] font-semibold text-[#b65c22]">
          {effect.name}
          <span className="font-mono">×{effect.count}</span>
        </span>
      ))}
    </span>
  );
}

/** "Logging (7d)" cell for a live row. */
export function LiveLoggingCell({ activity, align = 'left' }: { activity: RosterActivity; align?: 'left' | 'right' }) {
  if (activity.kind !== 'known') return <UnavailableCell what="Logging" align={align} />;
  const { signals } = activity;
  const lapsed = isLiveLapsed(activity);
  const lastLog = liveLastLogLabel(activity);
  if (signals.loggedLast7 === null || signals.loggedDays7 === null) {
    return (
      <div className={align === 'right' ? 'flex flex-col items-end' : ''} data-state="no-data" title="No diary entries have been logged in the companion app yet">
        <b className="text-xs font-semibold text-navy">No logs yet</b>
        <span className={`mt-1 block text-[10px] ${lapsed ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{lapsed ? 'Logging lapsed' : 'Diary not started'}</span>
      </div>
    );
  }
  const title = `${signals.loggedDays7} of the last 7 days logged in the companion app (through ${formatDay(signals.asOfDate)}, patient's local day)`;
  return (
    <div className={align === 'right' ? 'flex flex-col items-end' : ''} data-state="known" title={title}>
      <div className="flex items-center gap-2">
        <LoggingDots days={signals.loggedLast7} />
        <b className="font-mono text-xs font-semibold text-navy">{signals.loggedDays7}/7</b>
      </div>
      <span className={`mt-1 block text-[10px] ${lapsed ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
        {lastLog}
        {signals.mealStreak != null && <span className="text-muted-foreground"> · {signals.mealStreak}-day streak</span>}
      </span>
    </div>
  );
}

/** "Check-ins & wellbeing" cell for a live row. */
export function LiveEngagementCell({ activity, align = 'left' }: { activity: RosterActivity; align?: 'left' | 'right' }) {
  if (activity.kind !== 'known') return <UnavailableCell what="Check-ins" align={align} />;
  const { signals } = activity;
  const noCheckIns = signals.checkInStreak === null || signals.checkInRate30 === null;
  // A patient who has never checked in and has no averages, moods, or side
  // effects gets one line; repeating "no data" per family says nothing new.
  const nothingYet = noCheckIns && signals.avgCalories7 == null && signals.avgWater7 == null && signals.moodCounts == null && signals.topSideEffects == null;
  if (nothingYet) {
    return (
      <div className={align === 'right' ? 'text-right' : ''} data-state="no-data" title="No check-ins have been recorded in the companion app yet">
        <b className="text-xs font-semibold text-navy">No check-ins yet</b>
        <span className="mt-1 block text-[10px] text-muted-foreground">Check-ins not started</span>
      </div>
    );
  }
  return (
    <div className={`space-y-1 ${align === 'right' ? 'flex flex-col items-end text-right' : ''}`} data-state={noCheckIns ? 'no-data' : 'known'}>
      {noCheckIns ? (
        <b className="text-xs font-semibold text-navy" title="No check-ins have been recorded in the companion app yet">No check-ins yet</b>
      ) : (
        <div className="text-xs" title={`${formatDayCount(signals.checkInStreak)} check-in streak · ${signals.checkInRate30}% of the last 30 days checked in`}>
          <b className="font-mono font-semibold text-navy">{signals.checkInStreak}-day</b>
          <span className="text-muted-foreground"> streak · </span>
          <b className="font-mono font-semibold text-navy">{signals.checkInRate30}%</b>
          <span className="text-muted-foreground"> of 30d</span>
        </div>
      )}
      <span className="block text-[10px] text-muted-foreground">
        {signals.latestCheckInDate ? `Last check-in ${formatDay(signals.latestCheckInDate)}` : noCheckIns ? 'Check-ins not started' : 'No check-in date'}
        {' · '}
        <span title="7-day average of logged days">{signals.avgCalories7 == null ? 'cal: no data' : `${signals.avgCalories7.toLocaleString('en-US')} cal avg`}</span>
        {' · '}
        <span title="7-day average over days with water logged">{signals.avgWater7 == null ? 'water: no data' : `${signals.avgWater7} oz avg`}</span>
      </span>
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${align === 'right' ? 'justify-end' : ''}`}>
        <MoodBars counts={signals.moodCounts} />
        <SideEffectChips effects={signals.topSideEffects} />
      </div>
    </div>
  );
}

const MICRO = 'text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground';

/** Patient-detail engagement summary — the roster's figures, one tile each. */
export function EngagementSummary({ signals }: { signals: PatientActivitySignals }) {
  const tiles: Array<[string, ReactNode, string]> = [
    ['Logged (7d)', signals.loggedLast7 && signals.loggedDays7 != null
      ? <span className="flex items-center gap-2"><LoggingDots days={signals.loggedLast7} /><span className="font-mono text-sm text-navy">{signals.loggedDays7}/7</span></span>
      : <span className="text-xs text-muted-foreground">No logs yet</span>, 'Days with a diary entry, ending on the patient\'s local day'],
    ['Meal streak', <Value value={signals.mealStreak == null ? null : formatDayCount(signals.mealStreak)} />, 'Consecutive days with a diary entry'],
    ['Check-in streak', <Value value={signals.checkInStreak == null ? null : formatDayCount(signals.checkInStreak)} />, 'Consecutive days with a check-in'],
    ['Check-in rate (30d)', <Value value={signals.checkInRate30 == null ? null : `${signals.checkInRate30}%`} />, 'Share of the last 30 days with a check-in'],
    ['Avg calories (7d)', <Value value={signals.avgCalories7 == null ? null : `${signals.avgCalories7.toLocaleString('en-US')} cal`} />, 'Average over logged days in the last 7'],
    ['Avg water (7d)', <Value value={signals.avgWater7 == null ? null : `${signals.avgWater7} oz`} />, 'Average over days with water logged in the last 7'],
    ['Latest check-in', <Value value={signals.latestCheckInDate ? formatDay(signals.latestCheckInDate) : null} />, 'Most recent check-in date'],
    ['Mood (30d)', <MoodBars counts={signals.moodCounts} />, 'Mood scores across the last 30 days of check-ins'],
    ['Side effects (30d)', <SideEffectChips effects={signals.topSideEffects} />, 'Most-reported side effects in the last 30 days'],
  ];
  return (
    <div data-testid="engagement-summary" data-as-of={signals.asOfDate}>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3">
        {tiles.map(([label, value, hint]) => (
          <div key={label} className="bg-card p-3" title={hint}>
            <p className={MICRO}>{label}</p>
            <div className="mt-1">{value}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">Computed for the patient's local day {formatDay(signals.asOfDate)} — the same figures the roster shows.</p>
    </div>
  );
}

function Value({ value }: { value: string | null }) {
  return value == null
    ? <span className="text-xs text-muted-foreground" data-state="no-data">{NO_DATA_LABEL}</span>
    : <span className="font-mono text-sm text-navy">{value}</span>;
}
