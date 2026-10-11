/**
 * The provider-changed-your-diet and pregnancy-conflict notices, rendered
 * from the diet slice with device-local dismissal. Mounted on Today and on
 * Food preferences; `linkToPreferences` adds the "Open Food preferences"
 * door where the page itself is not already the destination.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { useDietNotices } from '@/hooks/useDietNotices';

export function DietNoticeList({ linkToPreferences = false }: { linkToPreferences?: boolean }) {
  const colors = useColors();
  const { notices, dismiss } = useDietNotices();
  if (notices.length === 0) return null;
  return (
    <View style={styles.list}>
      {notices.map(notice => (
        <View
          key={`${notice.kind}:${notice.id}`}
          testID={`diet-notice-${notice.kind}`}
          accessibilityRole="alert"
          style={[styles.card, { borderColor: colors.cobalt, backgroundColor: colors.accent, borderRadius: colors.radiusSm }]}
        >
          <Text style={[styles.title, { color: colors.navy }]}>{notice.title}</Text>
          <Text style={[styles.body, { color: colors.bodyText }]}>{notice.body}</Text>
          <View style={styles.row}>
            {linkToPreferences ? (
              <Pressable
                testID={`diet-notice-${notice.kind}-open`}
                accessibilityRole="button"
                onPress={() => router.push('/food-preferences' as never)}
                hitSlop={6}
              >
                <Text style={[styles.action, { color: colors.cobalt }]}>Open Food preferences</Text>
              </Pressable>
            ) : null}
            <Pressable
              testID={`diet-notice-${notice.kind}-dismiss`}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              onPress={() => dismiss(notice)}
              hitSlop={6}
            >
              <Text style={[styles.action, { color: colors.subtleText }]}>Got it</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  card: { borderWidth: 1, padding: 12, gap: 6 },
  title: { fontFamily: fonts.sansSemiBold, fontSize: 14 },
  body: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', gap: 16, marginTop: 4 },
  action: { fontFamily: fonts.sansMedium, fontSize: 13 },
});
