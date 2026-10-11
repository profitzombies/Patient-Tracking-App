/**
 * Plan tab: where the patient is (protocol day / maintenance), the diet in
 * force with its rule sheet and sample day, the restart-from-day-one history
 * when the provider restarted the protocol, and the door to Food preferences.
 * RN primitives only so the Node suites can mount it.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { usePatient } from '@/context/PatientContext';
import { Divider, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { GhostButton } from '@/components/onboarding/OnboardingFields';
import { DIET_BY_SLUG, PROTOCOL_LENGTH_DAYS } from '@/lib/diet-fit';
import { formatDateKey } from '@/data/patient-data';
import { useDietHistory } from '@/hooks/useDietHistory';
import { phaseLabel } from './DietSummaryCard';
import { SectionLabel } from './DietChoiceFields';

const PROTOCOL_RULES = [
  'Eat only from your Approved Foods list.',
  'Weigh in every morning and log it before breakfast.',
  'Drink your water target every day.',
  'Take your product as directed by your office.',
];

export function PlanDietSection({ onOpenPreferences }: { onOpenPreferences: () => void }) {
  const colors = useColors();
  const { diet, dietStatus } = usePatient();
  const { history, status: historyStatus, reload } = useDietHistory();
  const [showSampleDay, setShowSampleDay] = useState(false);

  if (dietStatus === 'loading' || dietStatus === 'idle') {
    return (
      <LedgerCard style={styles.card} testID="plan-diet-loading">
        <Text style={[styles.body, { color: colors.subtleText }]}>Loading your eating plan…</Text>
      </LedgerCard>
    );
  }
  if (dietStatus === 'error' || !diet) {
    return (
      <LedgerCard style={styles.card} testID="plan-diet-error">
        <Text style={[styles.body, { color: colors.riskText }]}>Couldn’t load your eating plan right now.</Text>
      </LedgerCard>
    );
  }

  const locked = diet.phase.dietPickerLocked;
  const entry = diet.currentDiet ? DIET_BY_SLUG.get(diet.currentDiet.dietSlug) ?? null : null;
  const ruleSheet = locked ? PROTOCOL_RULES : entry?.ruleSheet ?? [];
  const sampleDay = locked ? [] : entry?.sampleDay ?? [];
  const restarts = (history?.episodes ?? []).filter(e => e.episodeNumber > 1);

  return (
    <LedgerCard style={styles.card} testID="plan-diet-section">
      <SectionLabel text="Where you are" />
      <Text testID="plan-diet-phase" style={[styles.phase, { color: colors.navy }]}>{phaseLabel(diet)}</Text>
      {diet.phase.phase === 'protocol' ? (
        <Text style={[styles.body, { color: colors.bodyText }]}>
          {PROTOCOL_LENGTH_DAYS - diet.phase.programDay} days left in the protocol. Maintenance starts the day after, and the diet picker opens then.
        </Text>
      ) : null}

      <Divider style={styles.divider} />
      <SectionLabel text={locked ? 'Protocol rules' : 'Your diet'} />
      <Text testID="plan-diet-name" style={[styles.name, { color: colors.navy }]}>
        {locked ? 'THINNR protocol' : entry?.name ?? 'No diet picked yet'}
      </Text>
      {!locked && !entry ? (
        <Text style={[styles.body, { color: colors.bodyText }]}>Pick a diet or just track — your Plan shows its rule sheet here.</Text>
      ) : null}
      {ruleSheet.length > 0 ? (
        <View testID="plan-diet-rules" style={styles.list}>
          {ruleSheet.map((rule, index) => (
            <View key={index} style={styles.bullet}>
              <Text style={[styles.dot, { color: colors.cobalt }]}>•</Text>
              <Text style={[styles.body, { color: colors.bodyText, flex: 1 }]}>{rule}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {sampleDay.length > 0 ? (
        <>
          <Pressable
            testID="plan-diet-sample-toggle"
            accessibilityRole="button"
            accessibilityState={{ expanded: showSampleDay }}
            onPress={() => setShowSampleDay(v => !v)}
            style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.7 }]}
          >
            <Text style={[styles.toggleText, { color: colors.cobalt }]}>{showSampleDay ? 'Hide sample day' : 'See a sample day'}</Text>
          </Pressable>
          {showSampleDay ? (
            <View testID="plan-diet-sample-day" style={styles.list}>
              {sampleDay.map((line, index) => (
                <Text key={index} style={[styles.body, { color: colors.bodyText }]}>{line}</Text>
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      <Divider style={styles.divider} />
      <SectionLabel text="Protocol history" />
      {historyStatus === 'loading' && !history ? (
        <Text testID="plan-history-loading" style={[styles.body, { color: colors.subtleText }]}>Loading…</Text>
      ) : historyStatus === 'error' && !history ? (
        <View style={styles.row}>
          <Text testID="plan-history-error" style={[styles.body, { color: colors.riskText, flex: 1 }]}>Couldn’t load your history.</Text>
          <GhostButton label="Retry" onPress={reload} testID="plan-history-retry" />
        </View>
      ) : restarts.length === 0 ? (
        <Text testID="plan-history-none" style={[styles.body, { color: colors.bodyText }]}>
          {diet.phase.episodeStartedOn
            ? `Started ${formatDateKey(diet.phase.episodeStartedOn, true)}. No restarts.`
            : 'No protocol on file yet.'}
        </Text>
      ) : (
        <View style={styles.list}>
          {restarts.map(episode => (
            <Text key={episode.id} testID={`plan-history-restart-${episode.episodeNumber}`} style={[styles.body, { color: colors.bodyText }]}>
              Round {episode.episodeNumber} · restarted from day one on {formatDateKey(episode.startedOn, true)}
              {episode.endedOn ? ` · ended ${formatDateKey(episode.endedOn, true)}` : ''}
            </Text>
          ))}
          {history?.episodes.find(e => e.episodeNumber === 1) ? (
            <Text style={[styles.body, { color: colors.subtleText }]}>
              First started {formatDateKey(history.episodes.find(e => e.episodeNumber === 1)!.startedOn, true)}.
            </Text>
          ) : null}
        </View>
      )}

      <Divider style={styles.divider} />
      <Pressable
        testID="plan-open-food-preferences"
        accessibilityRole="button"
        onPress={onOpenPreferences}
        style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.linkKicker, { color: colors.labelText }]}>FOOD PREFERENCES</Text>
          <Text style={[styles.linkValue, { color: colors.navyLight }]}>
            {locked ? 'Allergies, restrictions and dislikes' : 'Change diet, allergies, restrictions and dislikes'}
          </Text>
        </View>
        <Text style={[styles.chevron, { color: colors.subtleText }]}>›</Text>
      </Pressable>
    </LedgerCard>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 8 },
  divider: { marginVertical: 6 },
  phase: { fontFamily: fonts.sansSemiBold, fontSize: 15 },
  name: { fontFamily: fonts.sansSemiBold, fontSize: 16 },
  body: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  list: { gap: 6 },
  bullet: { flexDirection: 'row', gap: 8 },
  dot: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  toggle: { paddingVertical: 4 },
  toggleText: { fontFamily: fonts.sansMedium, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  linkKicker: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 0.8 },
  linkValue: { fontFamily: fonts.sansMedium, fontSize: 14, marginTop: 2 },
  chevron: { fontSize: 22, lineHeight: 24 },
});
