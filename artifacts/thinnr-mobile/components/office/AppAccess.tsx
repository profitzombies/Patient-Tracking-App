/**
 * App-access (premium AI features) state for provider screens: a roster chip
 * for actionable states and the patient-record card. Read-only — the office
 * changes pricing under Payments → Settings; patients subscribe themselves.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import theme from '@/constants/colors';
import type { RosterAppAccess } from '@/lib/office-roster-api';
import { APP_ACCESS_STATE_LABEL, appAccessChip, appAccessTone, describeAppAccess, type AppAccessTone } from '@/lib/roster-app-access';

function useToneColors(): Record<AppAccessTone, { bg: string; border: string; text: string }> {
  const colors = useColors();
  return {
    neutral: { bg: colors.paperCardAlt, border: colors.border, text: colors.bodyText },
    good: { bg: '#eef6ee', border: '#b9d6b9', text: '#2f6b3a' },
    warn: { bg: colors.warnBg, border: colors.warnBorder, text: colors.warnText },
    bad: { bg: colors.riskBg, border: colors.riskBorder, text: colors.riskText },
  };
}

export function AppAccessChip({ patientId, access }: { patientId: string; access: RosterAppAccess | null | undefined }) {
  const chip = appAccessChip(access);
  const tones = useToneColors();
  if (!chip) return null;
  const tone = tones[chip.tone];
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg, borderColor: tone.border }]} testID={`chip-app-access-${patientId}`}>
      <Text style={[styles.badgeText, { color: tone.text }]}>{chip.label}</Text>
    </View>
  );
}

/** Patient-record card. Renders nothing when the family did not load (unknown ≠ locked). */
export function AppAccessCard({ patientId, access }: { patientId: string; access: RosterAppAccess | null | undefined }) {
  const colors = useColors();
  const tones = useToneColors();
  if (!access) return null;
  const tone = tones[appAccessTone(access.state)];
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`app-access-card-${patientId}`}>
      <View style={styles.cardRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: colors.subtleText }]}>PREMIUM AI FEATURES</Text>
          <Text style={[styles.value, { color: colors.navy }]} testID={`text-app-access-state-${patientId}`}>{APP_ACCESS_STATE_LABEL[access.state]}</Text>
        </View>
        <View style={[styles.badge, styles.badgeTop, { backgroundColor: tone.bg, borderColor: tone.border }]}>
          <Text style={[styles.badgeText, { color: tone.text }]}>{access.available ? 'AVAILABLE' : 'LOCKED'}</Text>
        </View>
      </View>
      <Text style={[styles.detail, { color: colors.bodyText }]} testID={`text-app-access-detail-${patientId}`}>{describeAppAccess(access)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 2 },
  badgeTop: { alignSelf: 'flex-start' },
  badgeText: { fontSize: 8, fontFamily: 'Inter_700Bold', letterSpacing: 0.6 },
  card: { borderWidth: 1, borderRadius: theme.radiusSm, padding: 12 },
  cardRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  label: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 1.1 },
  value: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginTop: 3 },
  detail: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 8, lineHeight: 16 },
});
