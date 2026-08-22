import type { WeightEntry } from "@/data/mock-data";

interface WeightTrendProps {
  entries: WeightEntry[];
  goalWeight: number;
  startingWeight: number;
  patientName: string;
}

const formatShortDate = (date: string) =>
  new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function WeightTrend({ entries, goalWeight, startingWeight, patientName }: WeightTrendProps) {
  if (entries.length === 0) {
    return (
      <div className="grid h-56 place-items-center border border-dashed border-[#bdc9dc] bg-[#f8f9fc] p-6 text-center text-xs text-[#718099]">
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
  const minWeight = Math.floor(Math.min(lowestEntry - 2, Math.max(goalWeight - 2, lowestEntry - 8)));
  const maxWeight = Math.ceil(Math.max(startingWeight, ...entries.map((entry) => entry.weight)) + 2);
  const range = Math.max(1, maxWeight - minWeight);
  const xFor = (index: number) => left + ((width - left - right) * (entries.length === 1 ? 0.5 : index / (entries.length - 1)));
  const yFor = (weight: number) => top + ((maxWeight - weight) / range) * (height - top - bottom);
  const path = entries.map((entry, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(entry.weight)}`).join(' ');
  const goalIsVisible = goalWeight >= minWeight;
  const goalY = goalIsVisible ? yFor(goalWeight) : height - bottom;
  const midWeight = Math.round((minWeight + maxWeight) / 2);
  const labels = [maxWeight, midWeight, minWeight];

  return (
    <figure aria-labelledby="weight-trend-caption">
      <div className="overflow-x-auto border border-[#dfe5ef] bg-white p-2">
        <svg
          className="h-60 min-w-[580px] w-full"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby="weight-trend-title weight-trend-description"
        >
          <title id="weight-trend-title">Weight trend for {patientName}</title>
          <desc id="weight-trend-description">
            {entries.length} logged weigh-ins. The dashed line is the goal weight of {goalWeight} pounds.
          </desc>
          {labels.map((label) => (
            <g key={label}>
              <line x1={left} x2={width - right} y1={yFor(label)} y2={yFor(label)} stroke="#e4e8f0" strokeWidth="1" />
              <text x={left - 8} y={yFor(label) + 4} textAnchor="end" fill="#718099" fontSize="10">{label}</text>
            </g>
          ))}
          <g>
            <line x1={left} x2={width - right} y1={goalY} y2={goalY} stroke="#9a6c29" strokeDasharray="5 4" strokeWidth="1.5" />
            <text x={width - right} y={goalY - 6} textAnchor="end" fill="#97631e" fontSize="10" fontWeight="700">
              Goal {goalWeight} lb{goalIsVisible ? '' : ' · below range'}
            </text>
          </g>
          <path d={path} fill="none" stroke="#315fc0" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
          {entries.map((entry, index) => (
            <g key={`${entry.date}-${index}`}>
              <circle cx={xFor(index)} cy={yFor(entry.weight)} r="4.5" fill="#fbfcff" stroke="#315fc0" strokeWidth="2.5">
                <title>{formatShortDate(entry.date)}: {entry.weight.toFixed(1)} pounds</title>
              </circle>
              {(index === 0 || index === entries.length - 1 || index % Math.ceil(entries.length / 5) === 0) && (
                <text x={xFor(index)} y={height - 14} textAnchor="middle" fill="#718099" fontSize="10">
                  {formatShortDate(entry.date)}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      <figcaption id="weight-trend-caption" className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] text-[#718099]">
        <span>Each point is a logged weigh-in. Hover or use the list below for exact values.</span>
        <span className="font-semibold text-[#97631e]">Goal reference: {goalWeight} lbs</span>
      </figcaption>
    </figure>
  );
}