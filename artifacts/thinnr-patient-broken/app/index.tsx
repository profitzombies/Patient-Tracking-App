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
  { title: 'FOOD LOG', value: '03', note: 'ITEMS / NOT VERIFIED', icon: 'coffee' as const, colorKey: 'danger' as const },
  { title: 'WATER METER', value: '0%', note: 'CLICK REFRESH TO FIX', icon: 'droplet' as const, colorKey: 'blue' as const },
  { title: 'BODY DATA', value: '???', note: 'SERVER DID NOT ANSWER', icon: 'activity' as const, colorKey: 'purple' as const },
];

const fakeRows = [
  { name: 'BREAKFAST', food: 'Greek Yogurt Protein Bowl', calories: '320', colorKey: 'danger' as const, icon: 'sun' as const },
  { name: 'LUNCH', food: 'Mediterranean Tuna Wrap', calories: '380', colorKey: 'blue' as const, icon: 'cloud' as const },
  { name: 'DINNER', food: 'Nothing logged (probably fine)', calories: '0', colorKey: 'orange' as const, icon: 'moon' as const },
  { name: 'SNACK?', food: 'DATA CORRUPTED', calories: 'ERR', colorKey: 'purple' as const, icon: 'help-circle' as const },
];

const popupMessages = ['ERROR 503: HEALTH SERVER BUSY', 'WARNING: DO NOT TRUST THIS NUMBER', 'AUTO-SAVE FAILED AGAIN'];

