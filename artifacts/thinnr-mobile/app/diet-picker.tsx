import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView } from '@/components/ui/PageScrollView';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { DietPicker } from '@/components/diet/DietPicker';
import { DIET_DISCLAIMER } from '@/lib/diet-fit';

/** Change-diet screen: the picker with one confirmation on an actual change. */
export default function DietPickerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/food-preferences' as never);
  };
  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable testID="diet-picker-back" accessibilityRole="button" accessibilityLabel="Back" onPress={close} hitSlop={10}>
          <Feather name="chevron-left" size={22} color={colors.navy} />
        </Pressable>
        <Text style={[styles.title, { color: colors.navy }]}>Choose a diet</Text>
        <View style={styles.spacer} />
      </View>
      <PageScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
        <DietPicker onDone={close} />
        <Text style={[styles.disclaimer, { color: colors.subtleText }]}>{DIET_DISCLAIMER}</Text>
      </PageScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    minHeight: 58,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
  },
  title: { fontSize: 18, fontFamily: 'PlayfairDisplay_700Bold' },
  spacer: { width: 22 },
  content: { padding: 18, maxWidth: 520, width: '100%', alignSelf: 'center', gap: 16 },
  disclaimer: { fontFamily: fonts.sans, fontSize: 11, lineHeight: 15 },
});
