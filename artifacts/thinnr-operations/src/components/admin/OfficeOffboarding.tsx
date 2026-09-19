import { useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Download, Loader2 } from 'lucide-react';
import {
  getGetOfficeOffboardingQueryKey,
  getOfficeDestructionCertificate,
  getOfficeOffboardingBundleDownloadUrl,
  useCompleteOfficeOffboarding,
  useGetOfficeOffboarding,
  useRecordOfficeOffboardingHandover,
  useRequestOfficeOffboardingBundle,
  useSealOfficeOffboarding,
  useStartOfficeOffboarding,
  type OfficeOffboardingHandoverInput,
  type OfficeOffboardingResult,
  type OfficeOffboardingStep,
} from '@workspace/api-client-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { requestReauth } from '@/lib/reauth';

const STEP_ORDER: OfficeOffboardingStep[] = ['start', 'bundle', 'handover', 'seal', 'complete'];
const RETRYABLE_BUNDLE = new Set(['failed', 'expired', 'cancelled']);

function formatWhen(value: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = error.data as { error?: unknown } | null;
    if (typeof data?.error === 'string') return data.error;
  }
  return error instanceof Error ? error.message : 'The offboarding request could not be completed.';
}

function needsReauth(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 401 || !('data' in error))
    return false;
  return (error.data as { code?: unknown } | null)?.code === 'reauth_required';
}

interface StepProps {
  number: number;
  title: string;
  state: 'done' | 'current' | 'upcoming';
  children: ReactNode;
}

