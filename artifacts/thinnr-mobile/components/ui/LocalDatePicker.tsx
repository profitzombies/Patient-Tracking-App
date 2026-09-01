import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

interface LocalDatePickerProps {
  value: string;
  onChange: (dateKey: string) => void;
  minDate?: string;
  maxDate?: string;
  testID: string;
}

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateFromKey(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

export function LocalDatePicker({
  value,
  onChange,
  minDate,
  maxDate,
  testID,
}: LocalDatePickerProps) {
  const colors = useColors();
  const selected = dateFromKey(value);
  const [visibleMonth, setVisibleMonth] = useState(
    () => new Date((selected ?? new Date()).getFullYear(), (selected ?? new Date()).getMonth(), 1, 12),
  );
  const cells = useMemo(() => {
    const first = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1, 12);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, [visibleMonth]);
  const monthLabel = visibleMonth.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  const shiftMonth = (delta: number) => {
    setVisibleMonth(current => new Date(current.getFullYear(), current.getMonth() + delta, 1, 12));
  };

  return (
    <View
      testID={testID}
      accessibilityLabel="Calendar date picker"
      style={[
        styles.calendar,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRadius: colors.radiusSm,
        },
      ]}
    >
      <View style={styles.header}>
        <Pressable
          testID={`${testID}-previous-month`}
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          onPress={() => shiftMonth(-1)}
          style={styles.monthButton}
        >
          <Feather name="chevron-left" size={18} color={colors.navy} />
        </Pressable>
        <Text style={[styles.monthLabel, { color: colors.navy }]}>{monthLabel}</Text>
        <Pressable
          testID={`${testID}-next-month`}
          accessibilityRole="button"
          accessibilityLabel="Next month"
          onPress={() => shiftMonth(1)}
          style={styles.monthButton}
        >
          <Feather name="chevron-right" size={18} color={colors.navy} />
        </Pressable>
      </View>
      <View style={styles.grid}>
        {DAY_LABELS.map((label, index) => (
          <Text key={`${label}-${index}`} style={[styles.dayLabel, { color: colors.labelText }]}>
            {label}
          </Text>
        ))}
        {cells.map(date => {
          const key = dateKey(date);
          const outside = date.getMonth() !== visibleMonth.getMonth();
          const disabled = (minDate ? key < minDate : false) || (maxDate ? key > maxDate : false);
          const active = key === value;
          return (
            <Pressable
              key={key}
              testID={`${testID}-day-${key}`}
              accessibilityRole="button"
              accessibilityLabel={date.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
              accessibilityState={{ selected: active, disabled }}
              disabled={disabled}
              onPress={() => onChange(key)}
              style={[
                styles.day,
                active && { backgroundColor: colors.cobalt },
                disabled && styles.disabled,
              ]}
            >
              <Text
                style={[
                  styles.dayText,
                  { color: outside ? colors.subtleText : colors.bodyText },
                  active && { color: colors.card },
                ]}
              >
                {date.getDate()}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  calendar: {
    borderWidth: 1,
    padding: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  monthButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthLabel: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayLabel: {
    width: '14.2857%',
    textAlign: 'center',
    fontSize: 9,
    fontFamily: 'Inter_700Bold',
    paddingVertical: 5,
  },
  day: {
    width: '14.2857%',
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
  },
  dayText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  disabled: {
    opacity: 0.25,
  },
});