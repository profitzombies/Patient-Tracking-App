import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setAuthTokenGetter, setBaseUrl } from '@workspace/api-client-react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { WebFitShell } from '@/components/WebFitShell';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import {
  PlayfairDisplay_600SemiBold,
  PlayfairDisplay_700Bold,
} from '@expo-google-fonts/playfair-display';
import * as Font from 'expo-font';
import { Redirect, Stack, usePathname, useRouter, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { emitChatSync } from '@/lib/chat-sync-events';
import { useColors } from '@/hooks/useColors';
import { AppModeProvider } from '@/context/AppModeContext';
import { OfficeRestrictionProvider, useOfficeRestriction } from '@/context/OfficeRestrictionContext';
import { RestrictedStaffNotice } from '@/components/provider/RestrictedStaffNotice';
import { staffRouteBlocked } from '@/lib/office-restriction';
import { CoachChatProvider } from '@/context/CoachChatContext';
import { CareTeamChatProvider } from '@/context/CareTeamChatContext';
import { OnboardingProvider } from '@/context/OnboardingContext';
import { OperationsProvider } from '@/context/OperationsContext';
import { PatientAccountProvider } from '@/context/PatientAccountProvider';
import { PatientProvider } from '@/context/PatientContext';
import { CartProvider } from '@/context/CartContext';
import { FoodLoggingProvider } from '@/context/FoodLoggingContext';
import { DeviceBiometricGate, DeviceFeaturesProvider } from '@/context/DeviceFeaturesContext';
import { PatientSyncNotice } from '@/components/patient/PatientSyncNotice';
import {
  PatientRouteShell,
  type PatientShellStatus,
} from '@/components/patient/PatientRouteShell';
import { useAppMode } from '@/context/AppModeContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { usePatient, usePatientSyncNotice } from '@/context/PatientContext';
import { supabase } from '@/lib/supabase';
import { markNotificationOpened } from '@/lib/push-notifications-api';
import {
  notificationAdmittedForPatient,
  notificationPatientId,
  resolveNotificationRoute,
} from '@/lib/push-notification-core';
import { reminderDoseFromResponse, type ReminderDoseIntent } from '@/lib/reminder-response';
import { BloodworkDraftLifecycle, useBloodworkRecoveryRoute } from '@/lib/bloodwork-recovery';
import { bloodworkRecoveryEntryDecision } from '@/lib/bloodwork-entry-policy';
import { useSupabaseSession } from '@/lib/supabase';
import { useOfficeAccess } from '@/hooks/useOfficeBilling';
import { isProviderArea, officeAccessGateDecision } from '@/lib/office-access-gate';
import { providerSignedOutRedirect } from '@/lib/provider-entry';

const publicDomain = process.env.EXPO_PUBLIC_DOMAIN;
if (publicDomain) setBaseUrl(`https://${publicDomain}`);
setAuthTokenGetter(async () => (await supabase?.auth.getSession())?.data.session?.access_token ?? null);

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

const queryClient = new QueryClient();

/**
 * Every font the app renders, preloaded up front in one place:
 * - Inter ×4 and Playfair Display ×2 for text (the Playfair weights are the
 *   editorial serif for the patient home hero — mirrors the web app's
 *   Cobalt Ledger display face).
 * - Feather + MaterialCommunityIcons TTFs — the only two icon families the
 *   app uses.
 *
 * The icon fonts are listed deliberately. @expo/vector-icons lazy-loads a
 * family's TTF the first time one of its icons renders, and a failed lazy
 * load is swallowed — on Android the icons' private-use codepoints then fall
 * through to the system font and render as tofu/X boxes (seen on-device in
 * Expo Go). Preloading here gives icons the same guarantees as text fonts:
 * nothing renders until every glyph source is actually available.
 */
const APP_FONTS = {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  PlayfairDisplay_600SemiBold,
  PlayfairDisplay_700Bold,
  ...Feather.font,
  ...MaterialCommunityIcons.font,
};

/** Tries per load call: the initial fetch plus one automatic retry. */
const LOAD_ATTEMPTS = 2;
/** Per-attempt cap so a hung download can't pin the splash screen forever. */
const ATTEMPT_TIMEOUT_MS = 15_000;

function loadFontsWithTimeout(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`font load timed out after ${ATTEMPT_TIMEOUT_MS}ms`));
    }, ATTEMPT_TIMEOUT_MS);
    Font.loadAsync(APP_FONTS).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type FontStatus = 'loading' | 'retrying' | 'error' | 'ready';

