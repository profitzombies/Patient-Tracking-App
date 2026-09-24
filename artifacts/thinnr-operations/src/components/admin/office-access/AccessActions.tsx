/**
 * HQ's actions on one office's access subscription.
 *
 * Each action is a small form in a dialog that states, in plain language,
 * exactly what applying it will do to this office before it is applied. None
 * of them can mark the office's payment setup complete: an office still adds
 * its own bank account and cards at first sign-in, whatever HQ records here.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, PANEL, PANEL_LABEL } from '@/components/patient/heritage';
import { useToast } from '@/hooks/use-toast';
import { useHqOfficeAccessMutations } from '@/hooks/use-billing';
import { centsToDollarsInput, formatCents, parseDollarsToCents, formatDate } from '@/lib/billing-format';
import {
  PAID_THROUGH_SOURCE_LABELS,
  PLAN_LABELS,
  suggestedPaidThrough,
  toDateInput,
} from '@/lib/office-access';
import type {
  OfficeAccessPlan,
  OfficeAccessPolicy,
  OfficeAccessTerms,
  PaidThroughSource,
} from '@/lib/billing-types';

export type AccessActionKind = 'included-period' | 'reset-trial' | 'price' | 'paid-through' | 'offline-payment';

const TITLES: Record<AccessActionKind, string> = {
  'included-period': 'Included period',
  'reset-trial': 'Reset the trial',
  price: 'Price for this office',
  'paid-through': 'Already paid through',
  'offline-payment': 'Record an offline payment',
};

function Effect({ children }: { children: React.ReactNode }) {
  return (
    <p className={`${PANEL} px-3 py-2 text-[11px] leading-relaxed text-foreground`} data-testid="text-access-action-effect">
      {children}
    </p>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className={PANEL_LABEL}>{label}</p>
      {children}
      {help && <p className="text-[11px] leading-relaxed text-muted-foreground">{help}</p>}
    </div>
  );
}

interface FormProps {
  terms: OfficeAccessTerms | null;
  policy: OfficeAccessPolicy;
  /** Applies the action; the dialog closes on success. */
  run: (apply: () => Promise<unknown>, done: string) => void;
  pending: boolean;
}

function IncludedPeriodForm({ terms, policy, run, pending, mutations }: FormProps & { mutations: ReturnType<typeof useHqOfficeAccessMutations> }) {
  const [lifetime, setLifetime] = useState(terms?.lifetime ?? false);
  const [endsAt, setEndsAt] = useState(toDateInput(terms?.includedPeriodEndsAt));
  const maxYears = Math.floor(policy.maxIncludedPeriodDays / 365);
  const maxDate = toDateInput(new Date(Date.now() + policy.maxIncludedPeriodDays * 86_400_000));
  const tooLong = !lifetime && endsAt !== '' && endsAt > maxDate;

  return (
    <div className="space-y-4">
      <Field label="Lifetime access" help="A lifetime office is never charged for access and never enters a recovery window.">
        <Switch checked={lifetime} onCheckedChange={setLifetime} aria-label="Lifetime access" data-testid="switch-access-lifetime" />
      </Field>
      {!lifetime && (
        <Field label="Included through" help={`Up to ${maxYears} years from today. Clear the date to end the included period now.`}>
          <input
            type="date"
            className={`${INPUT_CLASS} h-9 w-48`}
            value={endsAt}
            max={maxDate}
            onChange={(event) => setEndsAt(event.target.value)}
            aria-label="Included period end date"
            data-testid="input-access-included-ends"
          />
        </Field>
      )}
      <Effect>
        {lifetime
          ? 'This office will be marked as lifetime access: no access charge, ever, and no recovery window.'
          : endsAt
            ? `This office pays nothing for access until ${formatDate(`${endsAt}T00:00:00Z`)}. Billing starts the day after.`
            : 'The included period ends now. The office is charged for access from its next billing run.'}
      </Effect>
      {tooLong && (
        <p className="text-[11px] font-medium text-destructive" role="alert">
          An included period cannot run more than {maxYears} years out.
        </p>
      )}
      <DialogFooter>
        <button
          type="button"
          className={`${BTN_PRIMARY} h-9 px-4`}
          disabled={pending || tooLong}
          data-testid="button-access-included-apply"
          onClick={() =>
            run(
              () =>
                mutations.includedPeriod.mutateAsync(
                  lifetime ? { lifetime: true } : { lifetime: false, endsAt: endsAt ? endsAt : null },
                ),
              lifetime ? 'Marked as lifetime access.' : endsAt ? `Included through ${formatDate(`${endsAt}T00:00:00Z`)}.` : 'Included period ended.',
            )
          }
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Applying" /> : 'Apply'}
        </button>
      </DialogFooter>
    </div>
  );
}

