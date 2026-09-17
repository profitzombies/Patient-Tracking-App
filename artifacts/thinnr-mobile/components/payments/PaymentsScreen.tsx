/**
 * Screen shell for every page of the provider app's Payments area — the
 * mobile counterpart of the web area's Header + SectionTabs + Boundary.
 *
 * Which branch renders is decided from AUTH STATE, never from missing data:
 *   - session resolving  → "Checking your sign-in…" (no demo flash, no call)
 *   - signed out         → the caller's demo body under the demo notice,
 *                          fed by the same pinned dataset as the web area
 *   - signed in          → the office billing status is loaded first;
 *                          403 / can_manage=false → permission state,
 *                          errors → announced ErrorBox with retry,
 *                          no Stripe account → redirect to Get paid
 *                          (unless the page allows it), else the live body.
 *
 * Section tabs are a horizontal strip under the title (one Payments entry in
 * the provider launcher; this strip reaches every sub-page). Detail pages
 * hide the strip and show a back link instead.
 */
import React, { type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, usePathname, type Href } from 'expo-router';
import { PageScrollView } from '@/components/ui/PageScrollView';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { useSupabaseSession } from '@/lib/supabase';
import { OfficeBillingError } from '@/lib/office-billing-api';
import type { OfficeBillingStatus } from '@/lib/office-billing-types';
import { useOfficeBillingStatus } from '@/hooks/useOfficeBilling';
import { Body, DemoNotice, ErrorBox, LoadingBox, Panel, SandboxBadge } from './primitives';

export const PAYMENTS_BASE = '/payments';

export const PAYMENTS_SECTIONS = [
  { key: 'overview', path: '/payments', label: 'Overview' },
  { key: 'activity', path: '/payments/activity', label: 'Activity' },
  { key: 'transactions', path: '/payments/transactions', label: 'Transactions' },
  { key: 'refunds', path: '/payments/refunds', label: 'Refunds' },
  { key: 'fulfillment', path: '/payments/fulfillment', label: 'Fulfillment' },
  { key: 'subscriptions', path: '/payments/subscriptions', label: 'Subscriptions' },
  { key: 'payouts', path: '/payments/payouts', label: 'Payouts' },
  { key: 'links', path: '/payments/links', label: 'Payment links' },
  { key: 'prices', path: '/payments/prices', label: 'Prices' },
  { key: 'settings', path: '/payments/settings', label: 'Settings' },
] as const;

export type PaymentsSectionKey = (typeof PAYMENTS_SECTIONS)[number]['key'] | 'get-paid';

const PERMISSION_TEXT = 'Only office owners and admins can manage payments.';
export const DEMO_SUB = 'A guided example of your office payment workspace.';

export type PaymentsLive = { userId: string; status: OfficeBillingStatus };

export interface PaymentsScreenProps {
  section: PaymentsSectionKey;
  title: string;
  sub: string;
  /** Demo persona body (signed out). Rendered with the demo notice above it. */
  demo: ReactNode;
  /** Live body for a signed-in staff member whose office status resolved. */
  live: (ctx: PaymentsLive) => ReactNode;
  /** Header action slot; receives the live context (undefined in demo). */
  action?: (ctx: PaymentsLive | undefined) => ReactNode;
  /** Get paid shows even before an account exists. */
  allowNoAccount?: boolean;
  /** Detail pages hide the section strip and show a back link. */
  back?: { href: Href; label: string };
  /** Demo title suffix override (defaults to the shared demo subtitle). */
  demoSub?: string;
  testID?: string;
}

export function PaymentsScreen(props: PaymentsScreenProps) {
  const { session, sessionLoading } = useSupabaseSession();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomPad = Platform.OS === 'web' ? 84 + 16 : insets.bottom + 84 + 16;

  if (!sessionLoading && session?.user) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]} testID={props.testID ?? `payments-${props.section}`}>
        <LiveGate key={session.user.id} userId={session.user.id} {...props} bottomPad={bottomPad} />
      </View>
    );
  }
  const demo = !sessionLoading;
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]} testID={props.testID ?? `payments-${props.section}`}>
      <PageScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]} keyboardShouldPersistTaps="handled">
        <PaymentsHeader
          section={props.section}
          title={props.title}
          sub={demo ? props.demoSub ?? DEMO_SUB : props.sub}
          sandbox={demo || undefined}
          back={props.back}
          action={demo ? props.action?.(undefined) : undefined}
        />
        {demo ? (
          <>
            <DemoNotice />
            {props.demo}
          </>
        ) : (
          <LoadingBox label="Checking your sign-in…" testID="billing-session-loading" />
        )}
      </PageScrollView>
    </View>
  );
}

