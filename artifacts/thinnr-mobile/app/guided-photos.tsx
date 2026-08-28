/**
 * /guided-photos — the hands-free progress photo session route behind the
 * Progress screen's "Guided photo session" button and the check-in link.
 *
 * Same contract as /food-camera: the route only makes sense while an entry
 * point is awaiting an outcome, so it claims the pending handoff
 * (lib/guided-photos) at mount, hands the session's result back through
 * it, and pops itself. Reached with nothing pending (deep link, refresh)
 * it redirects to Progress — gated on the active pathname so the redirect
 * can't hijack navigation while the screen unmounts. Closing any other way
 * (swipe back, hardware back) settles null through the unmount cleanup so
 * the caller never hangs.
 */
import React, { useEffect, useRef } from 'react';
import { Redirect, useRouter, usePathname } from 'expo-router';
import { GuidedPhotoSession } from '@/components/patient/GuidedPhotoSession';
import {
  claimGuidedPhotoRequest,
  type GuidedPhotoHandoff,
  type GuidedSessionOutcome,
} from '@/lib/guided-photos';

export default function GuidedPhotosScreen() {
  const router = useRouter();
  const pathname = usePathname();

  // Claim exactly once, before the first render commits: a re-render must
  // not re-claim (the handoff is already gone), and the no-request case has
  // to be known synchronously so the redirect renders instead of a session.
  const handoffRef = useRef<GuidedPhotoHandoff | null | undefined>(undefined);
  if (handoffRef.current === undefined) {
    handoffRef.current = claimGuidedPhotoRequest();
  }
  const handoff = handoffRef.current;

  // Dismissals that skip the surface's own close (swipe back, hardware
  // back) still resolve the caller — settle is idempotent, so this is a
  // no-op after a real outcome already went through.
  useEffect(() => {
    if (!handoff) return;
    return () => handoff.settle(null);
  }, [handoff]);

  if (!handoff) {
    if (pathname !== '/guided-photos') return null;
    return <Redirect href="/(patient)/progress" />;
  }

  const handleSettle = (outcome: GuidedSessionOutcome | null) => {
    handoff.settle(outcome);
    if (router.canGoBack()) router.back();
    else router.replace('/(patient)/progress');
  };

  return <GuidedPhotoSession onSettle={handleSettle} />;
}