function ResetTrialForm({ policy, run, pending, mutations }: FormProps & { mutations: ReturnType<typeof useHqOfficeAccessMutations> }) {
  const [days, setDays] = useState(policy.includedPeriodDays);
  const valid = Number.isFinite(days) && days >= 1 && days <= policy.maxIncludedPeriodDays;
  const ends = valid ? formatDate(new Date(Date.now() + days * 86_400_000).toISOString()) : '—';
  return (
    <div className="space-y-4">
      <Field label="Fresh period" help={`The standard included period is ${policy.includedPeriodDays} days.`}>
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            className={`${INPUT_CLASS} h-9 w-28 tabular-nums`}
            value={Number.isFinite(days) ? days : ''}
            min={1}
            max={policy.maxIncludedPeriodDays}
            onChange={(event) => setDays(event.target.value === '' ? Number.NaN : Number(event.target.value))}
            aria-label="Included period days"
            data-testid="input-access-reset-days"
          />
          <span className="text-[11px] text-muted-foreground">days</span>
        </div>
      </Field>
      <Effect>
        The included period restarts today and runs to {ends}. Any recovery window is cleared and the office has normal access again.
      </Effect>
      <DialogFooter>
        <button
          type="button"
          className={`${BTN_PRIMARY} h-9 px-4`}
          disabled={pending || !valid}
          data-testid="button-access-reset-apply"
          onClick={() => run(() => mutations.resetTrial.mutateAsync({ days }), `Trial reset — included through ${ends}.`)}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Applying" /> : 'Reset trial'}
        </button>
      </DialogFooter>
    </div>
  );
}

function PriceForm({ terms, policy, run, pending, mutations }: FormProps & { mutations: ReturnType<typeof useHqOfficeAccessMutations> }) {
  const [plan, setPlan] = useState<OfficeAccessPlan>(terms?.plan ?? 'monthly');
  const [override, setOverride] = useState(terms?.priceCentsOverride !== null && terms?.priceCentsOverride !== undefined);
  const [amount, setAmount] = useState(centsToDollarsInput(terms?.priceCentsOverride ?? terms?.priceCents ?? policy.monthlyPriceCents));
  const parsed = parseDollarsToCents(amount);
  const standard = plan === 'yearly' ? policy.yearlyPriceCents : policy.monthlyPriceCents;
  const problem = override && !parsed.ok ? parsed.error : null;
  return (
    <div className="space-y-4">
      <Field label="Plan">
        <Select value={plan} onValueChange={(value) => setPlan(value as OfficeAccessPlan)}>
          <SelectTrigger className="h-9 w-48 text-xs" aria-label="Plan" data-testid="select-access-plan">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="monthly" className="text-xs">{PLAN_LABELS.monthly} · {formatCents(policy.monthlyPriceCents)}</SelectItem>
            <SelectItem value="yearly" className="text-xs">{PLAN_LABELS.yearly} · {formatCents(policy.yearlyPriceCents)}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Own price" help="Off means this office pays the standard price, including any future change to it.">
        <Switch checked={override} onCheckedChange={setOverride} aria-label="Override the price for this office" data-testid="switch-access-price-override" />
      </Field>
      {override && (
        <Field label="Amount per period">
          <input
            className={`${INPUT_CLASS} h-9 w-40 tabular-nums`}
            value={amount}
            inputMode="decimal"
            onChange={(event) => setAmount(event.target.value)}
            aria-label="Price override amount"
            aria-invalid={problem ? true : undefined}
            data-testid="input-access-price"
          />
        </Field>
      )}
      <Effect>
        {override && parsed.ok
          ? `This office is charged ${formatCents(parsed.cents)} per ${plan === 'yearly' ? 'year' : 'month'}, instead of the standard ${formatCents(standard)}. Periods already charged are unchanged.`
          : `This office is charged the standard ${PLAN_LABELS[plan].toLowerCase()} price, ${formatCents(standard)}. Periods already charged are unchanged.`}
      </Effect>
      {problem && <p className="text-[11px] font-medium text-destructive" role="alert">{problem}</p>}
      <DialogFooter>
        <button
          type="button"
          className={`${BTN_PRIMARY} h-9 px-4`}
          disabled={pending || Boolean(problem)}
          data-testid="button-access-price-apply"
          onClick={() =>
            run(
              () => mutations.terms.mutateAsync({ plan, priceCentsOverride: override && parsed.ok ? parsed.cents : null }),
              override && parsed.ok ? `Price set to ${formatCents(parsed.cents)}.` : 'Back to the standard price.',
            )
          }
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Applying" /> : 'Apply'}
        </button>
      </DialogFooter>
    </div>
  );
}

