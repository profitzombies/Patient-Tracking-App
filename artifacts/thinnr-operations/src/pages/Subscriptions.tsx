import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Search, Filter, Box, AlertCircle, CheckCircle2, PackageOpen } from "lucide-react";
import { MOCK_PRODUCTS } from "@/data/mock-data";
import { useScopedPatients, useScopedSubscriptions } from "@/data/scoped-data";
import { useToast } from "@/hooks/use-toast";
import { addDaysToKey, keyToDate, useDateRange } from "@/contexts/date-range";

/**
 * Deterministic date rendering: every subscription timestamp is a UTC-noon ISO
 * string seeded from the fixed demo anchor, so its first 10 characters are the
 * canonical date key. Formatting goes through a local-noon Date (keyToDate) so
 * the same calendar day renders in every timezone — never through the viewer's
 * clock.
 */
const isoToKey = (iso: string) => iso.slice(0, 10);
const formatKey = (key: string, withYear = false) =>
  keyToDate(key).toLocaleDateString('en-US', withYear
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' });

function ProductImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  return failed ? (
    <PackageOpen size={20} className="text-muted-foreground" aria-label={`${alt} image unavailable`} />
  ) : (
    <img
      src={src}
      alt={alt}
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

export default function Subscriptions() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const { toast } = useToast();
  const { range } = useDateRange();
  // One office's book of business inside the HQ drill-in; program-wide otherwise.
  const patients = useScopedPatients();
  const subs = useScopedSubscriptions();

  const filteredSubs = useMemo(() => subs.filter((subscription) => {
    const patient = patients.find((candidate) => candidate.id === subscription.patientId);
    const matchesStatus = statusFilter === 'all' || subscription.status === statusFilter;
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery = !normalizedQuery || patient?.name.toLowerCase().includes(normalizedQuery) || subscription.id.toLowerCase().includes(normalizedQuery);
    return matchesStatus && matchesQuery;
  }), [subs, patients, query, statusFilter]);

  // Upcoming shipments are counted against the shared operations range, not the
  // viewer's clock: the 7 demo days immediately after the selected window ends.
  // With the default range (ending on the fixed demo anchor) this reads as
  // "due in the next 7 days", and it stays stable in every timezone.
  const upcomingWindow = useMemo(() => ({
    start: addDaysToKey(range.end, 1),
    end: addDaysToKey(range.end, 7),
  }), [range.end]);
  const upcomingCount = useMemo(() => subs.filter((subscription) => {
    const shipKey = isoToKey(subscription.nextShipment);
    return subscription.status === 'active' && shipKey >= upcomingWindow.start && shipKey <= upcomingWindow.end;
  }).length, [subs, upcomingWindow]);

  const getStatusColor = (status: string) => {
    if (status === 'active') return "border-accent-border bg-accent text-primary";
    if (status === 'paused') return "border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]";
    return "border-destructive/30 bg-destructive/10 text-destructive";
  };

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[32px] leading-none tracking-[-.02em] text-navy">Subscriptions</h1>
          <p className="mt-2 text-sm text-muted-foreground">Manage recurring supplement deliveries and billing.</p>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-3 mb-6">
        <div className="flex items-center gap-4 rounded-lg border border-card-border bg-card p-4 shadow-soft">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
            <CheckCircle2 size={20} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">Active Subs</p>
            <p className="mt-0.5 font-serif text-[26px] leading-none text-navy" data-testid="text-kpi-active-subs">
              {subs.filter(s => s.status === 'active').length}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">Recurring monthly deliveries</p>
          </div>
        </div>
        <div className="flex items-center gap-4 rounded-lg border border-card-border bg-card p-4 shadow-soft">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-destructive/10 text-destructive" aria-hidden="true">
            <AlertCircle size={20} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">Action Needed</p>
            <p className="mt-0.5 font-serif text-[26px] leading-none text-destructive" data-testid="text-kpi-action-needed">
              {subs.filter(s => s.status === 'overdue' || s.paymentStatus === 'failed').length}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">Overdue or failed payment</p>
          </div>
        </div>
        <div className="flex items-center gap-4 rounded-lg border border-card-border bg-card p-4 shadow-soft">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
            <Box size={20} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">Upcoming Shipments</p>
            <p className="mt-0.5 font-serif text-[26px] leading-none text-navy" data-testid="text-kpi-upcoming-shipments">
              {upcomingCount}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground" data-testid="text-upcoming-window">
              Due {formatKey(upcomingWindow.start)} – {formatKey(upcomingWindow.end)}
            </p>
          </div>
        </div>
      </div>

      <section className="mb-6 overflow-hidden rounded-lg border border-card-border bg-card shadow-soft">
        <div className="border-b border-border bg-paper-alt p-4">
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">THINNR catalog</p>
          <div className="mt-1 flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
            <div>
              <h2 className="font-serif text-xl leading-tight text-navy">Products in monthly delivery plans</h2>
              <p className="mt-1 text-xs text-muted-foreground">Public product imagery and source-aligned descriptions from THINNR.</p>
            </div>
            <span className="inline-flex w-fit items-center rounded-sm border border-border bg-secondary px-2 py-0.5 font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground">Mock pricing</span>
          </div>
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {MOCK_PRODUCTS.map((product) => (
            <article key={product.id} className="flex min-h-[238px] flex-col bg-card p-4 transition-colors hover:bg-secondary" data-testid={`card-product-${product.id}`}>
              <div className="mb-4 flex h-24 items-center justify-center overflow-hidden rounded-md border border-border bg-white">
                <ProductImage src={product.imageUrl} alt={`${product.name} by THINNR`} />
              </div>
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-serif text-[15px] leading-snug text-navy">{product.name}</h3>
                <span className="whitespace-nowrap font-mono text-xs font-semibold text-primary">${product.price}/mo</span>
              </div>
              <p className="mt-2 flex-1 text-[11px] leading-4 text-muted-foreground">{product.description}</p>
              <span className="mt-3 text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground">{product.category}</span>
            </article>
          ))}
          {/* Filler cell: with 9 products, the 2-col (sm/md) and 5-col (xl) grids
              leave one trailing slot; fill it with card paper so the hairline
              background never reads as a colored slab. Hidden where rows divide
              evenly (1-col base, 3-col lg). */}
          <div aria-hidden="true" className="hidden bg-card sm:block lg:hidden xl:block" />
        </div>
        <p className="border-t border-border bg-paper-alt px-4 py-3 text-[10px] leading-4 text-muted-foreground">
          *Homeopathic claims are based on traditional homeopathic principles and have not been evaluated by the FDA. **These statements have not been evaluated by the FDA. This synthetic operations demo does not provide medical advice.
        </p>
      </section>

      <div className="overflow-hidden rounded-lg border border-card-border bg-card shadow-soft">
        <div className="flex flex-col gap-3 border-b border-border bg-paper-alt p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center text-xs font-semibold text-muted-foreground">
              <Filter size={14} className="mr-1.5 text-primary" aria-hidden="true" /> View:
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              data-testid="select-subscription-status"
              className="h-9 rounded-md border border-border bg-card px-2.5 text-xs font-semibold text-navy shadow-xs outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">All Subscriptions</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="overdue">Overdue / Failed</option>
            </select>
          </div>
          <label className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-border bg-card px-3 shadow-xs transition focus-within:ring-2 focus-within:ring-ring sm:w-64">
            <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Search subscriptions</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search patient or ID"
              data-testid="input-subscription-search"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-xs min-w-[900px]">
            <thead className="border-b border-border bg-paper-alt text-[10px] uppercase tracking-[.11em] text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-semibold w-1/4">Patient</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">Products</th>
                <th className="px-5 py-3 font-semibold">Monthly Value</th>
                <th className="px-5 py-3 font-semibold">Next Shipment</th>
                <th className="px-5 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredSubs.map((sub) => {
                const patient = patients.find(p => p.id === sub.patientId);
                const isFailed = sub.paymentStatus === 'failed';

                return (
                  <tr key={sub.id} className="transition-colors hover:bg-accent/40" data-testid={`row-subscription-${sub.id}`}>
                    <td className="px-5 py-4">
                      <Link href={`/patients/${patient?.id}`} className="block rounded-sm font-semibold text-navy hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        {patient?.name}
                      </Link>
                      <span className="font-mono text-[10px] text-muted-foreground">{sub.id}</span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-col items-start gap-1">
                        <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${getStatusColor(sub.status)}`}>
                          {sub.status}
                        </span>
                        {isFailed && (
                          <span className="flex items-center gap-1 text-[10px] font-semibold text-destructive">
                            <AlertCircle size={10} aria-hidden="true" /> Payment Failed
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex -space-x-2">
                        {sub.products.slice(0,3).map(pid => {
                          const prod = MOCK_PRODUCTS.find(p => p.id === pid);
                          return (
                            <div key={pid} title={prod?.name} className="h-8 w-8 overflow-hidden rounded-full border border-border bg-white shadow-xs">
                              {prod?.imageUrl ? <ProductImage src={prod.imageUrl} alt={`${prod.name} product`} /> : <Box size={14} className="m-auto mt-2 text-muted-foreground" />}
                            </div>
                          );
                        })}
                        {sub.products.length > 3 && (
                          <div className="z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-secondary text-[10px] font-bold text-secondary-foreground">
                            +{sub.products.length - 3}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4 font-mono font-semibold text-navy">
                      ${sub.monthlyValue}
                    </td>
                    <td className="px-5 py-4 text-muted-foreground">
                      {formatKey(isoToKey(sub.nextShipment), true)}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <button
                        onClick={() => toast({ title: `${patient?.name} subscription opened`, description: "Demo mode keeps changes in this session only." })}
                        data-testid={`button-manage-${sub.id}`}
                        className="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-primary shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Manage
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredSubs.length === 0 && (
            <div className="p-8 text-center text-xs text-muted-foreground" data-testid="text-empty-subscriptions">No subscriptions match this view.</div>
          )}
        </div>
        <div className="divide-y divide-border md:hidden">
          {filteredSubs.map((subscription) => {
            const patient = patients.find((candidate) => candidate.id === subscription.patientId);
            return (
              <article key={subscription.id} className="p-4" data-testid={`card-subscription-${subscription.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/patients/${patient?.id}`} className="rounded-sm font-serif text-base leading-tight text-navy hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {patient?.name}
                    </Link>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">{subscription.id}</p>
                  </div>
                  <span className={`inline-flex rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${getStatusColor(subscription.status)}`}>
                    {subscription.status}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground">Monthly value</p>
                    <p className="mt-1 font-mono font-semibold text-navy">${subscription.monthlyValue}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-muted-foreground">Next shipment</p>
                    <p className="mt-1 text-muted-foreground">{formatKey(isoToKey(subscription.nextShipment), true)}</p>
                  </div>
                </div>
                <button
                  onClick={() => toast({ title: `${patient?.name} subscription opened`, description: "Demo mode keeps changes in this session only." })}
                  data-testid={`button-manage-mobile-${subscription.id}`}
                  className="mt-4 w-full rounded-md border border-border bg-card px-3 py-2 text-xs font-semibold text-primary shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Manage subscription
                </button>
              </article>
            );
          })}
          {filteredSubs.length === 0 && (
            <div className="p-8 text-center text-xs text-muted-foreground" data-testid="text-empty-subscriptions-mobile">No subscriptions match this view.</div>
          )}
        </div>
      </div>
    </div>
  );
}
