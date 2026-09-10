/**
 * Shared page frame for patient login, patient signup, and provider login.
 * The image-led welcome owns a separate layout.
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

export interface AuthPageFrameProps {
  /** Renders a back control on the left of the top bar when provided. */
  onBack?: () => void;
  backTestID?: string;
  backAccessibilityLabel?: string;
  /** Small right-aligned caption in the top bar (used when there is no back control). */
  topNote?: string;
  /** Anything that must sit above the hero, e.g. an environment warning. */
  banner?: React.ReactNode;
  hero?: React.ReactNode;
  kicker?: string;
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
  /**
   * Keep the content top-anchored but let the footer sink to the bottom of
   * the viewport on tall phones (login). Ignored when `balance` is set.
   */
  pinFooter?: boolean;
  testID?: string;
  /**
   * Selects the visual variant. The provider default keeps the legacy
   * centered-bar and smaller type. The patient variant brings the confident,
   * edge-to-edge typography of the Heritage aesthetic.
   */
  variant?: 'patient' | 'provider';
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
  pinFooter = false,
  testID,
  variant = 'provider',
}: AuthPageFrameProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web'
    ? Math.max(insets.top, variant === 'patient' ? 67 : 44)
    : insets.top + space.sm;
  const bottomPad = Platform.OS === 'web' && variant === 'patient'
    ? Math.max(insets.bottom, 34) + space.md
    : Math.max(insets.bottom, space.md) + space.md;

  return (
    <View testID={testID} style={[styles.page, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={[styles.topBar, variant === 'patient' && styles.topBarPatient]}>
        {onBack ? (
          <Pressable
            testID={backTestID}
            accessibilityRole="button"
            accessibilityLabel={backAccessibilityLabel}
            onPress={onBack}
            style={({ pressed }) => [
              styles.backBtn,
              { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm },
              variant === 'patient' && styles.backBtnPatient,
              pressed && { backgroundColor: colors.accent },
            ]}
          >
            <Feather name="chevron-left" size={18} color={colors.navy} />
          </Pressable>
        ) : (
          <View style={styles.backSlot} />
        )}
        <Text style={[styles.wordmark, variant === 'patient' && styles.wordmarkPatient, { color: colors.navy }]}>THINNR</Text>
        <View style={[styles.backSlot, styles.noteSlot]}>
          {topNote && variant !== 'patient' ? <Text style={[styles.topNote, { color: colors.subtleText }]}>{topNote}</Text> : null}
        </View>
      </View>

      <KeyboardAwareScrollViewCompat
        style={styles.scroll}
        contentContainerStyle={[styles.content, variant === 'patient' && styles.contentPatient, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
        bottomOffset={96}
      >
        {balance ? <View style={styles.slackTop} /> : null}
        {banner ? <View style={styles.block}>{banner}</View> : null}
        {hero ? <View style={styles.block}>{hero}</View> : null}
        {/* With nothing above it, the heading takes the hero's share of the gap under the top bar. */}
        <View style={[styles.block, !hero && !banner && styles.leadingHeading, variant === 'patient' && styles.headingPatient]}>
          {kicker && variant !== 'patient' ? <Text style={[styles.kicker, { color: colors.labelText }]}>{kicker}</Text> : null}
          <Text accessibilityRole="header" style={[styles.title, variant === 'patient' && styles.titlePatient, { color: colors.navy }]}>{title}</Text>
          {subtitle ? <Text style={[styles.subtitle, variant === 'patient' && styles.subtitlePatient, { color: colors.bodyText }]}>{subtitle}</Text> : null}
        </View>
        <View>{children}</View>
        {footer && pinFooter && !balance ? <View style={styles.slackTop} /> : null}
        {footer ? <View style={[styles.footer, variant === 'patient' && styles.footerPatient]}>{footer}</View> : null}
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
  topBarPatient: {
    paddingTop: 0,
    paddingBottom: space.lg,
  },
  backBtn: {
    width: authLayout.headerControl,
    height: authLayout.headerControl,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnPatient: {
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  backSlot: { width: authLayout.headerControl, height: authLayout.headerControl, justifyContent: 'center' },
  noteSlot: { width: 'auto', minWidth: authLayout.headerControl, alignItems: 'flex-end' },
  wordmark: { fontSize: 23, fontFamily: fonts.serif, letterSpacing: -0.5 },
  wordmarkPatient: { fontSize: 32 },
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
  // Match welcome's extra 32pt below the unchanged header, including banners.
  // Scroll-content padding lets footer slack yield before short pages scroll.
  contentPatient: { paddingTop: space.sm + space.xl },
  slackTop: { flexGrow: 1, minHeight: 0 },
  slackBottom: { flexGrow: 1.4, minHeight: space.sm },
  block: { marginBottom: space.lg },
  leadingHeading: { marginTop: space.md },
  headingPatient: { marginTop: space.xs, marginBottom: space.xl },
  kicker: { fontSize: 10.5, fontFamily: fonts.sansBold, letterSpacing: 1.5 },
  title: { marginTop: space.sm, fontSize: 28, lineHeight: 34, fontFamily: fonts.serifBold },
  titlePatient: { marginTop: 0, fontSize: 32, lineHeight: 38 },
  subtitle: { marginTop: space.sm, fontSize: 14.5, lineHeight: 22, fontFamily: fonts.sans },
  subtitlePatient: { marginTop: space.sm, fontSize: 16, lineHeight: 24 },
  footer: { marginTop: space.lg, alignItems: 'center' },
  footerPatient: { marginTop: space.xl },
});
