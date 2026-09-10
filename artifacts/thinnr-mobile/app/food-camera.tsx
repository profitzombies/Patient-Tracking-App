/**
 * /food-camera — the in-app capture route behind every coach food-photo
 * entry point (chat composer, diary chips, Library card, retake).
 *
 * The screen only makes sense while an entry point is awaiting a capture:
 * it claims the pending handoff request (lib/food-camera) at mount, hands
 * the surface's result back through it, and pops itself. Reached with
 * nothing pending (deep link, refresh) it redirects to the coach chat —
 * gated on the active pathname so the redirect can't hijack navigation
 * while the screen unmounts. Closing any other way (swipe back, hardware
 * back) settles null through the unmount cleanup so the caller never
 * hangs.
 *
 * Web never opens this route: entry points keep the browser photo picker,
 * so a stray visit lands on the same redirect.
 */
import React, { useEffect, useRef } from 'react';
import { Redirect, useRouter, usePathname, type Href } from 'expo-router';
import { FoodCameraSurface } from '@/components/patient/FoodCameraSurface';
import {
  claimFoodCameraRequest,
  type FoodCameraCapture,
  type FoodCameraSession,
} from '@/lib/food-camera';

export default function FoodCameraScreen() {
  const router = useRouter();
  const pathname = usePathname();

  // Claim exactly once, before the first render commits: a re-render must
  // not re-claim (the session is already gone), and the no-request case has
  // to be known synchronously so the redirect renders instead of a camera.
  const sessionRef = useRef<FoodCameraSession | null | undefined>(undefined);
  if (sessionRef.current === undefined) {
    sessionRef.current = claimFoodCameraRequest();
  }
  const session = sessionRef.current;

  // Dismissals that skip the surface's own close (swipe back, hardware
  // back) still resolve the caller — settle is idempotent, so this is a
  // no-op after a real result already went through.
  useEffect(() => {
    if (!session) return;
    return () => session.settle(null);
  }, [session]);

  if (!session) {
    if (pathname !== '/food-camera') return null;
    return <Redirect href={'/coach-history' as Href} />;
  }

  const handleSettle = (capture: FoodCameraCapture | null) => {
    session.settle(capture);
    if (router.canGoBack()) router.back();
    else router.replace('/coach-history' as Href);
  };

  return <FoodCameraSurface onSettle={handleSettle} />;
}