/** Shared date + term picker for the two "paid through" actions. */
function PaidThroughFields({ terms, plan, setPlan, date, setDate }: {
  terms: OfficeAccessTerms | null;
  plan: OfficeAccessPlan;
  setPlan: (plan: OfficeAccessPlan) => void;
  date: string;
  setDate: (date: string) => void;
}) {
  const suggest = (next: OfficeAccessPlan) => {
    setPlan(next);
    setDate(suggestedPaidThrough(next, terms));
  };
  return (
    <>
      <Field label="They paid for" help="Picking a term fills in the date below; change it if the real date is different.">
        <div className="flex items-center gap-2">
          {(['monthly', 'yearly'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`${plan === option ? BTN_PRIMARY : BTN_SECONDARY} h-8 px-3`}
              aria-pressed={plan === option}
              data-testid={`button-access-term-${option}`}
              onClick={() => suggest(option)}
            >
              {option === 'monthly' ? 'A month' : 'A year'}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Paid through">
        <input
          type="date"
          className={`${INPUT_CLASS} h-9 w-48`}
          value={date}
          onChange={(event) => setDate(event.target.value)}
          aria-label="Paid through date"
          data-testid="input-access-paid-through"
        />
      </Field>
    </>
  );
}

function PaidThroughForm({ terms, run, pending, mutations }: FormProps & { mutations: ReturnType<typeof useHqOfficeAccessMutations> }) {
  const [plan, setPlan] = useState<OfficeAccessPlan>(terms?.plan ?? 'monthly');
  const [date, setDate] = useState(() => suggestedPaidThrough(terms?.plan ?? 'monthly', terms));
  const [source, setSource] = useState<PaidThroughSource>('hq_migration');
  return (
    <div className="space-y-4">
      <PaidThroughFields terms={terms} plan={plan} setPlan={setPlan} date={date} setDate={setDate} />
      <Field label="Where the money came from" help="Recorded on the office so anyone reading it later knows what this date is based on.">
        <Select value={source} onValueChange={(value) => setSource(value as PaidThroughSource)}>
          <SelectTrigger className="h-9 w-64 text-xs" aria-label="Payment source" data-testid="select-access-source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PAID_THROUGH_SOURCE_LABELS) as PaidThroughSource[]).map((option) => (
              <SelectItem key={option} value={option} className="text-xs">{PAID_THROUGH_SOURCE_LABELS[option]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Effect>
        {date
          ? `This office is treated as paid for access through ${formatDate(`${date}T00:00:00Z`)}. It is still asked to add its own bank account and cards at first sign-in — nothing recorded here stands in for them.`
          : 'Choose the date this office is paid through.'}
      </Effect>
      <DialogFooter>
        <button
          type="button"
          className={`${BTN_PRIMARY} h-9 px-4`}
          disabled={pending || !date}
          data-testid="button-access-paid-through-apply"
          onClick={() =>
            run(
              () => mutations.paidThrough.mutateAsync({ paidThrough: date, source }),
              `Recorded as paid through ${formatDate(`${date}T00:00:00Z`)}.`,
            )
          }
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Applying" /> : 'Record'}
        </button>
      </DialogFooter>
    </div>
  );
}

function OfflinePaymentForm({ terms, run, pending, mutations }: FormProps & { mutations: ReturnType<typeof useHqOfficeAccessMutations> }) {
  const [plan, setPlan] = useState<OfficeAccessPlan>(terms?.plan ?? 'monthly');
  const [date, setDate] = useState(() => suggestedPaidThrough(terms?.plan ?? 'monthly', terms));
  const [amount, setAmount] = useState(centsToDollarsInput(terms?.priceCents ?? null));
  const parsed = parseDollarsToCents(amount);
  const problem = amount.trim() === '' ? null : parsed.ok ? null : parsed.error;
  const restricted = terms?.state === 'restricted';
  return (
    <div className="space-y-4">
      <PaidThroughFields terms={terms} plan={plan} setPlan={setPlan} date={date} setDate={setDate} />
      <Field label="Amount received" help="Optional. Recorded with the payment so the history shows what was taken.">
        <input
          className={`${INPUT_CLASS} h-9 w-40 tabular-nums`}
          value={amount}
          inputMode="decimal"
          onChange={(event) => setAmount(event.target.value)}
          aria-label="Amount received"
          aria-invalid={problem ? true : undefined}
          data-testid="input-access-offline-amount"
        />
      </Field>
      <Effect>
        {date
          ? `${restricted ? 'This office stops being restricted and gets normal access back. ' : ''}Access is paid through ${formatDate(`${date}T00:00:00Z`)} and any recovery window is cleared, exactly as a successful card charge would leave it.`
          : 'Choose the date this payment covers the office through.'}
      </Effect>
      {problem && <p className="text-[11px] font-medium text-destructive" role="alert">{problem}</p>}
      <DialogFooter>
        <button
          type="button"
          className={`${BTN_PRIMARY} h-9 px-4`}
          disabled={pending || !date || Boolean(problem)}
          data-testid="button-access-offline-apply"
          onClick={() =>
            run(
              () =>
                mutations.offlinePayment.mutateAsync({
                  paidThrough: date,
                  ...(amount.trim() !== '' && parsed.ok ? { amountCents: parsed.cents } : {}),
                }),
              restricted ? 'Payment recorded — the office is no longer restricted.' : `Offline payment recorded through ${formatDate(`${date}T00:00:00Z`)}.`,
            )
          }
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Applying" /> : 'Record payment'}
        </button>
      </DialogFooter>
    </div>
  );
}

const DESCRIPTIONS: Record<AccessActionKind, string> = {
  'included-period': 'Give this office a period it pays nothing for, change when that period ends, or make its access complimentary for life.',
  'reset-trial': 'Start the included period again from today. Use this when an office needs more time.',
  price: 'What this office is charged for access, and on what cadence.',
  'paid-through': 'Record access this office has already paid for — usually when it moves over from the old system.',
  'offline-payment': 'Record a payment taken outside Stripe: a check, a transfer, or a card run elsewhere.',
};

export function AccessActionDialog({ providerId, officeName, action, terms, policy, onClose }: {
  providerId: string;
  officeName: string;
  action: AccessActionKind | null;
  terms: OfficeAccessTerms | null;
  policy: OfficeAccessPolicy;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const mutations = useHqOfficeAccessMutations(providerId);
  const [pending, setPending] = useState(false);

  const run = (apply: () => Promise<unknown>, done: string) => {
    setPending(true);
    apply()
      .then(() => {
        toast({ variant: 'success', title: officeName, description: done });
        onClose();
      })
      .catch((error: unknown) => {
        toast({
          variant: 'destructive',
          title: 'Nothing was changed',
          description: error instanceof Error ? error.message : 'The change could not be applied. Try again.',
        });
      })
      .finally(() => setPending(false));
  };

  const shared = { terms, policy, run, pending, mutations };
  return (
    <Dialog open={action !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="dialog-access-action">
        {action && (
          <>
            <DialogHeader>
              <DialogTitle className="font-serif text-navy">{TITLES[action]}</DialogTitle>
              <DialogDescription>{DESCRIPTIONS[action]}</DialogDescription>
            </DialogHeader>
            {action === 'included-period' && <IncludedPeriodForm {...shared} />}
            {action === 'reset-trial' && <ResetTrialForm {...shared} />}
            {action === 'price' && <PriceForm {...shared} />}
            {action === 'paid-through' && <PaidThroughForm {...shared} />}
            {action === 'offline-payment' && <OfflinePaymentForm {...shared} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