function LiveGate({ userId, bottomPad, ...props }: PaymentsScreenProps & { userId: string; bottomPad: number }) {
  const status = useOfficeBillingStatus(userId);
  const pathname = usePathname();
  const forbidden = (status.error instanceof OfficeBillingError && status.error.status === 403) || status.data?.viewer.can_manage === false;

  let body: ReactNode;
  let ctx: PaymentsLive | undefined;
  if (status.isPending) {
    body = <LoadingBox testID="billing-status-loading" />;
  } else if (forbidden) {
    body = <PermissionState />;
  } else if (status.isError || !status.data) {
    body = <ErrorBox error={status.error} retry={() => void status.refetch()} testID="billing-status-error" />;
  } else if (!props.allowNoAccount && status.data.account === null) {
    // Guarded redirect: only while this payments page is the one on screen.
    if (pathname.startsWith(PAYMENTS_BASE)) return <Redirect href="/payments/get-paid" />;
    body = null;
  } else {
    ctx = { userId, status: status.data };
    body = props.live(ctx);
  }

  return (
    <PageScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]} keyboardShouldPersistTaps="handled">
      <PaymentsHeader section={props.section} title={props.title} sub={props.sub} sandbox={status.data?.sandbox} back={props.back} action={props.action?.(ctx)} />
      {body}
    </PageScrollView>
  );
}

export function PermissionState() {
  const colors = useColors();
  return (
    <Panel testID="status-billing-unauthorized" style={{ borderColor: colors.border }}>
      <View accessibilityRole="alert" style={{ gap: 8 }}>
        <Feather name="shield" size={18} color={colors.mutedForeground} />
        <Text style={[styles.permissionTitle, { color: colors.navy }]}>Payments access is restricted</Text>
        <Body>{PERMISSION_TEXT}</Body>
      </View>
    </Panel>
  );
}

export function PaymentsHeader({ section, title, sub, sandbox, back, action }: {
  section: PaymentsSectionKey;
  title: string;
  sub: string;
  sandbox?: boolean;
  back?: { href: Href; label: string };
  action?: ReactNode;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  return (
    <View style={[styles.header, { paddingTop: topPad + 8 }]}>
      {back ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={back.label}
          testID="payments-back"
          onPress={() => (router.canGoBack() ? router.back() : router.navigate(back.href))}
          style={styles.backLink}
        >
          <Feather name="chevron-left" size={14} color={colors.cobalt} />
          <Text style={[styles.backText, { color: colors.cobalt }]}>{back.label}</Text>
        </Pressable>
      ) : null}
      <View style={styles.titleRow}>
        <View style={[styles.brandMark, { backgroundColor: colors.navy }]}>
          <Text style={[styles.brandMarkText, { color: colors.brandMarkText }]}>TH</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.kicker, { color: colors.labelText }]}>PAYMENTS</Text>
          <Text style={[styles.title, { color: colors.navy }]} accessibilityRole="header" testID="payments-title">{title}</Text>
        </View>
      </View>
      <SandboxBadge sandbox={sandbox} />
      <Text style={[styles.sub, { color: colors.bodyText }]}>{sub}</Text>
      {action ? <View style={styles.action}>{action}</View> : null}
      {back ? null : <SectionTabs active={section} />}
    </View>
  );
}

export function SectionTabs({ active }: { active: PaymentsSectionKey }) {
  const colors = useColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.tabs, { borderBottomColor: colors.border }]}
      contentContainerStyle={styles.tabsContent}
      accessibilityRole="tablist"
      accessibilityLabel="Payments sections"
    >
      {PAYMENTS_SECTIONS.map((sectionItem) => {
        const isActive = sectionItem.key === active;
        return (
          <Pressable
            key={sectionItem.key}
            testID={`tab-payments-${sectionItem.key}`}
            accessibilityRole="tab"
            accessibilityLabel={sectionItem.label}
            accessibilityState={{ selected: isActive }}
            aria-selected={isActive}
            onPress={() => { if (!isActive) router.navigate(sectionItem.path as Href); }}
            style={[styles.tab, { borderBottomColor: isActive ? colors.cobalt : 'transparent' }]}
          >
            <Text style={[styles.tabText, { color: isActive ? colors.cobalt : colors.mutedForeground }]}>{sectionItem.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: 14, gap: 12 },
  header: { gap: 8, marginBottom: 4 },
  backLink: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', minHeight: 32 },
  backText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: { width: 34, height: 34, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { fontSize: 11, fontFamily: 'Inter_700Bold', letterSpacing: 1 },
  kicker: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 1.4 },
  title: { fontSize: 22, fontFamily: fonts.serifBold, lineHeight: 28 },
  sub: { fontSize: 12, lineHeight: 17, fontFamily: 'Inter_400Regular' },
  action: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tabs: { borderBottomWidth: 1, marginHorizontal: -14, flexGrow: 0 },
  tabsContent: { paddingHorizontal: 10 },
  tab: { paddingHorizontal: 10, paddingVertical: 10, borderBottomWidth: 2, marginBottom: -1, minHeight: 40, justifyContent: 'center' },
  tabText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  permissionTitle: { fontSize: 18, fontFamily: fonts.serifBold },
});
