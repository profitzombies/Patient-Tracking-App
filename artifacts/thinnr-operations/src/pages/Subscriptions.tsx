import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Search, Filter, Box, AlertCircle, CheckCircle2, PackageOpen } from "lucide-react";
import { MOCK_PATIENTS, MOCK_PRODUCTS, MOCK_SUBSCRIPTIONS } from "@/data/mock-data";
import { useToast } from "@/hooks/use-toast";

function ProductImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  return failed ? (
    <PackageOpen size={20} className="text-[#8793a8]" aria-label={`${alt} image unavailable`} />
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

  const filteredSubs = useMemo(() => MOCK_SUBSCRIPTIONS.filter((subscription) => {
    const patient = MOCK_PATIENTS.find((candidate) => candidate.id === subscription.patientId);
    const matchesStatus = statusFilter === 'all' || subscription.status === statusFilter;
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery = !normalizedQuery || patient?.name.toLowerCase().includes(normalizedQuery) || subscription.id.toLowerCase().includes(normalizedQuery);
    return matchesStatus && matchesQuery;
  }), [query, statusFilter]);

  const getStatusColor = (status: string) => {
    if (status === 'active') return "bg-[#eef3fc] text-[#3156a2] border-[#aebfe0]";
    if (status === 'paused') return "bg-[#fff6e5] text-[#97631e] border-[#d7b889]";
    return "bg-[#fff0f0] text-[#a04646] border-[#d5a7a7]";
  };

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[32px] leading-none tracking-[-.04em] text-[#172c56]">Subscriptions</h1>
          <p className="mt-2 text-sm text-[#718099]">Manage recurring supplement deliveries and billing.</p>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-3 mb-6">
        <div className="border border-[#bdc9dc] bg-[#fbfcff] p-4 flex items-center gap-4">
          <div className="p-3 bg-[#eef3fc] text-[#3156a2]">
            <CheckCircle2 size={24} />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#74839d]">Active Subs</p>
            <p className="text-2xl font-mono font-semibold text-[#172c56]">
              {MOCK_SUBSCRIPTIONS.filter(s => s.status === 'active').length}
            </p>
          </div>
        </div>
        <div className="border border-[#bdc9dc] bg-[#fbfcff] p-4 flex items-center gap-4">
          <div className="p-3 bg-[#fff0f0] text-[#a04646]">
            <AlertCircle size={24} />
          </div>
          <div>
             <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#74839d]">Action Needed</p>
             <p className="text-2xl font-mono font-semibold text-[#a04646]">
              {MOCK_SUBSCRIPTIONS.filter(s => s.status === 'overdue' || s.paymentStatus === 'failed').length}
            </p>
          </div>
        </div>
        <div className="border border-[#bdc9dc] bg-[#fbfcff] p-4 flex items-center gap-4">
          <div className="p-3 bg-[#f8f9fc] text-[#53698f]">
            <Box size={24} />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#74839d]">Upcoming Shipments</p>
            <p className="text-2xl font-mono font-semibold text-[#172c56]">
              {MOCK_SUBSCRIPTIONS.filter(s => new Date(s.nextShipment) < new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) && s.status === 'active').length}
            </p>
          </div>
        </div>
      </div>

      <section className="mb-6 border border-[#bdc9dc] bg-[#fbfcff]">
        <div className="border-b border-[#bdc9dc] bg-[#f8f9fc] p-4">
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#74839d]">THINNR catalog</p>
          <div className="mt-1 flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
            <div>
              <h2 className="text-lg font-semibold tracking-[-.03em] text-[#284675]">Products in monthly delivery plans</h2>
              <p className="mt-1 text-xs text-[#718099]">Public product imagery and source-aligned descriptions from THINNR.</p>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-[.12em] text-[#7b879d]">Mock pricing</span>
          </div>
        </div>
        <div className="grid gap-px bg-[#dfe5ef] sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {MOCK_PRODUCTS.map((product) => (
            <article key={product.id} className="flex min-h-[238px] flex-col bg-[#fbfcff] p-4 transition-colors hover:bg-[#f0f3f9]">
              <div className="mb-4 flex h-24 items-center justify-center overflow-hidden border border-[#e4e8f0] bg-white">
                <ProductImage src={product.imageUrl} alt={`${product.name} by THINNR`} />
              </div>
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-bold text-[#172c56]">{product.name}</h3>
                <span className="whitespace-nowrap font-mono text-xs font-semibold text-[#315fc0]">${product.price}/mo</span>
              </div>
              <p className="mt-2 flex-1 text-[11px] leading-4 text-[#718099]">{product.description}</p>
              <span className="mt-3 text-[9px] font-bold uppercase tracking-[.12em] text-[#8793a8]">{product.category}</span>
            </article>
          ))}
        </div>
        <p className="border-t border-[#dfe5ef] px-4 py-3 text-[10px] leading-4 text-[#7b879d]">
          *Homeopathic claims are based on traditional homeopathic principles and have not been evaluated by the FDA. **These statements have not been evaluated by the FDA. This synthetic operations demo does not provide medical advice.
        </p>
      </section>

      <div className="border border-[#bdc9dc] bg-[#fbfcff]">
        <div className="flex flex-col gap-3 border-b border-[#bdc9dc] bg-[#f8f9fc] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
             <div className="flex items-center text-xs font-semibold text-[#53698f]">
              <Filter size={14} className="mr-1.5" /> View:
            </div>
            <select 
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-8 border border-[#bdc9dc] bg-[#fbfcff] px-2 text-xs text-[#1b2f55] outline-none focus:border-[#315fc0]"
            >
              <option value="all">All Subscriptions</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="overdue">Overdue / Failed</option>
            </select>
          </div>
          <label className="flex h-9 min-w-0 items-center gap-2 border border-[#bdc9dc] bg-[#fbfcff] px-3 sm:w-64">
            <Search size={14} className="shrink-0 text-[#7b879d]" />
            <span className="sr-only">Search subscriptions</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search patient or ID"
              className="min-w-0 flex-1 bg-transparent text-xs text-[#1b2f55] outline-none placeholder:text-[#9aa5b7]"
            />
          </label>
        </div>
        
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-xs min-w-[900px]">
             <thead className="border-b border-[#d5deeb] bg-[#f8f9fc] text-[10px] uppercase tracking-[.11em] text-[#8290a7]">
              <tr>
                <th className="px-5 py-3 font-semibold w-1/4">Patient</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">Products</th>
                <th className="px-5 py-3 font-semibold">Monthly Value</th>
                <th className="px-5 py-3 font-semibold">Next Shipment</th>
                <th className="px-5 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e4e8f0]">
              {filteredSubs.map((sub) => {
                const patient = MOCK_PATIENTS.find(p => p.id === sub.patientId);
                const isFailed = sub.paymentStatus === 'failed';
                
                return (
                  <tr key={sub.id} className="hover:bg-[#f0f3f9] transition-colors">
                    <td className="px-5 py-4">
                      <Link href={`/patients/${patient?.id}`} className="font-semibold text-[#172c56] hover:text-[#315fc0] hover:underline block">
                        {patient?.name}
                      </Link>
                      <span className="text-[10px] text-[#8793a8] font-mono">{sub.id}</span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-col items-start gap-1">
                        <span className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${getStatusColor(sub.status)}`}>
                          {sub.status}
                        </span>
                        {isFailed && (
                          <span className="text-[10px] font-semibold text-[#a04646] flex items-center gap-1">
                            <AlertCircle size={10} /> Payment Failed
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex -space-x-2">
                        {sub.products.slice(0,3).map(pid => {
                          const prod = MOCK_PRODUCTS.find(p => p.id === pid);
                          return (
                            <div key={pid} title={prod?.name} className="w-8 h-8 rounded-full border border-[#bdc9dc] bg-white overflow-hidden shadow-sm">
                              {prod?.imageUrl ? <ProductImage src={prod.imageUrl} alt={`${prod.name} product`} /> : <Box size={14} className="m-auto mt-2 text-[#8793a8]" />}
                            </div>
                          );
                        })}
                        {sub.products.length > 3 && (
                          <div className="w-8 h-8 rounded-full border border-[#bdc9dc] bg-[#f8f9fc] text-[10px] font-bold text-[#53698f] flex items-center justify-center z-10">
                            +{sub.products.length - 3}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4 font-mono text-[#284675] font-semibold">
                      ${sub.monthlyValue}
                    </td>
                    <td className="px-5 py-4 text-[#53698f]">
                      {new Date(sub.nextShipment).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-4 text-right">
                       <button
                         onClick={() => toast({ title: `${patient?.name} subscription opened`, description: "Demo mode keeps changes in this session only." })}
                         className="text-[11px] font-semibold text-[#3156a2] hover:text-[#172c56] border border-[#bdc9dc] px-2 py-1 bg-white hover:bg-[#e9eef8]"
                       >
                        Manage
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-[#e4e8f0] md:hidden">
          {filteredSubs.map((subscription) => {
            const patient = MOCK_PATIENTS.find((candidate) => candidate.id === subscription.patientId);
            return (
              <article key={subscription.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Link href={`/patients/${patient?.id}`} className="text-sm font-bold text-[#172c56] hover:text-[#315fc0]">
                      {patient?.name}
                    </Link>
                    <p className="mt-1 font-mono text-[10px] text-[#8793a8]">{subscription.id}</p>
                  </div>
                  <span className={`inline-flex border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${getStatusColor(subscription.status)}`}>
                    {subscription.status}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Monthly value</p>
                    <p className="mt-1 font-mono font-semibold text-[#284675]">${subscription.monthlyValue}</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8793a8]">Next shipment</p>
                    <p className="mt-1 text-[#53698f]">{new Date(subscription.nextShipment).toLocaleDateString()}</p>
                  </div>
                </div>
                <button
                  onClick={() => toast({ title: `${patient?.name} subscription opened`, description: "Demo mode keeps changes in this session only." })}
                  className="mt-4 w-full border border-[#bdc9dc] bg-white px-3 py-2 text-xs font-semibold text-[#3156a2] hover:bg-[#e9eef8]"
                >
                  Manage subscription
                </button>
              </article>
            );
          })}
          {filteredSubs.length === 0 && (
            <div className="p-8 text-center text-xs text-[#718099]">No subscriptions match this view.</div>
          )}
        </div>
      </div>
    </div>
  );
}