export default function BrokenPatientHome() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [popupIndex, setPopupIndex] = useState(0);

  useEffect(() => {
    const finishLoading = setTimeout(() => setLoading(false), 2800);
    const popupTimer = setInterval(() => setPopupIndex(index => (index + 1) % popupMessages.length), 1100);
    return () => {
      clearTimeout(finishLoading);
      clearInterval(popupTimer);
    };
  }, []);

  const palette = {
    danger: colors.destructive,
    blue: colors.primary,
    purple: '#800080',
    orange: '#ff8000',
  };

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
        <View style={[styles.browserBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.browserText, { color: colors.mutedForeground }]}>THINNR HEALTH NETWORK - Microsoft Internet Explorer</Text>
          <Text style={[styles.browserClose, { color: colors.destructive }]}>X</Text>
        </View>

        <View style={[styles.siteHeader, { backgroundColor: colors.primary, borderColor: colors.border }]}>
          <View style={styles.headerBrand}>
            <Text style={[styles.logo, { color: colors.accent }]}>THINNR</Text>
            <Text style={[styles.logoSub, { color: colors.primaryForeground }]}>PATIENT PORTAL</Text>
          </View>
          <View style={[styles.headerStamp, { backgroundColor: colors.destructive, borderColor: colors.accent }]}>
            <Text style={[styles.stampText, { color: colors.primaryForeground }]}>LIVE</Text>
            <Text style={[styles.stampSub, { color: colors.accent }]}>v0.0004</Text>
          </View>
        </View>

        <View style={[styles.fakeNav, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.navItem, { color: colors.primary }]}>HOME</Text>
          <Text style={[styles.navItem, { color: colors.destructive }]}>MY FOOD</Text>
          <Text style={[styles.navItem, { color: '#800080' }]}>BODY</Text>
          <Text style={[styles.navItem, { color: colors.mutedForeground }]}>HELP??</Text>
          <Text style={[styles.navItem, { color: colors.primary }]}>LOG OUT</Text>
        </View>

        <View style={[styles.warningStrip, { backgroundColor: colors.accent, borderColor: colors.destructive }]}>
          <Feather name="alert-triangle" size={21} color={colors.destructive} />
          <Text style={[styles.warningText, { color: colors.destructive }]}>THIS PAGE IS NOT OPTIMIZED FOR ANY DEVICE</Text>
        </View>

        <View style={[styles.welcomeWindow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.windowTitle, { backgroundColor: colors.primary }]}>
            <Text style={[styles.windowTitleText, { color: colors.primaryForeground }]}>[ PATIENT_HOME.EXE ]</Text>
            <Text style={[styles.windowButtons, { color: colors.accent }]}>_ [] X</Text>
          </View>
          <View style={styles.welcomeBody}>
            <Text style={[styles.welcomeHeading, { color: colors.foreground }]}>WELCOME USER: EMMA</Text>
            <Text style={[styles.welcomeCopy, { color: colors.mutedForeground }]}>You have been successfully almost logged in.</Text>
            <Text style={[styles.welcomeCopy, { color: colors.destructive }]}>STATUS: NOT SURE / LAST SYNC: NEVER</Text>
            <View style={styles.fakeInputRow}>
              <Text style={[styles.fakeLabel, { color: colors.mutedForeground }]}>CURRENT DATE:</Text>
              <View style={[styles.fakeInput, { backgroundColor: colors.input, borderColor: colors.border }]}>
                <Text style={[styles.fakeInputText, { color: colors.mutedForeground }]}>08/24/2026???</Text>
              </View>
              <View style={[styles.fakeButton, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                <Text style={[styles.fakeButtonText, { color: colors.secondaryForeground }]}>REFRESH</Text>
              </View>
            </View>
          </View>
        </View>

        <View style={[styles.terribleScore, { backgroundColor: colors.destructive, borderColor: colors.border }]}>
          <View>
            <Text style={[styles.scoreLabel, { color: colors.accent }]}>TODAY'S WELLNESS SCORE:</Text>
            <Text style={[styles.score, { color: colors.primaryForeground }]}>6.8?</Text>
          </View>
          <View style={styles.scoreRight}>
            <Feather name="trending-up" size={32} color={colors.secondary} />
            <Text style={[styles.scoreNote, { color: colors.accent }]}>UP OR DOWN?</Text>
          </View>
        </View>

        <View style={[styles.sectionHeading, { backgroundColor: colors.primary, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.primaryForeground }]}>QUICK HEALTH STUFF (DO NOT RELY ON THIS)</Text>
          <Text style={[styles.headingCode, { color: colors.accent }]}>[REF: 000-ERR]</Text>
        </View>
        <View style={[styles.tileRow, { borderColor: colors.border }]}>
          {tiles.map(tile => (
            <View
              key={tile.title}
              style={[styles.tile, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Feather name={tile.icon} size={27} color={palette[tile.colorKey]} />
              <Text style={[styles.tileTitle, { color: colors.mutedForeground }]}>{tile.title}</Text>
              <Text style={[styles.tileValue, { color: colors.foreground }]}>{tile.value}</Text>
              <Text style={[styles.tileNote, { color: colors.mutedForeground }]}>{tile.note}</Text>
            </View>
          ))}
        </View>

        <View style={[styles.sectionHeading, styles.mealHeading, { backgroundColor: '#800080', borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.primaryForeground }]}>FOOD DIARY / TODAY / MAYBE</Text>
          <Text style={[styles.headingCode, { color: colors.accent }]}>EDIT: NO</Text>
        </View>
        <View style={[styles.mealBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.tableHeader, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Text style={[styles.tableHeaderText, { color: colors.primaryForeground }]}>MEAL</Text>
            <Text style={[styles.tableHeaderText, { color: colors.accent }]}>DESCRIPTION (WRAPS)</Text>
            <Text style={[styles.tableHeaderText, { color: colors.primaryForeground }]}>KCAL?</Text>
          </View>
          {fakeRows.map((meal, index) => (
            <View key={meal.name} style={[styles.mealRow, { borderTopColor: colors.border }, index % 2 === 1 && { backgroundColor: colors.secondary }]}>
              <View style={[styles.mealIcon, { backgroundColor: palette[meal.colorKey] }]}>
                <Feather name={meal.icon} size={16} color={colors.accent} />
              </View>
              <View style={styles.mealCopy}>
                <Text style={[styles.mealName, { color: colors.foreground }]}>{meal.name}</Text>
                <Text style={[styles.mealFood, { color: colors.mutedForeground }]}>{meal.food}</Text>
              </View>
              <Text style={[styles.calories, { color: palette[meal.colorKey] }]}>{meal.calories}</Text>
            </View>
          ))}
        </View>

        <View style={styles.buttonCluster}>
          <View style={[styles.bigFakeButton, { backgroundColor: colors.accent, borderColor: colors.border }]}>
            <Feather name="plus-square" size={22} color={colors.destructive} />
            <Text style={[styles.bigFakeButtonText, { color: colors.foreground }]}>ADD FOOD NOW</Text>
          </View>
          <View style={[styles.smallFakeButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.smallFakeButtonText, { color: colors.primary }]}>[ SAVE ]</Text>
          </View>
          <View style={[styles.smallFakeButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.smallFakeButtonText, { color: colors.destructive }]}>[ CANCEL ]</Text>
          </View>
        </View>

        <View style={[styles.underConstruction, { backgroundColor: colors.accent, borderColor: colors.destructive }]}>
          <Text style={[styles.constructionText, { color: colors.destructive }]}>!!! UNDER CONSTRUCTION !!!</Text>
          <Text style={[styles.constructionCopy, { color: colors.mutedForeground }]}>Please be patient while our interns upload your metabolism.</Text>
          <View style={styles.fakeProgress}>
            <View style={[styles.fakeProgressFill, { backgroundColor: colors.primary }]} />
          </View>
          <Text style={[styles.constructionCopy, { color: colors.foreground }]}>Progress: 12% (stuck)</Text>
        </View>

        <View style={[styles.footer, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="settings" size={20} color={colors.destructive} />
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>Copyright 1998-2026 THINNR Health-ish Systems | Best viewed at 800x600</Text>
          <Feather name="help-circle" size={25} color="#800080" />
        </View>
      </ScrollView>

      <View style={[styles.alertWindow, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.alertTitle, { backgroundColor: colors.destructive }]}>
          <Text style={[styles.alertTitleText, { color: colors.primaryForeground }]}>THINNR ERROR</Text>
          <Text style={[styles.alertClose, { color: colors.accent }]}>X</Text>
        </View>
        <View style={styles.alertBody}>
          <Feather name="x-circle" size={25} color={colors.destructive} />
          <Text style={[styles.alertText, { color: colors.mutedForeground }]}>{popupMessages[popupIndex]}</Text>
        </View>
        <View style={[styles.alertOkay, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
          <Text style={[styles.alertOkayText, { color: colors.foreground }]}>OK (NOT REALLY)</Text>
        </View>
      </View>

      <View style={[styles.alertWindow, styles.secondAlert, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.alertTitle, { backgroundColor: '#800080' }]}>
          <Text style={[styles.alertTitleText, { color: colors.primaryForeground }]}>SYSTEM MESSAGE</Text>
          <Text style={[styles.alertClose, { color: colors.accent }]}>X</Text>
        </View>
        <View style={styles.alertBody}>
          <Feather name="help-circle" size={25} color="#800080" />
          <Text style={[styles.alertText, { color: colors.mutedForeground }]}>Your health data is probably somewhere else.</Text>
        </View>
      </View>

      {loading && (
        <View style={[styles.loading, { backgroundColor: colors.primary, borderColor: colors.accent }]}>
          <View style={[styles.loadingWindow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.alertTitle, { backgroundColor: colors.destructive }]}>
              <Text style={[styles.alertTitleText, { color: colors.primaryForeground }]}>PLEASE WAIT...</Text>
              <Text style={[styles.alertClose, { color: colors.accent }]}>X</Text>
            </View>
            <View style={styles.loadingContent}>
              <ActivityIndicator size="large" color={colors.destructive} />
              <Text style={[styles.loadingTitle, { color: colors.foreground }]}>CONTACTING WELLNESS DATABASE</Text>
              <Text style={[styles.loadingCopy, { color: colors.destructive }]}>DO NOT REFRESH. SERIOUSLY.</Text>
              <View style={[styles.loadingBar, { borderColor: colors.border }]}>
                <View style={[styles.loadingBarFill, { backgroundColor: colors.destructive }]} />
              </View>
              <Text style={[styles.loadingSmall, { color: colors.mutedForeground }]}>LOADED 47 OF 9000 FILES</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  page: { paddingHorizontal: 5, gap: 6 },
  browserBar: { minHeight: 23, borderWidth: 1, paddingHorizontal: 5, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  browserText: { fontSize: 8, fontFamily: 'Courier New' },
  browserClose: { fontSize: 13, fontWeight: '900' },
  siteHeader: { minHeight: 76, borderWidth: 2, paddingHorizontal: 9, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerBrand: { transform: [{ rotate: '-1deg' }] },
  logo: { fontSize: 38, lineHeight: 38, fontWeight: '900', letterSpacing: -3, fontFamily: 'Courier New' },
  logoSub: { fontSize: 10, letterSpacing: 4, fontFamily: 'Courier New' },
  headerStamp: { width: 60, height: 49, borderWidth: 2, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '6deg' }] },
  stampText: { fontSize: 17, fontWeight: '900', fontFamily: 'Courier New' },
  stampSub: { fontSize: 8, fontFamily: 'Courier New' },
  fakeNav: { minHeight: 30, borderWidth: 1, paddingHorizontal: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navItem: { fontSize: 9, fontWeight: '900', textDecorationLine: 'underline', fontFamily: 'Courier New' },
  warningStrip: { minHeight: 36, borderWidth: 2, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', gap: 7 },
  warningText: { flex: 1, fontSize: 10, fontWeight: '900', fontFamily: 'Courier New' },
  welcomeWindow: { borderWidth: 2, minHeight: 175 },
  windowTitle: { minHeight: 23, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  windowTitleText: { fontSize: 11, fontWeight: '900', fontFamily: 'Courier New' },
  windowButtons: { fontSize: 12, fontWeight: '900', fontFamily: 'Courier New' },
  welcomeBody: { padding: 10 },
  welcomeHeading: { fontSize: 19, fontWeight: '900', fontFamily: 'Courier New' },
  welcomeCopy: { fontSize: 11, marginTop: 8, fontFamily: 'Courier New' },
  fakeInputRow: { marginTop: 14, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 5 },
  fakeLabel: { fontSize: 9, fontWeight: '900', fontFamily: 'Courier New' },
  fakeInput: { minWidth: 116, height: 27, borderWidth: 1, paddingHorizontal: 5, justifyContent: 'center' },
  fakeInputText: { fontSize: 10, fontFamily: 'Courier New' },
  fakeButton: { height: 27, borderWidth: 2, paddingHorizontal: 7, justifyContent: 'center' },
  fakeButtonText: { fontSize: 9, fontWeight: '900', fontFamily: 'Courier New' },
  terribleScore: { minHeight: 105, borderWidth: 2, padding: 9, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  scoreLabel: { fontSize: 10, fontWeight: '900', fontFamily: 'Courier New' },
  score: { fontSize: 53, lineHeight: 59, fontWeight: '900', fontFamily: 'Courier New' },
  scoreRight: { alignItems: 'flex-end', gap: 8 },
  scoreNote: { fontSize: 9, fontWeight: '900', fontFamily: 'Courier New' },
  sectionHeading: { minHeight: 29, borderWidth: 2, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 10, fontWeight: '900', fontFamily: 'Courier New' },
  headingCode: { fontSize: 9, fontWeight: '900', fontFamily: 'Courier New' },
  mealHeading: { marginTop: 4 },
  tileRow: { borderWidth: 2, padding: 3, flexDirection: 'row', gap: 3 },
  tile: { flex: 1, minHeight: 127, borderWidth: 1, padding: 6, justifyContent: 'space-between', transform: [{ rotate: '-1deg' }] },
  tileTitle: { fontSize: 8, fontWeight: '900', fontFamily: 'Courier New' },
  tileValue: { fontSize: 20, fontWeight: '900', marginTop: 4, fontFamily: 'Courier New' },
  tileNote: { fontSize: 8, lineHeight: 10, fontFamily: 'Courier New' },
  mealBox: { borderWidth: 2 },
  tableHeader: { minHeight: 24, borderBottomWidth: 1, paddingHorizontal: 5, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tableHeaderText: { width: '31%', fontSize: 8, fontWeight: '900', fontFamily: 'Courier New' },
  mealRow: { minHeight: 67, padding: 7, borderTopWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  mealIcon: { width: 33, height: 33, borderWidth: 1, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '9deg' }] },
  mealCopy: { flex: 1 },
  mealName: { fontSize: 9, fontWeight: '900', fontFamily: 'Courier New' },
  mealFood: { fontSize: 10, marginTop: 4, fontFamily: 'Courier New' },
  calories: { width: 34, fontSize: 14, fontWeight: '900', textAlign: 'right', fontFamily: 'Courier New' },
  buttonCluster: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  bigFakeButton: { minHeight: 46, flex: 1, borderWidth: 2, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 5, transform: [{ rotate: '-2deg' }] },
  bigFakeButtonText: { fontSize: 11, fontWeight: '900', fontFamily: 'Courier New' },
  smallFakeButton: { minHeight: 35, borderWidth: 2, paddingHorizontal: 6, justifyContent: 'center', transform: [{ rotate: '3deg' }] },
  smallFakeButtonText: { fontSize: 9, fontWeight: '900', fontFamily: 'Courier New' },
  underConstruction: { minHeight: 117, borderWidth: 3, padding: 8, alignItems: 'center', justifyContent: 'center', gap: 7 },
  constructionText: { fontSize: 17, fontWeight: '900', fontFamily: 'Courier New', textAlign: 'center' },
  constructionCopy: { fontSize: 9, fontFamily: 'Courier New', textAlign: 'center' },
  fakeProgress: { width: '82%', height: 18, borderWidth: 2, padding: 2, backgroundColor: '#ffffff' },
  fakeProgressFill: { width: '12%', flex: 1 },
  footer: { minHeight: 49, borderWidth: 1, padding: 6, flexDirection: 'row', alignItems: 'center', gap: 6 },
  footerText: { flex: 1, fontSize: 8, lineHeight: 11, fontFamily: 'Courier New' },
  alertWindow: { position: 'absolute', top: Platform.OS === 'web' ? 82 : 108, left: 16, right: 14, minHeight: 143, borderWidth: 3, boxShadow: '5px 5px 0px #000000', transform: [{ rotate: '-1deg' }] },
  secondAlert: { top: Platform.OS === 'web' ? 248 : 272, left: 43, right: 4, transform: [{ rotate: '2deg' }] },
  alertTitle: { minHeight: 25, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  alertTitleText: { fontSize: 10, fontWeight: '900', fontFamily: 'Courier New' },
  alertClose: { fontSize: 13, fontWeight: '900', fontFamily: 'Courier New' },
  alertBody: { minHeight: 72, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 9 },
  alertText: { flex: 1, fontSize: 11, lineHeight: 15, fontFamily: 'Courier New' },
  alertOkay: { alignSelf: 'center', minWidth: 115, minHeight: 25, borderWidth: 2, marginBottom: 7, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  alertOkayText: { fontSize: 9, fontWeight: '900', fontFamily: 'Courier New' },
  loading: { ...StyleSheet.absoluteFillObject, borderWidth: 4, alignItems: 'center', justifyContent: 'center', padding: 18 },
  loadingWindow: { width: '100%', borderWidth: 3, boxShadow: '6px 6px 0px #000000' },
  loadingContent: { minHeight: 230, padding: 20, alignItems: 'center', justifyContent: 'center', gap: 13 },
  loadingTitle: { fontSize: 15, fontWeight: '900', textAlign: 'center', fontFamily: 'Courier New' },
  loadingCopy: { fontSize: 10, fontWeight: '900', textAlign: 'center', fontFamily: 'Courier New' },
  loadingBar: { width: '100%', height: 25, borderWidth: 2, padding: 3, backgroundColor: '#ffffff' },
  loadingBarFill: { width: '47%', flex: 1 },
  loadingSmall: { fontSize: 8, fontFamily: 'Courier New' },
});