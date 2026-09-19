import { useEffect, useState } from 'react';
import { useSession } from '@/contexts/session';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const ANNOUNCEMENT_SECONDS = new Set([60, 30, 10, 5]);

export function IdleTimeoutDialog() {
  const { idleState, secondsLeft, dismissIdleWarning, signOut } = useSession();
  const [announcedSeconds, setAnnouncedSeconds] = useState(secondsLeft);

  useEffect(() => {
    if (idleState === 'warning' && ANNOUNCEMENT_SECONDS.has(secondsLeft)) {
      setAnnouncedSeconds(secondsLeft);
    }
  }, [idleState, secondsLeft]);

  if (idleState !== 'warning') return null;

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Still there?</AlertDialogTitle>
          <AlertDialogDescription>
            You’ll be signed out for security in {secondsLeft} seconds.
          </AlertDialogDescription>
          <span className="sr-only" aria-live="assertive" aria-atomic="true">
            {announcedSeconds} seconds until sign out.
          </span>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="button-idle-sign-out"
            onClick={signOut}
          >
            Sign out now
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="button-idle-stay"
            onClick={dismissIdleWarning}
          >
            I’m still here
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}