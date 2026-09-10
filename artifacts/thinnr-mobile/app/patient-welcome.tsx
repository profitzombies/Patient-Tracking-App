/**
 * Patient welcome — the first screen a signed-out patient sees.
 * Image-led, edge-to-edge opening that transitions cleanly into a warm, readable
 * content area. Demonstrates the Heritage aesthetic without generic marketing wrappers.
 */
import React from 'react';
import { StyleSheet, View, Text, Image, Platform, Pressable } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionGroup, SecondaryButton } from '@/components/auth/AuthPrimitives';
import { PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { authLayout, space } from '@/constants/spacing';
import { useAppWindowDimensions } from '@/hooks/useAppWindowDimensions';
import { HOME_HERO_IMAGE } from '@/data/recipe-images';

export default function PatientWelcomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useAppWindowDimensions();
  
  // Lay the image out squarely (1:1 aspect ratio) so it spans the width
  // and sits edge-to-edge, letting the native photo crop show perfectly.
  const imageSize = width;
  const imageOffset = space.xl;
  
  // Wordmark needs to sit in the pale upper space of the photo,
  // safely below the native status bar/notch.
  const logoTop = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top + space.sm;
  
  // Ensure the footer yields to the home indicator.
  const bottomPad = (Platform.OS === 'web' ? Math.max(insets.bottom, 34) : insets.bottom) + space.md;

  return (
    <View testID="patient-welcome" style={[styles.page, { backgroundColor: colors.background }]}>
      <ScrollView
        testID="welcome-scroll"
        style={styles.scroll}
        contentContainerStyle={[styles.contentContainer, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
        bounces={false}
        contentInsetAdjustmentBehavior="never"
      >
        {/* Lower the photo without moving the safe-area-aligned wordmark. */}
        <View testID="welcome-hero" style={{ width: imageSize, height: imageSize + imageOffset, flexShrink: 0 }}>
          {/* Continue the photo's pale tabletop behind the status bar. */}
          <View
            style={[styles.heroTopFill, { height: imageOffset }]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            aria-hidden
          >
            <Image
              source={HOME_HERO_IMAGE}
              style={{ width: imageSize, height: imageSize }}
              resizeMode="cover"
              accessible={false}
            />
          </View>
          <Image 
            source={HOME_HERO_IMAGE}
            style={[styles.heroImage, { height: imageSize, marginTop: imageOffset }]}
            resizeMode="cover"
            accessibilityRole="image"
            accessibilityLabel="Grilled chicken bowl with greens"
          />
          <View style={[styles.logoOverlay, { paddingTop: logoTop }]}>
            <Text testID="welcome-wordmark" style={[styles.wordmark, { color: colors.navy }]}>THINNR</Text>
          </View>
        </View>

        {/* Unified greeting, promise, and actions */}
        <View testID="welcome-content" style={styles.content}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.navy }]}>
            Progress, with your care team beside you.
          </Text>
          <Text style={[styles.subtitle, { color: colors.bodyText }]}>
            Keep your daily plan, meals, check-ins, and coaching in one calm place.
          </Text>

          <ActionGroup style={styles.actions}>
            <PrimaryButton 
              testID="welcome-login" 
              label="Log In" 
              onPress={() => router.push('/patient-login')} 
            />
            <SecondaryButton
              testID="welcome-signup"
              label="Create New Account"
              accessibilityLabel="Create new account"
              onPress={() => router.push('/patient-signup')}
            />
          </ActionGroup>
        </View>
        
        {/* Flexible space pushes footer to the bottom on tall screens */}
        <View style={styles.slackBottom} />

        <View style={styles.footer}>
          <Pressable
            testID="welcome-provider" 
            accessibilityRole="button"
            accessibilityLabel="Provider login"
            onPress={() => router.push('/provider-login')} 
            style={({ pressed }) => [styles.providerHit, pressed && { opacity: 0.7 }]}
          >
            <Text style={[styles.providerLabel, { color: colors.bodyText }]}>Provider login</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { 
    flex: 1,
  },
  scroll: { 
    flex: 1,
  },
  contentContainer: {
    flexGrow: 1,
  },
  heroImage: { 
    width: '100%', 
  },
  heroTopFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  logoOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  wordmark: { 
    fontSize: 32, 
    fontFamily: fonts.serif, 
    letterSpacing: -0.5,
  },
  content: {
    paddingHorizontal: authLayout.pagePadding,
    paddingTop: space.xl,
    maxWidth: authLayout.maxContentWidth,
    width: '100%',
    alignSelf: 'center',
  },
  title: { 
    fontSize: 32, 
    lineHeight: 38, 
    fontFamily: fonts.serifBold,
  },
  subtitle: { 
    marginTop: space.sm, 
    fontSize: 16, 
    lineHeight: 24, 
    fontFamily: fonts.sans,
  },
  actions: { 
    marginTop: space.xl, 
  },
  slackBottom: { 
    flexGrow: 1, 
    minHeight: space.xl, 
  },
  footer: { 
    alignItems: 'center',
    paddingHorizontal: authLayout.pagePadding,
  },
  providerHit: {
    minHeight: authLayout.headerControl,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  providerLabel: {
    fontSize: 13,
    fontFamily: fonts.sansSemiBold,
    textAlign: 'center',
  },
});
