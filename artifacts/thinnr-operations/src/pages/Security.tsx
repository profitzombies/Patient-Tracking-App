import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { ShieldCheck } from 'lucide-react';
import { useSession } from '@/contexts/session';
import { formatUsPhone, isValidUsPhone, normalizeUsPhone } from '@/lib/us-contact';
import { useToast } from '@/hooks/use-toast';
import { BTN_PRIMARY, BTN_SECONDARY, CHIP_COBALT, CHIP_WARM, INPUT_CLASS, SectionCard } from '@/components/patient/heritage';
import {
  fetchMySecurity,
  completeMySecondFactorPhone,
  reportMySignIn,
  setMySecondFactorEnabled,
  signOutMyOtherSessions,
  startMySecondFactorPhone,
  type MySecurity,
  type SecuritySession,
  type SecuritySignIn,
} from '@/lib/office-api';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const PREVIEW: MySecurity = {
  realm: 'staff', canChangePassword: false, contact: { email: 's•••@thinnr.com', phone: null },
  passwordChangedAt: null, currentSessionKnown: true,
  secondFactor: { policyRequired: true, enabled: true, phone: '•••-•••-4471', verifiedAt: '2026-08-01T12:00:00Z' },
  signIns: [
    { id: 'preview-1', at: '2026-08-18T14:30:00Z', method: 'email_code', methodLabel: 'Emailed code', platform: 'web', device: 'Chrome on Mac', region: 'Austin, Texas, US', newDevice: true, current: true, active: true, revokedAt: null, revokedReason: null, reportedAt: null },
    { id: 'preview-2', at: '2026-08-12T09:10:00Z', method: 'email_code', methodLabel: 'Emailed code', platform: 'web', device: 'Safari on iPhone', region: 'Austin, Texas, US', newDevice: false, current: false, active: true, revokedAt: null, revokedReason: null, reportedAt: null },
  ],
  sessions: [
    { ref: 'preview-current1', createdAt: '2026-08-18T14:30:00Z', lastSeenAt: '2026-08-18T16:15:00Z', platform: 'web', device: 'Chrome on Mac', region: 'Austin, Texas, US', current: true, signInId: 'preview-1' },
    { ref: 'preview-other001', createdAt: '2026-08-12T09:10:00Z', lastSeenAt: '2026-08-17T20:00:00Z', platform: 'web', device: 'Safari on iPhone', region: 'Austin, Texas, US', current: false, signInId: 'preview-2' },
  ],
};

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function SignIns({ rows, preview, onReport }: { rows: SecuritySignIn[]; preview: boolean; onReport: (row: SecuritySignIn) => void }) {
  return <div className="divide-y divide-border">{rows.length ? rows.map((row) => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" data-testid={`security-signin-${row.id}`}>
    <div><div className="flex flex-wrap items-center gap-2"><b className="text-sm text-navy">{row.device}</b>{row.newDevice && <span className={CHIP_WARM}>New device</span>}{row.current && <span className={CHIP_COBALT}>Current</span>}</div><p className="mt-1 text-xs text-muted-foreground">{when(row.at)} · {row.region ?? 'Region unavailable'} · {row.methodLabel}</p></div>
    <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-[11px] text-destructive`} disabled={preview} onClick={() => onReport(row)}>This wasn&apos;t me</button>
  </div>) : <p className="p-5 text-xs text-muted-foreground">No recent sign-ins were found.</p>}</div>;
}

function Sessions({ rows }: { rows: SecuritySession[] }) {
  return <div className="divide-y divide-border">{rows.length ? rows.map((row) => <div key={row.ref} className="px-5 py-4" data-testid={`security-session-${row.ref}`}><div className="flex items-center gap-2"><b className="text-sm text-navy">{row.device}</b>{row.current && <span className={CHIP_COBALT}>Current</span>}</div><p className="mt-1 text-xs text-muted-foreground">{row.region ?? 'Region unavailable'} · Last seen {when(row.lastSeenAt)}</p></div>) : <p className="p-5 text-xs text-muted-foreground">No active sessions were found.</p>}</div>;
}

export default function Security() {
  const { authStatus, signOut } = useSession();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const client = useQueryClient();
  const preview = authStatus !== 'signed-in';
  const query = useQuery({ queryKey: ['account-security'], queryFn: fetchMySecurity, enabled: !preview, retry: false });
  const [confirm, setConfirm] = useState<SecuritySignIn | 'others' | null>(null);
  const [phone, setPhone] = useState('');
  const [phoneRequest, setPhoneRequest] = useState<{ requestId: string; destination: string; devCode: string | null } | null>(null);
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => confirm === 'others' ? signOutMyOtherSessions() : reportMySignIn((confirm as SecuritySignIn).id),
    onSuccess: async () => {
      if (confirm === 'others') {
        toast({ variant: 'success', title: 'Other sessions signed out', description: 'This device stays signed in.' });
        setConfirm(null);
        await client.invalidateQueries({ queryKey: ['account-security'] });
      } else {
        toast({ variant: 'destructive', title: 'Sign-in reported', description: 'Every session on your account was signed out.' });
        signOut();
        navigate('/', { replace: true });
      }
    },
    onError: (error) => toast({ variant: 'destructive', title: 'Security action failed', description: error instanceof Error ? error.message : 'Try again.' }),
  });
  const data = preview ? PREVIEW : query.data;
  const refreshSecurity = () => client.invalidateQueries({ queryKey: ['account-security'] });
  const phoneStart = useMutation({
    mutationFn: () => startMySecondFactorPhone(`+1${normalizeUsPhone(phone)}`),
    onSuccess: (result) => {
      setPhoneRequest({ requestId: result.requestId, destination: result.destination, devCode: result.devCode ?? null });
      setPhoneError(null);
    },
    onError: (error) => setPhoneError(error instanceof Error ? error.message : 'Could not send a text.'),
  });
  const phoneComplete = useMutation({
    mutationFn: () => completeMySecondFactorPhone(phoneRequest!.requestId, phoneCode),
    onSuccess: async () => {
      setPhone('');
      setPhoneCode('');
      setPhoneRequest(null);
      setPhoneError(null);
      toast({ variant: 'success', title: 'Sign-in phone verified' });
      await refreshSecurity();
    },
    onError: (error) => setPhoneError(error instanceof Error ? error.message : 'That code did not work.'),
  });
  const factorToggle = useMutation({
    mutationFn: (enabled: boolean) => setMySecondFactorEnabled(enabled),
    onSuccess: async (_, enabled) => {
      toast({ variant: 'success', title: enabled ? 'Texted sign-in code turned on' : 'Texted sign-in code turned off' });
      await refreshSecurity();
    },
    onError: (error) => setPhoneError(error instanceof Error ? error.message : 'The setting could not be changed.'),
  });
  return <div className="mx-auto max-w-[1000px] space-y-6 px-4 py-7 md:px-8" data-testid={preview ? 'security-preview' : 'security-live'}>
    <header><div className="flex items-center gap-2 text-primary"><ShieldCheck size={16}/><span className="text-[10px] font-bold uppercase tracking-[.14em]">Account</span></div><h1 className="mt-2 font-serif text-3xl font-bold text-navy">Security</h1><p className="mt-2 text-sm text-muted-foreground">Review where your account has been used and close access you do not recognize.</p></header>
    {preview && <p className="rounded-md border border-accent-border bg-accent p-3 text-xs font-semibold text-navy">Preview — sign in to manage your real account</p>}
    {!preview && query.isPending && <p className="rounded-md border border-border p-6 text-sm text-muted-foreground">Loading account security…</p>}
    {!preview && query.isError && <div role="alert" className="rounded-md border border-destructive/30 p-5"><p className="text-sm text-destructive">{query.error instanceof Error ? query.error.message : 'Account security could not be loaded.'}</p><button className={`${BTN_SECONDARY} mt-3 h-8 px-3`} onClick={() => void query.refetch()}>Try again</button></div>}
    {data && <>
      {data.secondFactor && (
        <SectionCard
          title="Sign-in phone"
          sub="Use a texted code as a second check after your emailed sign-in code."
          action={data.secondFactor.policyRequired ? (
            <span className={CHIP_COBALT}>Required for your role</span>
          ) : (
            <button
              type="button"
              data-testid="button-second-factor-toggle"
              className={`${BTN_SECONDARY} h-8 px-3`}
              disabled={preview || factorToggle.isPending}
              onClick={() => factorToggle.mutate(!data.secondFactor!.enabled)}
            >
              Turn {data.secondFactor.enabled ? 'off' : 'on'}
            </button>
          )}
        >
          <div className="space-y-4 p-5">
            <div>
              <p className="text-sm font-semibold text-navy">{data.secondFactor.phone ?? 'No phone verified'}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {data.secondFactor.phone ? 'Verified for sign-in' : 'Add a mobile number before turning on texted codes.'}
              </p>
            </div>
            {!preview && (
              <div className="max-w-md space-y-3">
                {!phoneRequest ? (
                  <>
                    <input
                      type="tel"
                      value={phone}
                      onChange={(event) => setPhone(formatUsPhone(event.target.value))}
                      autoComplete="tel-national"
                      maxLength={14}
                      className={`${INPUT_CLASS} h-9 w-full`}
                      placeholder={data.secondFactor.phone ? 'Enter a new mobile number' : 'Mobile number'}
                      aria-label="Mobile number"
                      data-testid="input-security-phone"
                    />
                    <button
                      type="button"
                      className={`${BTN_PRIMARY} h-9 px-3.5`}
                      data-testid="button-security-phone-send"
                      disabled={phoneStart.isPending || !isValidUsPhone(phone)}
                      onClick={() => phoneStart.mutate()}
                    >
                      {phoneStart.isPending ? 'Sending…' : 'Text me a code'}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">Enter the code texted to {phoneRequest.destination}.</p>
                    <input
                      inputMode="numeric"
                      maxLength={6}
                      value={phoneCode}
                      onChange={(event) => setPhoneCode(event.target.value.replace(/\D/g, ''))}
                      className={`${INPUT_CLASS} h-9 w-full`}
                      aria-label="Texted verification code"
                      data-testid="input-security-phone-code"
                    />
                    {phoneRequest.devCode && (
                      <p className="rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs text-warn">
                        Dev delivery mode — your code is {phoneRequest.devCode}.
                      </p>
                    )}
                    <button
                      type="button"
                      className={`${BTN_PRIMARY} h-9 px-3.5`}
                      data-testid="button-security-phone-verify"
                      disabled={phoneComplete.isPending || phoneCode.length !== 6}
                      onClick={() => phoneComplete.mutate()}
                    >
                      {phoneComplete.isPending ? 'Verifying…' : 'Verify'}
                    </button>
                  </>
                )}
                {phoneError && <p role="alert" className="text-xs font-medium text-destructive">{phoneError}</p>}
              </div>
            )}
          </div>
        </SectionCard>
      )}
      <SectionCard title="Recent sign-ins" sub="The newest account access, including device and approximate region."><SignIns rows={data.signIns} preview={preview} onReport={setConfirm}/></SectionCard>
      <SectionCard title="Active sessions" sub="Devices that can still access this account." action={<button type="button" data-testid="button-sign-out-others" className={`${BTN_PRIMARY} h-8 px-3`} disabled={preview || mutation.isPending} onClick={() => setConfirm('others')}>Sign out everywhere else</button>}><Sessions rows={data.sessions}/></SectionCard>
    </>}
    <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirm === 'others' ? 'Sign out everywhere else?' : 'Report this sign-in?'}</AlertDialogTitle><AlertDialogDescription>{confirm === 'others' ? 'Every other device will need to sign in again.' : 'This immediately signs out every session, including this device.'}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction data-testid="button-security-confirm" onClick={(event) => { event.preventDefault(); mutation.mutate(); }} disabled={mutation.isPending}>{mutation.isPending ? 'Working…' : 'Confirm'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}