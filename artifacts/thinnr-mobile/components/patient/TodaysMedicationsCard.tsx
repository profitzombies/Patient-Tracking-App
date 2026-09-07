/**
 * "Today's medications" — every dose scheduled for the selected day with a
 * one-tap Taken / Skipped decision, plus a day switcher covering the
 * seven-day correction window so a late entry or a fix lands on the right
 * day. Renders nothing for accounts with no medications (the demo persona
 * never has any), so screens that mount it stay byte-identical there.
 */
import React, { useMemo, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { usePatient } from '@/context/PatientContext';
import {
  DOSE_CORRECTION_WINDOW_DAYS,
  doseStatuses,
  formatClockTime,
  medicationLine,
  shiftDateKey,
  withinCorrectionWindow,
  type DoseState,
} from '@/lib/medication-schedule';

const STATE_LABEL: Record<DoseState, string> = {
  upcoming: 'Upcoming',
  due: 'Due now',
  missed: 'Not logged',
  taken: 'Taken',
  skipped: 'Skipped',
};

function dayLabel(dateKey: string, todayKey: string): string {
  if (dateKey === todayKey) return 'Today';
  if (dateKey === shiftDateKey(todayKey, -1)) return 'Yesterday';
  return new Date(`${dateKey}T12:00:00.000Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function TodaysMedicationsCard({ source = 'check_in' }: { source?: 'check_in' | 'account' }) {
  const colors = useColors();
  const patient = usePatient();
  const todayKey = patient.todayKey;
  const [dateKey, setDateKey] = useState(todayKey);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  // Keep the picker inside the window if the day rolled over while open.
  const viewing = withinCorrectionWindow(dateKey, todayKey) ? dateKey : todayKey;
  const earliest = shiftDateKey(todayKey, -DOSE_CORRECTION_WINDOW_DAYS);

  const rows = useMemo(
    () => doseStatuses(patient.medications, patient.doseLogs, viewing, viewing, timeZone, new Date()),
    [patient.medications, patient.doseLogs, viewing, timeZone],
  );
  const byId = useMemo(() => new Map(patient.medications.map(m => [m.id, m])), [patient.medications]);

  if (patient.medications.length === 0) return null;

  const decide = async (row: (typeof rows)[number], status: 'taken' | 'skipped') => {
    const clearing = row.state === status;
    setBusyKey(row.key);
    const ok = await patient.logDose({
      medicationId: row.medicationId,
      dueDate: row.dueDate,
      dueTime: row.dueTime,
      status: clearing ? null : status,
      source,
    });
    setBusyKey(null);
    if (ok) {
      const medication = byId.get(row.medicationId);
      AccessibilityInfo.announceForAccessibility(
        clearing
          ? `Cleared ${medication?.name ?? 'dose'} ${formatClockTime(row.dueTime)}.`
          : `${medication?.name ?? 'Dose'} ${formatClockTime(row.dueTime)} marked ${status}.`,
      );
    }
  };

  return (
    <LedgerCard testID="today-medications" style={{ padding: 16, marginBottom: 14 }}>
      <View style={styles.headerRow}>
        <Text style={[styles.fieldLabel, { color: colors.labelText }]}>
          {viewing === todayKey ? "TODAY'S MEDICATIONS" : 'MEDICATIONS'}
        </Text>
        <View style={styles.dayNav}>
          <Pressable
            testID="today-medications-prev"
            accessibilityRole="button"
            accessibilityLabel="Earlier day"
            disabled={viewing <= earliest}
            onPress={() => setDateKey(shiftDateKey(viewing, -1))}
            hitSlop={8}
            style={{ opacity: viewing <= earliest ? 0.35 : 1 }}
          >
            <Feather name="chevron-left" size={18} color={colors.navy} />
          </Pressable>
          <Text testID="today-medications-day" style={[styles.dayText, { color: colors.navy }]}>
            {dayLabel(viewing, todayKey)}
          </Text>
          <Pressable
            testID="today-medications-next"
            accessibilityRole="button"
            accessibilityLabel="Later day"
            disabled={viewing >= todayKey}
            onPress={() => setDateKey(shiftDateKey(viewing, 1))}
            hitSlop={8}
            style={{ opacity: viewing >= todayKey ? 0.35 : 1 }}
          >
            <Feather name="chevron-right" size={18} color={colors.navy} />
          </Pressable>
        </View>
      </View>

      {rows.length === 0 ? (
        <Text testID="today-medications-empty" style={[styles.emptyText, { color: colors.subtleText }]}>
          Nothing scheduled {viewing === todayKey ? 'today' : 'this day'}.
        </Text>
      ) : (
        rows.map(row => {
          const medication = byId.get(row.medicationId);
          const isTaken = row.state === 'taken';
          const isSkipped = row.state === 'skipped';
          const stateColor =
            isTaken ? colors.cobalt : isSkipped ? colors.subtleText : row.state === 'missed' ? colors.warnText : colors.bodyText;
          const busy = busyKey === row.key;
          return (
            <View
              key={row.key}
              testID={`dose-row-${row.medicationId}-${row.dueTime}`}
              style={[styles.doseRow, { borderTopColor: colors.border }]}
            >
              <View style={styles.doseInfo}>
                <Text style={[styles.doseName, { color: colors.navy }]} numberOfLines={2}>
                  {medication ? medicationLine(medication) : 'Medication'}
                </Text>
                <Text style={[styles.doseMeta, { color: stateColor }]}>
                  {formatClockTime(row.dueTime)} · {STATE_LABEL[row.state]}
                </Text>
              </View>
              <View style={styles.doseActions}>
                <Pressable
                  testID={`dose-taken-${row.medicationId}-${row.dueTime}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${isTaken ? 'Clear taken for' : 'Mark taken:'} ${medication?.name ?? 'medication'} ${formatClockTime(row.dueTime)}`}
                  accessibilityState={{ selected: isTaken, disabled: busy }}
                  disabled={busy}
                  onPress={() => void decide(row, 'taken')}
                  style={[
                    styles.doseBtn,
                    {
                      borderColor: isTaken ? colors.cobalt : colors.border,
                      backgroundColor: isTaken ? colors.cobalt : colors.paperCardAlt,
                      borderRadius: colors.radiusSm,
                    },
                  ]}
                >
                  <Feather name="check" size={14} color={isTaken ? colors.paperCardAlt : colors.navy} />
                  <Text style={[styles.doseBtnText, { color: isTaken ? colors.paperCardAlt : colors.navy }]}>Taken</Text>
                </Pressable>
                <Pressable
                  testID={`dose-skipped-${row.medicationId}-${row.dueTime}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${isSkipped ? 'Clear skipped for' : 'Mark skipped:'} ${medication?.name ?? 'medication'} ${formatClockTime(row.dueTime)}`}
                  accessibilityState={{ selected: isSkipped, disabled: busy }}
                  disabled={busy}
                  onPress={() => void decide(row, 'skipped')}
                  style={[
                    styles.doseBtn,
                    {
                      borderColor: isSkipped ? colors.navy : colors.border,
                      backgroundColor: isSkipped ? colors.navy : colors.paperCardAlt,
                      borderRadius: colors.radiusSm,
                    },
                  ]}
                >
                  <Text style={[styles.doseBtnText, { color: isSkipped ? colors.paperCardAlt : colors.navy }]}>Skip</Text>
                </Pressable>
              </View>
            </View>
          );
        })
      )}
      <Text style={[styles.footNote, { color: colors.subtleText }]}>
        Tap again to clear a decision. Past days can be corrected for {DOSE_CORRECTION_WINDOW_DAYS} days.
      </Text>
    </LedgerCard>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldLabel: { fontSize: 10, letterSpacing: 1.4, fontFamily: 'Inter_700Bold' },
  dayNav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dayText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', minWidth: 72, textAlign: 'center' },
  emptyText: { fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 10 },
  doseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 10,
    marginTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  doseInfo: { flex: 1, gap: 2 },
  doseName: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  doseMeta: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  doseActions: { flexDirection: 'row', gap: 6 },
  doseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    minHeight: 40,
    paddingHorizontal: 12,
  },
  doseBtnText: { fontSize: 12.5, fontFamily: 'Inter_700Bold' },
  footNote: { fontSize: 11.5, lineHeight: 16, fontFamily: 'Inter_400Regular', marginTop: 10 },
});
