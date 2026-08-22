import { summarizeMeals, type DailyLog, type DailyTargets } from "@/data/nutrition-data";

interface AdherenceTrendProps {
  days: DailyLog[];
  targets: DailyTargets;
  patientName: string;
}

const shortDate = (dateKey: string) =>
  new Date(`${dateKey}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * 14-day calories-vs-target and water-vs-target bars, drawn in the same
 * hand-rolled SVG style as the weight trend chart.
 */
export function AdherenceTrend({ days, targets, patientName }: AdherenceTrendProps) {
  const window14 = days.slice(-14);
  if (window14.length === 0) {
    return (
      <div className="grid h-48 place-items-center border border-dashed border-[#bdc9dc] bg-[#f8f9fc] p-6 text-center text-xs text-[#718099]">
        No logging history is available yet.
      </div>
    );
  }

  const width = 760;
  const height = 306;
  const left = 52;
  const right = 14;
  const slot = (width - left - right) / window14.length;
  const barWidth = Math.min(30, slot * 0.62);
  const xFor = (index: number) => left + slot * index + slot / 2;

  const calTotals = window14.map((day) => summarizeMeals(day.meals).calories);
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
  const waterScale = Math.max(80, ...window14.map((day) => day.waterOz));
  const yWater = (value: number) => waterTop + (1 - value / waterScale) * waterHeight;

  return (
    <figure>
      <div className="overflow-x-auto border border-[#dfe5ef] bg-white p-2">
        <svg
          className="h-72 min-w-[560px] w-full"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby="adherence-trend-title adherence-trend-desc"
        >
          <title id="adherence-trend-title">14-day intake and water logging for {patientName}</title>
          <desc id="adherence-trend-desc">
            Daily logged calories against the {targets.calories}-calorie target, and water against the {targets.waterOz} ounce target. Missed days are marked.
          </desc>

          <text x={left} y={12} fill="#8793a8" fontSize="8" fontWeight="700" letterSpacing="1.4">CALORIES LOGGED</text>
          {calTicks.map((tick) => (
            <g key={`cal-${tick}`}>
              <line x1={left} x2={width - right} y1={yCal(tick)} y2={yCal(tick)} stroke="#e4e8f0" strokeWidth="1" />
              <text x={left - 8} y={yCal(tick) + 3} textAnchor="end" fill="#718099" fontSize="9">{tick}</text>
            </g>
          ))}
          <line x1={left} x2={width - right} y1={yCal(targets.calories)} y2={yCal(targets.calories)} stroke="#9a6c29" strokeDasharray="5 4" strokeWidth="1.5" />
          <text x={width - right} y={yCal(targets.calories) - 5} textAnchor="end" fill="#97631e" fontSize="9" fontWeight="700">
            Target {targets.calories.toLocaleString()}
          </text>

          {window14.map((day, index) => {
            const calories = calTotals[index];
            const isToday = day.offset === 0;
            if (!day.logged) {
              return (
                <g key={day.dateKey}>
                  <rect x={xFor(index) - barWidth / 2} y={calBase - 9} width={barWidth} height={9} fill="none" stroke="#c99898" strokeDasharray="3 2" strokeWidth="1">
                    <title>{shortDate(day.dateKey)}: no meals logged</title>
                  </rect>
                </g>
              );
            }
            const fill = isToday ? "#8da4d6" : calories > targets.calories ? "#bc821e" : "#315fc0";
            return (
              <rect
                key={day.dateKey}
                x={xFor(index) - barWidth / 2}
                y={yCal(calories)}
                width={barWidth}
                height={Math.max(2, calBase - yCal(calories))}
                fill={fill}
              >
                <title>{shortDate(day.dateKey)}: {calories.toLocaleString()} cal{isToday ? " (today, still logging)" : ""} · target {targets.calories.toLocaleString()}</title>
              </rect>
            );
          })}

          <text x={left} y={waterTop - 8} fill="#8793a8" fontSize="8" fontWeight="700" letterSpacing="1.4">WATER (FL OZ)</text>
          <line x1={left} x2={width - right} y1={waterBase} y2={waterBase} stroke="#e4e8f0" strokeWidth="1" />
          <line x1={left} x2={width - right} y1={yWater(targets.waterOz)} y2={yWater(targets.waterOz)} stroke="#9a6c29" strokeDasharray="5 4" strokeWidth="1.5" />
          <text x={width - right} y={yWater(targets.waterOz) - 4} textAnchor="end" fill="#97631e" fontSize="9" fontWeight="700">
            {targets.waterOz} oz
          </text>
          {window14.map((day, index) => {
            if (day.waterOz <= 0) {
              return (
                <rect key={`w-${day.dateKey}`} x={xFor(index) - barWidth / 2} y={waterBase - 6} width={barWidth} height={6} fill="none" stroke="#c99898" strokeDasharray="3 2" strokeWidth="1">
                  <title>{shortDate(day.dateKey)}: no water logged</title>
                </rect>
              );
            }
            return (
              <rect
                key={`w-${day.dateKey}`}
                x={xFor(index) - barWidth / 2}
                y={yWater(day.waterOz)}
                width={barWidth}
                height={Math.max(2, waterBase - yWater(day.waterOz))}
                fill="#7f98cf"
              >
                <title>{shortDate(day.dateKey)}: {day.waterOz} oz of {targets.waterOz} oz</title>
              </rect>
            );
          })}

          {window14.map((day, index) => (
            index % 2 === window14.length % 2 ? (
              <text key={`label-${day.dateKey}`} x={xFor(index)} y={height - 6} textAnchor="middle" fill="#718099" fontSize="9">
                {shortDate(day.dateKey)}
              </text>
            ) : null
          ))}
        </svg>
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[#718099]">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 bg-[#315fc0]" />On plan</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 bg-[#bc821e]" />Over target</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 bg-[#8da4d6]" />Today (partial)</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 border border-dashed border-[#c99898]" />Not logged</span>
      </figcaption>
    </figure>
  );
}
