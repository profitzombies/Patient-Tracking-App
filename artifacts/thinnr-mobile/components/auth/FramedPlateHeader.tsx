import React from 'react';
import { ImageBackground, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

const HERO = require('@/assets/images/patient/home-hero.jpg');

function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function FramedPlateHeader({
  audience,
  title,
  caption = `${greeting()} — your plate is waiting on your Today tab.`,
  imageHeight = 176,
}: {
  audience: string;
  title: string;
  caption?: string;
  /** Taller photo for hero-style uses such as the welcome screen. */
  imageHeight?: number;
}) {
  const colors = useColors();
  return (
    <>
      <ImageBackground
        source={HERO}
        accessibilityLabel="Grilled chicken bowl with greens"
        resizeMode="cover"
        style={[styles.image, { height: imageHeight }]}
      >
        <View style={[styles.scrim, { backgroundColor: `${colors.card}E8` }]} />
        <View style={styles.imageCopy}>
          <View
            style={[
              styles.badge,
              { backgroundColor: colors.warnBg, borderColor: colors.warnBorder },
            ]}
          >
            <Feather name="coffee" size={11} color={colors.warnText} />
            <Text style={[styles.badgeText, { color: colors.warnText }]}>APPROVED LIST</Text>
          </View>
          <Text style={[styles.caption, { color: colors.navy }]}>{caption}</Text>
        </View>
      </ImageBackground>
      <View style={styles.heading}>
        <Text style={[styles.kicker, { color: colors.labelText }]}>{audience}</Text>
        <Text style={[styles.title, { color: colors.navy }]}>{title}</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  image: { height: 176, justifyContent: 'flex-end', overflow: 'hidden' },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 76, opacity: 0.96 },
  imageCopy: { paddingHorizontal: 18, paddingBottom: 4 },
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  badgeText: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 0.65 },
  caption: {
    marginTop: 7,
    maxWidth: 310,
    fontSize: 19,
    lineHeight: 22,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  heading: { paddingHorizontal: 18, paddingTop: 12 },
  kicker: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.5 },
  title: { marginTop: 4, fontSize: 26, lineHeight: 32, fontFamily: 'PlayfairDisplay_700Bold' },
});