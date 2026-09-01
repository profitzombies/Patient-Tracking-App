import type { WeightEntry } from "@/data/mock-data";

interface WeightTrendProps {
  entries: WeightEntry[];
  goalWeight?: number | null;
  startingWeight: number;
  patientName: string;
}

const formatShortDate = (date: string) =>
  new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function WeightTrend({ entries, goalWeight, startingWeight, patientName }: WeightTrendProps) {
  if (entries.length === 0) {
    return (
      <div className="grid h-56 place-items-center rounded-md border border-dashed border-border bg-secondary p-6 text-center text-xs text-muted-foreground">
        No weigh-ins have been logged for this session yet.
      </div>
    );
  }

  const width = 760;
  const height = 250;
  const left = 48;
  const right = 18;
  const top = 20;
  const bottom = 40;
  const lowestEntry = Math.min(...entries.map((entry) => entry.weight));
  const minWeight = Math.floor(goalWeight == null ? lowestEntry - 2 : Math.min(lowestEntry - 2, Math.max(goalWeight - 2, lowestEntry - 8)));
  const maxWeight = Math.ceil(Math.max(startingWeight, ...entries.map((entry) => entry.weight)) + 2);
  const range = Math.max(1, maxWeight - minWeight);
  const xFor = (index: number) => left + ((width - left - right) * (entries.length === 1 ? 0.5 : index / (entries.length - 1)));
  const yFor = (weight: number) => top + ((maxWeight - weight) / range) * (height - top - bottom);
  const path = entries.map((entry, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(entry.weight)}`).join(' ');
  const goalIsVisible = goalWeight != null && goalWeight >= minWeight;
  const goalY = goalWeight != null && goalIsVisible ? yFor(goalWeight) : height - bottom;
  const midWeight = Math.round((minWeight + maxWeight) / 2);
  const labels = [maxWeight, midWeight, minWeight];

  return (
    <figure aria-labelledby="weight-trend-caption">
      <div className="overflow-x-auto rounded-md border border-border bg-white p-2">
        <svg
          className="h-60 min-w-[580px] w-full"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby="weight-trend-title weight-trend-description"
        >
          <title id="weight-trend-title">Weight trend for {patientName}</title>
          <desc id="weight-trend-description">
            {entries.length} logged weigh-ins.{goalWeight != null ? ` The dashed line is the goal weight of ${goalWeight} pounds.` : ''}
          </desc>
          {labels.map((label) => (
            <g key={label}>
              <line className="stroke-border" x1={left} x2={width - right} y1={yFor(label)} y2={yFor(label)} strokeWidth="1" />
              <text className="fill-muted-foreground" x={left - 8} y={yFor(label) + 4} textAnchor="end" fontSize="10">{label}</text>
            </g>
          ))}
          {goalWeight != null && <g>
            <line className="stroke-accent-warm" x1={left} x2={width - right} y1={goalY} y2={goalY} strokeDasharray="5 4" strokeWidth="1.5" />
            <text className="fill-[#b65c22]" x={width - right} y={goalY - 6} textAnchor="end" fontSize="10" fontWeight="700">
              Goal {goalWeight} lb{goalIsVisible ? '' : ' · below range'}
            </text>
          </g>}
          <path className="stroke-primary" d={path} fill="none" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
          {entries.map((entry, index) => (
            <g key={`${entry.date}-${index}`}>
              <circle className="fill-white stroke-primary" cx={xFor(index)} cy={yFor(entry.weight)} r="4.5" strokeWidth="2.5">
                <title>{formatShortDate(entry.date)}: {entry.weight.toFixed(1)} pounds</title>
              </circle>
              {(index === 0 || index === entries.length - 1 || index % Math.ceil(entries.length / 5) === 0) && (
                <text className="fill-muted-foreground" x={xFor(index)} y={height - 14} textAnchor="middle" fontSize="10">
                  {formatShortDate(entry.date)}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      <figcaption id="weight-trend-caption" className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] text-muted-foreground">
        <span>Each point is a logged weigh-in. Hover or use the list below for exact values.</span>
        {goalWeight != null && <span className="font-semibold text-[#b65c22]">Goal reference: {goalWeight} lbs</span>}
      </figcaption>
    </figure>
  );
}
