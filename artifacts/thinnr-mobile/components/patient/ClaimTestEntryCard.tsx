import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { fonts } from '@/constants/colors';
import { useColors } from '@/hooks/useColors';
import { claimTestRequest, type ClaimTestState } from '@/lib/claim-test-api';
import { useSupabaseSession } from '@/lib/supabase';

/** Server-gated entry: only a 200 for the designated real patient can reveal it. */
export function ClaimTestEntryCard() {
  const colors = useColors();
  const { session, sessionLoading } = useSupabaseSession();
  const [state, setState] = useState<ClaimTestState | null>(null);

  useEffect(() => {
    if (sessionLoading || !session) return;
    let live = true;
    claimTestRequest(session.access_token)
      .then(result => {
        if (live && result.status === 200) setState(result.data as ClaimTestState);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [session, sessionLoading]);

  if (!session || !state) return null;
  return (
    <Pressable
      testID="today-claim-test-card"
      accessibilityRole="button"
      accessibilityLabel={`Private account claim test. Current state: ${state.state.claimed ? 'claimed' : 'not claimed'}.`}
      onPress={() => router.push('/claim-test')}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
        pressed && { backgroundColor: colors.accent },
      ]}
    >
      <View style={[styles.icon, { backgroundColor: colors.warnBg }]}>
        <Feather name="tool" size={16} color={colors.orangeText} />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.kicker, { color: colors.labelText }]}>PRIVATE TEST CONTROL</Text>
        <Text style={[styles.title, { color: colors.navy }]}>Account claim paths</Text>
        <Text style={[styles.meta, { color: colors.subtleText }]}>
          {state.state.claimed ? 'Claimed' : 'Not claimed'} · review four test scenarios
        </Text>
      </View>
      <Feather name="chevron-right" size={17} color={colors.cobalt} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 9, minHeight: 78, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 38, height: 38, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1 },
  kicker: { fontFamily: fonts.sansBold, fontSize: 9, letterSpacing: 1.2, marginBottom: 3 },
  title: { fontFamily: fonts.sansSemiBold, fontSize: 14 },
  meta: { fontFamily: fonts.sans, fontSize: 12, marginTop: 2 },
});