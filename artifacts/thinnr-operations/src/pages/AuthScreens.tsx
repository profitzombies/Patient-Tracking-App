/**
 * Full-screen states for the real-auth front door: booting, a failed
 * profile lookup, and the "patients live in the mobile app" notice. All
 * keep the Heritage look of the sign-in screen.
 */
import { AlertTriangle, BadgeCheck, Lock, LogOut, RefreshCw, Smartphone } from 'lucide-react';
import { useSession } from '@/contexts/session';
import { findSeededAccount } from '@/data/hq/accounts';

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

/**
 * Shown instead of the office workspace while THINNR has the staffer's
 * provider account locked. The lock lives in Supabase, so this appears on a
 * fresh sign-in in any browser and mid-session via the lock poll/realtime
 * refresh — and clears itself the moment HQ unlocks the account.
 */
export function AccountLockedScreen() {
  const { signOut, providerAccountCode } = useSession();
  const office = providerAccountCode ? findSeededAccount(providerAccountCode) : undefined;
  return (
    <Frame>
      <section
        className="rounded-lg border border-card-border bg-card p-6 text-center shadow-soft"
        data-testid="screen-account-locked"
      >
        <span className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-destructive/10 text-destructive" aria-hidden="true">
          <Lock size={20} />
        </span>
        <h1 className="mt-4 font-serif text-xl font-bold tracking-[-.01em] text-navy">
          This account is locked
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          THINNR has paused {office?.officeName ?? 'your office'}&rsquo;s access to the operations
          portal, so staff sign-ins are temporarily out of service. Contact THINNR to restore
          access — nothing has been deleted, and everything returns the moment the account is
          unlocked.
        </p>
        <button
          type="button"
          onClick={signOut}
          data-testid="button-signout-locked"
          className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-semibold text-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <LogOut size={15} aria-hidden="true" />
          Sign out
        </button>
      </section>
    </Frame>
  );
}

/**
 * Landing for a claimed provider or office staffer. Their login is real and
 * verified against the migrated THINNR rolls, but claimed accounts see live
 * program data through their own scoped views as those tools roll out — the
 * demo workspaces stay reserved for the guided walkthrough personas.
 */
export function ClaimedWorkspaceScreen() {
  const { signOut, claimedWorkspace, authUser } = useSession();
  const firstName = (claimedWorkspace?.name ?? '').trim().split(/\s+/)[0] || null;
  return (
    <Frame>
      <section
        className="rounded-lg border border-card-border bg-card p-6 text-center shadow-soft"
        data-testid="screen-claimed-workspace"
      >
        <span className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
          <BadgeCheck size={20} />
        </span>
        <h1 className="mt-4 font-serif text-xl font-bold tracking-[-.01em] text-navy">
          {firstName ? `Welcome back, ${firstName}` : 'Your account is claimed'}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground" data-testid="text-claimed-detail">
          {claimedWorkspace?.name ?? authUser?.email ?? 'Your account'} is verified
          {claimedWorkspace?.officeName ? (
            <>
              {' '}with <span className="font-semibold text-foreground">{claimedWorkspace.officeName}</span>
            </>
          ) : null}
          {claimedWorkspace?.kind === 'provider' ? ' as the provider on file' : ''}. Your login and
          password are set — the office workspace for claimed accounts opens here as THINNR rolls
          it out, and this same sign-in will take you straight in.
        </p>
        <button
          type="button"
          onClick={signOut}
          data-testid="button-signout-claimed"
          className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-semibold text-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <LogOut size={15} aria-hidden="true" />
          Sign out
        </button>
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