/**
 * Load status for APP_FONTS with explicit failure handling. The app used to
 * keep rendering when `useFonts` reported an error, which silently produced
 * system-font text and tofu-box icons; a failure now surfaces a retry screen
 * instead, and the underlying error is logged where it can be seen (Metro
 * console, adb logcat, browser console).
 */
function useAppFonts(): { status: FontStatus; retry: () => void } {
  const [status, setStatus] = useState<FontStatus>('loading');
  const inFlight = useRef(false);

  const load = useCallback(async (kind: 'initial' | 'retry') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus(kind === 'initial' ? 'loading' : 'retrying');
    // These logs stream to the Metro terminal from real devices — they exist
    // so on-device reports ("icons broken on Android") can be matched to a
    // session: which platform ran the gate, and whether fonts loaded or why
    // not. Keep them until Android tofu reports are confirmed resolved.
    const startedAt = Date.now();
    // Platform.constants.reactNativeVersion is the NATIVE runtime version of
    // the client binary (Expo Go itself), not the bundled JS. A native version
    // that differs from the project JS RN below means the tester's Expo Go
    // targets another SDK and may silently ignore custom font registration.
    const nativeRN = JSON.stringify(Platform.constants?.reactNativeVersion ?? 'n/a');
    let projectRN = 'unknown';
    try {
      // Resolved by the bundler, so the log stays truthful across SDK upgrades.
      projectRN =
        (require('react-native/package.json') as { version?: string }).version ?? 'unknown';
    } catch {
      // Node verify suites stub react-native; the exact version is moot there.
    }
    console.log(
      `[fonts] gate v2 ${kind} load starting on ${Platform.OS} | client native RN ${nativeRN} | project JS RN ${projectRN}`,
    );
    try {
      for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt += 1) {
        try {
          // Already-loaded families resolve immediately inside loadAsync, so
          // retries only re-fetch what actually failed.
          await loadFontsWithTimeout();
          console.log(
            `[fonts] gate v2 loaded on ${Platform.OS} in ${Date.now() - startedAt}ms (attempt ${attempt}/${LOAD_ATTEMPTS})`,
          );
          setStatus('ready');
          return;
        } catch (error) {
          console.error(
            `[fonts] Load attempt ${attempt}/${LOAD_ATTEMPTS} failed:`,
            error,
          );
        }
      }
      setStatus('error');
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    load('initial');
  }, [load]);

  const retry = useCallback(() => {
    load('retry');
  }, [load]);

  return { status, retry };
}

/**
 * Shown when fonts genuinely cannot be fetched. Deliberately renders **no**
 * custom fonts and **no** vector icons — both are exactly what failed here,
 * so everything below uses the system face only.
 */
