/**
 * Payments charts for the provider app's Payments overview: a port of the
 * web area's RevenueCharts (artifacts/thinnr-operations
 * src/components/billing/hq/RevenueCharts.tsx) to react-native-svg with the
 * same semantics:
 *   - niceMax axis, signed y-domain when any value is negative,
 *   - the readout is TOUCH-ONLY (nothing pinned at rest; drag across the
 *     plot to scrub, lift to clear),
 *   - `running` series read the last point as the total ("so far"),
 *   - hourly series are running totals through the current hour, with
 *     "Through 3 PM" / "So far today" readout headers,
 *   - every chart carries a spoken summary as its accessibility label.
 *
 * Pure SVG in real pixels (width measured from the layout), so the verify
 * scripts render it under react-test-renderer without a DOM.
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { formatCents } from '@/lib/office-billing-format';
import type { HourPoint, SeriesPoint } from '@/lib/office-billing-types';
import { CARD_SHADOW_SOFT, MicroLabel } from './primitives';

export type Money = 'money' | 'count';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

const FALLBACK_W = 360;
const PAD = { top: 16, right: 12, bottom: 26, left: 48 };
const AXIS_TEXT = '#6b7590';

function fmt(value: number, unit: Money): string {
  return unit === 'money' ? formatCents(value) : value.toLocaleString('en-US');
}

/** Short axis label: "$1.2k" / "$850" / "12". */
export function axis(value: number, unit: Money): string {
  if (unit === 'count') return value.toLocaleString('en-US');
  const sign = value < 0 ? '-' : '';
  const dollars = Math.abs(value) / 100;
  if (dollars >= 1000) return `${sign}$${(dollars / 1000).toFixed(dollars >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(dollars)}`;
}

