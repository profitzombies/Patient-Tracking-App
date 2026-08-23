import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
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
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColors } from '@/hooks/useColors';
import { AppModeProvider } from '@/context/AppModeContext';
import { CoachChatProvider } from '@/context/CoachChatContext';
import { OnboardingProvider } from '@/context/OnboardingContext';
import { OperationsProvider } from '@/context/OperationsContext';
import { PatientProvider } from '@/context/PatientContext';

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

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
    try {
      for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt += 1) {
        try {
          // Already-loaded families resolve immediately inside loadAsync, so
          // retries only re-fetch what actually failed.
          await loadFontsWithTimeout();
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
      <Stack.Screen name="persona" options={{ headerShown: false }} />
      <Stack.Screen name="patient-entry" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false }} />
      <Stack.Screen name="recipe/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="ai-recipe/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="approved-foods" options={{ headerShown: false }} />
      <Stack.Screen name="restaurant-guide" options={{ headerShown: false }} />
      <Stack.Screen name="instructions" options={{ headerShown: false }} />
      <Stack.Screen name="phase/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="create-food" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="log-food" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="check-in" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="coach-chat" options={{ headerShown: false }} />
    </Stack>
  );
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
      <FontLoadFailureScreen retrying={status === 'retrying'} onRetry={retry} />
    );
  }

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <AppModeProvider>
                <OperationsProvider>
                  <PatientProvider>
                    <OnboardingProvider>
                      <CoachChatProvider>
                        <RootLayoutNav />
                      </CoachChatProvider>
                    </OnboardingProvider>
                  </PatientProvider>
                </OperationsProvider>
              </AppModeProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const gateStyles = StyleSheet.create({
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