function FontLoadFailureScreen({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}) {
  const colors = useColors();
  return (
    <View style={[gateStyles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          gateStyles.card,
          { borderColor: colors.border, backgroundColor: colors.card },
        ]}
      >
        <Text style={[gateStyles.brand, { color: colors.navy }]}>THINNR</Text>
        <Text style={[gateStyles.title, { color: colors.navy }]}>
          Couldn't load fonts and icons
        </Text>
        <Text style={[gateStyles.body, { color: colors.subtleText }]}>
          The app needs a small download before it can display correctly.
          Check your connection, then retry.
        </Text>
        <Pressable
          testID="font-retry"
          accessibilityRole="button"
          accessibilityLabel="Retry loading fonts"
          disabled={retrying}
          onPress={onRetry}
          style={({ pressed }) => [
            gateStyles.button,
            { backgroundColor: retrying ? colors.cobaltMuted : colors.cobalt },
            pressed && { opacity: 0.85 },
          ]}
        >
          {retrying ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text style={[gateStyles.buttonText, { color: colors.primaryForeground }]}>
              Tap to retry
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="(patient)" options={{ headerShown: false }} />
      <Stack.Screen name="patient/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="office-patient/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="sell-to-patient" options={{ presentation: 'modal', headerShown: false }} />
      <Stack.Screen name="persona" options={{ headerShown: false }} />
      <Stack.Screen name="patient-login" options={{ headerShown: false }} />
      <Stack.Screen name="patient-welcome" options={{ headerShown: false }} />
      <Stack.Screen name="patient-signup" options={{ headerShown: false }} />
      <Stack.Screen name="program-ended" options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="provider-login" options={{ headerShown: false }} />
      <Stack.Screen name="claim-account" options={{ headerShown: false }} />
      <Stack.Screen name="account" options={{ headerShown: false }} />
      <Stack.Screen name="billing" options={{ headerShown: false, title: 'Payments & orders' }} />
      <Stack.Screen name="orders/index" options={{ headerShown: false, title: 'Orders' }} />
      <Stack.Screen name="orders/[id]" options={{ headerShown: false, title: 'Order' }} />
      <Stack.Screen name="my-subscriptions/index" options={{ headerShown: false, title: 'Subscriptions' }} />
      <Stack.Screen name="my-subscriptions/[id]" options={{ headerShown: false, title: 'Subscription' }} />
      <Stack.Screen name="shop" options={{ headerShown: false, title: 'Shop' }} />
      <Stack.Screen name="product/[id]" options={{ headerShown: false, title: 'Product' }} />
      <Stack.Screen name="cart" options={{ headerShown: false, title: 'Cart' }} />
      <Stack.Screen name="checkout" options={{ headerShown: false, title: 'Checkout', gestureEnabled: false }} />
      <Stack.Screen name="order-confirmation" options={{ headerShown: false, title: 'Order confirmed', gestureEnabled: false }} />
      <Stack.Screen name="security" options={{ headerShown: false }} />
      <Stack.Screen name="security-report" options={{ headerShown: false }} />
      <Stack.Screen name="consent" options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false }} />
      <Stack.Screen name="recipe/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="ai-recipe/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="approved-foods" options={{ headerShown: false }} />
      <Stack.Screen name="food-preferences" options={{ headerShown: false }} />
      <Stack.Screen name="diet-picker" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="restaurant-guide/index" options={{ headerShown: false }} />
      <Stack.Screen name="restaurant-guide/guidance" options={{ headerShown: false }} />
      <Stack.Screen name="restaurant-guide/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="menu-scan" options={{ headerShown: false }} />
      <Stack.Screen name="instructions" options={{ headerShown: false }} />
      <Stack.Screen name="rewards" options={{ headerShown: false }} />
      <Stack.Screen name="rewards/my-awards" options={{ headerShown: false }} />
      <Stack.Screen name="rewards/next-awards" options={{ headerShown: false }} />
      <Stack.Screen name="phase/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="training-course/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="training-lesson/[courseId]/[videoId]" options={{ headerShown: false }} />
      <Stack.Screen name="training-teammate/[viewerId]" options={{ headerShown: false }} />
      <Stack.Screen name="create-food" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="barcode-scan" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="log-food" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="food/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="bloodwork/index" options={{ headerShown: false }} />
      <Stack.Screen name="bloodwork/new" options={{ headerShown: false }} />
      <Stack.Screen name="bloodwork/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="patient/[id]/bloodwork/[reportId]" options={{ headerShown: false }} />
      <Stack.Screen name="yesterday-review" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="check-in" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="care-team-chat" options={{ headerShown: false }} />
      <Stack.Screen name="coach-history" options={{ headerShown: false }} />
      <Stack.Screen name="coach-memories" options={{ headerShown: false }} />
      <Stack.Screen name="coach-chat" options={{ headerShown: false }} />
      <Stack.Screen name="support-chat" options={{ headerShown: false }} />
      <Stack.Screen name="office-account" options={{ headerShown: false }} />
      <Stack.Screen
        name="food-camera"
        options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade' }}
      />
      <Stack.Screen
        name="guided-photos"
        options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade' }}
      />
    </Stack>
  );
}

/**
 * Route admission for a staff office narrowed for nonpayment.
 *
 * The allowed payment and subscription screens stay exactly as they are;
 * every other staff route resolves to the explanation instead. The navigator
 * stays mounted underneath (same shape as the patient gate) so Expo Router
 * keeps its history, and the blocked screen is inert while it is covered.
 *
 * The server refuses the blocked surface on its own, so this never holds the
 * app while the office's state is still unknown.
 */
function StaffRestrictionGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { mode, hydrated } = useAppMode();
  const { restricted } = useOfficeRestriction();
  const blocked = hydrated && staffRouteBlocked({ mode, restricted, pathname });
  const gatedNavigatorProps = {
    accessibilityElementsHidden: blocked,
    importantForAccessibility: blocked ? 'no-hide-descendants' : 'auto',
    'aria-hidden': blocked,
    pointerEvents: blocked ? 'none' : 'auto',
    ...(Platform.OS === 'web' ? { inert: blocked } : {}),
  } as unknown as React.ComponentProps<typeof View>;

  return (
    <>
      <View style={gateStyles.gatedNavigator} {...gatedNavigatorProps}>
        {children}
      </View>
      {blocked ? (
        <View style={[StyleSheet.absoluteFill, { zIndex: 900 }]} pointerEvents="auto" accessibilityViewIsModal>
          <RestrictedStaffNotice />
        </View>
      ) : null}
    </>
  );
}

/**
 * A signed-out visitor never reaches the provider area: provider screens send
 * them to provider sign-in when the device is in staff mode, or to the
 * patient front door otherwise. Claiming an account stays open. Same shape as
 * the other gates: the navigator stays mounted underneath, inert and covered,
 * while the redirect lands.
 */
function ProviderSignedOutGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const colors = useColors();
  const { mode, hydrated } = useAppMode();
  const { session, sessionLoading } = useSupabaseSession();
  const href = providerSignedOutRedirect({
    modeHydrated: hydrated,
    mode,
    sessionLoading,
    signedIn: Boolean(session?.user),
    pathname,
  });
  const redirecting = href !== null;
  const gatedNavigatorProps = {
    accessibilityElementsHidden: redirecting,
    importantForAccessibility: redirecting ? 'no-hide-descendants' : 'auto',
    'aria-hidden': redirecting,
    pointerEvents: redirecting ? 'none' : 'auto',
    ...(Platform.OS === 'web' ? { inert: redirecting } : {}),
  } as unknown as React.ComponentProps<typeof View>;

  return (
    <>
      <View style={gateStyles.gatedNavigator} {...gatedNavigatorProps}>
        {children}
      </View>
      {redirecting ? (
        <View
          style={[StyleSheet.absoluteFill, gateStyles.container, { zIndex: 950, backgroundColor: colors.background }]}
          pointerEvents="auto"
          accessibilityViewIsModal
          testID="provider-signed-out-redirect"
        >
          <ActivityIndicator accessibilityLabel="Opening sign-in" />
        </View>
      ) : null}
      {href ? <Redirect href={href} /> : null}
    </>
  );
}

function LivePatientEntryGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const { resolving, account, accountNotice, retryResolve } = usePatientAccount();
  const patient = usePatient();
  const syncNotice = usePatientSyncNotice();
  const { session } = useSupabaseSession();
  const accountKey = account.kind === 'real' && session?.user.id
    ? `${session.user.id}:${account.patientId}`
    : null;
  const recoveryRoute = useBloodworkRecoveryRoute(accountKey);
  const decision = bloodworkRecoveryEntryDecision({
      modeHydrated,
      mode,
      accountResolving: resolving,
      accountKind: account.kind,
      patientHydrated: patient.hydrated,
      onboardingComplete: patient.hydratedFlags?.onboardingComplete ?? null,
      consentSatisfied: patient.hydratedPrivacy?.consent.satisfied ?? null,
      deletionPending: patient.hydratedPrivacy?.deletion !== null && patient.hydratedPrivacy?.deletion !== undefined,
      pathname,
    }, recoveryRoute);

  /**
   * Keep the root navigator mounted for redirects, but replace its old opaque
   * first-hydration veil with a route-safe frame.  This frame never contains
   * patient data or patient controls; an admitted account gets its own
   * destination navigation from (patient)/_layout once the decision allows.
   */
  const gateStatus: PatientShellStatus =
    syncNotice
      ? 'error'
      : account.kind === 'unresolved' && !resolving
      ? 'offline'
      : decision.kind === 'redirect'
        ? 'denied'
        : 'loading';
  const gateDetail =
    syncNotice
      ? syncNotice.message
      : account.kind === 'unresolved' && !resolving
      ? accountNotice ?? 'Your account could not be reached. Retry when you are online.'
      : decision.kind === 'redirect'
        ? decision.href === '/consent'
          ? 'Consent is required before your private record can open.'
          : decision.href === '/onboarding/welcome'
            ? 'Finish onboarding before opening your private record.'
            : 'Sign in before opening patient data.'
        : undefined;
  const gateRetry = syncNotice
    ? account.kind === 'unresolved'
      ? retryResolve
      : patient.rehydrate
    : account.kind === 'unresolved' && !resolving
      ? retryResolve
      : undefined;
  const gateBlocked = decision.kind !== 'allow';
  const gatedNavigatorProps = {
    accessibilityElementsHidden: gateBlocked,
    importantForAccessibility: gateBlocked ? 'no-hide-descendants' : 'auto',
    'aria-hidden': gateBlocked,
    pointerEvents: gateBlocked ? 'none' : 'auto',
    ...(Platform.OS === 'web' ? { inert: gateBlocked } : {}),
  } as unknown as React.ComponentProps<typeof View>;

  useEffect(() => {
    if (gateBlocked) Keyboard.dismiss();
  }, [gateBlocked]);

  // Keep the root Stack mounted while Redirect dispatches. Returning Redirect
  // instead of the Stack leaves no navigator to receive Expo Router's nested
  // "(patient) / today" replace action and triggers the development LogBox.
  return (
    <>
      <View style={gateStyles.gatedNavigator} {...gatedNavigatorProps}>
        {children}
      </View>
      {gateBlocked ? (
        <View
          style={[StyleSheet.absoluteFill, { zIndex: 1000 }]}
          pointerEvents="auto"
          accessibilityViewIsModal
        >
          <PatientRouteShell
            pathname={pathname}
            status={gateStatus}
            detail={gateDetail}
            onRetry={gateRetry}
          />
        </View>
      ) : null}
      {decision.kind === 'redirect' ? <Redirect href={decision.href} /> : null}
    </>
  );
}

/**
 * Office setup is deliberately desktop-only. Signed-in staff are admitted
 * centrally only after the office-access snapshot says the office is ready;
 * patient routes and signed-out visitors never make this request.
 */
function OfficeAccessGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const colors = useColors();
  const { mode, hydrated } = useAppMode();
  const { session, sessionLoading } = useSupabaseSession();
  const shouldRead = hydrated && mode === 'staff' && !sessionLoading &&
    Boolean(session?.user) && isProviderArea(pathname);
  const access = useOfficeAccess(session?.user.id ?? 'signed-out', { enabled: shouldRead });
  const decision = officeAccessGateDecision({
    modeHydrated: hydrated,
    mode,
    sessionLoading,
    signedIn: Boolean(session?.user),
    pathname,
    pending: shouldRead && access.isPending,
    failed: shouldRead && access.isError,
    snapshot: access.data,
  });
  if (decision.kind === 'allow') return <>{children}</>;
  if (decision.kind === 'hold') {
    return (
      <View style={[gateStyles.container, { backgroundColor: colors.background }]} testID="office-access-hold">
        <ActivityIndicator accessibilityLabel="Checking office setup" />
      </View>
    );
  }
  return (
    <OfficeAccessState
      error={decision.kind === 'error'}
      missing={decision.kind === 'handoff' ? decision.missing : []}
      retry={() => void access.refetch()}
    />
  );
}
function PushResponseBridge() {
  const router = useRouter();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const { session, sessionLoading } = useSupabaseSession();
  const { resolving, account } = usePatientAccount();
  const patient = usePatient();
  const pending = useRef<{
    route: string;
    notificationId: string | null;
    patientId: string | null;
  } | null>(null);
  const pendingDoses = useRef<ReminderDoseIntent[]>([]);
  const opened = useRef(new Set<string>());
  const handledResponses = useRef(new Set<string>());
  const admitted = modeHydrated && mode === 'patient' && !resolving &&
    account.kind === 'real' && patient.hydrated &&
    patient.hydratedFlags?.onboardingComplete === true &&
    patient.hydratedPrivacy?.consent.satisfied === true &&
    patient.hydratedPrivacy.deletion === null;
  const staffAdmitted = modeHydrated && mode === 'staff' && !sessionLoading && Boolean(session?.user);

  const recordOpened = useCallback((notificationId: string | null) => {
    if (!notificationId || opened.current.has(notificationId)) return;
    opened.current.add(notificationId);
    void markNotificationOpened(notificationId).catch(() => {
      opened.current.delete(notificationId);
    });
  }, []);

  const logDose = patient.logDose;

  const consume = useCallback((response: Notifications.NotificationResponse) => {
    const responseId = `${response.notification.request.identifier}:${response.notification.date}:${response.actionIdentifier}`;
    if (handledResponses.current.has(responseId)) return;
    handledResponses.current.add(responseId);
    const data = response.notification.request.content.data;
    if (data?.kind === 'staff_attention_digest' || data?.kind === 'coach_chat_flag') {
      const route = resolveNotificationRoute(data);
      if (!route) return;
      if (staffAdmitted) router.push(route as Href);
      else pending.current = { route, notificationId: null, patientId: null };
      return;
    }
    const responsePatientId = notificationPatientId(data);
    const activePatientId = account.kind === 'real' ? account.patientId : null;
    // Human-chat actions are patient-owned. A stale notification from an old
    // account must never be admitted into whichever account happens to be
    // selected when the native response eventually arrives.
    if (!notificationAdmittedForPatient(data, activePatientId)) {
      handledResponses.current.delete(responseId);
      return;
    }
    const dose = reminderDoseFromResponse(response, Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (dose) {
      // A medication reminder: "Taken" / "Skip" log the dose straight from
      // the notification; a plain tap opens the check-in card instead.
      // Actions foreground the app (there is no background response task),
      // so log first and then land on the card where the dose now shows.
      if (dose.status) {
        if (admitted) void logDose({ ...dose.log, status: dose.status });
        else pendingDoses.current.push(dose);
      }
      if (admitted) router.push('/check-in' as Href);
       else pending.current = { route: '/check-in', notificationId: null, patientId: activePatientId };
      return;
    }
    if (
      data?.kind === 'care_team_reply' &&
      (data.thread === 'coach' || data.thread === 'support' || data.thread === 'care_team')
    ) {
      emitChatSync(data.thread);
    }
    const route = resolveNotificationRoute(data) ?? '/(patient)/today';
    const notificationId = typeof data?.notificationId === 'string' ? data.notificationId : null;
    if (admitted) {
      recordOpened(notificationId);
      router.push(route as Href);
    } else {
      pending.current = { route, notificationId, patientId: responsePatientId ?? activePatientId };
    }
  }, [account, admitted, recordOpened, router, staffAdmitted]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const subscription = Notifications.addNotificationResponseReceivedListener(consume);
    const received = Notifications.addNotificationReceivedListener(notification => {
      const data = notification.request.content.data;
      if (
        data?.kind === 'care_team_reply' &&
        (data.thread === 'coach' || data.thread === 'support' || data.thread === 'care_team')
      ) {
        emitChatSync(data.thread);
      }
    });
    void Notifications.getLastNotificationResponseAsync().then(response => {
      if (response) consume(response);
    }).catch(() => {});
    return () => {
      subscription.remove();
      received.remove();
    };
  }, [consume]);

  useEffect(() => {
    if (!staffAdmitted || pending.current?.route !== '/(tabs)/patients') return;
    pending.current = null;
    router.push('/(tabs)/patients' as Href);
  }, [router, staffAdmitted]);

  useEffect(() => {
    if (!admitted) return;
    const doses = pendingDoses.current;
    pendingDoses.current = [];
    for (const dose of doses) {
      if (dose.status) void logDose({ ...dose.log, status: dose.status });
    }
    if (!pending.current) return;
    const { route, notificationId, patientId } = pending.current;
    pending.current = null;
    if (account.kind !== 'real' || !patientId || patientId !== account.patientId) return;
    recordOpened(notificationId);
    router.push(route as Href);
  }, [account, admitted, logDose, recordOpened, router]);
  return null;
}

