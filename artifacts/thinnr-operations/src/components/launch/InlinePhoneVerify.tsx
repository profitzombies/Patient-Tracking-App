import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS } from '@/components/patient/heritage';
import { completeMySecondFactorPhone, startMySecondFactorPhone } from '@/lib/office-api';
import { formatUsPhone, isValidUsPhone, normalizeUsPhone } from '@/lib/us-contact';
import { useToast } from '@/hooks/use-toast';

/**
 * Practice setup's in-place sign-in phone check. Uses the same second-factor
 * start/complete calls as the Security settings page, then refreshes the
 * setup status so the step can fold.
 */
export function InlinePhoneVerify({ emailVerified, canVerify, onVerified }: {
  emailVerified: boolean;
  /** False for HQ inspection: the screen stays read-only. */
  canVerify: boolean;
  /** Called just before setup status is refreshed. */
  onVerified: () => void;
}) {
  const { toast } = useToast();
  const client = useQueryClient();
  const [phone, setPhone] = useState('');
  const [request, setRequest] = useState<{ requestId: string; destination: string; devCode: string | null } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => startMySecondFactorPhone(`+1${normalizeUsPhone(phone)}`),
    onSuccess: (result) => {
      setRequest({ requestId: result.requestId, destination: result.destination, devCode: result.devCode ?? null });
      setCode('');
      setError(null);
    },
    onError: (failure) => setError(failure instanceof Error ? failure.message : 'Could not send a text.'),
  });
  const complete = useMutation({
    mutationFn: () => completeMySecondFactorPhone(request!.requestId, code),
    onSuccess: async () => {
      setPhone('');
      setCode('');
      setRequest(null);
      setError(null);
      toast({ variant: 'success', title: 'Sign-in phone verified' });
      onVerified();
      await Promise.all([
        client.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'office' && query.queryKey[1] === 'launch' }),
        client.invalidateQueries({ queryKey: ['account-security'] }),
      ]);
    },
    onError: (failure) => setError(failure instanceof Error ? failure.message : 'That code did not work.'),
  });

  return <div className="space-y-4 p-5 text-sm">
    {emailVerified && <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Check size={14} className="text-primary" aria-hidden="true" />Email verified at sign-in
    </p>}
    <p>Your role requires a texted code after your emailed sign-in code. Add your mobile number and enter the code we text you.</p>
    {!canVerify ? (
      <p className="text-muted-foreground">Only the signed-in staff member can verify their own phone.</p>
    ) : (
      <div className="max-w-md space-y-3">
        {!request ? (
          <form className="flex flex-wrap items-center gap-3" onSubmit={(event) => {
            event.preventDefault();
            if (isValidUsPhone(phone) && !start.isPending) start.mutate();
          }}>
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(formatUsPhone(event.target.value))}
              autoComplete="tel-national"
              maxLength={14}
              className={`${INPUT_CLASS} h-10 min-w-0 flex-1`}
              placeholder="(555) 123-4567"
              aria-label="Mobile number"
              data-testid="input-launch-phone"
            />
            <button
              type="submit"
              className={`${BTN_PRIMARY} h-10 px-4`}
              data-testid="button-launch-phone-send"
              disabled={start.isPending || !isValidUsPhone(phone)}
            >
              {start.isPending ? 'Sending…' : 'Text me a code'}
            </button>
          </form>
        ) : (
          <form className="space-y-3" onSubmit={(event) => {
            event.preventDefault();
            if (code.length === 6 && !complete.isPending) complete.mutate();
          }}>
            <p className="text-xs text-muted-foreground">Enter the code texted to {request.destination}.</p>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              className={`${INPUT_CLASS} h-10 w-full`}
              aria-label="Texted verification code"
              data-testid="input-launch-phone-code"
            />
            {request.devCode && (
              <p className="rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs text-warn">
                Dev delivery mode — your code is {request.devCode}.
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                className={`${BTN_PRIMARY} h-10 px-4`}
                data-testid="button-launch-phone-verify"
                disabled={complete.isPending || code.length !== 6}
              >
                {complete.isPending ? 'Verifying…' : 'Verify'}
              </button>
              <button
                type="button"
                className={`${BTN_SECONDARY} h-10 px-4`}
                data-testid="button-launch-phone-change"
                disabled={complete.isPending}
                onClick={() => { setRequest(null); setCode(''); setError(null); }}
              >
                Use a different number
              </button>
            </div>
          </form>
        )}
        {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
      </div>
    )}
  </div>;
}
