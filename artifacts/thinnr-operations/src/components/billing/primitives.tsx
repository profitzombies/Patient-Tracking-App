/**
 * Shared building blocks for every payments screen (HQ, office, public).
 * They reuse the Heritage chip/panel recipes so the payments family reads as
 * one with the rest of the desk.
 */
import type { ReactNode } from 'react';
import { FlaskConical } from 'lucide-react';
import { CHIP_COBALT, CHIP_RISK, CHIP_WARM, INSET, MICRO_LABEL } from '@/components/patient/heritage';
import { formatCents, type PillTone } from '@/lib/billing-format';
import type { FeeBreakdown as FeeBreakdownShape, HqProfit } from '@/lib/billing-types';

const CHIP_NEUTRAL =
  'inline-flex items-center gap-1.5 rounded-sm border border-border bg-secondary px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.06em] text-muted-foreground';
const CHIP_INFO =
  'inline-flex items-center gap-1.5 rounded-sm border border-[#b9c8e8] bg-[#eef3ff] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.06em] text-[#2b4a8f]';

const TONE_CLASS: Record<PillTone, string> = {
  neutral: CHIP_NEUTRAL,
  good: CHIP_COBALT,
  warn: CHIP_WARM,
  bad: CHIP_RISK,
  info: CHIP_INFO,
};

export function StatusPill({ tone, children, testId }: { tone: PillTone; children: ReactNode; testId?: string }) {
  return (
    <span className={TONE_CLASS[tone]} data-testid={testId}>
      {children}
    </span>
  );
}

/**
 * Loud environment marker. Rendered whenever the API reports sandbox keys so
 * nobody mistakes a test charge for a real one.
 */
export function SandboxBadge({ sandbox, className }: { sandbox: boolean | undefined; className?: string }) {
  if (!sandbox) return null;
  return (
    <span
      role="status"
      data-testid="billing-sandbox-badge"
      className={`inline-flex items-center gap-1.5 rounded-sm border border-[#e8b47c] bg-[#fff4e6] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.14em] text-[#b65c22] ${className ?? ''}`}
    >
      <FlaskConical size={11} aria-hidden="true" />
      Sandbox — test payments only
    </span>
  );
}

export function MoneyCell({
  cents,
  signed,
  muted,
  className,
}: {
  cents: number | null | undefined;
  signed?: boolean;
  muted?: boolean;
  className?: string;
}) {
  return (
    <span className={`tabular-nums ${muted ? 'text-muted-foreground' : ''} ${className ?? ''}`}>
      {formatCents(cents, { signed })}
    </span>
  );
}

interface FeeRow {
  label: string;
  cents: number | null | undefined;
  hint?: string;
  emphasis?: boolean;
  signed?: boolean;
}

function FeeRows({ rows }: { rows: FeeRow[] }) {
  return (
    <dl className="divide-y divide-border">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className={row.emphasis ? 'text-xs font-semibold text-foreground' : 'text-xs text-muted-foreground'}>
            {row.label}
            {row.hint ? <span className="ml-1.5 text-[10px] text-muted-foreground">{row.hint}</span> : null}
          </dt>
          <dd className={row.emphasis ? 'text-sm font-semibold text-foreground' : 'text-xs text-foreground'}>
            <MoneyCell cents={row.cents} signed={row.signed} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The money story of one order. `perspective` decides which lines appear:
 * offices see their net; HQ additionally sees hard cost and profit.
 */
export function FeeBreakdown({
  fees,
  profit,
  perspective,
}: {
  fees: FeeBreakdownShape;
  profit?: HqProfit;
  perspective: 'office' | 'hq';
}) {
  const stripeActual = fees.stripe_fee_cents !== null;
  const rows: FeeRow[] = [
    { label: 'Subtotal', cents: fees.subtotal_cents },
    { label: 'Shipping', cents: fees.shipping_charge_cents },
    { label: 'Sales tax', cents: fees.tax_cents, hint: fees.tax_cents === 0 ? '(none collected)' : undefined },
    { label: 'Total charged', cents: fees.total_cents, emphasis: true },
    { label: 'THINNR share (60% of floor)', cents: -fees.thinnr_share_cents },
    { label: 'THINNR shipping fee', cents: -fees.shipping_charge_cents },
    {
      label: 'Stripe processing',
      cents: -(stripeActual ? (fees.stripe_fee_cents as number) : fees.stripe_fee_estimate_cents),
      hint: stripeActual ? undefined : '(estimated)',
    },
    {
      label: 'Office net',
      cents: fees.office_net_cents ?? fees.office_net_estimate_cents,
      emphasis: true,
      hint: fees.office_net_cents === null ? '(estimated)' : undefined,
    },
  ];
  if (
    fees.application_fee_collected_cents !== null &&
    fees.application_fee_collected_cents !== fees.application_fee_cents
  ) {
    rows.splice(6, 0, {
      label: 'THINNR fee collected',
      cents: fees.application_fee_collected_cents,
      hint: '(differs from expected)',
    });
  }
  return (
    <div className={`${INSET} px-4 py-2`} data-testid="billing-fee-breakdown">
      <FeeRows rows={rows} />
      {perspective === 'hq' && profit ? (
        <div className="mt-2 border-t border-dashed border-border pt-2">
          <p className={MICRO_LABEL}>THINNR economics</p>
          <FeeRows
            rows={[
              { label: 'Application fee', cents: fees.application_fee_cents },
              { label: 'Hard cost', cents: -profit.hard_cost_cents },
              { label: 'Shipping cost', cents: -profit.shipping_cost_cents },
              { label: 'THINNR profit', cents: profit.hq_profit_cents, emphasis: true },
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Two-column key/value strip used for addresses, Stripe references, etc. */
export function DetailList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label}>
          <dt className={MICRO_LABEL}>{item.label}</dt>
          <dd className="mt-0.5 text-xs text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function formatAddress(address: {
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  phone?: string | null;
}): string[] {
  return [
    address.name,
    address.line1,
    address.line2 ?? '',
    `${address.city}, ${address.state} ${address.postal_code}`,
    address.country !== 'US' ? address.country : '',
    address.phone ?? '',
  ].filter(Boolean);
}
