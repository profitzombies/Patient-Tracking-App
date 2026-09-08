/**
 * Shared page frame for the auth entry screens (welcome, patient login,
 * patient signup, provider login).
 *
 * One place owns the top bar (back control + THINNR wordmark), safe-area
 * insets, keyboard-aware scrolling, the 520pt content column, and the
 * vertical rhythm between hero, heading, content, and footer. Screens pass
 * slots; they never hand-roll chrome or spacing.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { authLayout, space } from '@/constants/spacing';

interface AuthPageFrameProps {
  /** Renders a back control on the left of the top bar when provided. */
  onBack?: () => void;
  backTestID?: string;
  backAccessibilityLabel?: string;
  /** Small right-aligned caption in the top bar (used when there is no back control). */
  topNote?: string;
  /** Anything that must sit above the hero, e.g. an environment warning. */
  banner?: React.ReactNode;
  hero?: React.ReactNode;
  kicker: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * On tall phones, distribute slack above the hero and below the footer so
   * a short page (welcome) reads balanced instead of top-hugging. Long pages
   * simply scroll from the top.
   */
  balance?: boolean;
  testID?: string;
}

export function AuthPageFrame({
  onBack,
  backTestID,
  backAccessibilityLabel = 'Go back',
  topNote,
  banner,
  hero,
  kicker,
  title,
  subtitle,
  children,
  footer,
  balance = false,
  testID,
}: AuthPageFrameProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 44) : insets.top + space.sm;
  const bottomPad = Math.max(insets.bottom, space.md) + space.md;

  return (
    <View testID={testID} style={[styles.page, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={styles.topBar}>
        {onBack ? (
          <Pressable
            testID={backTestID}
            accessibilityRole="button"
            accessibilityLabel={backAccessibilityLabel}
            onPress={onBack}
            style={({ pressed }) => [
              styles.backBtn,
              { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm },
              pressed && { backgroundColor: colors.accent },
            ]}
          >
            <Feather name="chevron-left" size={18} color={colors.navy} />
          </Pressable>
        ) : (
          <View style={styles.backSlot} />
        )}
        <Text style={[styles.wordmark, { color: colors.navy }]}>THINNR</Text>
        <View style={[styles.backSlot, styles.noteSlot]}>
          {topNote ? <Text style={[styles.topNote, { color: colors.subtleText }]}>{topNote}</Text> : null}
        </View>
      </View>

      <KeyboardAwareScrollViewCompat
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
        bottomOffset={96}
      >
        {balance ? <View style={styles.slackTop} /> : null}
        {banner ? <View style={styles.block}>{banner}</View> : null}
        {hero ? <View style={styles.block}>{hero}</View> : null}
        <View style={styles.block}>
          <Text style={[styles.kicker, { color: colors.labelText }]}>{kicker}</Text>
          <Text style={[styles.title, { color: colors.navy }]}>{title}</Text>
          {subtitle ? <Text style={[styles.subtitle, { color: colors.bodyText }]}>{subtitle}</Text> : null}
        </View>
        <View>{children}</View>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
        {balance ? <View style={styles.slackBottom} /> : null}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: authLayout.headerPadding,
    paddingTop: space.sm,
    paddingBottom: space.md,
    maxWidth: authLayout.maxContentWidth,
    width: '100%',
    alignSelf: 'center',
  },
  backBtn: {
    width: authLayout.headerControl,
    height: authLayout.headerControl,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backSlot: { width: authLayout.headerControl, height: authLayout.headerControl, justifyContent: 'center' },
  noteSlot: { width: 'auto', minWidth: authLayout.headerControl, alignItems: 'flex-end' },
  wordmark: { fontSize: 23, fontFamily: fonts.serif, letterSpacing: -0.5 },
  topNote: { fontSize: 12, fontFamily: fonts.sansSemiBold },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: authLayout.pagePadding,
    paddingTop: space.sm,
    maxWidth: authLayout.maxContentWidth,
    width: '100%',
    alignSelf: 'center',
    flexGrow: 1,
  },
  slackTop: { flexGrow: 1, minHeight: 0 },
  slackBottom: { flexGrow: 1.4, minHeight: space.sm },
  block: { marginBottom: space.lg },
  kicker: { fontSize: 10.5, fontFamily: fonts.sansBold, letterSpacing: 1.5 },
  title: { marginTop: space.sm, fontSize: 28, lineHeight: 34, fontFamily: fonts.serifBold },
  subtitle: { marginTop: space.sm, fontSize: 14.5, lineHeight: 22, fontFamily: fonts.sans },
  footer: { marginTop: space.lg, alignItems: 'center' },
});
