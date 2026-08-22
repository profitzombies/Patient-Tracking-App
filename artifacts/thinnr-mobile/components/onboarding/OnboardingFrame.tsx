/**
 * Shared chrome for every simulated-onboarding step: back button, step
 * counter, thin square progress bar, coach callout, scrollable content,
 * and a footer Next button.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { ProgressBar } from '@/components/ui/LedgerPrimitives';
import { useColors } from '@/hooks/useColors';
import { useOnboardingFlow } from '@/context/OnboardingContext';
import { type StepKey } from '@/data/onboarding-data';
import { CoachCallout, PrimaryButton } from './OnboardingFields';

interface OnboardingFrameProps {
  stepKey: StepKey;
  title: string;
  coach?: string;
  children: React.ReactNode;
  nextLabel?: string;
  nextDisabled?: boolean;
  /** Defaults to advancing to the next visible step. */
  onNext?: () => void;
  /** For steps with their own CTA buttons (e.g. Connect / Skip). */
  hideNext?: boolean;
}

export function OnboardingFrame({
  stepKey,
  title,
  coach,
  children,
  nextLabel = 'Next',
  nextDisabled = false,
  onNext,
  hideNext = false,
}: OnboardingFrameProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const flow = useOnboardingFlow(stepKey);
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={styles.headerRow}>
        <Pressable
          testID="ob-back"
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => {
            Haptics.selectionAsync();
            flow.goBack();
          }}
          style={({ pressed }) => [
            styles.backBtn,
            { borderColor: colors.border, backgroundColor: colors.card },
            pressed && { backgroundColor: colors.accent },
          ]}
        >
          <Feather name="chevron-left" size={18} color={colors.navy} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerLabel, { color: colors.labelText }]}>NEW PATIENT · SIMULATION</Text>
          <Text style={[styles.headerStep, { color: colors.navy }]}>
            STEP {flow.stepNumber} OF {flow.stepCount}
          </Text>
        </View>
        <View style={styles.backBtnSpacer} />
      </View>
      <ProgressBar value={flow.progress} style={styles.progress} />

      <KeyboardAwareScrollViewCompat
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        bottomOffset={84}
      >
        {coach ? <CoachCallout text={coach} /> : null}
        <Text style={[styles.title, { color: colors.navy }]}>{title}</Text>
        {children}
      </KeyboardAwareScrollViewCompat>

      {!hideNext ? (
        <FooterAboveKeyboard bottomInset={insets.bottom}>
          <View
            style={[
              styles.footer,
              {
                borderTopColor: colors.divider,
                backgroundColor: colors.background,
                paddingBottom: Math.max(insets.bottom, 12) + 4,
              },
            ]}
          >
            <PrimaryButton
              testID="ob-next"
              label={nextLabel}
              disabled={nextDisabled}
              onPress={onNext ?? flow.goNext}
            />
          </View>
        </FooterAboveKeyboard>
      ) : (
        <View style={{ paddingBottom: Math.max(insets.bottom, 8) }} />
      )}
    </View>
  );
}

/**
 * Keeps the footer button pinned just above the software keyboard on native.
 * The `opened` offset consumes the safe-area padding baked into the footer so
 * the button sits tight against the keyboard instead of hovering above it.
 * On web the keyboard never overlays the layout, so this is a passthrough.
 */
function FooterAboveKeyboard({
  bottomInset,
  children,
}: {
  bottomInset: number;
  children: React.ReactNode;
}) {
  if (Platform.OS === 'web') {
    return <>{children}</>;
  }
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: bottomInset }}>
      {children}
    </KeyboardStickyView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  backBtn: {
    width: 44,
    height: 44,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnSpacer: {
    width: 44,
  },
  headerCenter: {
    alignItems: 'center',
  },
  headerLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  headerStep: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
    marginTop: 2,
  },
  progress: {
    height: 4,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 32,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.5,
    marginBottom: 16,
  },
  footer: {
    borderTopWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
});