/** "Sep 3" — short, timezone-free label for a YYYY-MM-DD key. */
export function shortDay(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = max / magnitude;
  const nice = step <= 1 ? 1 : step <= 2 ? 2 : step <= 2.5 ? 2.5 : step <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** "12 AM", "1 PM" for an hour key "0".."23". */
export function hourLabel(key: string): string {
  const hour = Number(key);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function chartSummary(title: string, dates: string[], series: ChartSeries[], unit: Money, label: (key: string) => string = shortDay, running = false): string {
  if (dates.length === 0) return `${title}: no data.`;
  const parts = series.map((s) => {
    if (running) return `${s.label} ${fmt(s.values[s.values.length - 1] ?? 0, unit)} so far`;
    const total = s.values.reduce((sum, v) => sum + v, 0);
    const peakIndex = s.values.reduce((best, v, i) => (v > s.values[best] ? i : best), 0);
    return `${s.label} ${fmt(total, unit)} in total, peaking at ${fmt(s.values[peakIndex] ?? 0, unit)} at ${label(dates[peakIndex])}`;
  });
  return `${title}, ${label(dates[0])} to ${label(dates[dates.length - 1])}: ${parts.join('; ')}.`;
}

export interface AreaChartProps {
  title: string;
  dates: string[];
  series: ChartSeries[];
  unit: Money;
  height?: number;
  compact?: boolean;
  formatLabel?: (key: string) => string;
  formatLabelLong?: (key: string) => string;
  emptyLabel?: string;
  labelCount?: number;
  running?: boolean;
  testID?: string;
}

export function AreaChart({
  title,
  dates,
  series,
  unit,
  height = 220,
  compact = false,
  formatLabel = shortDay,
  formatLabelLong,
  emptyLabel = 'No activity in this range yet',
  labelCount,
  running = false,
  testID,
}: AreaChartProps) {
  const colors = useColors();
  const [width, setWidth] = useState(FALLBACK_W);
  const [hover, setHover] = useState<number | null>(null);
  const n = dates.length;
  const pad = compact ? { top: 8, right: 8, bottom: 18, left: 8 } : PAD;
  const innerW = Math.max(1, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const max = useMemo(() => niceMax(Math.max(0, ...series.flatMap((s) => s.values))), [series]);
  const min = useMemo(() => {
    const lowest = Math.min(0, ...series.flatMap((s) => s.values));
    return lowest < 0 ? -niceMax(-lowest) : 0;
  }, [series]);
  const span = max - min;
  const x = (i: number) => pad.left + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
  const y = (v: number) => pad.top + innerH - ((v - min) / span) * innerH;
  const summary = chartSummary(title, dates, series, unit, formatLabel, running);
  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next > 0 && next !== width) setWidth(next);
  };

  if (n === 0 || series.every((s) => s.values.every((v) => v === 0))) {
    return (
      <View
        onLayout={onLayout}
        testID={testID}
        accessibilityRole="image"
        accessibilityLabel={summary}
        style={[styles.empty, { height, borderColor: colors.border }]}
      >
        <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{emptyLabel}</Text>
      </View>
    );
  }

  const ticks = compact ? (min < 0 ? [min, 0, max] : [0, max]) : [...(min < 0 ? [min, min / 2] : []), 0, max / 4, max / 2, (max * 3) / 4, max];
  const fitLabels = Math.max(2, Math.floor(innerW / (compact ? 56 : 64)));
  const labelEvery = Math.max(1, Math.ceil((n - 1) / Math.max(1, Math.min(labelCount ?? (compact ? 3 : 8), fitLabels) - 1)));
  const lastLabelIndex = n - 1;
  const showLabel = (i: number) => {
    if (i === lastLabelIndex) return true;
    if (i % labelEvery !== 0) return false;
    return x(lastLabelIndex) - x(i) >= (compact ? 40 : 48);
  };
  const engaged = hover !== null;
  const active = hover ?? n - 1;
  const readout = series.map((s) => `${s.label} ${fmt(s.values[active] ?? 0, unit)}`);
  const longLabel = (formatLabelLong ?? formatLabel)(dates[active]);
  const activeX = x(active);
  const pick = (locationX: number) => {
    const index = Math.round(((locationX - pad.left) / innerW) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, index)));
  };
  const linePath = (values: number[]) => values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const areaPath = (values: number[]) => `${linePath(values)} L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const gradientBase = `g-${(testID ?? title).replace(/[^a-z0-9]/gi, '')}`;

  return (
    <View testID={testID} onLayout={onLayout} style={styles.figure}>
      <View
        accessibilityRole="image"
        accessibilityLabel={summary}
        accessibilityHint="Drag across the chart to read each point"
        onStartShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(event) => pick(event.nativeEvent.locationX)}
        onResponderMove={(event) => pick(event.nativeEvent.locationX)}
        onResponderRelease={() => setHover(null)}
        onResponderTerminate={() => setHover(null)}
        testID={testID ? `${testID}-plot` : undefined}
      >
        <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <Defs>
            {series.map((s) => (
              <LinearGradient key={s.key} id={`${gradientBase}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                <Stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
              </LinearGradient>
            ))}
          </Defs>
          {ticks.map((t) => (
            <React.Fragment key={t}>
              <Line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke={colors.border} strokeWidth={1} strokeDasharray={t === 0 ? undefined : '2 4'} />
              {!compact && (
                <SvgText x={pad.left - 8} y={y(t) + 3} textAnchor="end" fontSize={10} fill={AXIS_TEXT}>
                  {axis(t, unit)}
                </SvgText>
              )}
            </React.Fragment>
          ))}
          {dates.map((d, i) =>
            showLabel(i) ? (
              <SvgText key={d} x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize={10} fill={AXIS_TEXT}>
                {formatLabel(d)}
              </SvgText>
            ) : null,
          )}
          {series.map((s) => (
            <React.Fragment key={s.key}>
              <Path d={areaPath(s.values)} fill={`url(#${gradientBase}-${s.key})`} />
              <Path d={linePath(s.values)} fill="none" stroke={s.color} strokeWidth={compact ? 1.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
            </React.Fragment>
          ))}
          {engaged && (
            <>
              <Line x1={activeX} x2={activeX} y1={pad.top} y2={pad.top + innerH} stroke={colors.navy} strokeWidth={1} strokeDasharray="3 3" />
              {series.map((s) => (
                <Path
                  key={`dot-${s.key}`}
                  d={`M${(activeX - 3.5).toFixed(1)},${y(s.values[active] ?? 0).toFixed(1)} a3.5,3.5 0 1,0 7,0 a3.5,3.5 0 1,0 -7,0`}
                  fill={colors.card}
                  stroke={s.color}
                  strokeWidth={2}
                />
              ))}
            </>
          )}
        </Svg>
      </View>
      {/* Live text only while engaged: nothing announced or pinned at rest. */}
      <Text accessibilityLiveRegion="polite" aria-live="polite" style={styles.srOnly}>
        {engaged ? `${longLabel}: ${readout.join(', ')}` : ''}
      </Text>
      {engaged && !compact && (
        <View testID={testID ? `${testID}-readout` : undefined} style={[styles.readout, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
          <Text style={[styles.readoutHead, { color: colors.navy }]}>{longLabel}</Text>
          {series.map((s, i) => (
            <View key={s.key} style={styles.readoutRow}>
              <View style={[styles.swatch, { backgroundColor: s.color }]} />
              <Text style={[styles.readoutLabel, { color: colors.mutedForeground }]}>{s.label}</Text>
              <Text style={[styles.readoutValue, { color: colors.navy }]}>{readout[i].slice(s.label.length + 1)}</Text>
            </View>
          ))}
        </View>
      )}
      {!compact && (
        <View style={styles.legend}>
          {series.map((s) => (
            <View key={s.key} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: s.color }]} />
              <Text style={[styles.legendText, { color: colors.mutedForeground }]}>{s.label}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function ChartCard({ label, value, detail, dates, values, unit, color, running, testID }: {
  label: string;
  value: string;
  detail?: string;
  dates: string[];
  values: number[];
  unit: Money;
  color: string;
  running?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <View testID={testID} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius, boxShadow: CARD_SHADOW_SOFT }]}>
      <MicroLabel>{label}</MicroLabel>
      <Text style={[styles.cardValue, { color: colors.navy }]}>{value}</Text>
      {detail ? <Text style={[styles.cardDetail, { color: colors.subtleText }]}>{detail}</Text> : null}
      <View style={{ marginTop: 10 }}>
        <AreaChart title={label} dates={dates} series={[{ key: 'v', label, color, values }]} unit={unit} height={90} compact running={running} />
      </View>
    </View>
  );
}

export function cumulative(values: number[]): number[] {
  let running = 0;
  return values.map((v) => (running += v));
}

/** Same hues the web area resolves from its theme tokens. */
export const CHART_COLORS = {
  gross: '#315eae',
  net: '#8da4d6',
  fees: '#b65c22',
  profit: '#2f7d4f',
  refunds: '#a04646',
  count: '#5878b9',
};
export const OFFICE_NET = '#2f7d4f';

/** Today's points through the current hour as RUNNING TOTALS (lines only climb). */
export function hourlySeriesFrom(points: HourPoint[], currentHour: number) {
  const shown = points.filter((p) => p.hour <= currentHour);
  return {
    hours: shown.map((p) => String(p.hour)),
    gross: cumulative(shown.map((p) => p.collected_cents)),
    net: cumulative(shown.map((p) => p.net_cents)),
    fees: cumulative(shown.map((p) => p.fee_cents)),
    profit: cumulative(shown.map((p) => p.profit_cents)),
  };
}

/** Readout header for a running-total hour: "Through 3 PM", or "So far today" on the current hour. */
export function runningHourLabel(key: string, currentHourKey: string): string {
  if (key === currentHourKey) return 'So far today';
  return `Through ${hourLabel(String((Number(key) + 1) % 24))}`;
}

export function seriesFrom(series: SeriesPoint[]) {
  return {
    dates: series.map((p) => p.date),
    gross: series.map((p) => p.collected_cents),
    net: series.map((p) => p.collected_cents - p.refunded_cents),
    officeNet: series.map((p) => p.net_cents),
    fees: series.map((p) => p.fee_cents),
    refunds: series.map((p) => p.refunded_cents),
    orders: series.map((p) => p.orders),
  };
}

const styles = StyleSheet.create({
  figure: { width: '100%' },
  empty: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
  readout: { marginTop: 8, borderWidth: 1, borderRadius: 7, paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  readoutHead: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  readoutRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  readoutLabel: { fontSize: 11, fontFamily: 'Inter_400Regular', flex: 1 },
  readoutValue: { fontSize: 11, fontFamily: 'Inter_600SemiBold', fontVariant: ['tabular-nums'] },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendText: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  swatch: { width: 8, height: 8, borderRadius: 4 },
  card: { borderWidth: 1, padding: 14, gap: 4 },
  cardValue: { fontSize: 22, fontFamily: fonts.serifBold, fontVariant: ['tabular-nums'] },
  cardDetail: { fontSize: 11, fontFamily: 'Inter_400Regular' },
});
