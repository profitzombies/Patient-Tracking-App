/**
 * "Provider launch readiness" on HQ System health: a read-only checklist of
 * what a real office needs before its owner can sign in and connect Stripe.
 * The server only reads vendor settings; every fix is done in the vendor's
 * dashboard and confirmed by re-running the check here.
 */
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AlertTriangle, CheckCircle2, ClipboardCheck, Copy, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { fetchLaunchReadiness, type ReadinessCheck, type ReadinessSection, type ReadinessStatus } from '@/lib/launch-readiness-api';
import { useToast } from '@/hooks/use-toast';

const SECTION_LABEL: Record<ReadinessSection, string> = {
  app: 'App address',
  stripe_live: 'Stripe — Live',
  stripe_test: 'Stripe — Test',
  warehouse: 'Warehouse',
  email: 'Email',
  sms: 'Text messages',
};
const SECTION_ORDER: ReadinessSection[] = ['app', 'stripe_live', 'stripe_test', 'warehouse', 'email', 'sms'];

const STATUS_LABEL: Record<ReadinessStatus, string> = {
  pass: 'Ready', warn: 'Check', fail: 'Fix needed', manual: 'Confirm by hand',
};
const STATUS_CLASS: Record<ReadinessStatus, string> = {
  pass: 'border-[#b6dcc4] bg-[#eef8f1] text-[#23703f]',
  warn: 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]',
  fail: 'border-[#e7a7a2] bg-[#fdf0ef] text-[#a2302a]',
  manual: 'border-border bg-secondary text-navy',
};

function StatusIcon({ status }: { status: ReadinessStatus }) {
  if (status === 'pass') return <CheckCircle2 size={13} aria-hidden="true" />;
  if (status === 'fail') return <XCircle size={13} aria-hidden="true" />;
  if (status === 'warn') return <AlertTriangle size={13} aria-hidden="true" />;
  return <ClipboardCheck size={13} aria-hidden="true" />;
}

function CheckRow({ check }: { check: ReadinessCheck }) {
  const { toast } = useToast();
  const copy = async () => {
    if (!check.copyValue) return;
    try {
      await navigator.clipboard.writeText(check.copyValue);
      toast({ title: 'Copied', description: check.copyValue });
    } catch {
      toast({ variant: 'destructive', title: 'Could not copy', description: 'Select the address and copy it by hand.' });
    }
  };
  return (
    <li className="flex flex-col gap-1.5 border-t border-border py-3 first:border-t-0" data-testid={`readiness-check-${check.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-navy">{check.label}</p>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_CLASS[check.status]}`} data-testid={`readiness-status-${check.id}`}>
          <StatusIcon status={check.status} />
          {STATUS_LABEL[check.status]}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{check.detail}</p>
      {check.fix && <p className="text-xs text-navy"><span className="font-semibold">What to do: </span>{check.fix}</p>}
      {check.copyValue && (
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded border border-border bg-secondary px-2 py-1 text-[11px] text-navy" title={check.copyValue}>{check.copyValue}</code>
          <button type="button" onClick={copy} className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[11px] font-semibold text-navy hover:bg-secondary" aria-label={`Copy ${check.label}`}>
            <Copy size={12} aria-hidden="true" /> Copy
          </button>
        </div>
      )}
    </li>
  );
}

export function LaunchReadinessCard({ enabled }: { enabled: boolean }) {
  const query = useQuery({
    queryKey: ['hq-launch-readiness'],
    queryFn: fetchLaunchReadiness,
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const checks = query.data?.checks ?? [];
  const failing = checks.filter((check) => check.status === 'fail').length;
  const manual = checks.filter((check) => check.status === 'manual' || check.status === 'warn').length;

  return (
    <section className="mt-6 rounded-lg border border-card-border bg-card p-5 shadow-soft" aria-labelledby="launch-readiness-heading" data-testid="system-health-launch-readiness">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="launch-readiness-heading" className="font-serif text-base font-bold text-navy">Provider launch readiness</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            What a real office needs before its owner can sign in and connect Stripe. This check only reads settings — it never changes Stripe, email or text-message accounts.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-semibold text-navy hover:bg-secondary disabled:opacity-60"
          data-testid="button-rerun-launch-readiness"
        >
          {query.isFetching ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}
          {query.isFetching ? 'Checking…' : 'Re-run check'}
        </button>
      </div>

      {query.isLoading ? (
        <p className="mt-4 text-xs text-muted-foreground">Checking Stripe, email and text-message settings…</p>
      ) : query.isError ? (
        <p role="alert" className="mt-4 rounded-md border border-[#e7a7a2] bg-[#fdf0ef] px-4 py-2.5 text-xs text-[#a2302a]" data-testid="text-launch-readiness-error">
          {query.error instanceof Error ? query.error.message : 'The check could not run.'}
        </p>
      ) : query.data ? (
        <>
          <p className="mt-3 text-xs font-semibold text-navy" data-testid="text-launch-readiness-summary">
            {failing === 0 && manual === 0 ? 'Everything is ready.' : `${failing} to fix · ${manual} to confirm or review`}
            <span className="ml-2 font-normal text-muted-foreground">Checked {format(new Date(query.data.checkedAt), 'MMM d, HH:mm')}</span>
          </p>
          <div className="mt-2 grid grid-cols-1 gap-x-8 lg:grid-cols-2">
            {SECTION_ORDER.map((section) => {
              const rows = checks.filter((check) => check.section === section);
              if (!rows.length) return null;
              return (
                <div key={section} className="mt-3 min-w-0">
                  <h3 className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">{SECTION_LABEL[section]}</h3>
                  <ul className="mt-1">{rows.map((check) => <CheckRow key={check.id} check={check} />)}</ul>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}
