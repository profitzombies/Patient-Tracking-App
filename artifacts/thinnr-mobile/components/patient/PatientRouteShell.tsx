/**
 * Safe, data-free frame used while a patient route is being admitted or
 * hydrated.  It deliberately does not use PatientHeader: that header's
 * avatar opens a patient route and is therefore an interactive control that
 * must stay hidden until admission is complete.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { PatientTabBar } from '@/components/patient/PatientTabBar';

export type PatientRouteName = 'today' | 'diary' | 'progress' | 'recipes' | 'library' | 'plan' | 'unknown';
export type PatientShellStatus = 'loading' | 'offline' | 'error' | 'denied';

export interface PatientRouteMeta {
  title: string;
  subtitle: string;
}

export const PATIENT_ROUTE_META: Record<PatientRouteName, PatientRouteMeta> = {
  today: { title: 'Today', subtitle: 'YOUR DAILY PLAN' },
  diary: { title: 'Food Diary', subtitle: 'YOUR MEALS & HYDRATION' },
  progress: { title: 'Progress', subtitle: 'YOUR JOURNEY' },
  recipes: { title: 'Library', subtitle: 'FOODS & RECIPES FOR YOUR PLAN' },
  library: { title: 'Library', subtitle: 'FOODS & RECIPES FOR YOUR PLAN' },
  plan: { title: 'Plan', subtitle: 'YOUR PROGRAM' },
  unknown: { title: 'THINNR', subtitle: 'PATIENT COMPANION' },
};

/** Expo Router can expose either the grouped or ungrouped pathname. */
export function patientRouteFromPathname(pathname: string): PatientRouteName {
  const normalized = pathname.replace('/(patient)', '') || '/today';
  if (normalized === '/today') return 'today';
  if (normalized === '/diary') return 'diary';
  if (normalized === '/progress') return 'progress';
  if (normalized === '/recipes') return 'recipes';
  if (normalized === '/plan') return 'plan';
  return 'unknown';
}

export function isPatientRoutePath(pathname: string): boolean {
  const normalized = pathname.replace('/(patient)', '');
  return normalized === '/today' || normalized === '/diary' || normalized === '/progress' ||
    normalized === '/recipes' || normalized === '/plan';
}

interface PatientRouteHeaderProps {
  meta: PatientRouteMeta;
}

function PatientRouteHeader({ meta }: PatientRouteHeaderProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  return (
    <View
      testID="patient-route-safe-header"
      style={[
        styles.header,
        {
          backgroundColor: colors.paperCardAlt,
          borderBottomColor: colors.border,
          paddingTop: topPad,
        },
      ]}
    >
      <View style={styles.headerInner}>
        <View style={styles.brandRow}>
          <View style={[styles.brandMark, { backgroundColor: colors.navy }]}>
            <Text style={[styles.brandMarkText, { color: colors.brandMarkText }]}>TH</Text>
          </View>
          <View>
            <Text style={[styles.title, { color: colors.navy }]}>{meta.title}</Text>
            <Text style={[styles.subtitle, { color: colors.labelText }]}>{meta.subtitle}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function SkeletonBlock({
  style,
  colors,
}: {
  style?: object;
  colors: ReturnType<typeof useColors>;
}) {
  return <View style={[styles.skeletonBlock, { backgroundColor: colors.border }, style]} />;
}

function SkeletonRows({ colors, count = 3 }: { colors: ReturnType<typeof useColors>; count?: number }) {
  return (
    <View style={styles.skeletonRows}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={[styles.skeletonRow, { borderBottomColor: colors.border }]}>
          <SkeletonBlock colors={colors} style={styles.skeletonDot} />
          <View style={styles.skeletonRowBody}>
            <SkeletonBlock colors={colors} style={[styles.skeletonLine, index % 2 ? styles.skeletonLineShort : null]} />
            <SkeletonBlock colors={colors} style={styles.skeletonLineDetail} />
          </View>
          <SkeletonBlock colors={colors} style={styles.skeletonAction} />
        </View>
      ))}
    </View>
  );
}

/**
 * Static route-shaped placeholders keep the first frame familiar without
 * guessing any patient values.  In particular, Progress never reserves a
 * session-photo section: photos are private content, not loading chrome.
 */
