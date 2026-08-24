/**
 * Full-screen states for the real-auth front door: booting, a failed
 * profile lookup, and the "patients live in the mobile app" notice. All
 * keep the Heritage look of the sign-in screen.
 */
import { AlertTriangle, LogOut, RefreshCw, Smartphone } from 'lucide-react';
import { useSession } from '@/contexts/session';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background font-sans text-foreground">
      <main className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center px-5 py-10">
        {children}
      </main>
      <footer className="border-t border-border bg-sidebar px-5 py-2 text-center">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Synthetic Demo Data • Not Medical Advice
        </p>
      </footer>
    </div>
  );
}

export function BootScreen() {
  return (
    <Frame>
      <div className="text-center" data-testid="screen-auth-loading">
        <span className="mx-auto grid h-12 w-12 animate-pulse place-items-center rounded-md bg-navy text-brand-foreground shadow-soft">
          <span className="text-sm font-bold tracking-[.04em]">TH</span>
        </span>
        <p className="mt-4 text-sm text-muted-foreground">Checking your session…</p>
      </div>
    </Frame>
  );
}

export function ProfileErrorScreen() {
  const { retryRoleFetch, signOut, authUser } = useSession();
  return (
    <Frame>
      <section
        className="rounded-lg border border-card-border bg-card p-6 text-center shadow-soft"
        data-testid="screen-auth-error"
      >
        <span className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-destructive/10 text-destructive" aria-hidden="true">
          <AlertTriangle size={20} />
        </span>
        <h1 className="mt-4 font-serif text-xl font-bold tracking-[-.01em] text-navy">
          We couldn’t load your workspace
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {authUser?.email ?? authUser?.phone ?? 'Your account'} signed in, but the profile lookup
          failed. Retry, or sign out and browse the demo instead.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={retryRoleFetch}
            data-testid="button-retry-profile"
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-primary-border bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-xs transition hover:bg-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <RefreshCw size={15} aria-hidden="true" />
            Try again
          </button>
          <button
            type="button"
            onClick={signOut}
            data-testid="button-signout-error"
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-semibold text-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <LogOut size={15} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </section>
    </Frame>
  );
}

export function PatientOnWebNotice() {
  const { signOut, authUser } = useSession();
  return (
    <Frame>
      <section
        className="rounded-lg border border-card-border bg-card p-6 text-center shadow-soft"
        data-testid="screen-patient-web"
      >
        <span className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
          <Smartphone size={20} />
        </span>
        <h1 className="mt-4 font-serif text-xl font-bold tracking-[-.01em] text-navy">
          You’re signed in as a patient
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {authUser?.email ?? authUser?.phone ?? 'This account'} is a patient account. The THINNR
          patient experience — coach, diary, and progress — lives in the mobile app. This portal is
          for offices and THINNR HQ.
        </p>
        <button
          type="button"
          onClick={signOut}
          data-testid="button-signout-patient"
          className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-semibold text-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <LogOut size={15} aria-hidden="true" />
          Sign out
        </button>
      </section>
    </Frame>
  );
}
