/**
 * PhaseCard — renders one THINNR program phase in the Heritage language:
 * paper card (cobalt accent strip when the phase is current), header
 * (verbatim serif phase name + day range + status badge), verbatim
 * dosage/exercise lines, stat tiles, then the phase's body blocks in the
 * exact order they appear in the manual (paragraphs, "what to expect"
 * callouts, meal-plan sections).
 *
 * `variant="summary"` (Instructions screen top card) skips the meal-plan
 * block and offers a link to the full card; `variant="full"` renders
 * everything.
 *
 * All program text comes verbatim from data/program-instructions.ts — this
 * component must never rewrite or truncate those strings.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { Divider, LedgerCard } from '@/components/ui/LedgerPrimitives';
import {
  phaseStatusForDay,
  type PhaseCallout,
  type PhaseMealPlan,
  type ProgramPhase,
} from '@/data/program-instructions';

interface PhaseCardProps {
  phase: ProgramPhase;
  /** Program day used to derive the Current / Completed / Upcoming badge. */
  day: number;
  variant: 'summary' | 'full';
  /** Summary only — opens the full phase card when content was held back. */
  onOpenFull?: () => void;
  testID?: string;
}

export function PhaseCard({ phase, day, variant, onOpenFull, testID }: PhaseCardProps) {
  const colors = useColors();
  const status = phaseStatusForDay(phase, day);

  const badge =
    status === 'current'
      ? { bg: colors.activeBg, border: colors.activeBorder, text: colors.activeGreen, label: 'CURRENT', icon: 'check' as const }
      : status === 'completed'
        ? { bg: colors.sidebarBg, border: colors.border, text: colors.labelText, label: 'COMPLETED', icon: 'check' as const }
        : { bg: colors.card, border: colors.border, text: colors.subtleText, label: 'UPCOMING', icon: 'clock' as const };

  const hasMealPlan = phase.body.some(b => b.kind === 'mealPlan');
  const showLink = variant === 'summary' && hasMealPlan && !!onOpenFull;

  const renderCallout = (callout: PhaseCallout, key: string) => (
    <View
      key={key}
      style={[
        styles.callout,
        {
          backgroundColor: colors.activeBg,
          borderColor: colors.activeBorder,
          borderRadius: colors.radiusSm,
        },
      ]}
    >
      <View style={styles.calloutTitleRow}>
        <Feather name="zap" size={12} color={colors.activeGreen} />
        {callout.title ? (
          <Text style={[styles.calloutTitle, { color: colors.activeGreen }]}>{callout.title}</Text>
        ) : (
          <Text style={[styles.calloutLabel, { color: colors.activeGreen }]}>WHAT TO EXPECT</Text>
        )}
      </View>
      {callout.paragraphs.map((text, i) => (
        <Text key={i} style={[styles.calloutText, { color: colors.navyLight }]}>
          {text}
        </Text>
      ))}
    </View>
  );

  const renderMealPlan = (mealPlan: PhaseMealPlan, key: string) => (
    <View key={key}>
      <Divider style={{ marginTop: 16 }} />
      <Text style={[styles.mealPlanHeading, { color: colors.navy }]}>{mealPlan.heading}</Text>
      {mealPlan.intro.map((text, i) => (
        <Text key={i} style={[styles.paragraph, { color: colors.bodyText }]}>
          {text}
        </Text>
      ))}
      {mealPlan.meals.map(meal => (
        <View
          key={meal.title}
          style={[
            styles.mealBox,
            {
              backgroundColor: colors.paperCardAlt,
              borderColor: colors.border,
              borderRadius: colors.radiusSm,
            },
          ]}
        >
          <Text style={[styles.mealTitle, { color: colors.navyLight }]}>{meal.title}</Text>
          {meal.lines.map((line, i) => (
            <Text key={i} style={[styles.mealLine, { color: colors.bodyText }]}>
              {line}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );

  return (
    <LedgerCard accentTop={status === 'current'} testID={testID ?? `phase-card-${phase.id}`}>
      <View style={styles.inner}>
        {/* ── Header ── */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.phaseKicker, { color: colors.labelText }]}>
              PHASE {phase.index} OF 4
            </Text>
            <Text style={[styles.phaseName, { color: colors.navy }]}>{phase.name}</Text>
            <Text style={[styles.phaseRange, { color: colors.bodyText }]}>{phase.dayRange}</Text>
          </View>
          <View
            testID={`phase-status-${phase.id}`}
            style={[styles.badge, { backgroundColor: badge.bg, borderColor: badge.border }]}
          >
            <Feather name={badge.icon} size={10} color={badge.text} />
            <Text style={[styles.badgeText, { color: badge.text }]}>{badge.label}</Text>
          </View>
        </View>

        {/* ── Verbatim dosage / exercise directives ── */}
        {(phase.dosage || phase.exercise) && (
          <View style={styles.directives}>
            {phase.dosage ? (
              <View style={styles.directiveRow}>
                <View
                  style={[
                    styles.directiveIcon,
                    { backgroundColor: colors.accent, borderRadius: colors.radiusSm },
                  ]}
                >
                  <Feather name="droplet" size={12} color={colors.cobalt} />
                </View>
                <Text style={[styles.directiveText, { color: colors.navyLight }]}>{phase.dosage}</Text>
              </View>
            ) : null}
            {phase.exercise ? (
              <View style={styles.directiveRow}>
                <View
                  style={[
                    styles.directiveIcon,
                    { backgroundColor: colors.accent, borderRadius: colors.radiusSm },
                  ]}
                >
                  <Feather name="activity" size={12} color={colors.cobalt} />
                </View>
                <Text style={[styles.directiveText, { color: colors.navyLight }]}>{phase.exercise}</Text>
              </View>
            ) : null}
          </View>
        )}

        {/* ── Stat tiles ── */}
        <View style={styles.statRow}>
          {phase.stats.map(stat => (
            <View
              key={stat.label}
              style={[
                styles.statTile,
                {
                  backgroundColor: colors.paperCardAlt,
                  borderColor: colors.border,
                  borderRadius: colors.radiusSm,
                },
              ]}
            >
              <Text style={[styles.statValue, { color: colors.navy }]} numberOfLines={1}>
                {stat.value}
              </Text>
              <Text style={[styles.statLabel, { color: colors.labelText }]} numberOfLines={1}>
                {stat.label.toUpperCase()}
              </Text>
            </View>
          ))}
        </View>

        {/* ── Body blocks, in manual order ── */}
        {phase.body.map((block, index) => {
          if (block.kind === 'paragraph') {
            return (
              <Text key={index} style={[styles.paragraph, { color: colors.bodyText }]}>
                {block.text}
              </Text>
            );
          }
          if (block.kind === 'callout') {
            return renderCallout(block.callout, String(index));
          }
          if (variant === 'full') {
            return renderMealPlan(block.mealPlan, String(index));
          }
          return null;
        })}

        {showLink ? (
          <Pressable
            testID={`phase-open-full-${phase.id}`}
            onPress={onOpenFull}
            style={({ pressed }) => [
              styles.linkBtn,
              {
                backgroundColor: colors.activeBg,
                borderColor: colors.activeBorder,
                borderRadius: colors.radiusSm,
              },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={[styles.linkText, { color: colors.cobalt }]}>
              Read the full phase card — meal instructions
            </Text>
            <Feather name="arrow-right" size={13} color={colors.cobalt} />
          </Pressable>
        ) : null}
      </View>
    </LedgerCard>
  );
}

const styles = StyleSheet.create({
  inner: {
    padding: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  phaseKicker: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  phaseName: {
    fontSize: 21,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
    lineHeight: 27,
    marginTop: 4,
  },
  phaseRange: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    marginTop: 3,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 4,
    marginTop: 2,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
    fontFamily: 'Inter_700Bold',
  },
  directives: {
    marginTop: 12,
    gap: 6,
  },
  directiveRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  directiveIcon: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  directiveText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    paddingTop: 3,
  },
  statRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  statTile: {
    flex: 1,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.4,
    fontFamily: 'Inter_600SemiBold',
  },
  statLabel: {
    fontSize: 7.5,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
    marginTop: 3,
  },
  paragraph: {
    fontSize: 12.5,
    lineHeight: 19,
    marginTop: 12,
    fontFamily: 'Inter_400Regular',
  },
  callout: {
    borderWidth: 1,
    padding: 12,
    marginTop: 12,
  },
  calloutTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  calloutTitle: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    lineHeight: 16,
    marginTop: -1,
  },
  calloutLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginTop: 1,
  },
  calloutText: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    fontFamily: 'Inter_400Regular',
  },
  mealPlanHeading: {
    fontSize: 16,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.1,
    lineHeight: 22,
    marginTop: 14,
  },
  mealBox: {
    borderWidth: 1,
    padding: 12,
    marginTop: 10,
  },
  mealTitle: {
    fontSize: 14.5,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.1,
    lineHeight: 20,
  },
  mealLine: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
    fontFamily: 'Inter_400Regular',
  },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 14,
  },
  linkText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
});
