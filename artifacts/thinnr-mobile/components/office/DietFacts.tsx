/**
 * Read-only diet facts for the provider app: the roster row line and the
 * patient-record card. Rendering rides the pure helpers in lib/roster-diet so
 * unknown reads as "Unknown" (never "No diet" or "0%") on every surface.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import theme from '@/constants/colors';
import type { RosterDietFacts } from '@/lib/office-roster-api';
import { dietDisplayName, dietRowSummary, fitsDietDisplay, phaseLabel } from '@/lib/roster-diet';

type Stage = 'protocol' | 'maintenance' | null | undefined;

const SEVERE_BG = '#fff0f0';

export function PendingBlockBadge({ patientId }: { patientId: string }) {
  const colors = useColors();
  return (
    <View style={[styles.badge, { backgroundColor: colors.orangeBg, borderColor: colors.orangeBorder }]} testID={`pending-block-${patientId}`}>
      <Feather name="shield" size={9} color={colors.orangeText} />
      <Text style={[styles.badgeText, { color: colors.orangeText }]}>BLOCK PENDING</Text>
    </View>
  );
}

export function SevereAllergyBadge({ patientId }: { patientId: string }) {
  const colors = useColors();
  return (
    <View style={[styles.badge, { backgroundColor: SEVERE_BG, borderColor: '#d5a7a7' }]} testID={`severe-allergy-${patientId}`}>
      <Feather name="alert-triangle" size={9} color={colors.destructive} />
      <Text style={[styles.badgeText, { color: colors.destructive }]}>SEVERE ALLERGY</Text>
    </View>
  );
}

/** One meta line under the roster row name plus the two badges when they apply. */
export function DietRowLine({ patientId, facts, stage, week }: { patientId: string; facts: RosterDietFacts | null | undefined; stage: Stage; week?: number | null }) {
  const colors = useColors();
  return (
    <View style={styles.rowLine} testID={`diet-row-${patientId}`}>
      <Text style={[styles.rowText, { color: facts == null ? colors.subtleText : colors.bodyText }, facts == null && styles.italic]} numberOfLines={1}>
        {dietRowSummary(facts, stage, week)}
      </Text>
      {facts?.pendingBlock ? <PendingBlockBadge patientId={patientId} /> : null}
      {facts?.severeAllergy ? <SevereAllergyBadge patientId={patientId} /> : null}
    </View>
  );
}

/** Patient-record card: diet, phase, % fits diet, and the pending-block badge. Read-only. */
export function DietFactsCard({ patientId, facts, stage, week }: { patientId: string; facts: RosterDietFacts | null | undefined; stage: Stage; week?: number | null }) {
  const colors = useColors();
  const fits = fitsDietDisplay(facts);
  const phase = phaseLabel(stage, week);
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`diet-card-${patientId}`}>
      <View style={styles.cardRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: colors.labelText }]}>DIET</Text>
          <Text
            style={[styles.value, { color: facts == null ? colors.subtleText : colors.navy }, facts == null && styles.italic]}
            testID={`diet-name-${patientId}`}
          >
            {dietDisplayName(facts)}
          </Text>
          {facts?.diet?.startedAt ? (
            <Text style={[styles.detail, { color: colors.subtleText }]}>Since {new Date(facts.diet.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
          ) : null}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: colors.labelText }]}>PHASE</Text>
          <Text style={[styles.value, { color: phase ? colors.navy : colors.subtleText }]}>{phase ?? '--'}</Text>
        </View>
      </View>
      <View style={[styles.cardRow, { marginTop: 10 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: colors.labelText }]}>FITS DIET</Text>
          <Text
            style={[styles.value, { color: fits.known ? colors.navy : colors.subtleText }, !fits.known && styles.italic]}
            testID={`fits-diet-${patientId}`}
          >
            {fits.text}
          </Text>
          <Text style={[styles.detail, { color: colors.subtleText }]}>{fits.detail}</Text>
        </View>
        <View style={{ flex: 1, gap: 4, alignItems: 'flex-start' }}>
          <Text style={[styles.label, { color: colors.labelText }]}>SAFETY</Text>
          {facts?.pendingBlock ? <PendingBlockBadge patientId={patientId} /> : null}
          {facts?.severeAllergy ? <SevereAllergyBadge patientId={patientId} /> : null}
          {facts && !facts.pendingBlock && !facts.severeAllergy ? (
            <Text style={[styles.detail, { color: colors.subtleText }]}>Nothing pending</Text>
          ) : null}
          {facts == null ? <Text style={[styles.detail, { color: colors.subtleText }]}>Unknown</Text> : null}
        </View>
      </View>
      <Text style={[styles.footnote, { color: colors.subtleText }]}>
        Diet changes, block reviews and list edits are made in the office web app.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  rowLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 3 },
  rowText: { fontSize: 10, fontFamily: 'Inter_500Medium', flexShrink: 1 },
  italic: { fontStyle: 'italic' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 2 },
  badgeText: { fontSize: 8, fontFamily: 'Inter_700Bold', letterSpacing: 0.6 },
  card: { borderWidth: 1, borderRadius: theme.radiusSm, padding: 12 },
  cardRow: { flexDirection: 'row', gap: 12 },
  label: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 1.1 },
  value: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginTop: 3 },
  detail: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 2 },
  footnote: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 12 },
});
