/**
 * Small controls the diet picker and the onboarding diet step share:
 * safety-screening questions, activity level, fasting preset + start time and
 * the Whole30 start day. RN primitives only (Node suites mount these).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import {
  ACTIVITY_LABELS,
  ACTIVITY_LEVELS,
  SCREENING_PROMPTS,
  type ActivityLevel,
  type ScreeningAnswer,
  type ScreeningQuestion,
} from '@/lib/diet-fit';
import { FASTING_PRESETS, fastingWindowFor, formatClock, minutesOf, timeOfMinutes, type FastingPreset } from '@/lib/diet-state';
import { formatDateKey, shiftDateKey } from '@/data/patient-data';

// ─── Shared chip ────────────────────────────────────────────────────────────

export function OptionChip({
  label,
  selected,
  onPress,
  testID,
  role = 'radio',
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
  role?: 'radio' | 'checkbox' | 'button';
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={role}
      accessibilityState={role === 'button' ? undefined : { checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? colors.cobalt : colors.card,
          borderColor: selected ? colors.cobalt : colors.border,
          borderRadius: colors.radiusSm,
        },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Text style={[styles.chipText, { color: selected ? colors.primaryForeground : colors.navy }]}>{label}</Text>
    </Pressable>
  );
}

export function SectionLabel({ text }: { text: string }) {
  const colors = useColors();
  return <Text style={[styles.sectionLabel, { color: colors.labelText }]}>{text.toUpperCase()}</Text>;
}

// ─── Screening ──────────────────────────────────────────────────────────────

export const SCREENING_TITLES: Record<ScreeningQuestion, string> = {
  medication: 'A quick safety check',
  eating_disorder: 'A quick safety check',
  pregnancy: 'Optional',
};

export function ScreeningQuestionRows({
  questions,
  answers,
  onAnswer,
  testIDPrefix = 'screen',
}: {
  questions: ScreeningQuestion[];
  answers: Partial<Record<ScreeningQuestion, ScreeningAnswer | null | undefined>>;
  onAnswer: (question: ScreeningQuestion, answer: ScreeningAnswer) => void;
  testIDPrefix?: string;
}) {
  const colors = useColors();
  if (questions.length === 0) return null;
  return (
    <View style={styles.block}>
      {questions.map(q => {
        const value = answers[q] ?? null;
        return (
          <View key={q} testID={`${testIDPrefix}-${q}`} style={[styles.questionCard, { backgroundColor: colors.accent, borderColor: colors.border, borderRadius: colors.radiusSm }]}>
            <Text style={[styles.sectionLabel, { color: colors.labelText }]}>{SCREENING_TITLES[q].toUpperCase()}</Text>
            <Text style={[styles.prompt, { color: colors.navy }]}>{SCREENING_PROMPTS[q]}</Text>
            <View style={styles.row}>
              <OptionChip label="Yes" selected={value === 'yes'} onPress={() => onAnswer(q, 'yes')} testID={`${testIDPrefix}-${q}-yes`} />
              <OptionChip label="No" selected={value === 'no'} onPress={() => onAnswer(q, 'no')} testID={`${testIDPrefix}-${q}-no`} />
              {q === 'pregnancy' ? (
                <OptionChip label="Prefer not to say" selected={value === 'skipped'} onPress={() => onAnswer(q, 'skipped')} testID={`${testIDPrefix}-${q}-skip`} />
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ─── Activity level ─────────────────────────────────────────────────────────

export const ACTIVITY_SHORT_LABELS: Record<ActivityLevel, string> = {
  sedentary: 'Mostly sitting',
  light: 'Light',
  moderate: 'Moderate',
  active: 'Active',
  very_active: 'Very active',
};

export function ActivityLevelPicker({
  value,
  onChange,
  testIDPrefix = 'activity',
}: {
  value: ActivityLevel | null;
  onChange: (level: ActivityLevel) => void;
  testIDPrefix?: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.block}>
      {ACTIVITY_LEVELS.map(level => {
        const selected = value === level;
        return (
          <Pressable
            key={level}
            testID={`${testIDPrefix}-${level}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(level)}
            style={({ pressed }) => [
              styles.activityRow,
              {
                backgroundColor: colors.card,
                borderColor: selected ? colors.cobalt : colors.border,
                borderWidth: selected ? 2 : 1,
                borderRadius: colors.radiusSm,
              },
              pressed && { opacity: 0.9 },
            ]}
          >
            <Text style={[styles.activityName, { color: colors.navy }]}>{ACTIVITY_SHORT_LABELS[level]}</Text>
            <Text style={[styles.activitySub, { color: colors.subtleText }]}>{ACTIVITY_LABELS[level]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── Fasting window ─────────────────────────────────────────────────────────

export function presetById(id: string | null | undefined): FastingPreset {
  return FASTING_PRESETS.find(p => p.id === id) ?? FASTING_PRESETS[0];
}

export function FastingWindowFields({
  presetId,
  eatingStart,
  onChange,
  testIDPrefix = 'fasting',
}: {
  presetId: string | null;
  eatingStart: string;
  onChange: (next: { presetId: string; eatingStart: string }) => void;
  testIDPrefix?: string;
}) {
  const colors = useColors();
  const preset = presetById(presetId);
  const window = fastingWindowFor(preset, eatingStart);
  const shift = (delta: number) => onChange({ presetId: preset.id, eatingStart: timeOfMinutes(minutesOf(eatingStart) + delta) });
  return (
    <View style={styles.block}>
      <SectionLabel text="Fasting schedule" />
      <View style={styles.row}>
        {FASTING_PRESETS.map(p => (
          <OptionChip
            key={p.id}
            label={p.label}
            selected={preset.id === p.id}
            testID={`${testIDPrefix}-preset-${p.id.replace(':', '-')}`}
            onPress={() => onChange({ presetId: p.id, eatingStart: presetId ? eatingStart : p.defaultStart })}
          />
        ))}
      </View>
      <View style={[styles.timeRow, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.sectionLabel, { color: colors.labelText }]}>EATING WINDOW</Text>
          <Text testID={`${testIDPrefix}-window`} style={[styles.windowText, { color: colors.navy }]}>
            {formatClock(window.eatingStart)} – {formatClock(window.eatingEnd)}
          </Text>
        </View>
        <View style={styles.row}>
          <OptionChip label="−30 min" role="button" selected={false} onPress={() => shift(-30)} testID={`${testIDPrefix}-earlier`} />
          <OptionChip label="+30 min" role="button" selected={false} onPress={() => shift(30)} testID={`${testIDPrefix}-later`} />
        </View>
      </View>
    </View>
  );
}

// ─── Whole30 start ──────────────────────────────────────────────────────────

export function Whole30StartFields({
  todayKey,
  startDate,
  onChange,
  testIDPrefix = 'whole30',
}: {
  todayKey: string;
  startDate: string;
  onChange: (startDate: string) => void;
  testIDPrefix?: string;
}) {
  const colors = useColors();
  const value = startDate || todayKey;
  const tomorrow = shiftDateKey(todayKey, 1);
  const label = value === todayKey ? 'Today' : value === tomorrow ? 'Tomorrow' : formatDateKey(value);
  return (
    <View style={styles.block}>
      <SectionLabel text="Day one" />
      <View style={styles.row}>
        <OptionChip label="Today" selected={value === todayKey} onPress={() => onChange(todayKey)} testID={`${testIDPrefix}-today`} />
        <OptionChip label="Tomorrow" selected={value === tomorrow} onPress={() => onChange(tomorrow)} testID={`${testIDPrefix}-tomorrow`} />
        <OptionChip label="Next week" selected={value === shiftDateKey(todayKey, 7)} onPress={() => onChange(shiftDateKey(todayKey, 7))} testID={`${testIDPrefix}-next-week`} />
      </View>
      <Text testID={`${testIDPrefix}-start`} style={[styles.activitySub, { color: colors.bodyText }]}>
        Your 30 days start {label}. The day counter lives on Today.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  chipText: { fontFamily: fonts.sansMedium, fontSize: 13 },
  sectionLabel: { fontFamily: fonts.sansMedium, fontSize: 11, letterSpacing: 0.8 },
  questionCard: { borderWidth: 1, padding: 12, gap: 8 },
  prompt: { fontFamily: fonts.sansMedium, fontSize: 14, lineHeight: 20 },
  activityRow: { padding: 12, gap: 2 },
  activityName: { fontFamily: fonts.sansSemiBold, fontSize: 14 },
  activitySub: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
  timeRow: { borderWidth: 1, padding: 12, gap: 10 },
  windowText: { fontFamily: fonts.sansSemiBold, fontSize: 16 },
});
