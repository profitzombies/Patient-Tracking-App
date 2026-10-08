/**
 * Weight trend line chart for patient mode. Heritage language: ledger-style
 * hairline rules on paper, a cobalt series line with paper-filled markers,
 * and the goal as a restrained dashed orange reference. Adapted for a denser
 * check-in series: sparse date labels and auto-scroll to the newest reading.
 * With no weigh-ins it says so instead of drawing an empty plot; with no goal
 * on record it leaves the goal line out.
 */
import React, { useRef } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { fonts } from '@/constants/colors';
import { useColors } from '@/hooks/useColors';
import type { WeightPoint } from '@/context/PatientContext';

const formatLabel = (dateKey: string) =>
  new Date(`${dateKey}T12:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

interface PatientWeightChartProps {
  points: WeightPoint[];
  /** Null when the account has no goal weight on record. */
  goalWeight: number | null;
}

export function PatientWeightChart({ points, goalWeight }: PatientWeightChartProps) {
  const colors = useColors();
  const scrollRef = useRef<ScrollView>(null);

  if (points.length === 0) {
    return (
      <View testID="weight-chart-empty" style={{ paddingVertical: 28, paddingHorizontal: 16, alignItems: 'center' }}>
        <Text style={{ fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, color: colors.subtleText, textAlign: 'center' }}>
          No weigh-ins yet. Your trend appears once you record a weight at check-in.
        </Text>
      </View>
    );
  }

  const chartWidth = Math.max(330, points.length * 30);
  const chartHeight = 170;
  const top = 16;
  const bottom = 34;
  const side = 24;

  const values = goalWeight === null ? points.map(p => p.weight) : [...points.map(p => p.weight), goalWeight];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const padding = Math.max(2, (high - low) * 0.14);
  const min = low - padding;
  const max = high + padding;
  const range = Math.max(1, max - min);
  const plotHeight = chartHeight - top - bottom;

  const xFor = (index: number) => points.length < 2
    ? chartWidth / 2
    : side + (index / (points.length - 1)) * (chartWidth - side * 2);
  const yFor = (weight: number) => top + ((max - weight) / range) * plotHeight;

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.weight)}`).join(' ');
  const goalY = goalWeight === null ? null : yFor(goalWeight);
  const labelEvery = Math.max(1, Math.ceil(points.length / 7));
  // Ruled lines across the plot, like a ledger sheet (baseline drawn darker).
  const gridYs = [top, top + plotHeight / 2];

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingRight: 8 }}
      onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      accessibilityLabel="Weight trend chart; swipe horizontally to review all weigh-ins"
    >
      <Svg width={chartWidth} height={chartHeight}>
        {gridYs.map(y => (
          <Line key={y} x1={side} x2={chartWidth - side} y1={y} y2={y} stroke={colors.divider} strokeWidth={1} />
        ))}
        <Line x1={side} x2={chartWidth - side} y1={top + plotHeight} y2={top + plotHeight} stroke={colors.border} strokeWidth={1} />
        {goalWeight !== null && goalY !== null ? (
          <>
            <Line x1={side} x2={chartWidth - side} y1={goalY} y2={goalY} stroke={colors.orange} strokeWidth={1} strokeDasharray="4 4" />
            <SvgText x={chartWidth - side} y={Math.max(12, goalY - 5)} textAnchor="end" fill={colors.orangeText} fontSize="9" fontWeight="600">
              Goal {goalWeight.toFixed(1)}
            </SvgText>
          </>
        ) : null}
        <Path d={path} fill="none" stroke={colors.cobalt} strokeWidth={2.5} />
        {points.map((p, index) => {
          const isLast = index === points.length - 1;
          const showLabel = index % labelEvery === 0 || isLast;
          return (
            <React.Fragment key={`${p.dateKey}-${index}`}>
              {(showLabel || isLast) && (
                <Circle
                  cx={xFor(index)}
                  cy={yFor(p.weight)}
                  r={isLast ? 4 : 3}
                  fill={isLast ? colors.cobalt : colors.card}
                  stroke={colors.cobalt}
                  strokeWidth={2}
                />
              )}
              {showLabel && (
                <SvgText x={xFor(index)} y={chartHeight - 12} textAnchor="middle" fill={colors.subtleText} fontSize="8">
                  {formatLabel(p.dateKey)}
                </SvgText>
              )}
            </React.Fragment>
          );
        })}
      </Svg>
    </ScrollView>
  );
}
