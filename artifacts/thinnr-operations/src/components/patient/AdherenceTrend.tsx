import { summarizeMeals, type DailyLog, type DailyTargets } from "@/data/nutrition-data";

interface AdherenceTrendProps {
  /** Companion-app days to chart — already scoped to the shared range by the caller. */
  days: DailyLog[];
  targets: DailyTargets;
  patientName: string;
  /** Human label of the active range, for the accessible title and empty state. */
  rangeLabel: string;
}

const shortDate = (dateKey: string) =>
  new Date(`${dateKey}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * Calories-vs-target and water-vs-target bars for the selected range, drawn in
 * the same hand-rolled SVG style as the weight trend chart. Label density and
 * bar width adapt to however many days the range covers.
 */
export function AdherenceTrend({ days, targets, patientName, rangeLabel }: AdherenceTrendProps) {
  if (days.length === 0) {
    return (
      <div className="grid h-48 place-items-center rounded-md border border-dashed border-border bg-secondary p-6 text-center text-xs text-muted-foreground">
        No companion-app history falls in the selected range ({rangeLabel}).
      </div>
    );
  }

  const width = 760;
  const height = 306;
  const left = 52;
  const right = 14;
  const slot = (width - left - right) / days.length;
  const barWidth = Math.min(30, slot * 0.62);
  const xFor = (index: number) => left + slot * index + slot / 2;

  const calTotals = days.map((day) => summarizeMeals(day.meals).calories);
  const maxCal = Math.max(targets.calories * 1.25, ...calTotals);
  const calScale = Math.ceil(maxCal / 250) * 250;
  const calTop = 18;
  const calHeight = 148;
  const calBase = calTop + calHeight;
  const yCal = (value: number) => calTop + (1 - value / calScale) * calHeight;
  const calTicks: number[] = [];
  for (let tick = 0; tick <= calScale; tick += 500) calTicks.push(tick);

  const waterTop = 218;
  const waterHeight = 60;
  const waterBase = waterTop + waterHeight;
  const waterScale = Math.max(80, ...days.map((day) => day.waterOz));
  const yWater = (value: number) => waterTop + (1 - value / waterScale) * waterHeight;

  // Label roughly seven evenly spaced days, always including the newest one.
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));
  const isLabeled = (index: number) => (days.length - 1 - index) % labelEvery === 0;
  const hasToday = days.some((day) => day.offset === 0);

  return (
    <figure>
      <div className="overflow-x-auto rounded-md border border-border bg-white p-2">
        <svg
          className="h-72 min-w-[560px] w-full"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby="adherence-trend-title adherence-trend-desc"
        >
          <title id="adherence-trend-title">Intake and water logging for {patientName}, {rangeLabel}</title>
          <desc id="adherence-trend-desc">
            {days.length} days of logged calories against the {targets.calories}-calorie target, and water against the {targets.waterOz} ounce target. Missed days are marked.
          </desc>

          <text className="fill-muted-foreground" x={left} y={12} fontSize="8" fontWeight="700" letterSpacing="1.4">CALORIES LOGGED</text>
          {calTicks.map((tick) => (
            <g key={`cal-${tick}`}>
              <line className="stroke-border" x1={left} x2={width - right} y1={yCal(tick)} y2={yCal(tick)} strokeWidth="1" />
              <text className="fill-muted-foreground" x={left - 8} y={yCal(tick) + 3} textAnchor="end" fontSize="9">{tick}</text>
            </g>
          ))}
          <line className="stroke-accent-warm" x1={left} x2={width - right} y1={yCal(targets.calories)} y2={yCal(targets.calories)} strokeDasharray="5 4" strokeWidth="1.5" />
          <text className="fill-[#b65c22]" x={width - right} y={yCal(targets.calories) - 5} textAnchor="end" fontSize="9" fontWeight="700">
            Target {targets.calories.toLocaleString()}
          </text>

          {days.map((day, index) => {
            const calories = calTotals[index];
            const isToday = day.offset === 0;
            if (!day.logged) {
              return (
                <g key={day.dateKey}>
                  <rect className="stroke-[#d5a7a7]" x={xFor(index) - barWidth / 2} y={calBase - 9} width={barWidth} height={9} fill="none" strokeDasharray="3 2" strokeWidth="1">
                    <title>{shortDate(day.dateKey)}: no meals logged</title>
                  </rect>
                </g>
              );
            }
            const fill = isToday ? "fill-[hsl(var(--chart-3))]" : calories > targets.calories ? "fill-accent-warm" : "fill-primary";
            return (
              <rect
                key={day.dateKey}
                className={fill}
                x={xFor(index) - barWidth / 2}
                y={yCal(calories)}
                width={barWidth}
                height={Math.max(2, calBase - yCal(calories))}
              >
                <title>{shortDate(day.dateKey)}: {calories.toLocaleString()} cal{isToday ? " (today, still logging)" : ""} · target {targets.calories.toLocaleString()}</title>
              </rect>
            );
          })}

          <text className="fill-muted-foreground" x={left} y={waterTop - 8} fontSize="8" fontWeight="700" letterSpacing="1.4">WATER (FL OZ)</text>
          <line className="stroke-border" x1={left} x2={width - right} y1={waterBase} y2={waterBase} strokeWidth="1" />
          <line className="stroke-accent-warm" x1={left} x2={width - right} y1={yWater(targets.waterOz)} y2={yWater(targets.waterOz)} strokeDasharray="5 4" strokeWidth="1.5" />
          <text className="fill-[#b65c22]" x={width - right} y={yWater(targets.waterOz) - 4} textAnchor="end" fontSize="9" fontWeight="700">
            {targets.waterOz} oz
          </text>
          {days.map((day, index) => {
            if (day.waterOz <= 0) {
              return (
                <rect key={`w-${day.dateKey}`} className="stroke-[#d5a7a7]" x={xFor(index) - barWidth / 2} y={waterBase - 6} width={barWidth} height={6} fill="none" strokeDasharray="3 2" strokeWidth="1">
                  <title>{shortDate(day.dateKey)}: no water logged</title>
                </rect>
              );
            }
            return (
              <rect
                key={`w-${day.dateKey}`}
                className="fill-[hsl(var(--chart-2))]"
                x={xFor(index) - barWidth / 2}
                y={yWater(day.waterOz)}
                width={barWidth}
                height={Math.max(2, waterBase - yWater(day.waterOz))}
              >
                <title>{shortDate(day.dateKey)}: {day.waterOz} oz of {targets.waterOz} oz</title>
              </rect>
            );
          })}

          {days.map((day, index) => (
            isLabeled(index) ? (
              <text key={`label-${day.dateKey}`} className="fill-muted-foreground" x={xFor(index)} y={height - 6} textAnchor="middle" fontSize="9">
                {shortDate(day.dateKey)}
              </text>
            ) : null
          ))}
        </svg>
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] bg-primary" />On plan</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] bg-accent-warm" />Over target</span>
        {hasToday && <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] bg-[hsl(var(--chart-3))]" />Today (partial)</span>}
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] border border-dashed border-[#d5a7a7]" />Not logged</span>
      </figcaption>
    </figure>
  );
}
