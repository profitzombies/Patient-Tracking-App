/**
 * HQ → Audit log → Legal holds.
 *
 * Every hold across the network: who placed it, when, why, and (for lifted
 * ones) who lifted it and why. Lifting from here is the same second, audited
 * action as lifting from the office or patient page — it needs a reason.
 * Active holds are the default view because they are the ones that change
 * what the clean-up jobs may touch tonight.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Scale } from 'lucide-react';
import {
  getGetHqLegalHoldsQueryKey,
  useGetHqLegalHolds,
  useLiftHqLegalHold,
  type GetHqLegalHoldsStatus,
  type HqLegalHold,
} from '@workspace/api-client-react';
import { useSession } from '@/contexts/session';
import { useHqData } from '@/contexts/hq-data';
import { MetricTile, PageHeader } from '@/components/admin/primitives';
import { BTN_SECONDARY } from '@/components/patient/heritage';
import { LegalHoldBadge, LegalHoldReasonForm, apiErrorMessage, holdWhen, useCanManageLegalHolds } from '@/components/admin/LegalHold';
import { useToast } from '@/hooks/use-toast';

const STATUS_OPTIONS: { value: GetHqLegalHoldsStatus; label: string }[] = [
  { value: 'active', label: 'Active holds' },
  { value: 'lifted', label: 'Lifted holds' },
  { value: 'all', label: 'All holds' },
];

function targetLabel(hold: HqLegalHold, officeName: string | undefined): { kind: string; name: string } {
  if (hold.targetKind === 'provider') return { kind: 'Whole office', name: officeName ?? hold.targetLabel ?? hold.targetId };
  return { kind: 'Patient', name: hold.targetLabel ?? 'Patient' };
}

export default function LegalHolds() {
  const { authStatus, authUser, hqRole } = useSession();
  const { findAccount } = useHqData();
  const { canView, canManage } = useCanManageLegalHolds();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<GetHqLegalHoldsStatus>('active');
  const [lifting, setLifting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = { status, limit: 500 };

  const { data, isLoading, isError, error: loadError } = useGetHqLegalHolds(params, {
    query: {
      enabled: canView,
      queryKey: [...getGetHqLegalHoldsQueryKey(params), authUser?.id, hqRole],
      refetchInterval: 60_000,
    },
  });
  const lift = useLiftHqLegalHold({
    mutation: {
      onSuccess: async (result) => {
        setLifting(null);
        setError(null);
        toast({ title: 'Legal hold lifted', description: `${result.hold.targetLabel ?? 'The record'} is no longer on hold.` });
        await queryClient.invalidateQueries({ queryKey: getGetHqLegalHoldsQueryKey() });
      },
      onError: (err) => setError(apiErrorMessage(err, 'The hold could not be lifted.')),
    },
  });

  const holds = data?.holds ?? [];
  const officeCount = holds.filter((hold) => hold.active && hold.targetKind === 'provider').length;
  const patientCount = holds.filter((hold) => hold.active && hold.targetKind === 'patient').length;

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <Link href="/admin/audit" data-testid="link-back-to-audit" className="mb-4 inline-flex items-center rounded-sm text-xs font-semibold text-muted-foreground hover:text-navy">
        <ChevronLeft size={14} className="mr-1" aria-hidden="true" />Audit log
      </Link>
      <PageHeader
        kicker="System Log"
        title="Legal holds"
        sub="Patients and offices whose records may not be deleted — because of litigation, a regulator, or counsel. While a hold is active every clean-up job and every deletion request leaves the record alone. Placing and lifting are both audited."
      />

      {!canView ? (
        <p className="mt-6 rounded-md border border-border bg-secondary px-4 py-3 text-xs text-muted-foreground" data-testid="text-legal-holds-demo-note">
          {authStatus !== 'signed-in'
            ? 'The guided demo has no legal holds. Sign in with an HQ Admin account to review real holds.'
            : 'Your HQ role cannot review legal holds.'}
        </p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="legal-holds-summary">
            <MetricTile label="Active holds" value={data ? String(data.activeCount) : '—'} detail={data && data.activeCount > 0 ? 'Deletion blocked' : 'Nothing on hold'} testId="metric-legal-holds-active" />
            <MetricTile label="Whole offices" value={data && status === 'active' ? String(officeCount) : '—'} detail="Every patient of the office" />
            <MetricTile label="Single patients" value={data && status === 'active' ? String(patientCount) : '—'} detail="Held individually" />
          </div>

          <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
            <div className="flex items-center justify-between gap-4 border-b border-border bg-paper-alt p-4">
              <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                Show
                <select
                  data-testid="select-legal-hold-status"
                  value={status}
                  onChange={(e) => { setStatus(e.target.value as GetHqLegalHoldsStatus); setLifting(null); setError(null); }}
                  className="h-9 rounded-md border border-border bg-card px-3 text-xs font-normal text-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] text-muted-foreground">Place a hold from an office account page or a patient's record in the office drill-in.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-xs">
                <thead className="border-b border-border bg-secondary text-[10px] uppercase tracking-[.11em] text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Placed</th>
                    <th className="px-4 py-3 font-semibold">Held record</th>
                    <th className="px-4 py-3 font-semibold">Office</th>
                    <th className="px-4 py-3 font-semibold">Reason</th>
                    <th className="px-4 py-3 font-semibold">Placed by</th>
                    <th className="px-4 py-3 font-semibold">Lifted</th>
                    <th className="px-4 py-3 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">Loading legal holds…</td></tr>
                  )}
                  {isError && (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-destructive" role="alert">{apiErrorMessage(loadError, 'Legal holds could not be loaded.')}</td></tr>
                  )}
                  {!isLoading && !isError && holds.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground" data-testid="text-legal-holds-empty">No {status === 'all' ? '' : `${status} `}legal holds.</td></tr>
                  )}
                  {!isLoading && !isError && holds.map((hold) => {
                    const account = hold.providerId ? findAccount(hold.providerId) : undefined;
                    const target = targetLabel(hold, account?.officeName);
                    const recordHref = hold.targetKind === 'provider'
                      ? `/admin/accounts/${hold.targetId}`
                      : hold.providerId ? `/admin/accounts/${hold.providerId}/office/patients/${hold.targetId}` : null;
                    return (
                      <tr key={hold.id} data-testid={`row-legal-hold-${hold.id}`} className="border-b border-border align-top last:border-0">
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{holdWhen(hold.placedAt)}</td>
                        <td className="px-4 py-3">
                          <span className="flex flex-wrap items-center gap-2">
                            {hold.active && <LegalHoldBadge scope={hold.targetKind === 'provider' ? 'office' : undefined} testId={`chip-legal-hold-${hold.id}`} />}
                            {recordHref ? (
                              <Link href={recordHref} className="font-semibold text-navy hover:underline" data-testid={`link-legal-hold-target-${hold.id}`}>{target.name}</Link>
                            ) : (
                              <span className="font-semibold text-navy">{target.name}</span>
                            )}
                          </span>
                          <span className="mt-0.5 block text-[10px] text-muted-foreground">{target.kind} · <span className="font-mono">{hold.targetId}</span></span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="block text-foreground">{account?.officeName ?? (hold.providerId ? 'Provider' : 'No office')}</span>
                          {hold.providerId && <span className="block font-mono text-[10px] text-muted-foreground">{hold.providerId}</span>}
                        </td>
                        <td className="max-w-[320px] px-4 py-3 text-foreground" data-testid={`text-legal-hold-reason-${hold.id}`}>{hold.reason}</td>
                        <td className="px-4 py-3 text-foreground">{hold.placedByName ?? 'HQ staff'}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {hold.liftedAt ? (
                            <>
                              <span className="block">{holdWhen(hold.liftedAt)} by {hold.liftedByName ?? 'HQ staff'}</span>
                              {hold.liftReason && <span className="block text-[10px]">{hold.liftReason}</span>}
                            </>
                          ) : 'Still active'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {hold.active && canManage && lifting !== hold.id && (
                            <button
                              type="button"
                              data-testid={`button-lift-legal-hold-${hold.id}`}
                              disabled={lift.isPending}
                              onClick={() => { setError(null); setLifting(hold.id); }}
                              className={`${BTN_SECONDARY} h-8 whitespace-nowrap px-3 text-[11px]`}
                            >
                              <Scale size={12} aria-hidden="true" />Lift hold
                            </button>
                          )}
                          {lifting === hold.id && (
                            <div className="min-w-[280px] text-left">
                              <LegalHoldReasonForm
                                intent="lift"
                                what={target.name}
                                pending={lift.isPending}
                                error={error}
                                testIdPrefix={`legal-hold-list-lift-${hold.id}`}
                                onCancel={() => { setLifting(null); setError(null); }}
                                onSubmit={(reason) => lift.mutate({ id: hold.id, data: { reason } })}
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
