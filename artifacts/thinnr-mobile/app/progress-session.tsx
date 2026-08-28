/**
 * /progress-session — the hands-free guided progress-photo flow.
 *
 * Patient-only, like the check-in: any other persona (or a stray deep
 * link before the persona gate) is redirected home, gated on the active
 * pathname so the redirect can't hijack navigation while this screen is
 * tearing down. The surface is fully self-contained — captures, review,
 * upload, save — so the route just hosts it and pops itself when done.
 */
import React from 'react';
import { Redirect, usePathname, useRouter } from 'expo-router';
import { useAppMode } from '@/context/AppModeContext';
import { GuidedSessionSurface } from '@/components/patient/GuidedSessionSurface';

export default function ProgressSessionScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const { mode, hydrated } = useAppMode();

  // Patient-only route: deep links must not bypass the persona flow. The
  // pathname gate keeps the redirect from hijacking in-flight navigation
  // while this screen tears down.
  if (!hydrated) return null;
  if (mode !== 'patient') {
    if (pathname !== '/progress-session') return null;
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const handleDone = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(patient)/progress');
  };

  return <GuidedSessionSurface onDone={handleDone} />;
}
