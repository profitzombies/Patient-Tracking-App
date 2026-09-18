/**
 * HQ product catalog: the ordered product list (drag or arrow keys to
 * reorder), status controls, and the program-wide fee settings. Product
 * details live on their own page (ProductEditor); the audit trail on
 * CatalogHistory. Mounted under /admin/payments, so links are base-relative.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { Archive, ArchiveRestore, GripVertical, Plus } from 'lucide-react';
import { AdminPage, MetricTile } from '@/components/admin/primitives';
import { BTN_PRIMARY, BTN_SECONDARY, SectionCard } from '@/components/patient/heritage';
import { MoneyCell } from '@/components/billing/primitives';
import { MoneyInput, PercentInput, bpsToPercentInput, parsePercentToBps } from '@/components/billing/MoneyInput';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useHqCatalog, useHqCatalogMutations } from '@/hooks/use-billing';
import { BillingApiError } from '@/lib/billing-api';
import { centsToDollarsInput, formatCents, formatDateTime, parseDollarsToCents } from '@/lib/billing-format';
import type { CatalogProduct, HqCatalogResponse, PickPackTier, ProductStatus } from '@/lib/billing-types';
import { DEMO_CATALOG } from '../demo-data';
import { useBillingSandbox } from '../use-billing-sandbox';
import { ErrorBox, Gate, Header, Preview } from './../shared';
import { FIELD_LABEL, PRODUCT_CATEGORY_LABEL, ProductStatusPill, ProductThumb, cadenceSummary } from './shared';

export function PaymentsCatalog() {
  return <Gate>{(demo, canWrite) => <CatalogBody demo={demo} canWrite={canWrite} />}</Gate>;
}

function CatalogBody({ demo, canWrite }: { demo: boolean; canWrite: boolean }) {
  const query = useHqCatalog();
  const sandbox = useBillingSandbox();
  const data = demo ? DEMO_CATALOG : query.data;
  const drafts = data?.products.filter((p) => p.status === 'draft').length ?? 0;
  const active = data?.products.filter((p) => p.status === 'active').length ?? 0;
  return (
    <AdminPage>
      <Header
        title="Product catalog"
        sub="Products, pricing floors, costs and the fee assumptions behind every office minimum."
        sandbox={sandbox.data?.sandbox}
        action={
          canWrite ? (
            <Link href="/catalog/products/new" data-testid="button-catalog-add" className={`${BTN_PRIMARY} h-9 px-3.5`}>
              <Plus size={14} aria-hidden="true" />
              Add product
            </Link>
          ) : undefined
        }
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-72" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : data ? (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3" data-testid="catalog-tiles">
            <MetricTile label="Active products" value={String(active)} detail={`${data.products.length} in the catalog`} />
            <MetricTile label="Drafts" value={String(drafts)} detail={drafts ? 'Not visible to offices yet' : 'Everything is published'} />
            <MetricTile
              label="Offices below minimum"
              value={String(data.offices_below_minimum)}
              detail={data.offices_below_minimum ? 'Pricing under the break-even floor' : 'Every office price clears the minimum'}
            />
          </div>
          <ProductTable data={data} demo={demo} canWrite={canWrite} />
          <SettingsCard data={data} canWrite={canWrite} demo={demo} />
          <Link className="mt-4 inline-block text-xs font-semibold text-primary hover:underline" href="/catalog/history">
            View catalog change history
          </Link>
        </>
      ) : null}
    </AdminPage>
  );
}

const NEXT_ACTION: Partial<Record<ProductStatus, { label: string; status: ProductStatus }>> = {
  draft: { label: 'Publish', status: 'active' },
  active: { label: 'Retire', status: 'retired' },
  retired: { label: 'Reactivate', status: 'active' },
};

function ProductTable({ data, demo, canWrite }: { data: HqCatalogResponse; demo: boolean; canWrite: boolean }) {
  const mutations = useHqCatalogMutations();
  const { toast } = useToast();
  const working = useMemo(() => data.products.filter((p) => p.status !== 'archived'), [data.products]);
  const archived = useMemo(() => data.products.filter((p) => p.status === 'archived'), [data.products]);
  const serverOrder = working.map((p) => p.id).join('|');
  const [order, setOrder] = useState<string[]>(() => working.map((p) => p.id));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    setOrder(serverOrder ? serverOrder.split('|') : []);
  }, [serverOrder]);
  const byId = new Map(data.products.map((p) => [p.id, p]));
  const rows = order.map((id) => byId.get(id)).filter((p): p is CatalogProduct => Boolean(p));

  const previewOnly = () => toast({ title: 'Preview only', description: 'Sign in to change the live catalog.' });
  // Screen-reader announcement for keyboard moves and save outcomes.
  const [announcement, setAnnouncement] = useState('');
  // Reorder requests are serialized: while one is in flight the latest
  // requested order is parked and sent when the first settles, so quick
  // arrow presses cannot race and let an older order land last.
  const inFlight = useRef(false);
  const pending = useRef<string[] | null>(null);
  // Always read the archived ids current at send time (a product restored
  // while a request is in flight must not be listed twice).
  const archivedIds = useRef<string[]>([]);
  archivedIds.current = archived.map((p) => p.id);
  const send = (next: string[]) => {
    inFlight.current = true;
    const active = new Set(next);
    mutations.reorder.mutate([...next, ...archivedIds.current.filter((id) => !active.has(id))], {
      onError: (error) => {
        pending.current = null;
        const stale = error instanceof BillingApiError && error.status === 409;
        setAnnouncement(stale ? 'The catalog changed elsewhere; the order was reloaded.' : 'The new order was not saved.');
        toast({
          variant: 'destructive',
          title: 'Order not saved',
          description: stale ? 'The catalog changed while you were reordering. It has been reloaded.' : error.message,
        });
      },
      onSettled: () => {
        inFlight.current = false;
        const queued = pending.current;
        pending.current = null;
        if (queued) send(queued);
      },
    });
  };
  const commit = (next: string[]) => {
    if (next.join('|') === order.join('|')) return;
    setOrder(next);
    if (demo) {
      previewOnly();
      return;
    }
    if (inFlight.current) pending.current = next;
    else send(next);
  };
  const move = (id: string, delta: number) => {
    const index = order.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    const next = [...order];
    next.splice(index, 1);
    next.splice(target, 0, id);
    setAnnouncement(`${byId.get(id)?.name ?? 'Product'} moved to position ${target + 1} of ${order.length}.`);
    commit(next);
  };
  const dropOn = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    const next = order.filter((id) => id !== dragging);
    next.splice(next.indexOf(targetId), 0, dragging);
    commit(next);
  };
  const setStatus = (product: CatalogProduct, status: ProductStatus, title: string) => {
    if (demo) {
      previewOnly();
      return;
    }
    mutations.setStatus.mutate(
      { productId: product.id, status },
      {
        onSuccess: () => toast({ variant: 'success', title }),
        onError: (error) => toast({ variant: 'destructive', title: 'Change not saved', description: error.message }),
      },
    );
  };

  return (
    <>
      <SectionCard
        title="Products"
        sub={canWrite ? 'Drag a row, or focus its handle and use the arrow keys, to change the order offices see.' : 'In the order offices see them.'}
      >
        <p role="status" aria-live="polite" className="sr-only" data-testid="status-catalog-reorder">
          {announcement}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-xs" data-testid="table-catalog">
            <thead>
              <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                <th className="w-8 px-2 py-3" aria-label="Order" />
                <th className="px-3 py-3 text-left font-bold">Product</th>
                <th className="px-3 py-3 text-right font-bold">Floor</th>
                <th className="px-3 py-3 text-right font-bold">Hard cost</th>
                <th className="px-3 py-3 text-right font-bold">THINNR share</th>
                <th className="px-3 py-3 text-right font-bold">Office minimum</th>
                <th className="px-3 py-3 text-right font-bold">Profit / unit</th>
                <th className="px-3 py-3 text-right font-bold">Offices</th>
                <th className="px-3 py-3 text-left font-bold">Status</th>
                <th className="px-3 py-3 text-right font-bold">{canWrite ? 'Actions' : ''}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, index) => {
                const next = NEXT_ACTION[p.status];
                return (
                  <tr
                    key={p.id}
                    data-testid={`row-catalog-${p.id}`}
                    draggable={canWrite}
                    onDragStart={(event) => {
                      if (!canWrite) return;
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', p.id);
                      setDragging(p.id);
                    }}
                    onDragOver={(event) => {
                      if (!dragging) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      if (over !== p.id) setOver(p.id);
                    }}
                    onDragLeave={(event) => {
                      if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return;
                      if (over === p.id) setOver(null);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      dropOn(p.id);
                      setDragging(null);
                      setOver(null);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    className={`border-b border-border last:border-b-0 transition-colors ${
                      dragging === p.id ? 'opacity-50' : over === p.id ? 'bg-accent/40' : 'hover:bg-secondary/40'
                    }`}
                  >
                    <td className="px-2 py-2 align-middle">
                      {canWrite && (
                        <button
                          type="button"
                          aria-label={`Reorder ${p.name}: position ${index + 1} of ${rows.length}. Use the arrow keys to move.`}
                          data-testid={`handle-catalog-${p.id}`}
                          className="grid h-8 w-6 cursor-grab place-items-center rounded text-muted-foreground hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                          onKeyDown={(event) => {
                            if (event.key === 'ArrowUp') {
                              event.preventDefault();
                              move(p.id, -1);
                            } else if (event.key === 'ArrowDown') {
                              event.preventDefault();
                              move(p.id, 1);
                            }
                          }}
                        >
                          <GripVertical size={14} aria-hidden="true" />
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-3">
                        <ProductThumb src={p.image_url} name={p.name} />
                        <div className="min-w-0">
                          <Link href={`/catalog/products/${p.id}`} className="block truncate font-semibold text-navy hover:underline">
                            {p.name}
                          </Link>
                          <p className="max-w-[32ch] truncate text-[11px] text-muted-foreground">{p.tagline || p.description || 'No description yet'}</p>
                          <p className="max-w-[40ch] truncate text-[10px] text-muted-foreground" data-testid={`text-catalog-plan-${p.slug}`}>
                            {`${PRODUCT_CATEGORY_LABEL[p.category]} · ${cadenceSummary(p.offered_cadences_weeks, p.default_cadence_weeks)}`}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <MoneyCell cents={p.floor_price_cents} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <MoneyCell cents={p.hard_cost_cents} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <MoneyCell cents={p.thinnr_share_cents} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <MoneyCell cents={p.break_even_minimum_cents} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <MoneyCell cents={p.hq_profit_per_unit_cents} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {p.offices_offering}
                      {p.offices_below_minimum > 0 && (
                        <span className="ml-1 text-[10px] font-semibold text-warn">({p.offices_below_minimum} below)</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <ProductStatusPill status={p.status} />
                    </td>
                    <td className="px-3 py-2">
                      {canWrite && (
                        <div className="flex items-center justify-end gap-1.5">
                          <Link href={`/catalog/products/${p.id}`} className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}>
                            Edit
                          </Link>
                          {next && (
                            <button
                              type="button"
                              className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                              data-testid={`button-${next.label.toLowerCase()}-${p.id}`}
                              onClick={() => setStatus(p, next.status, `${p.name} ${next.label.toLowerCase().replace(/e?$/, 'ed')}`)}
                            >
                              {next.label}
                            </button>
                          )}
                          <button
                            type="button"
                            className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                            data-testid={`button-archive-${p.id}`}
                            aria-label={`Archive ${p.name}`}
                            onClick={() => setStatus(p, 'archived', `${p.name} archived`)}
                          >
                            <Archive size={12} aria-hidden="true" />
                            Archive
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="p-8 text-center text-xs text-muted-foreground">
                    No products yet. Add the first one to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
      {archived.length > 0 && (
        <SectionCard
          className="mt-5"
          title={`Archived products (${archived.length})`}
          sub="Kept for history. Restore one to bring it back as retired."
          action={
            <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`} onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
              {showArchived ? 'Hide' : 'Show'}
            </button>
          }
        >
          {showArchived && (
            <ul className="divide-y divide-border">
              {archived.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-5 py-3 text-xs" data-testid={`row-archived-${p.id}`}>
                  <ProductThumb src={p.image_url} name={p.name} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/catalog/products/${p.id}`} className="block truncate font-semibold text-navy hover:underline">
                      {p.name}
                    </Link>
                    <p className="text-[11px] text-muted-foreground">
                      Floor {formatCents(p.floor_price_cents)} · archived {formatDateTime(p.archived_at)}
                    </p>
                  </div>
                  <ProductStatusPill status={p.status} />
                  {canWrite && (
                    <button
                      type="button"
                      className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                      data-testid={`button-restore-${p.id}`}
                      onClick={() => setStatus(p, 'retired', `${p.name} restored`)}
                    >
                      <ArchiveRestore size={12} aria-hidden="true" />
                      Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
    </>
  );
}

function parseWholePercent(raw: string): number | null {
  const trimmed = raw.trim().replace(/%$/, '');
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= 90 ? value : null;
}

const PICK_PACK_TIERS: Array<{ id: PickPackTier; label: string }> = [
  { id: 'under_50', label: '<50/wk' },
  { id: 'from_51', label: '51–99' },
  { id: 'from_100', label: '100–249' },
  { id: 'from_250', label: '250–499' },
  { id: 'from_500', label: '500–1499' },
  { id: 'from_1500', label: '1500+' },
];
function suggestedTier(orders: number): PickPackTier {
  if (orders >= 1500) return 'from_1500';
  if (orders >= 500) return 'from_500';
  if (orders >= 250) return 'from_250';
  if (orders >= 100) return 'from_100';
  if (orders >= 51) return 'from_51';
  return 'under_50';
}

function ScheduleMoney({
  label,
  testId,
  input,
  help,
}: {
  label: string;
  testId: string;
  input: React.InputHTMLAttributes<HTMLInputElement>;
  help?: string;
}) {
  return (
    <label>
      <span className={FIELD_LABEL}>{label}</span>
      <MoneyInput data-testid={testId} {...input} />
      {help && <span className="mt-1 block text-[11px] text-muted-foreground">{help}</span>}
    </label>
  );
}

export function SettingsCard({ data, canWrite, demo }: { data: HqCatalogResponse; canWrite: boolean; demo: boolean }) {
  const mutation = useHqCatalogMutations().settings;
  const { toast } = useToast();
  const s = data.settings;
  const fromSettings = (settings: typeof s) => ({
    shipping_charge: centsToDollarsInput(settings.shipping_charge_cents),
    shipping_cost: centsToDollarsInput(settings.shipping_cost_cents),
    free_shipping_over: centsToDollarsInput(settings.free_shipping_over_cents),
    expedited_enabled: settings.expedited_enabled,
    pick_pack_tier: settings.pick_pack_tier,
    order_fees: Object.fromEntries(PICK_PACK_TIERS.map(({ id }) => [id, centsToDollarsInput(settings.pick_pack_schedule.order_fee_cents[id])])) as Record<PickPackTier, string>,
    unit_fee: centsToDollarsInput(settings.pick_pack_schedule.unit_cents),
    oversized_unit_fee: centsToDollarsInput(settings.pick_pack_schedule.oversized_unit_cents),
    overweight_pick_fee: centsToDollarsInput(settings.pick_pack_schedule.overweight_pick_cents),
    overweight_threshold_lb: String(settings.pick_pack_schedule.overweight_threshold_lb),
    packaging: centsToDollarsInput(settings.pick_pack_schedule.packaging_cents),
    pick_pack_pass_through_default: settings.pick_pack_pass_through_default,
    card_fee_percent: bpsToPercentInput(settings.card_fee_bps),
    card_fee_fixed: centsToDollarsInput(settings.card_fee_fixed_cents),
    subscribe_save_enabled: settings.subscribe_save_enabled,
    subscribe_save_percent: String(settings.subscribe_save_percent),
  });
  const [form, setForm] = useState(() => fromSettings(s));
  // The version we send is the one the fields were filled from, so a save
  // after someone else changed settings is refused (409) instead of silently
  // overwriting their numbers. Untouched forms follow the server.
  const [baseline, setBaseline] = useState(() => ({ version: s.version, form: fromSettings(s) }));
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline.form);
  // A newer server version only replaces an untouched form. While edits are
  // pending the baseline stays paired with the values the fields came from,
  // so saving is refused (409) rather than overwriting someone else's change;
  // the note below tells the editor to reload.
  const behind = s.version !== baseline.version;
  useEffect(() => {
    if (!behind || dirty) return;
    const next = fromSettings(s);
    setBaseline({ version: s.version, form: next });
    setForm(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [behind, dirty, s.version]);
  const discardEdits = () => {
    const next = fromSettings(s);
    setBaseline({ version: s.version, form: next });
    setForm(next);
    setError(null);
  };
  const [error, setError] = useState<string | null>(null);
  type TextKey = 'shipping_charge' | 'shipping_cost' | 'free_shipping_over' | 'unit_fee' | 'oversized_unit_fee' | 'overweight_pick_fee' | 'overweight_threshold_lb' | 'packaging' | 'card_fee_percent' | 'card_fee_fixed' | 'subscribe_save_percent';
  const field = (key: TextKey) => ({
    value: form[key],
    disabled: !canWrite,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      setError(null);
      setForm((x) => ({ ...x, [key]: event.target.value }));
    },
  });
  const save = () => {
    const charge = parseDollarsToCents(form.shipping_charge);
    const cost = parseDollarsToCents(form.shipping_cost);
    const freeOver = form.free_shipping_over.trim() ? parseDollarsToCents(form.free_shipping_over) : null;
    const percent = parsePercentToBps(form.card_fee_percent);
    const fixed = parseDollarsToCents(form.card_fee_fixed);
    if (!charge.ok) return setError(`Shipping charge: ${charge.error}`);
    if (!cost.ok) return setError(`Shipping cost: ${cost.error}`);
    if (freeOver && !freeOver.ok) return setError(`Free shipping above: ${freeOver.error}`);
    if (!percent.ok) return setError(`Card fee: ${percent.error}`);
    if (!fixed.ok) return setError(`Card fee fixed amount: ${fixed.error}`);
    const savePercent = parseWholePercent(form.subscribe_save_percent);
    if (savePercent === null) return setError('Subscribe-and-save discount: enter a whole number from 0 to 90.');
    const scheduleFields = {
      unit_cents: parseDollarsToCents(form.unit_fee),
      oversized_unit_cents: parseDollarsToCents(form.oversized_unit_fee),
      overweight_pick_cents: parseDollarsToCents(form.overweight_pick_fee),
      packaging_cents: parseDollarsToCents(form.packaging),
    };
    const badSchedule = Object.entries(scheduleFields).find(([, value]) => !value.ok);
    if (badSchedule && !badSchedule[1].ok) return setError(`Pick-and-pack schedule: ${badSchedule[1].error}`);
    const orderFees = Object.fromEntries(PICK_PACK_TIERS.map(({ id }) => [id, parseDollarsToCents(form.order_fees[id])])) as Record<PickPackTier, ReturnType<typeof parseDollarsToCents>>;
    const badTier = PICK_PACK_TIERS.find(({ id }) => !orderFees[id].ok);
    if (badTier) {
      const badFee = orderFees[badTier.id];
      if (!badFee.ok) return setError(`${badTier.label} order fee: ${badFee.error}`);
    }
    const threshold = Number(form.overweight_threshold_lb);
    if (!Number.isFinite(threshold) || threshold <= 0) return setError('Overweight threshold: enter a positive number of pounds.');
    if (demo) {
      toast({ title: 'Preview only', description: 'Sign in to change live payment settings.' });
      return;
    }
    mutation.mutate(
      {
        shipping_charge_cents: charge.cents,
        shipping_cost_cents: cost.cents,
        free_shipping_over_cents: freeOver?.ok ? freeOver.cents : null,
        expedited_enabled: form.expedited_enabled,
        pick_pack_tier: form.pick_pack_tier,
        pick_pack_schedule: {
          order_fee_cents: Object.fromEntries(PICK_PACK_TIERS.map(({ id }) => [id, orderFees[id].ok ? orderFees[id].cents : 0])) as Record<PickPackTier, number>,
          unit_cents: scheduleFields.unit_cents.ok ? scheduleFields.unit_cents.cents : 0,
          oversized_unit_cents: scheduleFields.oversized_unit_cents.ok ? scheduleFields.oversized_unit_cents.cents : 0,
          overweight_pick_cents: scheduleFields.overweight_pick_cents.ok ? scheduleFields.overweight_pick_cents.cents : 0,
          overweight_threshold_lb: threshold,
          packaging_cents: scheduleFields.packaging_cents.ok ? scheduleFields.packaging_cents.cents : 0,
        },
        pick_pack_pass_through_default: form.pick_pack_pass_through_default,
        card_fee_bps: percent.bps,
        card_fee_fixed_cents: fixed.cents,
        subscribe_save_enabled: form.subscribe_save_enabled,
        subscribe_save_percent: savePercent,
        expected_version: baseline.version,
      },
      {
        onSuccess: (result) => {
          // Our own save is the new baseline; the refetched query will match.
          const next = fromSettings(result.settings);
          setBaseline({ version: result.settings.version, form: next });
          setForm(next);
          toast({ variant: 'success', title: 'Program settings saved' });
        },
      },
    );
  };
  return (
    <SectionCard
      className="mt-5"
      title="Program settings"
      sub="Shipping and card fee assumptions drive every office minimum. Amounts are in dollars."
    >
      <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className={FIELD_LABEL}>Shipping charged to patients (fallback when live rates are unavailable)</span>
          <MoneyInput data-testid="input-settings-shipping-charge" {...field('shipping_charge')} />
        </label>
        <label className="block">
          <span className={FIELD_LABEL}>Shipping cost to THINNR</span>
          <MoneyInput data-testid="input-settings-shipping-cost" {...field('shipping_cost')} />
        </label>
        <label className="block">
          <span className={FIELD_LABEL}>Free shipping above</span>
          <MoneyInput data-testid="input-settings-free-shipping-over" placeholder="Never" {...field('free_shipping_over')} />
          <span className="mt-1 block text-[11px] text-muted-foreground">Blank means never.</span>
        </label>
        <label className="block">
          <span className={FIELD_LABEL}>Card fee rate</span>
          <PercentInput data-testid="input-settings-card-fee-percent" {...field('card_fee_percent')} />
        </label>
        <label className="block">
          <span className={FIELD_LABEL}>Card fee per payment</span>
          <MoneyInput data-testid="input-settings-card-fee-fixed" {...field('card_fee_fixed')} />
        </label>
      </div>
      <div className="space-y-5 border-t border-border px-5 py-5" data-testid="settings-shipping-rules">
        <label className="flex items-center gap-3 text-xs font-semibold text-navy">
          <input
            type="checkbox"
            data-testid="checkbox-settings-expedited"
            checked={form.expedited_enabled}
            disabled={!canWrite}
            onChange={(event) => setForm((current) => ({ ...current, expedited_enabled: event.target.checked }))}
          />
          Expedited (USPS Priority Mail) offered
        </label>
        <fieldset>
          <legend className="text-sm font-semibold text-navy">Pick-and-pack schedule</legend>
          <p className="mt-1 text-[11px] text-muted-foreground" data-testid="text-pick-pack-tier-hint">
            Trailing 7 days: {s.weekly_paid_orders} paid orders → suggests {PICK_PACK_TIERS.find((tier) => tier.id === suggestedTier(s.weekly_paid_orders))?.label}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PICK_PACK_TIERS.map(({ id, label }) => (
              <label key={id} className="rounded-md border border-border p-3 text-xs">
                <span className="flex items-center gap-2 font-semibold text-navy">
                  <input
                    type="radio"
                    name="pick-pack-tier"
                    value={id}
                    checked={form.pick_pack_tier === id}
                    disabled={!canWrite}
                    onChange={() => setForm((current) => ({ ...current, pick_pack_tier: id }))}
                  />
                  {label}
                </span>
                <MoneyInput
                  className="mt-2"
                  aria-label={`${label} order fee`}
                  data-testid={`input-settings-order-fee-${id}`}
                  value={form.order_fees[id]}
                  disabled={!canWrite}
                  onChange={(event) => setForm((current) => ({ ...current, order_fees: { ...current.order_fees, [id]: event.target.value } }))}
                />
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <ScheduleMoney label="Unit fee" testId="input-settings-unit-fee" input={field('unit_fee')} />
          <ScheduleMoney label="Oversized unit fee" testId="input-settings-oversized-unit-fee" input={field('oversized_unit_fee')} />
          <ScheduleMoney label="Overweight pick" testId="input-settings-overweight-pick-fee" input={field('overweight_pick_fee')} />
          <label>
            <span className={FIELD_LABEL}>Overweight threshold lb</span>
            <input type="number" min="1" step="0.1" data-testid="input-settings-overweight-threshold" className="mt-1 h-9 w-full rounded-md border border-border bg-card px-3 text-sm" {...field('overweight_threshold_lb')} />
          </label>
          <ScheduleMoney label="Packaging allowance" testId="input-settings-packaging" input={field('packaging')} help="Cost + 10%, TBD" />
        </div>
        <label className="flex items-center gap-3 text-xs font-semibold text-navy">
          <input
            type="checkbox"
            data-testid="checkbox-settings-pick-pack-pass-through"
            checked={form.pick_pack_pass_through_default}
            disabled={!canWrite}
            onChange={(event) => setForm((current) => ({ ...current, pick_pack_pass_through_default: event.target.checked }))}
          />
          Patients pay the pick-and-pack fee by default
        </label>
      </div>
      <div className="border-t border-border px-5 py-4" data-testid="settings-subscribe-save">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <label className="flex items-start gap-3 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              data-testid="checkbox-settings-subscribe-save"
              checked={form.subscribe_save_enabled}
              disabled={!canWrite}
              onChange={(event) => {
                setError(null);
                setForm((x) => ({ ...x, subscribe_save_enabled: event.target.checked }));
              }}
            />
            <span>
              <b className="block font-semibold text-navy">Subscribe and save</b>
              <span className="text-muted-foreground">
                {form.subscribe_save_enabled
                  ? 'Subscriptions are quoted at the office price minus this discount, on every cadence.'
                  : 'Off: subscriptions charge the full office price and no discount is shown anywhere.'}
              </span>
            </span>
          </label>
          <label className="block">
            <span className={FIELD_LABEL}>Discount</span>
            <PercentInput
              data-testid="input-settings-subscribe-save-percent"
              {...field('subscribe_save_percent')}
              disabled={!canWrite || !form.subscribe_save_enabled}
              aria-describedby="settings-subscribe-save-help"
            />
            <span id="settings-subscribe-save-help" className="mt-1 block text-[11px] text-muted-foreground">
              Whole percent, 0 to 90. Kept while the switch is off.
            </span>
          </label>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
        {canWrite && (
          <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-settings-save" disabled={mutation.isPending} onClick={save}>
            {mutation.isPending ? 'Saving…' : 'Save settings'}
          </button>
        )}
        <p className="text-[11px] text-muted-foreground">
          Version {s.version}
          {s.updated_at ? ` · last changed ${formatDateTime(s.updated_at)}` : ''}
        </p>
        {behind && dirty && (
          <p role="status" className="basis-full text-xs text-warn" data-testid="text-settings-behind">
            Someone else changed these settings while you were editing. Saving will be refused;{' '}
            <button type="button" className="underline underline-offset-2" onClick={discardEdits} data-testid="button-settings-discard">
              discard your edits
            </button>{' '}
            to load the latest values.
          </p>
        )}
        {(error || mutation.error) && (
          <p role="alert" className="basis-full text-xs text-destructive">
            {error ??
              (mutation.error instanceof BillingApiError && mutation.error.status === 409
                ? 'Someone else changed these settings. Discard your edits to see the latest.'
                : mutation.error?.message)}
          </p>
        )}
      </div>
    </SectionCard>
  );
}
