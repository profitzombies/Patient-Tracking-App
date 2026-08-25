/**
 * Shared non-ready states for the live Training surfaces.
 *
 * Training is the provider side's first live-data screen, so unlike the
 * seeded tabs it can genuinely be loading, failing, offline, or running in a
 * build without Supabase configuration. All three training screens render
 * this view for any status other than 'ready'.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';

interface TrainingStatusViewProps {
  status: 'loading' | 'error' | 'unconfigured';
  errorMessage?: string | null;
  onRetry?: () => void;
}

export function TrainingStatusView({ status, errorMessage, onRetry }: TrainingStatusViewProps) {
  const colors = useColors();

  if (status === 'loading') {
    return (
      <View style={styles.center} testID="training-loading">
        <ActivityIndicator color={colors.cobalt} />
        <Text style={[styles.loadingText, { color: colors.subtleText }]}>
          Loading the live training catalog…
        </Text>
      </View>
    );
  }

  if (status === 'unconfigured') {
    return (
      <View style={styles.cardWrap} testID="training-unconfigured">
        <LedgerCard style={styles.card}>
          <View style={[styles.iconChip, { backgroundColor: colors.accent }]}>
            <Feather name="database" size={18} color={colors.cobalt} />
          </View>
          <Text style={[styles.title, { color: colors.navy }]}>Training needs configuration</Text>
          <Text style={[styles.body, { color: colors.bodyText }]}>
            The Training tab reads the live THINNR course catalog, but this build has no database
            configuration. Add the Supabase environment settings (EXPO_PUBLIC_SUPABASE_URL and its
            publishable key) and restart the app to browse training.
          </Text>
          <Text style={[styles.footnote, { color: colors.subtleText }]}>
            Every other Care Team tab uses seeded demo data and keeps working without it.
          </Text>
        </LedgerCard>
      </View>
    );
  }

  return (
    <View style={styles.cardWrap} testID="training-error">
      <LedgerCard style={styles.card}>
        <View style={[styles.iconChip, { backgroundColor: colors.riskBg }]}>
          <Feather name="wifi-off" size={18} color={colors.riskText} />
        </View>
        <Text style={[styles.title, { color: colors.navy }]}>Couldn't load training</Text>
        <Text style={[styles.body, { color: colors.bodyText }]}>
          {errorMessage ? `${errorMessage}. ` : ''}
          The live catalog didn't come through — you may be offline. Check your connection and try
          again.
        </Text>
        {onRetry ? (
          <Pressable
            testID="training-retry"
            accessibilityRole="button"
            accessibilityLabel="Retry loading training"
            onPress={onRetry}
            style={({ pressed }) => [
              styles.retryBtn,
              { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Feather name="refresh-cw" size={13} color={colors.primaryForeground} />
            <Text style={[styles.retryText, { color: colors.primaryForeground }]}>Try again</Text>
          </Pressable>
        ) : null}
      </LedgerCard>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    paddingVertical: 64,
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  cardWrap: {
    paddingHorizontal: 14,
    paddingTop: 18,
  },
  card: {
    padding: 18,
    gap: 10,
  },
  iconChip: {
    width: 38,
    height: 38,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  body: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
  },
  footnote: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  retryText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
});