function PatientHydrationSkeleton({ route }: { route: PatientRouteName }) {
  const colors = useColors();
  const skeleton = (() => {
    if (route === 'today') {
      return (
        <View testID="patient-route-skeleton-today">
          <SkeletonBlock colors={colors} style={styles.todayHero} />
          <SkeletonRows colors={colors} count={3} />
        </View>
      );
    }
    if (route === 'diary') {
      return (
        <View testID="patient-route-skeleton-diary">
          <View style={styles.totalsRow}>
            {[0, 1, 2].map(index => (
              <View key={index} style={[styles.totalPlaceholder, { borderColor: colors.border }]}>
                <SkeletonBlock colors={colors} style={styles.totalNumber} />
                <SkeletonBlock colors={colors} style={styles.totalLabel} />
              </View>
            ))}
          </View>
          <SkeletonRows colors={colors} count={4} />
        </View>
      );
    }
    if (route === 'progress') {
      return (
        <View testID="patient-route-skeleton-progress">
          <View style={[styles.trendPlaceholder, { borderColor: colors.border }]}>
            <SkeletonBlock colors={colors} style={styles.trendTitle} />
            <View style={styles.trendBars}>
              {[0, 1, 2, 3, 4, 5].map(index => (
                <SkeletonBlock
                  key={index}
                  colors={colors}
                  style={[styles.trendBar, { height: 22 + index * 11 }]}
                />
              ))}
            </View>
          </View>
          <SkeletonRows colors={colors} count={2} />
        </View>
      );
    }
    return (
      <View testID="patient-route-skeleton-library">
        <View style={styles.libraryPlaceholderRow}>
          <SkeletonBlock colors={colors} style={styles.libraryPlaceholderImage} />
          <View style={styles.libraryPlaceholderCopy}>
            <SkeletonBlock colors={colors} style={styles.libraryPlaceholderTitle} />
            <SkeletonBlock colors={colors} style={styles.libraryPlaceholderDetail} />
          </View>
        </View>
        <SkeletonRows colors={colors} count={3} />
      </View>
    );
  })();

  return (
    <View
      testID="patient-route-hydration-skeleton"
      accessibilityRole="progressbar"
      accessibilityLabel="Loading route content"
      aria-busy={true}
      style={styles.skeleton}
    >
      {skeleton}
    </View>
  );
}

