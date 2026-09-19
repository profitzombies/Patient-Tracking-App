/**
 * Legal hold controls (HQ) and the read-only badge (office).
 *
 * A hold outranks every retention timer and the patient's own deletion
 * request: while it is active nothing about the patient, or about any
 * patient of a held office, is deleted. Only HQ Admins place or lift one and
 * both actions need a written reason (each is audited separately). An office
 * sees the badge on a held patient's page and nothing else; the patient app
 * never learns a hold exists.
 *
 *   <LegalHoldBadge />                    small chip, office + HQ
 *   <LegalHoldControls target… />         HQ: state + place / lift with reason
 *   <LegalHoldReasonForm …/>              the shared inline reason form
 */
import { useId, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Scale } from 'lucide-react';
import {
  getGetHqLegalHoldsQueryKey,
  useGetHqLegalHolds,
  useLiftHqLegalHold,
  usePlaceHqLegalHold,
  type HqLegalHold,
  type HqLegalHoldTargetKind,
} from '@workspace/api-client-react';
import { useSession } from '@/contexts/session';
import { useToast } from '@/hooks/use-toast';
import { BTN_PRIMARY, BTN_SECONDARY } from '@/components/patient/heritage';

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export function LegalHoldBadge({ scope, testId = 'chip-legal-hold' }: { scope?: 'office'; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1.5 rounded-sm border border-[#b9c4dc] bg-[#eef2fb] px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] text-navy"
    >
      <Scale size={10} aria-hidden="true" />
      {scope === 'office' ? 'Office on legal hold' : 'Legal hold'}
    </span>
  );
}

export const holdWhen = (value: string | null | undefined) => (value ? format(new Date(value), 'MMM d, yyyy HH:mm') : '—');

export function useCanManageLegalHolds(): { canView: boolean; canManage: boolean } {
  const { authStatus, hqRole } = useSession();
  const canView = authStatus === 'signed-in' && (hqRole === 'Super Admin' || hqRole === 'Admin');
  return { canView, canManage: canView };
}

interface ReasonFormProps {
  intent: 'place' | 'lift';
  what: string;
  pending: boolean;
  error: string | null;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
  testIdPrefix: string;
}

export function LegalHoldReasonForm({ intent, what, pending, error, onSubmit, onCancel, testIdPrefix }: ReasonFormProps) {
  const [reason, setReason] = useState('');
  const inputId = useId();
  const trimmed = reason.trim();
  const tooShort = trimmed.length < REASON_MIN;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (tooShort || pending) return;
    onSubmit(trimmed);
  };
  return (
    <form onSubmit={submit} className="rounded-md border border-[#b9c4dc] bg-[#eef2fb]/60 p-3" data-testid={`${testIdPrefix}-form`}>
      <label htmlFor={inputId} className="block text-[11px] font-semibold text-navy">
        {intent === 'place' ? `Why is ${what} being placed on legal hold?` : `Why is the hold on ${what} being lifted?`}
      </label>
      <textarea
        id={inputId}
        value={reason}
        onChange={(event) => setReason(event.target.value.slice(0, REASON_MAX))}
        rows={2}
        required
        minLength={REASON_MIN}
        maxLength={REASON_MAX}
        placeholder={intent === 'place' ? 'e.g. Litigation hold — Doe v. Northside, counsel request 9/19' : 'e.g. Matter closed, counsel released the hold'}
        data-testid={`${testIdPrefix}-reason`}
        className="mt-1.5 w-full rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
      />
      <p className="mt-1 text-[10px] text-muted-foreground">
        {intent === 'place'
          ? 'While the hold is active nothing about this record is deleted, whatever the retention settings or a deletion request say. Staff can still correct data; corrections stay audited.'
          : 'Any deletion request parked by this hold resumes the remainder of its grace period.'}
      </p>
      {error && <p role="alert" className="mt-1.5 text-[11px] text-destructive" data-testid={`${testIdPrefix}-error`}>{error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={tooShort || pending} className={`${BTN_PRIMARY} h-8 px-3 text-[11px] disabled:opacity-50`} data-testid={`${testIdPrefix}-submit`}>
          {pending ? (intent === 'place' ? 'Placing…' : 'Lifting…') : intent === 'place' ? 'Place hold' : 'Lift hold'}
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`} data-testid={`${testIdPrefix}-cancel`}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  return (err as { data?: { error?: string } })?.data?.error ?? fallback;
}

interface ControlsProps {
  targetKind: HqLegalHoldTargetKind;
  targetId: string;
  /** The office the target belongs to (the office itself for a provider hold). */
  providerId: string | null;
  /** Display name used in the reason prompt. */
  label: string;
}

/**
 * HQ hold state for one patient or office plus the place / lift actions.
 * For a patient, an active office-wide hold is shown read-only: it must be
 * lifted from the office account page, not from a single patient.
 */
export function LegalHoldControls({ targetKind, targetId, providerId, label }: ControlsProps) {
  const { canView, canManage } = useCanManageLegalHolds();
  const { authUser, hqRole } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<'place' | 'lift' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = { status: 'active' as const, ...(providerId ? { providerId } : {}) };
  const query = useGetHqLegalHolds(params, {
    query: {
      enabled: canView,
      queryKey: [...getGetHqLegalHoldsQueryKey(params), authUser?.id, hqRole],
    },
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetHqLegalHoldsQueryKey() });
  const place = usePlaceHqLegalHold({
    mutation: {
      onSuccess: async () => {
        setOpen(null);
        setError(null);
        toast({ title: 'Legal hold placed', description: `${label} is on hold. Nothing about it will be deleted until the hold is lifted.` });
        await invalidate();
      },
      onError: (err) => setError(apiErrorMessage(err, 'The hold could not be placed.')),
    },
  });
  const lift = useLiftHqLegalHold({
    mutation: {
      onSuccess: async () => {
        setOpen(null);
        setError(null);
        toast({ title: 'Legal hold lifted', description: `${label} is no longer on hold. Retention timers apply again.` });
        await invalidate();
      },
      onError: (err) => setError(apiErrorMessage(err, 'The hold could not be lifted.')),
    },
  });

  if (!canView) return null;
  const holds: HqLegalHold[] = query.data?.holds ?? [];
  const own = holds.find((hold) => hold.targetKind === targetKind && hold.targetId === targetId && hold.active) ?? null;
  const office = targetKind === 'patient' && providerId
    ? holds.find((hold) => hold.targetKind === 'provider' && hold.targetId === providerId && hold.active) ?? null
    : null;
  const pending = place.isPending || lift.isPending;
  const prefix = `legal-hold-${targetKind}`;

  return (
    <div className="flex flex-col gap-2" data-testid={`${prefix}-controls`}>
      <div className="flex flex-wrap items-center gap-2">
        {query.isError && (
          <span role="alert" className="text-[11px] text-destructive" data-testid={`${prefix}-load-error`}>
            {apiErrorMessage(query.error, 'Legal hold status could not be loaded.')}
          </span>
        )}
        {own && (
          <span className="flex flex-wrap items-center gap-2" data-testid={`${prefix}-active`}>
            <LegalHoldBadge testId={`${prefix}-badge`} />
            <span className="text-[11px] text-muted-foreground">
              Since {holdWhen(own.placedAt)}{own.placedByName ? ` by ${own.placedByName}` : ''} · {own.reason}
            </span>
          </span>
        )}
        {office && (
          <span className="flex flex-wrap items-center gap-2" data-testid={`${prefix}-office-active`}>
            <LegalHoldBadge scope="office" testId={`${prefix}-office-badge`} />
            <span className="text-[11px] text-muted-foreground">Lift it from the office account page.</span>
          </span>
        )}
        {canManage && !query.isError && query.data && !open && (
          own ? (
            <button type="button" onClick={() => { setError(null); setOpen('lift'); }} className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`} data-testid={`${prefix}-lift`}>
              Lift legal hold
            </button>
          ) : (
            <button type="button" onClick={() => { setError(null); setOpen('place'); }} className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`} data-testid={`${prefix}-place`}>
              <Scale size={12} aria-hidden="true" />
              Place legal hold
            </button>
          )
        )}
      </div>
      {open === 'place' && (
        <LegalHoldReasonForm
          intent="place"
          what={label}
          pending={pending}
          error={error}
          testIdPrefix={`${prefix}-place`}
          onCancel={() => { setOpen(null); setError(null); }}
          onSubmit={(reason) => place.mutate({ data: { targetKind, targetId, reason } })}
        />
      )}
      {open === 'lift' && own && (
        <LegalHoldReasonForm
          intent="lift"
          what={label}
          pending={pending}
          error={error}
          testIdPrefix={`${prefix}-lift`}
          onCancel={() => { setOpen(null); setError(null); }}
          onSubmit={(reason) => lift.mutate({ id: own.id, data: { reason } })}
        />
      )}
    </div>
  );
}
