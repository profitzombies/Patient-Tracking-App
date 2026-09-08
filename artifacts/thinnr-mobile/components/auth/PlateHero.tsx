/**
 * Framed Plate hero — the standalone photo band that opens every auth entry
 * screen. It is its own framed surface (soft radius, hairline border) and
 * never shares a card with form inputs; the page frame puts real vertical
 * space between it and whatever follows.
 *
 * The plate photo is square and the plate sits low-right in it, so a plain
 * center crop of a short band shows only pale tablecloth. The image is laid
 * out at the band's width and slid so the plate's centre line lands in the
 * band. The badge and greeting live on a cream strip under the photo, never
 * over it.
 */
import React, { useState } from 'react';
import { Image, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { HOME_HERO_IMAGE } from '@/data/recipe-images';
import { fonts } from '@/constants/colors';
import { space } from '@/constants/spacing';

/** Vertical position (0–1) of the plate's centre within the square photo. */
const PLATE_FOCUS_Y = 0.62;

export function plateGreeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export const PATIENT_PLATE_CAPTION = () => `${plateGreeting()} — your plate is waiting on your Today tab.`;
export const PROVIDER_PLATE_CAPTION = () => `${plateGreeting()} — care starts with a plate on plan.`;

export function PlateHero({
  caption = PATIENT_PLATE_CAPTION(),
  photoHeight = 120,
}: {
  caption?: string;
  /** Photo band height; the welcome screen runs taller than the form screens. */
  photoHeight?: number;
}) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const onLayout = (event: LayoutChangeEvent) => setWidth(Math.round(event.nativeEvent.layout.width));
  // Square image laid out at full width; slide it up so the plate's centre
  // sits mid-band, clamped so the band never shows a bare edge.
  const imageSize = width;
  const desiredTop = photoHeight / 2 - PLATE_FOCUS_Y * imageSize;
  const top = Math.min(0, Math.max(photoHeight - imageSize, desiredTop));

  return (
    <View
      style={[
        styles.frame,
        { borderColor: colors.border, borderRadius: colors.radius, backgroundColor: colors.card },
      ]}
    >
      <View
        onLayout={onLayout}
        accessibilityRole="image"
        accessibilityLabel="Grilled chicken bowl with greens"
        style={[styles.photo, { height: photoHeight, backgroundColor: colors.accent }]}
      >
        {width > 0 ? (
          <Image
            source={HOME_HERO_IMAGE}
            resizeMode="cover"
            style={{ position: 'absolute', left: 0, top, width: imageSize, height: imageSize }}
          />
        ) : null}
      </View>
      <View style={[styles.strip, { borderTopColor: colors.border }]}>
        <View style={[styles.badge, { backgroundColor: colors.warnBg, borderColor: colors.warnBorder }]}>
          <Feather name="coffee" size={11} color={colors.warnText} />
          <Text style={[styles.badgeText, { color: colors.warnText }]}>APPROVED LIST</Text>
        </View>
        <Text style={[styles.caption, { color: colors.navy }]}>{caption}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderWidth: 1, overflow: 'hidden' },
  photo: { width: '100%', overflow: 'hidden' },
  strip: { borderTopWidth: 1, paddingHorizontal: space.md, paddingVertical: space.md },
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
  },
  badgeText: { fontSize: 9, fontFamily: fonts.sansBold, letterSpacing: 0.65 },
  caption: {
    marginTop: space.sm,
    maxWidth: 320,
    fontSize: 18,
    lineHeight: 23,
    fontFamily: fonts.serif,
  },
});
