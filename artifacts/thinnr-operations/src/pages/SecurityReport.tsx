import { useState } from 'react';
import { Link, useSearch } from 'wouter';
import { submitSecurityReport } from '@/lib/office-api';
import { BTN_PRIMARY, LINK_ACTION } from '@/components/patient/heritage';

/**
 * "This wasn't me" landing for the link in a new-sign-in email. Nothing
 * happens on open: link scanners and stray clicks must not sign a teammate
 * out of every device, so the report fires only on the explicit button.
 */
export default function SecurityReport() {
  const search = useSearch();
  const token = new URLSearchParams(search).get('token') ?? '';
  const [state, setState] = useState<{ phase: 'ready' | 'busy' | 'done'; error: string | null; forcedReset: boolean }>({
    phase: token ? 'ready' : 'done',
    error: token ? null : 'This security link is missing its token.',
    forcedReset: false,
  });
  const confirm = async () => {
    if (!token || state.phase === 'busy') return;
    setState({ phase: 'busy', error: null, forcedReset: false });
    try {
      const result = await submitSecurityReport(token);
      setState({ phase: 'done', error: null, forcedReset: result.forcedReset });
    } catch (error) {
      setState({ phase: 'done', error: error instanceof Error ? error.message : 'This security link could not be used.', forcedReset: false });
    }
  };
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background px-5">
      <section className="w-full max-w-lg rounded-lg border border-border bg-card p-7 shadow-soft">
        <p className="text-[10px] font-bold uppercase tracking-[.14em] text-primary">Account security</p>
        <h1 className="mt-2 font-serif text-2xl font-bold text-navy">Was that you?</h1>
        {state.phase !== 'done' ? (
          <>
            <p className="mt-4 text-sm text-muted-foreground">
              If you don't recognize the sign-in from the email, confirm below and every device on that account will be signed out.
            </p>
            <button type="button" className={`mt-6 ${BTN_PRIMARY}`} data-testid="button-security-report-confirm" onClick={() => void confirm()} disabled={state.phase === 'busy'}>
              {state.phase === 'busy' ? 'Securing the account…' : "This wasn't me, sign out everywhere"}
            </button>
          </>
        ) : state.error ? (
          <p className="mt-4 text-sm text-destructive" role="alert">{state.error}</p>
        ) : (
          <p className="mt-4 text-sm text-foreground" data-testid="security-report-success">
            {state.forcedReset
              ? 'Every session on that account has been signed out. A new password is required at the next sign-in.'
              : 'Every session on that account has been signed out.'}
          </p>
        )}
        {state.phase === 'done' ? <Link href="/" className={`mt-6 ${LINK_ACTION}`}>Sign in</Link> : null}
      </section>
    </main>
  );
}