function PatientRouteStatus({
  status,
  detail,
  onRetry,
}: {
  status: PatientShellStatus;
  detail?: string;
  onRetry?: () => void;
}) {
  const colors = useColors();
  const loading = status === 'loading';
  const denied = status === 'denied';
  const error = status === 'error';
  const title = denied
    ? 'This patient route is unavailable'
    : error
      ? 'Couldn’t load your record'
      : 'You’re offline';
  const body = detail ?? (
    denied
      ? 'Sign in or finish the required account steps before opening patient data.'
      : error
        ? 'Something went wrong while loading your data. Retry to continue.'
        : 'Your account could not be reached. Retry when you are online.'
  );
  if (loading) {
    return (
      <View
        testID="patient-route-shell-loading-status"
        accessibilityLiveRegion="polite"
        style={styles.loadingStatus}
      >
        <Text style={[styles.loadingTitle, { color: colors.navy }]}>Loading your data</Text>
        <Text style={[styles.loadingBody, { color: colors.subtleText }]}>
          {detail ?? 'Your data will appear here shortly.'}
        </Text>
      </View>
    );
  }
  return (
    <View
      testID={`patient-route-shell-${status}`}
      accessibilityLiveRegion={loading ? 'polite' : 'assertive'}
      style={[
        styles.statusCard,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Feather
        name={denied ? 'lock' : error ? 'alert-triangle' : 'wifi-off'}
        size={20}
        color={denied ? colors.riskText : error ? colors.riskText : colors.warnText}
      />
      <Text style={[styles.statusTitle, { color: colors.navy }]}>{title}</Text>
      <Text style={[styles.statusBody, { color: colors.subtleText }]}>{body}</Text>
      {onRetry ? (
        <Pressable
          testID="patient-route-shell-retry"
          accessibilityRole="button"
          accessibilityLabel="Retry loading your account"
          onPress={onRetry}
          style={({ pressed }) => [
            styles.retryButton,
            { backgroundColor: colors.cobalt },
            pressed && { opacity: 0.82 },
          ]}
        >
          <Text style={[styles.retryText, { color: colors.primaryForeground }]}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function PatientRouteShell({
  pathname,
  status,
  detail,
  onRetry,
  navigationAllowed = false,
}: {
  pathname: string;
  status: PatientShellStatus;
  detail?: string;
  onRetry?: () => void;
  /**
   * Navigation is safe only after the root admission gate has allowed the
   * account.  The bar has destinations, never patient data, but it is still
   * intentionally absent for anonymous/denied deep links.
   */
  navigationAllowed?: boolean;
}) {
  const colors = useColors();
  const route = patientRouteFromPathname(pathname);
  const meta = PATIENT_ROUTE_META[route];
  return (
    <View testID="patient-route-shell" style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientRouteHeader meta={meta} />
      <View style={styles.body}>
        {status === 'loading' ? <PatientHydrationSkeleton route={route} /> : null}
        <PatientRouteStatus status={status} detail={detail} onRetry={onRetry} />
      </View>
      {navigationAllowed ? <PatientTabBar /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    borderBottomWidth: 1,
    zIndex: 2,
  },
  headerInner: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandMark: {
    width: 30,
    height: 30,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 16,
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: 0.2,
  },
  subtitle: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.4,
    marginTop: 1,
  },
  body: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 96,
  },
  skeleton: {
    gap: 14,
  },
  skeletonBlock: {
    borderRadius: 5,
    opacity: 0.65,
  },
  todayHero: {
    height: 154,
    width: '100%',
    borderRadius: 12,
  },
  skeletonRows: {
    borderTopWidth: 1,
    borderTopColor: 'transparent',
  },
  skeletonRow: {
    minHeight: 67,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    paddingVertical: 11,
  },
  skeletonDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
  },
  skeletonRowBody: {
    flex: 1,
    gap: 8,
  },
  skeletonLine: {
    width: '72%',
    height: 12,
  },
  skeletonLineShort: {
    width: '56%',
  },
  skeletonLineDetail: {
    width: '44%',
    height: 8,
  },
  skeletonAction: {
    width: 18,
    height: 18,
    borderRadius: 4,
  },
  totalsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  totalPlaceholder: {
    flex: 1,
    minHeight: 84,
    borderWidth: 1,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  totalNumber: {
    width: 40,
    height: 22,
  },
  totalLabel: {
    width: 48,
    height: 8,
  },
  trendPlaceholder: {
    height: 190,
    borderWidth: 1,
    borderRadius: 10,
    padding: 18,
    justifyContent: 'space-between',
  },
  trendTitle: {
    width: 110,
    height: 12,
  },
  trendBars: {
    height: 118,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-around',
    gap: 8,
  },
  trendBar: {
    flex: 1,
    maxWidth: 20,
    borderRadius: 4,
  },
  libraryPlaceholderRow: {
    minHeight: 108,
    flexDirection: 'row',
    gap: 12,
  },
  libraryPlaceholderImage: {
    width: 108,
    height: 108,
    borderRadius: 8,
  },
  libraryPlaceholderCopy: {
    flex: 1,
    justifyContent: 'center',
    gap: 10,
  },
  libraryPlaceholderTitle: {
    width: '78%',
    height: 13,
  },
  libraryPlaceholderDetail: {
    width: '52%',
    height: 9,
  },
  loadingStatus: {
    alignItems: 'center',
    paddingVertical: 18,
    gap: 6,
  },
  loadingTitle: {
    fontSize: 17,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  loadingBody: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    fontFamily: 'Inter_400Regular',
  },
  statusCard: {
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 22,
    paddingVertical: 26,
    gap: 10,
  },
  statusTitle: {
    fontSize: 20,
    textAlign: 'center',
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  statusBody: {
    maxWidth: 330,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    fontFamily: 'Inter_400Regular',
  },
  retryButton: {
    minWidth: 110,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    marginTop: 4,
    borderRadius: 7,
  },
  retryText: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
});