/**
 * Frame shared by the patient Orders and Subscriptions screens: a back
 * header, a keyboard-aware scroll body, loading / error / retry states, and a
 * single snackbar slot. Screens choose demo vs live from the account seam
 * (never from missing data) and pass the outcome in; the frame never
 * invents a healthy-looking empty state while a load is failing.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { ErrorBox, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { Snackbar } from '@/components/ui/Snackbar';
import { useColors } from '@/hooks/useColors';
import type { BillingNotice } from '@/components/billing/useBillingNotice';

interface BillingScreenProps {
  title: string;
  testID: string;
  /** First load in flight with nothing to show yet. */
  loading: boolean;
  /** Load or action failure to surface above the content. */
  error: string | null;
  /** Shown with the error when there is nothing else on screen. */
  onRetry?: () => void;
  hasContent: boolean;
  notice?: BillingNotice | null;
  onDismissNotice?: () => void;
  demo?: boolean;
  children: React.ReactNode;
}

export function BillingScreen({ title, testID, loading, error, onRetry, hasContent, notice, onDismissNotice, demo = false, children }: BillingScreenProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  return (
    <View testID={testID} style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable testID={`${testID}-back`} accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} hitSlop={10}>
          <Feather name="chevron-left" size={22} color={colors.navy} />
        </Pressable>
        <Text style={[styles.title, { color: colors.navy }]}>{title}</Text>
        <View style={styles.spacer} />
      </View>
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 28) + (notice ? 72 : 0) }]}
        bottomOffset={72}
      >
        {demo ? (
          <Text testID={`${testID}-demo-note`} style={[styles.demoNote, { color: colors.subtleText, borderColor: colors.border }]}>
            Demo data. Sign in with a patient account to manage real orders.
          </Text>
        ) : null}
        {error ? (
          <View style={styles.errorBlock}>
            <ErrorBox testID={`${testID}-error`} message={error} />
            {!hasContent && onRetry ? <PrimaryButton testID={`${testID}-retry`} label="Retry" onPress={onRetry} style={styles.retry} /> : null}
          </View>
        ) : null}
        {loading && !hasContent && !error ? (
          <Text testID={`${testID}-loading`} style={[styles.loading, { color: colors.bodyText }]}>Loading…</Text>
        ) : null}
        {hasContent ? children : null}
      </KeyboardAwareScrollViewCompat>
      {notice ? (
        <Snackbar
          testID={`${testID}-notice`}
          actionTestID={`${testID}-notice-dismiss`}
          message={notice.message}
          actionLabel="OK"
          onAction={() => onDismissNotice?.()}
        />
      ) : null}
    </View>
  );
}

export function SectionLabel({ text, testID }: { text: string; testID?: string }) {
  const colors = useColors();
  return <Text testID={testID} style={[styles.section, { color: colors.labelText }]}>{text.toUpperCase()}</Text>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { minHeight: 58, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1 },
  title: { fontSize: 18, fontFamily: 'PlayfairDisplay_700Bold' },
  spacer: { width: 22 },
  content: { padding: 18, maxWidth: 520, width: '100%', alignSelf: 'center' },
  section: { fontSize: 10, letterSpacing: 1.4, fontFamily: 'Inter_700Bold', marginTop: 20, marginBottom: 8 },
  demoNote: { fontSize: 12, lineHeight: 17, fontFamily: 'Inter_500Medium', borderWidth: 1, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 6 },
  errorBlock: { marginBottom: 8 },
  retry: { marginTop: 9 },
  loading: { fontSize: 13, fontFamily: 'Inter_500Medium', paddingVertical: 14 },
});
