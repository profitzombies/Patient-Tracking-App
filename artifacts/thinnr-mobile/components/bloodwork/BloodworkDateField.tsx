import React, { useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { LocalDatePicker } from '@/components/ui/LocalDatePicker';
import { formatBloodworkDate } from '@/lib/bloodwork-date';

interface BloodworkDateFieldProps {
  value: string;
  onChange: (dateKey: string) => void;
  disabled?: boolean;
  testID: string;
}

/**
 * Optional date-only field. The picker emits YYYY-MM-DD; the field never
 * creates a Date from a persisted value and therefore cannot shift days.
 */
export function BloodworkDateField({
  value,
  onChange,
  disabled = false,
  testID,
}: BloodworkDateFieldProps) {
  const colors = useColors();
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Pressable
          testID={`${testID}-toggle`}
          accessibilityRole="button"
          accessibilityLabel={value ? `Report date ${formatBloodworkDate(value)}` : 'Choose report date'}
          accessibilityState={{ disabled, expanded: open && !disabled }}
          aria-disabled={disabled}
          aria-expanded={open && !disabled}
          disabled={disabled}
          onPress={() => {
            if (disabled) return;
            setOpen(current => !current);
          }}
          style={[styles.valueButton, { borderColor: colors.border, backgroundColor: colors.card }]}
        >
          <Feather name="calendar" size={17} color={colors.cobalt} />
          <Text style={[styles.value, { color: value ? colors.navy : colors.subtleText }]}>
            {value ? formatBloodworkDate(value) : 'Choose date'}
          </Text>
          <Feather name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.subtleText} />
        </Pressable>
        {value ? (
          <Pressable
            testID={`${testID}-clear`}
            accessibilityRole="button"
            accessibilityLabel="Clear report date"
            disabled={disabled}
            onPress={() => {
              if (disabled) return;
              onChange('');
              setOpen(false);
            }}
            style={styles.clear}
          >
            <Text style={[styles.clearText, { color: colors.cobalt }]}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
      {open && !disabled ? (
        <LocalDatePicker
          testID={`${testID}-calendar`}
          value={value}
          onChange={dateKey => {
            if (disabled) return;
            onChange(dateKey);
            setOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  valueButton: {
    flex: 1,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  value: { flex: 1, fontSize: 15, fontFamily: 'Inter_400Regular' },
  clear: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  clearText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});