/**
 * Tiny inline trend line for tables and stat rows.
 *
 * Pure SVG, no chart library: a polyline scaled to the value range plus a
 * dot on the latest point. Screen readers get a summary sentence instead of
 * the path (role="img" + aria-label), so the trend is still announced.
 */
import { sparklineSummary } from '@/lib/sparkline-summary';

interface SparklineProps {
  values: number[];
  /** What the values count — used in the accessible summary ("engaged patients"). */
  label: string;
  width?: number;
  height?: number;
  className?: string;
  testId?: string;
}

export function Sparkline({ values, label, width = 96, height = 24, className, testId }: SparklineProps) {
  const summary = sparklineSummary(values, label);
  if (values.length === 0) {
    return (
      <span className={`inline-block text-[10px] text-muted-foreground ${className ?? ''}`} data-testid={testId}>
        —
      </span>
    );
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const stepX = values.length > 1 ? innerW / (values.length - 1) : 0;
  const points = values.map((value, index) => {
    const x = pad + (values.length > 1 ? index * stepX : innerW / 2);
    const y = pad + innerH - ((value - min) / span) * innerH;
    return [Number(x.toFixed(2)), Number(y.toFixed(2))] as const;
  });
  const last = points[points.length - 1];

  return (
    <svg
      role="img"
      aria-label={summary}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`overflow-visible text-primary ${className ?? ''}`}
      data-testid={testId}
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points.map(([x, y]) => `${x},${y}`).join(' ')}
      />
      <circle cx={last[0]} cy={last[1]} r={2} fill="currentColor" />
    </svg>
  );
}