export default function RootLayout() {
  const { status, retry } = useAppFonts();

  useEffect(() => {
    // The splash stays up only during the initial load; both the ready and
    // the failure paths need the screen (failure shows the retry UI).
    if (status !== 'loading') {
      SplashScreen.hideAsync();
    }
  }, [status]);

  if (status === 'loading') return null;

  if (status !== 'ready') {
    return (
      <WebFitShell>
        <FontLoadFailureScreen retrying={status === 'retrying'} onRetry={retry} />
      </WebFitShell>
    );
  }

  // WebFitShell sits outside SafeAreaProvider so the provider (and every
  // frame consumer below it, e.g. the tab bar's compact math) measures the
  // fixed iPhone-width canvas, not the real browser frame. Native: no-op.
  return (
    <WebFitShell>
      <SafeAreaProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <KeyboardProvider>
                <AppModeProvider>
                  <OfficeRestrictionProvider>
                  <OperationsProvider>
                    <PatientAccountProvider>
                      <PatientProvider>
                       <CartProvider>
                        <BloodworkDraftLifecycle />
                        <FoodLoggingProvider>
                        <DeviceFeaturesProvider>
                         <OnboardingProvider>
                          <DeviceBiometricGate>
                          <CoachChatProvider>
                          <CareTeamChatProvider>
                            <LivePatientEntryGuard>
                              {/* Unfinished setup sends provider staff to the
                                  desktop before anything else has a say; a
                                  narrowed office is a workspace that IS set
                                  up, so that notice sits inside it. */}
                              <ProviderSignedOutGuard>
                                <OfficeAccessGuard>
                                  <StaffRestrictionGuard>
                                    <RootLayoutNav />
                                  </StaffRestrictionGuard>
                                </OfficeAccessGuard>
                              </ProviderSignedOutGuard>
                            </LivePatientEntryGuard>
                            <PushResponseBridge />
                            <PatientSyncNotice />
                          </CareTeamChatProvider>
                          </CoachChatProvider>
                          </DeviceBiometricGate>
                         </OnboardingProvider>
                        </DeviceFeaturesProvider>
                        </FoodLoggingProvider>
                       </CartProvider>
                      </PatientProvider>
                    </PatientAccountProvider>
                  </OperationsProvider>
                  </OfficeRestrictionProvider>
                </AppModeProvider>
              </KeyboardProvider>
            </GestureHandlerRootView>
          </QueryClientProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </WebFitShell>
  );
}

const gateStyles = StyleSheet.create({
  gatedNavigator: {
    flex: 1,
  },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: 9,
    padding: 24,
    alignItems: 'flex-start',
    gap: 10,
  },
  brand: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 4,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  body: {
    fontSize: 13.5,
    lineHeight: 20,
  },
  button: {
    marginTop: 8,
    minWidth: 160,
    minHeight: 44,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

function OfficeAccessState({ error, missing, retry }: {
  error: boolean;
  missing: string[];
  retry: () => void;
}) {
  const colors = useColors();
  const signOut = () => { void supabase?.auth.signOut(); };
  return (
    <View style={[gateStyles.container, { backgroundColor: colors.background }]} testID={error ? 'office-access-gate-error' : 'office-access-handoff'}>
      <View style={[gateStyles.card, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <Text style={[gateStyles.brand, { color: colors.navy }]}>THINNR</Text>
        <Text style={[gateStyles.title, { color: colors.navy }]}>
          {error ? 'We couldn’t check your office setup' : 'Finish office setup on desktop'}
        </Text>
        <Text style={[gateStyles.body, { color: colors.subtleText }]}>
          {error
            ? 'For security, the provider app stays locked until we can confirm your office payment setup. Check your connection and retry.'
            : 'Sign in to the THINNR desktop dashboard to finish these required steps:'}
        </Text>
        {!error ? missing.map((item) => (
          <Text key={item} style={[gateStyles.body, { color: colors.bodyText }]}>• {item}</Text>
        )) : null}
        <Pressable
          testID="office-access-retry"
          accessibilityRole="button"
          onPress={retry}
          style={[gateStyles.button, { backgroundColor: colors.cobalt }]}
        >
          <Text style={[gateStyles.buttonText, { color: colors.primaryForeground }]}>Refresh setup status</Text>
        </Pressable>
        <Pressable
          testID="office-access-sign-out"
          accessibilityRole="button"
          onPress={signOut}
          style={[gateStyles.button, { borderWidth: 1, borderColor: colors.border }]}
        >
          <Text style={[gateStyles.buttonText, { color: colors.navy }]}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}
