import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';

const tiles = [
  { title: 'FOOD DIARY', value: '3', note: 'things eaten today', icon: 'coffee' as const, color: '#ff003c' },
  { title: 'WATER??', value: '0 / 8', note: 'cups maybe', icon: 'droplet' as const, color: '#008cff' },
  { title: 'BODY STUFF', value: '—', note: 'last checked: never', icon: 'activity' as const, color: '#b7ff00' },
];

const meals = [
  { name: 'BREAKFAST', food: 'Greek Yogurt Protein Bowl', calories: '320', color: '#ff003c' },
  { name: 'LUNCH', food: 'Mediterranean Tuna Wrap', calories: '380', color: '#008cff' },
  { name: 'DINNER', food: 'Nothing logged (probably fine)', calories: '0', color: '#ff8a00' },
];

const popupMessages = [
  'SYNC ERROR: probably your fault',
  'LOADING HEALTH... 47%',
  'WARNING: numbers are only suggestions',
];

export default function BrokenPatientHome() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [popup, setPopup] = useState(popupMessages[0]);

  useEffect(() => {
    const finishLoading = setTimeout(() => setLoading(false), 2100);
    const firstPopup = setTimeout(() => setPopup(popupMessages[1]), 800);
    const secondPopup = setTimeout(() => setPopup(popupMessages[2]), 2200);
    return () => {
      clearTimeout(finishLoading);
      clearTimeout(firstPopup);
      clearTimeout(secondPopup);
    };
  }, []);

  return (
    <View style={[styles.app, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.page,
          {
            paddingTop: Platform.OS === 'web' ? 70 : insets.top + 10,
            paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 28,
          },
        ]}
        showsVerticalScrollIndicator
      >
        <View style={styles.topLine}>
          <Text style={[styles.tiny, { color: colors.foreground }]}>THINNR</Text>
          <Text style={[styles.tiny, { color: colors.destructive }]}>PATIENT_HOME_v0.3</Text>
        </View>

        <View style={[styles.header, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <View>
            <Text style={[styles.hello, { color: colors.foreground }]}>HELLO EMMA?</Text>
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              This is your health dashboard
            </Text>
          </View>
          <View style={[styles.avatar, { backgroundColor: colors.accent, borderColor: colors.border }]}>
            <Feather name="user" size={23} color={colors.destructive} />
          </View>
        </View>

        <View style={[styles.badNotice, { backgroundColor: colors.destructive, borderColor: colors.foreground }]}>
          <Feather name="alert-octagon" size={18} color={colors.primaryForeground} />
          <Text style={[styles.badNoticeText, { color: colors.primaryForeground }]}>
            YOUR PLAN IS LOADING. PLEASE DO NOT CLOSE THE APP.
          </Text>
        </View>

        <View style={[styles.scoreBox, { backgroundColor: colors.primary, borderColor: colors.border }]}>
          <View>
            <Text style={[styles.scoreLabel, { color: colors.accent }]}>TODAY SCORE</Text>
            <Text style={[styles.score, { color: colors.primaryForeground }]}>6.8?</Text>
          </View>
          <View style={styles.scoreRight}>
            <Feather name="trending-up" size={30} color="#ff8a00" />
            <Text style={[styles.scoreNote, { color: colors.primaryForeground }]}>UP OR DOWN</Text>
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>QUICK THINGS</Text>
        <View style={styles.tileRow}>
          {tiles.map(tile => (
            <View
              key={tile.title}
              style={[styles.tile, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Feather name={tile.icon} size={22} color={tile.color} />
              <Text style={[styles.tileTitle, { color: colors.mutedForeground }]}>{tile.title}</Text>
              <Text style={[styles.tileValue, { color: colors.foreground }]}>{tile.value}</Text>
              <Text style={[styles.tileNote, { color: colors.mutedForeground }]}>{tile.note}</Text>
            </View>
          ))}
        </View>

        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>MEALS (TODAY)</Text>
        <View style={[styles.mealBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {meals.map((meal, index) => (
            <View key={meal.name} style={[styles.mealRow, index > 0 && { borderTopColor: colors.muted, borderTopWidth: 1 }]}>
              <View style={[styles.mealIcon, { backgroundColor: meal.color }]}>
                <Feather name={index === 0 ? 'sun' : index === 1 ? 'cloud' : 'moon'} size={16} color="#ffffff" />
              </View>
              <View style={styles.mealCopy}>
                <Text style={[styles.mealName, { color: colors.foreground }]}>{meal.name}</Text>
                <Text style={[styles.mealFood, { color: colors.mutedForeground }]}>{meal.food}</Text>
              </View>
              <Text style={[styles.calories, { color: meal.color }]}>{meal.calories}</Text>
            </View>
          ))}
        </View>

        <View style={[styles.fakeButton, { backgroundColor: colors.accent, borderColor: colors.border }]}>
          <Feather name="plus" size={20} color={colors.destructive} />
          <Text style={[styles.fakeButtonText, { color: colors.foreground }]}>ADD FOOD (BUTTON DOES NOTHING)</Text>
        </View>

        <View style={[styles.bottomMess, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
          <Feather name="settings" size={19} color={colors.destructive} />
          <Text style={[styles.bottomText, { color: colors.foreground }]}>
            LAST UPDATED: SOME TIME AGO{'\n'}BUILD STATUS: KIND OF OK
          </Text>
          <Feather name="help-circle" size={24} color="#008cff" />
        </View>
      </ScrollView>

      <View pointerEvents="none" style={[styles.toast, { backgroundColor: colors.destructive, borderColor: colors.foreground }]}>
        <Feather name="x-circle" size={17} color={colors.primaryForeground} />
        <Text style={[styles.toastText, { color: colors.primaryForeground }]}>{popup}</Text>
      </View>

      {loading && (
        <View pointerEvents="none" style={[styles.loading, { backgroundColor: 'rgba(0,0,0,0.94)' }]}>
          <ActivityIndicator size="large" color={colors.destructive} />
          <Text style={[styles.loadingTitle, { color: colors.primaryForeground }]}>LOADING PATIENT...</Text>
          <Text style={[styles.loadingCopy, { color: colors.accent }]}>PLEASE WAIT FOREVER</Text>
          <View style={[styles.loadingBar, { borderColor: colors.primaryForeground }]}>
            <View style={[styles.loadingBarFill, { backgroundColor: colors.destructive }]} />
          </View>
          <Text style={[styles.loadingSmall, { color: colors.primaryForeground }]}>DO NOT TAP ANYTHING</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  page: { paddingHorizontal: 13, gap: 13 },
  topLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tiny: { fontSize: 9, fontWeight: '900', letterSpacing: 1.7, fontFamily: 'Inter_700Bold' },
  header: { minHeight: 80, borderWidth: 2, padding: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hello: { fontSize: 24, fontWeight: '900', letterSpacing: -1.2, fontFamily: 'Inter_700Bold' },
  subtitle: { fontSize: 11, marginTop: 5, fontFamily: 'Inter_400Regular' },
  avatar: { width: 49, height: 42, borderWidth: 2, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '4deg' }] },
  badNotice: { minHeight: 49, borderWidth: 2, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  badNoticeText: { flex: 1, fontSize: 11, lineHeight: 15, fontWeight: '900', fontFamily: 'Inter_700Bold' },
  scoreBox: { minHeight: 121, borderWidth: 2, padding: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  scoreLabel: { fontSize: 11, fontWeight: '900', letterSpacing: 1.6, fontFamily: 'Inter_700Bold' },
  score: { fontSize: 60, lineHeight: 65, fontWeight: '900', fontFamily: 'Inter_700Bold' },
  scoreRight: { alignItems: 'flex-end', gap: 9 },
  scoreNote: { fontSize: 9, fontWeight: '900', letterSpacing: 1, fontFamily: 'Inter_700Bold' },
  sectionTitle: { fontSize: 12, fontWeight: '900', letterSpacing: 1.5, marginTop: 2, fontFamily: 'Inter_700Bold' },
  tileRow: { flexDirection: 'row', gap: 7 },
  tile: { flex: 1, minHeight: 116, borderWidth: 2, padding: 8, justifyContent: 'space-between' },
  tileTitle: { fontSize: 8, fontWeight: '900', letterSpacing: 0.2, fontFamily: 'Inter_700Bold' },
  tileValue: { fontSize: 20, fontWeight: '900', marginTop: 4, fontFamily: 'Inter_700Bold' },
  tileNote: { fontSize: 8, lineHeight: 10, fontFamily: 'Inter_400Regular' },
  mealBox: { borderWidth: 2 },
  mealRow: { minHeight: 70, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 9 },
  mealIcon: { width: 33, height: 37, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-5deg' }] },
  mealCopy: { flex: 1 },
  mealName: { fontSize: 10, fontWeight: '900', letterSpacing: 1, fontFamily: 'Inter_700Bold' },
  mealFood: { fontSize: 12, marginTop: 5, fontFamily: 'Inter_400Regular' },
  calories: { fontSize: 15, fontWeight: '900', fontFamily: 'Inter_700Bold' },
  fakeButton: { minHeight: 52, borderWidth: 2, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 9 },
  fakeButtonText: { fontSize: 11, fontWeight: '900', letterSpacing: 0.3, fontFamily: 'Inter_700Bold' },
  bottomMess: { borderWidth: 2, padding: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 9 },
  bottomText: { flex: 1, fontSize: 9, lineHeight: 14, fontWeight: '900', fontFamily: 'Inter_700Bold' },
  toast: { position: 'absolute', top: Platform.OS === 'web' ? 16 : 52, left: 9, right: 9, minHeight: 43, borderWidth: 2, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, transform: [{ rotate: '-1deg' }] },
  toastText: { fontSize: 11, fontWeight: '900', fontFamily: 'Inter_700Bold' },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 26, gap: 15 },
  loadingTitle: { fontSize: 24, fontWeight: '900', textAlign: 'center', letterSpacing: -0.8, fontFamily: 'Inter_700Bold' },
  loadingCopy: { fontSize: 12, fontWeight: '900', letterSpacing: 1.2, fontFamily: 'Inter_700Bold' },
  loadingBar: { width: '100%', height: 24, borderWidth: 2, padding: 3 },
  loadingBarFill: { width: '47%', flex: 1 },
  loadingSmall: { fontSize: 9, fontWeight: '900', letterSpacing: 1.3, fontFamily: 'Inter_700Bold' },
});