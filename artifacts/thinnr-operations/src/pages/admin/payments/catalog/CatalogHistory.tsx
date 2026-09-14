/**
 * Catalog audit trail: who changed what, when (to the second). Actor names
 * link to the teammate's profile on the HQ Team page (absolute `~/` link:
 * this page is nested under /admin/payments).
 */
import { Link } from 'wouter';
import { AdminPage } from '@/components/admin/primitives';
import { SectionCard } from '@/components/patient/heritage';
import { Skeleton } from '@/components/ui/skeleton';
import { useHqCatalogChanges } from '@/hooks/use-billing';
import { formatCents, formatPreciseDateTime } from '@/lib/billing-format';
import type { CatalogChange } from '@/lib/billing-types';
import { DEMO_CATALOG_CHANGES } from '../demo-data';
import { useBillingSandbox } from '../use-billing-sandbox';
import { ErrorBox, Gate, Header, Preview } from './../shared';
import { CHANGE_KIND_LABEL } from './shared';

export function PaymentsCatalogHistory() {
  return <Gate>{(demo) => <HistoryBody demo={demo} />}</Gate>;
}

function HistoryBody({ demo }: { demo: boolean }) {
  const query = useHqCatalogChanges({});
  const sandbox = useBillingSandbox();
  const rows = demo ? DEMO_CATALOG_CHANGES : query.data?.items;
  return (
    <AdminPage>
      <Header
        title="Catalog history"
        sub="Every product, office price and program setting change, with who made it and when."
        tabs={false}
        back={{ href: '/catalog', label: '← Back to product catalog' }}
        sandbox={sandbox.data?.sandbox}
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-64" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <SectionCard title="Changes" sub={rows?.length ? `${rows.length} most recent` : undefined}>
          {rows && rows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-xs" data-testid="table-catalog-history">
                <thead>
                  <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                    <th className="px-4 py-3 text-left font-bold">When</th>
                    <th className="px-4 py-3 text-left font-bold">Change</th>
                    <th className="whitespace-nowrap px-4 py-3 text-left font-bold">Product / office</th>
                    <th className="px-4 py-3 text-left font-bold">Details</th>
                    <th className="px-4 py-3 text-left font-bold">Who</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((change) => (
                    <tr key={change.id} className="border-b border-border align-top last:border-b-0" data-testid={`row-change-${change.id}`}>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground">
                        <time dateTime={change.created_at}>{formatPreciseDateTime(change.created_at)}</time>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-navy">{CHANGE_KIND_LABEL[change.kind] ?? change.kind}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {change.product_id ? (
                          <Link href={`/catalog/products/${change.product_id}`} className="font-medium text-navy hover:underline">
                            {change.product_name ?? 'Product'}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{change.kind === 'settings_updated' ? 'Program settings' : 'Catalog'}</span>
                        )}
                        {change.kind === 'office_price_updated' && (
                          <p className="text-[11px] text-muted-foreground">
                            {change.provider_id ? (
                              <Link href={`/providers/${change.provider_id}`} className="hover:underline">
                                {change.office_name ?? 'Office'}
                              </Link>
                            ) : (
                              change.office_name ?? 'Office'
                            )}
                          </p>
                        )}
                      </td>
                      <td className="w-full px-4 py-3 text-muted-foreground">{describeChange(change)}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <Actor change={change} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-8 text-center text-xs text-muted-foreground">No catalog changes recorded yet.</p>
          )}
        </SectionCard>
      )}
    </AdminPage>
  );
}

function Actor({ change }: { change: CatalogChange }) {
  if (!change.actor_user_id) return <span className="text-muted-foreground">System</span>;
  const name = change.actor_name ?? 'Former teammate';
  if (!change.actor_member_id) return <span>{name}</span>;
  return (
    <Link
      href={`~/admin/team?member=${encodeURIComponent(change.actor_member_id)}`}
      className="font-semibold text-primary hover:underline"
      data-testid={`link-actor-${change.id}`}
    >
      {name}
    </Link>
  );
}

const FIELD_LABELS: Record<string, string> = {
  name: 'name',
  description: 'description',
  floor_price_cents: 'floor',
  hard_cost_cents: 'hard cost',
  sell_price_cents: 'price',
  subscription_enabled: 'subscriptions',
  status: 'status',
  shipping_charge_cents: 'shipping charge',
  shipping_cost_cents: 'shipping cost',
  card_fee_bps: 'card fee rate',
  card_fee_fixed_cents: 'card fee per payment',
  sort_order: 'position',
};

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (key.endsWith('_cents') && typeof value === 'number') return formatCents(value);
  if (key === 'card_fee_bps' && typeof value === 'number') return `${(value / 100).toFixed(2)}%`;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  if (Array.isArray(value)) return `${value.length} items`;
  return String(value);
}

/** "floor $109.99 → $119.99 · hard cost unchanged" style summary from the before/after payloads. */
export function describeChange(change: CatalogChange): string {
  if (change.kind === 'products_reordered') return 'The order offices see was changed.';
  if (change.kind === 'product_image_added' || change.kind === 'product_image_removed' || change.kind === 'product_default_image') {
    const wasDefault = (change.after ?? change.before)?.is_default === true;
    return `${CHANGE_KIND_LABEL[change.kind]}${wasDefault ? ' (the default picture)' : ''}`;
  }
  const before = change.before ?? {};
  const after = change.after ?? {};
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).filter((key) => key in FIELD_LABELS);
  const parts = keys
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => {
      const label = FIELD_LABELS[key];
      if (!(key in before)) return `${label} set to ${formatValue(key, after[key])}`;
      if (!(key in after)) return `${label} cleared`;
      return `${label} ${formatValue(key, before[key])} → ${formatValue(key, after[key])}`;
    });
  return parts.length ? parts.join(' · ') : CHANGE_KIND_LABEL[change.kind] ?? change.kind;
}
