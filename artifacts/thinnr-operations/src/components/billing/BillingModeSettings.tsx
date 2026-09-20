import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hqBilling } from '@/lib/billing-api';
import { useSession } from '@/contexts/session';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, SectionCard } from '@/components/patient/heritage';
import type { BillingModeStatus } from '@/lib/billing-types';

export function BillingModeSettingsView({ status, canManage, busy, error, onSwitch }: {
  status: BillingModeStatus; canManage: boolean; busy: boolean; error?: string;
  onSwitch: (mode: 'test' | 'live', version: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const target = status.mode === 'test' ? 'live' : 'test';
  const setupReady = status.setup?.ready !== false && status.selection_loaded !== false && status.version !== null;
  const ready = setupReady && status.configuration[target].configured;
  return (
    <SectionCard title="Stripe payment mode" sub="Test is the safe default. Mode changes apply program-wide.">
      <div className="space-y-3 p-5">
        <p className="font-semibold" role="status" data-testid="billing-mode-current">
          {!setupReady ? 'Test is the safe default — payment setup incomplete' : status.mode === 'test' ? 'Test mode — no real charges' : 'Live mode — real money'}
        </p>
        {!setupReady && <div role="alert" className="space-y-1 text-sm">
          <p>{status.setup?.message ?? 'The saved payment mode could not be loaded. Payments and mode switching remain unavailable.'}</p>
          {status.setup?.missing.length ? <p>Required setup: {status.setup.missing.join(', ')}</p> : null}
          <p>No saved mode is being assumed and no payment configuration has been changed.</p>
        </div>}
        {!status.configuration[status.mode].configured && <p role="alert">Payments are unavailable: the selected mode is not configured.</p>}
        {(['test', 'live'] as const).map((mode) => <div key={mode} className="text-sm">
          <strong>{mode === 'test' ? 'Test' : 'Live'} configuration:</strong>{' '}
          {status.configuration[mode].configured ? 'Ready' : 'Not ready'}
          {!status.configuration[mode].configured && <p className="text-muted-foreground">
            {status.configuration[mode].missing.length ? `Required environment settings: ${status.configuration[mode].missing.join(', ')}.` : 'Check the environment configuration.'}
            {status.configuration[mode].errors?.join(' ')}
          </p>}
        </div>)}
        <p className="text-sm text-muted-foreground">Keys are configured on the server, never entered here. There is no automatic fallback between Test and Live.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!canManage ? <p className="text-sm">Only HQ administrators with settings access may change payment mode.</p> : <>
          <button type="button" className={`${BTN_SECONDARY} px-4 py-2`} disabled={busy || !ready}
            onClick={() => { setConfirming(true); setConfirmation(''); }}>
            Switch to {target === 'live' ? 'Live' : 'Test'}
          </button>
          {!ready && <p className="text-sm">{!setupReady ? 'Complete deployment and database setup before switching.' : `Configure ${target === 'live' ? 'Live' : 'Test'} before switching.`}</p>}
          {confirming && <div className="space-y-3 rounded-md border border-border p-4" role="group" aria-label="Confirm payment mode change">
            <p>{target === 'live' ? 'Live payments charge real cards. Type LIVE to confirm.' : 'Switch to Test? New payments will not charge real money.'}</p>
            {target === 'live' && <label className="block text-sm">Confirmation
              <input className={`${INPUT_CLASS} mt-1 block w-full`} value={confirmation} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} />
            </label>}
            <button type="button" className={`${BTN_PRIMARY} px-4 py-2`} disabled={busy || !ready || (target === 'live' && confirmation !== 'LIVE')}
              onClick={() => { if (!ready || status.version === null) return; onSwitch(target, status.version); setConfirming(false); setConfirmation(''); }}>
              {busy ? 'Switching…' : `Confirm ${target === 'live' ? 'Live' : 'Test'}`}
            </button>{' '}
            <button type="button" className={`${BTN_SECONDARY} px-4 py-2`} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </div>}
        </>}
      </div>
    </SectionCard>
  );
}

export function BillingModeSettings() {
  const { hqRole } = useSession();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['billing-mode'], queryFn: hqBilling.mode, staleTime: 0, refetchInterval: 30_000 });
  const mutation = useMutation({
    mutationFn: hqBilling.switchMode,
    onSuccess: async () => { await client.invalidateQueries(); },
    onError: () => { void query.refetch(); },
  });
  if (query.isPending) return <p role="status">Loading payment mode…</p>;
  if (query.isError || !query.data) return <p role="alert">Payment mode is unavailable. <button type="button" onClick={() => void query.refetch()}>Try again</button></p>;
  return <BillingModeSettingsView key={`${query.data.mode}:${query.data.version}`} status={query.data}
    canManage={hqRole === 'Super Admin' || hqRole === 'Admin'} busy={mutation.isPending}
    error={mutation.error?.message}
    onSwitch={(mode, version) => mutation.mutate({ mode, expected_version: version, confirm_live: mode === 'live' })} />;
}