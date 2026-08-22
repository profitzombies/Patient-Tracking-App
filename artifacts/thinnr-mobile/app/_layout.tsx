import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import {
  PlayfairDisplay_600SemiBold,
  PlayfairDisplay_700Bold,
} from '@expo-google-fonts/playfair-display';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { AppModeProvider } from '@/context/AppModeContext';
import { OnboardingProvider } from '@/context/OnboardingContext';
import { OperationsProvider } from '@/context/OperationsContext';
import { PatientProvider } from '@/context/PatientContext';

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

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
      <Stack.Screen name="log-food" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="check-in" options={{ headerShown: false, presentation: 'modal' }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    // Editorial serif for the patient home hero — mirrors the web app's
    // Cobalt Ledger display face (Playfair Display).
    PlayfairDisplay_600SemiBold,
    PlayfairDisplay_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

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
                      <RootLayoutNav />
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
