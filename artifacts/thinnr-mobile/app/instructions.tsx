/**
 * Program Instructions — patient-facing, day-aware guide to the THINNR
 * protocol. The top card always shows the phase matching the patient's
 * program day, followed by the manual's Welcome, 2 Pillars, 4 Phases
 * roadmap (each row opens the full phase card), and Taking the Formula
 * sections. All program wording is verbatim from docs/thinnr-program/.
 * Heritage language: paper cards, serif section titles, rounded
 * pale-cobalt chips; colors and radii come from shared theme tokens.
 *
 * A clearly-labeled, screen-local DEMO PREVIEW control lets a sales demo
 * dial in any program day (e.g. Day 1 → Activation badged "Current")
 * without touching the demo dataset — it defaults to the real day and
 * affects only this screen and the phase cards it opens.
 */
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Redirect, router, usePathname } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { PhaseCard } from '@/components/patient/PhaseCard';
import { Divider, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { useAppMode } from '@/context/AppModeContext';
import { ENROLLMENT_DAYS } from '@/data/patient-data';
import {
  clampProgramDay,
  FORMULA_SECTION,
  MAX_PROGRAM_DAY,
  phaseForDay,
  phaseStatusForDay,
  PHASES_SECTION,
  PILLARS_SECTION,
  PROGRAM_PHASES,
  WELCOME_SECTION,
  type ProgramPhaseId,
} from '@/data/program-instructions';

// Emma's actual program day, from the fixed-anchor demo dataset.
const REAL_DAY = clampProgramDay(ENROLLMENT_DAYS);

// One icon per "Taking the Formula" paragraph (sublingual dose, schedule,
// spacing, no food/drink, don't skip). UI chrome only.
const FORMULA_ICONS = ['droplet', 'repeat', 'clock', 'slash', 'alert-circle'] as const;

export default function InstructionsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { mode, hydrated: modeHydrated } = useAppMode();

  // Screen-local demo preview: defaults to the patient's real program day.
  const [previewDay, setPreviewDay] = useState(REAL_DAY);

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Patient-only route: deep links must not bypass the persona flow. The
  // redirect is gated on pathname so it can't hijack in-flight navigation.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    if (pathname !== '/instructions') return null;
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const effectiveDay = clampProgramDay(previewDay);
  const isPreviewing = effectiveDay !== REAL_DAY;
  const currentPhase = phaseForDay(effectiveDay);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/today');
  };

  const openPhase = (id: ProgramPhaseId) => {
    Haptics.selectionAsync();
    router.push({ pathname: '/phase/[id]', params: { id, day: String(effectiveDay) } });
  };

  const setDay = (day: number) => {
    Haptics.selectionAsync();
    setPreviewDay(clampProgramDay(day));
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Top bar ── */}
      <View
        style={[
          styles.topBar,
          { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt },
        ]}
      >
        <Pressable
          testID="instructions-back"
          onPress={goBack}
          style={({ pressed }) => [
            styles.topBtn,
            {
              borderColor: colors.border,
              borderRadius: colors.radiusSm,
              backgroundColor: pressed ? colors.accent : colors.card,
            },
          ]}
        >
          <Feather name="chevron-left" size={17} color={colors.bodyText} />
        </Pressable>
        <Text style={[styles.topTitle, { color: colors.navy }]}>Program Instructions</Text>
        <View style={styles.topSpacer} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        {/* ── Demo-only program day preview ── */}
        <View
          testID="demo-preview-panel"
          style={[
            styles.demoPanel,
            { backgroundColor: colors.warnBg, borderColor: colors.warnBorder, borderRadius: colors.radius },
          ]}
        >
          <View style={styles.demoTopRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.demoLabel, { color: colors.warnText }]}>DEMO PREVIEW</Text>
              <Text style={[styles.demoSub, { color: colors.warnText }]}>
                Program day — affects this screen only
              </Text>
            </View>
            <View style={styles.demoStepper}>
              <Pressable
                testID="demo-day-minus"
                onPress={() => setDay(effectiveDay - 1)}
                disabled={effectiveDay <= 1}
                style={({ pressed }) => [
                  styles.demoStepBtn,
                  {
                    borderColor: colors.warnBorder,
                    borderRadius: colors.radiusSm,
                    backgroundColor: pressed ? colors.accent : colors.card,
                  },
                  effectiveDay <= 1 && { opacity: 0.35 },
                ]}
              >
                <Feather name="minus" size={13} color={colors.warnText} />
              </Pressable>
              <Text testID="demo-day-value" style={[styles.demoValue, { color: colors.warnText }]}>
                Day {effectiveDay}
              </Text>
              <Pressable
                testID="demo-day-plus"
                onPress={() => setDay(effectiveDay + 1)}
                disabled={effectiveDay >= MAX_PROGRAM_DAY}
                style={({ pressed }) => [
                  styles.demoStepBtn,
                  {
                    borderColor: colors.warnBorder,
                    borderRadius: colors.radiusSm,
                    backgroundColor: pressed ? colors.accent : colors.card,
                  },
                  effectiveDay >= MAX_PROGRAM_DAY && { opacity: 0.35 },
                ]}
              >
                <Feather name="plus" size={13} color={colors.warnText} />
              </Pressable>
            </View>
          </View>

          <View style={styles.demoChipRow}>
            {PROGRAM_PHASES.map(phase => {
              const isActive = currentPhase.id === phase.id;
              return (
                <Pressable
                  key={phase.id}
                  testID={`demo-day-chip-${phase.startDay}`}
                  onPress={() => setDay(phase.startDay)}
                  style={({ pressed }) => [
                    styles.demoChip,
                    { borderRadius: colors.radiusSm },
                    isActive
                      ? { backgroundColor: colors.warnText, borderColor: colors.warnText }
                      : { backgroundColor: 'transparent', borderColor: colors.warnBorder },
                    pressed && { opacity: 0.75 },
                  ]}
                >
                  <Text
                    style={[styles.demoChipText, { color: isActive ? colors.warnBg : colors.warnText }]}
                  >
                    Day {phase.startDay}
                  </Text>
                </Pressable>
              );
            })}
            {isPreviewing && (
              <Pressable
                testID="demo-day-reset"
                onPress={() => setDay(REAL_DAY)}
                style={({ pressed }) => [
                  styles.demoChip,
                  styles.demoResetChip,
                  { borderColor: colors.warnBorder, borderRadius: colors.radiusSm },
                  pressed && { opacity: 0.75 },
                ]}
              >
                <Feather name="rotate-ccw" size={10} color={colors.warnText} />
                <Text style={[styles.demoChipText, { color: colors.warnText }]}>Reset</Text>
              </Pressable>
            )}
          </View>

          {isPreviewing && (
            <Text testID="demo-preview-hint" style={[styles.demoHint, { color: colors.warnText }]}>
              Previewing Day {effectiveDay} — your real program day is Day {REAL_DAY}.
            </Text>
          )}
        </View>

        {/* ── Current phase ── */}
        <Text style={[styles.sectionTitle, { color: colors.navyLight }]}>
          Current Phase · Day {effectiveDay}
        </Text>
        <PhaseCard
          phase={currentPhase}
          day={effectiveDay}
          variant="summary"
          onOpenFull={() => openPhase(currentPhase.id)}
          testID="current-phase-card"
        />

        {/* ── Welcome ── */}
        <Text style={[styles.sectionTitle, { color: colors.navyLight }]}>Welcome</Text>
        <LedgerCard style={styles.sectionCard}>
          <Text style={[styles.serifHeading, { color: colors.navy }]}>{WELCOME_SECTION.heading}</Text>
          {WELCOME_SECTION.paragraphs.map((text, i) => (
            <Text key={i} style={[styles.paragraph, { color: colors.bodyText }]}>
              {text}
            </Text>
          ))}
        </LedgerCard>

        {/* ── The 2 Pillars ── */}
        <Text style={[styles.sectionTitle, { color: colors.navyLight }]}>The 2 Pillars</Text>
        <LedgerCard style={styles.sectionCard}>
          <Text style={[styles.serifHeading, { color: colors.navy }]}>{PILLARS_SECTION.heading}</Text>
          <Text style={[styles.paragraph, { color: colors.bodyText }]}>{PILLARS_SECTION.intro}</Text>
          {PILLARS_SECTION.pillars.map((pillar, i) => (
            <View key={i} style={styles.pillarRow}>
              <View
                style={[
                  styles.numSquare,
                  { backgroundColor: colors.accent, borderRadius: colors.radiusSm },
                ]}
              >
                <Text style={[styles.numText, { color: colors.cobalt }]}>{i + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.pillarTitle, { color: colors.navyLight }]}>{pillar.title}</Text>
                <Text style={[styles.pillarText, { color: colors.bodyText }]}>{pillar.text}</Text>
              </View>
            </View>
          ))}
          <Text style={[styles.paragraph, { color: colors.bodyText }]}>{PILLARS_SECTION.outro}</Text>
          <View
            style={[
              styles.highlight,
              {
                backgroundColor: colors.activeBg,
                borderColor: colors.activeBorder,
                borderRadius: colors.radiusSm,
              },
            ]}
          >
            <Feather name="award" size={12} color={colors.activeGreen} style={{ marginTop: 3 }} />
            <Text style={[styles.highlightText, { color: colors.navyLight }]}>
              {PILLARS_SECTION.highlight}
            </Text>
          </View>
        </LedgerCard>

        {/* ── The 4 Phases roadmap ── */}
        <Text style={[styles.sectionTitle, { color: colors.navyLight }]}>The 4 Phases</Text>
        <LedgerCard style={styles.sectionCard}>
          <Text style={[styles.serifHeading, { color: colors.navy }]}>{PHASES_SECTION.heading}</Text>
          <Text style={[styles.paragraph, { color: colors.bodyText }]}>{PHASES_SECTION.intro}</Text>
          <View style={{ marginTop: 6 }}>
            {PROGRAM_PHASES.map((phase, index) => {
              const status = phaseStatusForDay(phase, effectiveDay);
              const isCurrent = status === 'current';
              return (
                <View key={phase.id}>
                  {index > 0 && <Divider />}
                  <Pressable
                    testID={`phase-row-${phase.id}`}
                    onPress={() => openPhase(phase.id)}
                    style={({ pressed }) => [styles.phaseRow, pressed && { opacity: 0.7 }]}
                  >
                    <View
                      style={[
                        styles.numSquare,
                        {
                          backgroundColor: isCurrent ? colors.cobalt : colors.accent,
                          borderRadius: colors.radiusSm,
                        },
                      ]}
                    >
                      {status === 'completed' ? (
                        <Feather name="check" size={13} color={colors.activeGreen} />
                      ) : (
                        <Text
                          style={[
                            styles.numText,
                            { color: isCurrent ? colors.primaryForeground : colors.cobalt },
                          ]}
                        >
                          {phase.index}
                        </Text>
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={styles.phaseNameRow}>
                        <Text style={[styles.phaseRowName, { color: colors.navyLight }]}>
                          {phase.shortName}
                        </Text>
                        {isCurrent && (
                          <View
                            style={[
                              styles.miniBadge,
                              { backgroundColor: colors.activeBg, borderColor: colors.activeBorder },
                            ]}
                          >
                            <Text style={[styles.miniBadgeText, { color: colors.activeGreen }]}>
                              CURRENT
                            </Text>
                          </View>
                        )}
                      </View>
                      <Text style={[styles.phaseRowMeta, { color: colors.subtleText }]} numberOfLines={1}>
                        {phase.name}
                      </Text>
                    </View>
                    <Text style={[styles.phaseRowRange, { color: colors.labelText }]}>
                      {phase.dayRangeShort}
                    </Text>
                    <Feather name="chevron-right" size={15} color={colors.subtleText} />
                  </Pressable>
                </View>
              );
            })}
          </View>
        </LedgerCard>

        {/* ── Taking the Formula ── */}
        <Text style={[styles.sectionTitle, { color: colors.navyLight }]}>Taking the Formula</Text>
        <LedgerCard style={styles.sectionCard}>
          <Text style={[styles.serifHeading, { color: colors.navy }]}>{FORMULA_SECTION.heading}</Text>
          {FORMULA_SECTION.items.map((text, i) => (
            <View key={i} style={styles.formulaRow}>
              <View
                style={[
                  styles.numSquare,
                  { backgroundColor: colors.accent, borderRadius: colors.radiusSm },
                ]}
              >
                <Feather name={FORMULA_ICONS[i] ?? 'info'} size={13} color={colors.cobalt} />
              </View>
              <Text style={[styles.formulaText, { color: colors.bodyText }]}>{text}</Text>
            </View>
          ))}
        </LedgerCard>

        <SyntheticDisclaimer />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  topBtn: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: {
    fontSize: 15,
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: 0.2,
  },
  topSpacer: {
    width: 34,
    height: 34,
  },
  content: {
    padding: 16,
  },
  // ── Demo preview panel ──
  demoPanel: {
    borderWidth: 1,
    borderStyle: 'dashed',
    padding: 12,
  },
  demoTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  demoLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  demoSub: {
    fontSize: 10,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  demoStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  demoStepBtn: {
    width: 26,
    height: 26,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  demoValue: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    minWidth: 52,
    textAlign: 'center',
  },
  demoChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  demoChip: {
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  demoResetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  demoChipText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  demoHint: {
    fontSize: 10.5,
    lineHeight: 15,
    marginTop: 9,
    fontFamily: 'Inter_400Regular',
  },
  // ── Sections ──
  sectionTitle: {
    fontSize: 19,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
    lineHeight: 25,
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 2,
  },
  sectionCard: {
    padding: 16,
  },
  serifHeading: {
    fontSize: 18,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
    lineHeight: 24,
  },
  paragraph: {
    fontSize: 12.5,
    lineHeight: 19,
    marginTop: 10,
    fontFamily: 'Inter_400Regular',
  },
  // ── Pillars ──
  pillarRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 14,
  },
  numSquare: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  pillarTitle: {
    fontSize: 12.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    lineHeight: 17,
  },
  pillarText: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
    fontFamily: 'Inter_400Regular',
  },
  highlight: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    padding: 12,
    marginTop: 14,
  },
  highlightText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
  },
  // ── Roadmap rows ──
  phaseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  phaseNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  phaseRowName: {
    fontSize: 15,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.1,
  },
  miniBadge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  miniBadgeText: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
  },
  phaseRowMeta: {
    fontSize: 10.5,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  phaseRowRange: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
    fontFamily: 'Inter_700Bold',
  },
  // ── Formula rows ──
  formulaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 14,
  },
  formulaText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 19,
    fontFamily: 'Inter_400Regular',
  },
});