function Step({ number, title, state, children }: StepProps) {
  return (
    <section
      className="grid gap-3 border-t border-border py-4 first:border-t-0 sm:grid-cols-[32px_1fr]"
      data-state={state}
      data-testid={`offboarding-step-${number}`}
    >
      <span
        className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${
          state === 'done'
            ? 'bg-[#eaf7ec] text-[#1f6b34]'
            : state === 'current'
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-muted-foreground'
        }`}
      >
        {state === 'done' ? <Check size={14} aria-label="Done" /> : number}
      </span>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-navy">{title}</h3>
          <span className="text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">{state}</span>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">{children}</div>
      </div>
    </section>
  );
}

export function OfficeOffboarding({ officeId }: { officeId: string }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<'start' | 'seal' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [handover, setHandover] = useState<OfficeOffboardingHandoverInput>({
    receivedBy: '',
    receivedOn: '',
    choice: 'retain',
    letterReference: '',
    note: '',
  });

  const query = useGetOfficeOffboarding(officeId, {
    query: {
      queryKey: getGetOfficeOffboardingQueryKey(officeId),
      refetchInterval: (current) => {
        const seal = current.state.data?.offboarding.seal;
        return seal?.startedAt && !seal.completedAt ? 5_000 : false;
      },
    },
  });
  const start = useStartOfficeOffboarding();
  const bundle = useRequestOfficeOffboardingBundle();
  const record = useRecordOfficeOffboardingHandover();
  const seal = useSealOfficeOffboarding();
  const complete = useCompleteOfficeOffboarding();

  const state = query.data?.offboarding;
  const busy = start.isPending || bundle.isPending || record.isPending || seal.isPending || complete.isPending;

  const saveResult = (result: OfficeOffboardingResult) => {
    queryClient.setQueryData(getGetOfficeOffboardingQueryKey(officeId), result);
    setError(null);
  };

  const perform = async (action: () => Promise<OfficeOffboardingResult>) => {
    setError(null);
    try {
      saveResult(await action());
    } catch (cause) {
      if (needsReauth(cause) && (await requestReauth())) {
        try {
          saveResult(await action());
          return;
        } catch (retryCause) {
          setError(errorMessage(retryCause));
          return;
        }
      }
      setError(errorMessage(cause));
    }
  };

  const stepState = (step: OfficeOffboardingStep): StepProps['state'] => {
    if (state?.status === 'offboarded') return 'done';
    if (state?.nextStep === step) return 'current';
    if (!state?.nextStep) return 'upcoming';
    return STEP_ORDER.indexOf(step) < STEP_ORDER.indexOf(state.nextStep) ? 'done' : 'upcoming';
  };

  const submitHandover = (event: FormEvent) => {
    event.preventDefault();
    void perform(() =>
      record.mutateAsync({
        id: officeId,
        data: {
          ...handover,
          receivedBy: handover.receivedBy.trim(),
          letterReference: handover.letterReference.trim(),
          note: handover.note?.trim() || undefined,
        },
      }),
    );
  };

  const downloadPart = async (part: number) => {
    setDownloading(`part-${part}`);
    setError(null);
    try {
      const result = await getOfficeOffboardingBundleDownloadUrl(officeId, { part });
      const anchor = document.createElement('a');
      anchor.href = result.url;
      anchor.download = result.fileName ?? '';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDownloading(null);
    }
  };

  const downloadCertificate = async () => {
    setDownloading('certificate');
    setError(null);
    try {
      const csv = await getOfficeDestructionCertificate(officeId);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${state?.officeName ?? 'office'}-destruction-certificate.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDownloading(null);
    }
  };

  if (query.isLoading) {
    return (
      <Card data-testid="office-offboarding">
        <CardHeader>
          <CardTitle>Offboard office</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">Loading offboarding status…</CardContent>
      </Card>
    );
  }

  if (!state || query.isError) {
    return (
      <Card data-testid="office-offboarding">
        <CardHeader>
          <CardTitle>Offboard office</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(query.error)}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const parts = state.bundle?.parts ?? [];
  const progress = state.bundle?.progress;
  const canRequestBundle = state.nextStep === 'bundle' && (!state.bundle || RETRYABLE_BUNDLE.has(state.bundle.status));

  return (
    <Card data-testid="office-offboarding">
      <CardHeader>
        <CardTitle>Offboard office</CardTitle>
        <CardDescription>
          Disable access, transfer the office record, seal charts, and finish the account closure.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4" data-testid="office-offboarding-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {state.legalHold && (
          <Alert className="mb-4 border-[#e8b47c] bg-[#fff4e6]" data-testid="office-offboarding-legal-hold">
            <AlertTriangle size={16} aria-hidden="true" />
            <AlertTitle>Office under legal hold</AlertTitle>
            <AlertDescription>
              Charts cannot be sealed and offboarding cannot be completed until the office legal hold is lifted.
            </AlertDescription>
          </Alert>
        )}

        <Step number={1} title="Disable staff sign-in" state={stepState('start')}>
          {state.started ? (
            <p>Staff sign-in disabled. {state.started.sessionsRevoked.toLocaleString('en-US')} sessions revoked.</p>
          ) : (
            <>
              <p>Revoke every staff login for this office and prevent further sign-in.</p>
              <Button
                className="mt-3"
                disabled={state.nextStep !== 'start' || busy}
                onClick={() => setConfirm('start')}
                data-testid="button-offboarding-start"
              >
                Disable staff sign-in
              </Button>
            </>
          )}
        </Step>

        <Step number={2} title="Generate office bundle" state={stepState('bundle')}>
          {state.bundle && (
            <div className="space-y-2">
              <p className="font-semibold capitalize text-foreground">Status: {state.bundle.status}</p>
              {(state.bundle.status === 'queued' || state.bundle.status === 'running') && (
                <p aria-live="polite" data-testid="offboarding-bundle-progress">
                  {progress?.patientsDone ?? 0} of {progress?.patientsTotal ?? 'unknown'} patients packed
                  {progress?.partsTotal != null ? ` · ${progress.partsDone ?? 0} of ${progress.partsTotal} parts` : ''}
                </p>
              )}
              {state.bundle.error && <p className="text-destructive">{state.bundle.error}</p>}
              {state.bundle.status === 'ready' && parts.length > 0 && (
                <ul className="space-y-2">
                  {parts.map((part, index) => (
                    <li
                      key={part.part}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                    >
                      <span>
                        {part.fileName} · part {index + 1} of {parts.length}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={downloading === `part-${part.part}`}
                        onClick={() => void downloadPart(part.part)}
                      >
                        <Download size={13} aria-hidden="true" />
                        Download
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {canRequestBundle && (
            <Button
              className="mt-3"
              disabled={busy}
              onClick={() => void perform(() => bundle.mutateAsync({ id: officeId }))}
              data-testid="button-offboarding-bundle"
            >
              {state.bundle ? 'Regenerate office bundle' : 'Generate office bundle'}
            </Button>
          )}
        </Step>

        <Step number={3} title="Record hand-over" state={stepState('handover')}>
          {state.handover ? (
            <dl
              className="grid gap-x-4 gap-y-2 rounded-md border border-border bg-secondary/50 p-3 sm:grid-cols-2"
              data-testid="offboarding-handover-summary"
            >
              <div>
                <dt className="font-semibold text-foreground">Received by</dt>
                <dd>{state.handover.receivedBy}</dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">Received on</dt>
                <dd>{state.handover.receivedOn}</dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">Choice</dt>
                <dd className="capitalize">{state.handover.choice}</dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">Letter reference</dt>
                <dd>{state.handover.letterReference}</dd>
              </div>
              {state.handover.note && (
                <div className="sm:col-span-2">
                  <dt className="font-semibold text-foreground">Note</dt>
                  <dd className="whitespace-pre-wrap">{state.handover.note}</dd>
                </div>
              )}
            </dl>
          ) : state.nextStep === 'handover' && !state.seal ? (
            <form className="space-y-4" onSubmit={submitHandover}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="handover-received-by">Received by</Label>
                  <Input
                    id="handover-received-by"
                    required
                    maxLength={200}
                    value={handover.receivedBy}
                    onChange={(event) => setHandover((current) => ({ ...current, receivedBy: event.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="handover-received-on">Received on</Label>
                  <Input
                    id="handover-received-on"
                    type="date"
                    required
                    value={handover.receivedOn}
                    onChange={(event) => setHandover((current) => ({ ...current, receivedOn: event.target.value }))}
                  />
                </div>
              </div>
              <RadioGroup
                value={handover.choice}
                onValueChange={(choice: 'retain' | 'destroy') => setHandover((current) => ({ ...current, choice }))}
              >
                <div className="flex items-start gap-2">
                  <RadioGroupItem id="handover-retain" value="retain" />
                  <Label htmlFor="handover-retain" className="font-normal">
                    <b className="text-foreground">Retain.</b> THINNR keeps the sealed charts in cold retention for the
                    clinical retention period.
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem id="handover-destroy" value="destroy" />
                  <Label htmlFor="handover-destroy" className="font-normal">
                    <b className="text-foreground">Destroy.</b> Sealed charts are destroyed {state.destroyAfterDays}{' '}
                    days after the hand-over.
                  </Label>
                </div>
              </RadioGroup>
              <div className="space-y-1.5">
                <Label htmlFor="handover-letter-reference">Letter reference</Label>
                <Input
                  id="handover-letter-reference"
                  required
                  maxLength={500}
                  value={handover.letterReference}
                  onChange={(event) => setHandover((current) => ({ ...current, letterReference: event.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="handover-note">Note (optional)</Label>
                <Textarea
                  id="handover-note"
                  maxLength={2000}
                  placeholder="Add Stripe or contract termination notes here."
                  value={handover.note}
                  onChange={(event) => setHandover((current) => ({ ...current, note: event.target.value }))}
                />
              </div>
              <Button type="submit" disabled={busy}>
                Record hand-over
              </Button>
            </form>
          ) : !state.handover ? (
            <p>Available after the office bundle is ready.</p>
          ) : null}
        </Step>

        <Step number={4} title="Seal all charts" state={stepState('seal')}>
          {state.seal ? (
            <>
              <div
                className="grid grid-cols-2 gap-2 sm:grid-cols-5"
                data-testid="offboarding-seal-progress"
                aria-live="polite"
              >
                {(['total', 'sealed', 'held', 'pending', 'failed'] as const).map((key) => (
                  <div key={key} className="rounded-md border border-border bg-secondary/50 p-2">
                    <span className="block text-[10px] font-bold uppercase tracking-[.08em]">{key}</span>
                    <b className="text-base text-navy">{state.seal!.progress[key]}</b>
                  </div>
                ))}
              </div>
              {!state.seal.completedAt && (
                <p className="mt-2 inline-flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" /> Sealing charts…
                </p>
              )}
              {state.seal.progress.held > 0 && (
                <p className="mt-2 text-[#8a5a00]">
                  Held charts are parked behind patient legal holds and cannot be completed yet.
                </p>
              )}
            </>
          ) : (
            <>
              <p>Seal every office chart before the account is completed.</p>
              <Button
                className="mt-3"
                disabled={state.nextStep !== 'seal' || state.legalHold || busy}
                onClick={() => setConfirm('seal')}
                data-testid="button-offboarding-seal"
              >
                Seal all charts
              </Button>
            </>
          )}
        </Step>

        <Step number={5} title="Complete" state={stepState('complete')}>
          {state.status === 'offboarded' ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-semibold text-foreground">Offboarded on {formatWhen(state.offboardedAt)}</p>
              {state.certificateAvailable && (
                <Button
                  variant="outline"
                  disabled={downloading === 'certificate'}
                  onClick={() => void downloadCertificate()}
                  data-testid="button-offboarding-certificate"
                >
                  <Download size={14} aria-hidden="true" />
                  Download destruction certificate
                </Button>
              )}
            </div>
          ) : (
            <>
              <p>Mark the office offboarded after sealing finishes.</p>
              <Button
                className="mt-3"
                disabled={state.nextStep !== 'complete' || state.legalHold || busy}
                onClick={() => void perform(() => complete.mutateAsync({ id: officeId }))}
                data-testid="button-offboarding-complete"
              >
                Complete offboarding
              </Button>
            </>
          )}
        </Step>
      </CardContent>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === 'start' ? 'Disable every staff sign-in?' : 'Seal every office chart?'}
            </DialogTitle>
            <DialogDescription>
              {confirm === 'start'
                ? 'Every staff login for this office will be revoked immediately, and staff will no longer be able to sign in.'
                : 'Sealing starts the chart retention or destruction process. The hand-over record cannot be changed after this begins.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                const choice = confirm;
                setConfirm(null);
                if (choice === 'start') void perform(() => start.mutateAsync({ id: officeId }));
                if (choice === 'seal') void perform(() => seal.mutateAsync({ id: officeId }));
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
