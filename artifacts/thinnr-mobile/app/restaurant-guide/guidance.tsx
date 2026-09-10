/**
 * Eating-out guidance — the full quoted program guidance for dining out,
 * opened from the Restaurant Guide's top card: the THINNR Restaurant Guide's
 * own "BEFORE YOU ORDER" rules first, then the manual/knowledge-base
 * sections that made up the original Restaurant Guide screen.
 *
 * Every program statement on this screen is quoted word-for-word from the
 * official docs archive (docs/thinnr-program/) via data/restaurant-directory.ts.
 * Do not edit quote text by hand: edit data/restaurant-guide.json and run
 * scripts/check-restaurant-guide-verbatim.mjs, which verifies each quoted
 * string against the archive. App-authored copy is limited to the screen
 * title, intro, section titles, and source attributions.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, usePathname } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Divider, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { GUIDANCE_SECTIONS } from '@/data/restaurant-directory';

export default function EatingOutGuidanceScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { mode, hydrated: modeHydrated } = useAppMode();

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Patient-only route: deep links must not bypass the persona flow. The
  // guard is gated on the active pathname so it can't hijack navigation
  // while this screen unmounts.
  if (!modeHydrated) return null;
  if (pathname === '/restaurant-guide/guidance' && mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/restaurant-guide');
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={{ paddingTop: topPad + 8, paddingBottom: bottomPad }}>
        <View style={styles.headerRow}>
          <Pressable
            testID="guidance-back-btn"
            onPress={goBack}
            hitSlop={8}
            style={({ pressed }) => [
              styles.backBtn,
              { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
            ]}
          >
            <Feather name="arrow-left" size={17} color={colors.navy} />
          </Pressable>
          <Text style={[styles.title, { color: colors.navy }]}>Eating-Out Guidance</Text>
        </View>

        <Text style={[styles.intro, { color: colors.bodyText }]}>
          Eating out on the THINNR program. Every rule below is quoted word-for-word from the
          official program materials.
        </Text>

        {GUIDANCE_SECTIONS.map(section => (
          <View key={section.key}>
            <SectionHeader label={section.title} style={styles.sectionHeader} />
            <LedgerCard>
              {section.quotes.map((quote, index) => (
                <View key={`${section.key}-${index}`}>
                  {index > 0 && <Divider />}
                  <View style={styles.quoteBlock}>
                    <View style={[styles.quoteRule, { borderLeftColor: colors.cobaltMuted }]}>
                      {quote.question ? (
                        <Text style={[styles.quoteQuestion, { color: colors.navyLight }]}>
                          {quote.question}
                        </Text>
                      ) : null}
                      {quote.lines.map((line, lineIndex) => (
                        <Text
                          key={lineIndex}
                          style={[
                            styles.quoteText,
                            { color: colors.bodyText },
                            (quote.question || lineIndex > 0) && styles.quoteTextGap,
                          ]}
                        >
                          {line}
                        </Text>
                      ))}
                    </View>
                    <Text style={[styles.quoteSource, { color: colors.labelText }]}>
                      {quote.source}
                    </Text>
                  </View>
                </View>
              ))}
            </LedgerCard>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
  },
  backBtn: {
    width: 32,
    height: 32,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 22,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
  },
  intro: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
    paddingHorizontal: 16,
    marginTop: 10,
    marginBottom: 4,
  },
  sectionHeader: {
    marginTop: 18,
    marginBottom: 8,
    paddingHorizontal: 16,
  },
  quoteBlock: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  quoteRule: {
    borderLeftWidth: 2,
    paddingLeft: 10,
  },
  quoteQuestion: {
    fontSize: 14.5,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    lineHeight: 20,
  },
  quoteText: {
    fontSize: 13,
    lineHeight: 19.5,
    fontFamily: 'Inter_400Regular',
  },
  quoteTextGap: {
    marginTop: 5,
  },
  quoteSource: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
    textTransform: 'uppercase',
    marginTop: 9,
  },
});
