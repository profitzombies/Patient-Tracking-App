/**
 * Provider accounts — every sub-account under the THINNR umbrella.
 *
 * Rows and additions are durable live provider records. Existing imported
 * rows may have intentionally unavailable account fields.
 *
 * The All-accounts header carries a URL-persisted directory search (?q=…,
 * replace-navigation per keystroke — the input's value IS the parsed param,
 * so reloads and shared links restore the view). Matching is the pure,
 * punctuation-tolerant matcher in data/hq/accounts. Each row is also a
 * pointer-only click target for the account detail page; the trailing Open
 * link stays the row's one announced, keyboard-reachable control.
 */
import { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Check, ChevronsUpDown, Plus, Search, X } from 'lucide-react';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { AccountLockedChip, AccountStatusChip, AdminPage, PageHeader } from '@/components/admin/primitives';
import { useAccountLocks } from '@/contexts/account-locks';
import { useHqData } from '@/contexts/hq-data';
import { accountMatchesQuery, accountSearchHaystack, monthlyRevenueOf, type AccountPlan } from '@/data/hq/accounts';
import { ProviderAccountError } from '@/lib/provider-accounts';
import { formatDateKey } from '@/data/nutrition-data';
import { useSession } from '@/contexts/session';
import { US_STATES, normalizeUsState, formatUsPhone, isValidUsPhone, isValidUsPostalCode, normalizeUsPostalCode, usStateName } from '@/lib/us-contact';

const fmt = (value: number) => value.toLocaleString('en-US');
const PLANS: AccountPlan[] = ['Core', 'Plus', 'Concierge'];
type StatusFilter = 'active' | 'offboarded' | 'all';

const EMPTY_FORM = {
  officeName: '',
  providerName: '',
  providerRole: 'Practitioner',
  address1: '',
  address2: '',
  city: '',
  state: '',
  postalCode: '',
  email: '',
  phone: '',
};

export default function Accounts() {
  const { accounts, accountsStatus, accountsError, addAccount, settingsValues } = useHqData();
  const { authStatus, hqRole } = useSession();
  const { isLocked } = useAccountLocks();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  // ?q= is the single source of truth for the directory search — the input's
  // value IS the parsed param, so reloads and shared URLs restore the view.
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const query = searchParams.get('q') ?? '';
  const requestedStatus = searchParams.get('status');
  const statusFilter: StatusFilter = requestedStatus === 'all' || requestedStatus === 'offboarded'
    ? requestedStatus
    : 'active';
  const updateParams = (update: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchString);
    update(params);
    const encoded = params.toString();
    navigate(encoded ? `/admin/accounts?${encoded}` : '/admin/accounts', { replace: true });
  };
  const setQuery = (next: string) => {
    updateParams((params) => {
      if (next) params.set('q', next);
      else params.delete('q');
    });
  };
  const setStatusFilter = (next: StatusFilter) => {
    updateParams((params) => {
      if (next === 'active') params.delete('status');
      else params.set('status', next);
    });
  };

  // Corpora build once per directory load; matching is per keystroke.
  const searchableAccounts = useMemo(
    () => accounts.map((account) => ({
      account,
      haystack: accountSearchHaystack(account, { locked: isLocked(account.id) }),
    })),
    [accounts, isLocked],
  );
  const visibleAccounts = useMemo(
    () => searchableAccounts
      .filter(({ account }) => statusFilter === 'all'
        || (statusFilter === 'offboarded' ? account.status === 'offboarded' : account.status !== 'offboarded'))
      .filter(({ haystack }) => accountMatchesQuery(haystack, query))
      .map(({ account }) => account),
    [searchableAccounts, query, statusFilter],
  );

  const [open, setOpen] = useState(false);
  const [stateOpen, setStateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  // The org setting seeds the plan choice — a small proof the settings page
  // actually feeds the rest of the demo.
  const defaultPlan = (settingsValues['provider-accounts.default-plan'] as AccountPlan) ?? 'Plus';
  const [plan, setPlan] = useState<AccountPlan>(defaultPlan);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const canManageAccounts = authStatus === 'signed-out' || hqRole === 'Super Admin' || hqRole === 'Admin';

  const openDialog = () => {
    setForm(EMPTY_FORM);
    setPlan(defaultPlan);
    setFormError(null);
    setOpen(true);
  };

  const setField = (key: keyof typeof EMPTY_FORM) => (event: React.ChangeEvent<HTMLInputElement>) => {
    let value = event.target.value;
    if (key === 'phone') value = formatUsPhone(value);
    // Digits only, capped at a ZIP+4 (12345-6789) so the field can't grow.
    if (key === 'postalCode') value = normalizeUsPostalCode(value);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async () => {
    if (submitting) return;
    const officeName = form.officeName.trim();
    const providerName = form.providerName.trim();
    const address1 = form.address1.trim();
    const address2 = form.address2.trim();
    const city = form.city.trim();
    const state = normalizeUsState(form.state);
    const postalCode = form.postalCode.trim();
    const email = form.email.trim().toLowerCase();
    const phone = form.phone.trim();

    if (!officeName || !providerName || !address1 || !city || !state || !postalCode || !email || !phone) {
      setFormError('Office name, provider name, Address 1, City, State, ZIP, claim email, and office phone are required.');
      return;
    }
    if (!isValidUsPostalCode(postalCode)) {
      setFormError('Please enter a valid 5-digit ZIP code.');
      return;
    }
    if (!isValidUsPhone(phone)) {
      setFormError('Please enter a valid 10-digit phone number.');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const created = await addAccount({
        officeName, providerName,
        providerRole: form.providerRole.trim() || 'Practitioner',
        address1,
        address2,
        city,
        state,
        postalCode,
        plan,
        email,
        phone,
      });
      toast({
        variant: 'success',
        title: `${created.account.officeName} created`,
        description:
          created.invitation === 'sent'
            ? `Needs setup · provider code ${created.account.providerCode ?? 'unavailable'} · claim invitation sent.`
            : `Needs setup · provider code ${created.account.providerCode ?? 'unavailable'} · the claim invitation could not be sent.`,
      });
      setOpen(false);
    } catch (cause) {
      setFormError(cause instanceof ProviderAccountError ? cause.message : 'The provider account could not be created.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AdminPage>
      <PageHeader
        kicker="Sub-accounts"
        title="Provider accounts"
        sub="Each live office links to the program through the provider code its patients type during mobile onboarding."
        action={canManageAccounts ? (
          <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-add-account" onClick={openDialog}>
            <Plus size={14} aria-hidden="true" />
            Add provider account
          </button>
        ) : undefined}
      />

      <SectionCard
        title="All accounts"
        sub={
          accountsStatus === 'ready' ? (
            <span aria-live="polite" data-testid="text-accounts-count">
              {query
                ? `${visibleAccounts.length} of ${accounts.length} offices match`
                : `${accounts.length} offices under the umbrella`}
            </span>
          ) : (
            'Live provider directory'
          )
        }
        action={
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <Select value={statusFilter} onValueChange={(value: StatusFilter) => setStatusFilter(value)}>
              <SelectTrigger className="h-9 w-[132px] text-xs" aria-label="Filter accounts by status" data-testid="select-account-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="offboarded">Offboarded</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative w-full sm:w-72">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search offices, providers, codes"
                aria-label="Search accounts by office, provider, role, code, phone, email, address, plan, or status"
                autoComplete="off"
                data-testid="input-account-search"
                className="h-9 w-full rounded-md border border-border bg-card pl-8 pr-8 text-xs text-foreground shadow-xs outline-none placeholder:text-muted-foreground/80 focus:ring-2 focus:ring-ring"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear account search"
                  data-testid="button-clear-account-search"
                  className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground transition hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                <th className="px-5 py-3 font-bold">Office</th>
                <th className="px-3 py-3 font-bold">Provider</th>
                <th className="px-3 py-3 font-bold">Code</th>
                <th className="px-3 py-3 font-bold">Plan</th>
                <th className="px-3 py-3 font-bold">Status</th>
                <th className="px-3 py-3 text-right font-bold">Patients</th>
                <th className="px-3 py-3 text-right font-bold">Monthly revenue</th>
                <th className="px-3 py-3 font-bold">Joined</th>
                <th className="px-5 py-3 text-right font-bold">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {accountsStatus !== 'ready' && (
                <tr><td colSpan={9} className="px-5 py-10 text-center text-xs text-muted-foreground">
                  {accountsStatus === 'loading' ? 'Loading live provider accounts…' : accountsStatus === 'unauthorized' ? 'Sign in with a THINNR HQ account to view the live provider directory.' : accountsError ?? 'The live provider directory could not be loaded.'}
                </td></tr>
              )}
              {accountsStatus === 'ready' && accounts.length === 0 && (
                <tr><td colSpan={9} className="px-5 py-10 text-center text-xs text-muted-foreground" data-testid="text-accounts-empty">
                  No provider accounts yet. Add the first provider account to get started.
                </td></tr>
              )}
              {accountsStatus === 'ready' && accounts.length > 0 && visibleAccounts.length === 0 && (
                <tr><td colSpan={9} className="px-5 py-10 text-center">
                  <p className="text-xs font-semibold text-navy" data-testid="text-accounts-no-match">
                    No offices match &ldquo;{query}&rdquo;
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    Try an office, provider, code, phone, email, address, plan, or status.
                  </p>
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className={`${BTN_SECONDARY} mt-3 h-8 px-3 text-[11px]`}
                    data-testid="button-accounts-empty-clear-search"
                  >
                    Clear search
                  </button>
                </td></tr>
              )}
              {visibleAccounts.map((account) => (
                <tr
                  key={account.id}
                  onClick={(event) => {
                    // Pointer-only convenience: the row duplicates its real,
                    // announced control (the trailing Open link — the row's
                    // one keyboard stop). Leave nested controls, modified
                    // clicks, and text selection alone.
                    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    if ((event.target as Element).closest('a, button, input, select, textarea')) return;
                    if (window.getSelection()?.toString()) return;
                    navigate(`/admin/accounts/${account.id}`);
                  }}
                  className="cursor-pointer border-b border-border transition hover:bg-accent/40 has-[a:focus-visible]:bg-accent/60 last:border-b-0"
                  data-testid={`row-account-${account.id}`}
                >
                  <td className="px-5 py-3">
                    <b className="block text-xs font-semibold text-navy">{account.officeName}</b>
                     <small className="text-[10px] text-muted-foreground">{[account.city, account.state ? usStateName(account.state) : ''].filter(Boolean).join(', ') || '—'}</small>
                    {statusFilter === 'offboarded' && account.offboarding && (
                      <small className="mt-0.5 block text-[10px] text-muted-foreground">
                        Started {account.offboarding.startedAt ? new Date(account.offboarding.startedAt).toLocaleDateString('en-US') : '—'}
                        {' · '}Offboarded {account.offboarding.offboardedAt ? new Date(account.offboarding.offboardedAt).toLocaleDateString('en-US') : '—'}
                      </small>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className="block text-foreground">{account.providerName}</span>
                    <small className="text-[10px] text-muted-foreground">{account.providerRole}</small>
                  </td>
                   <td className="px-3 py-3 font-mono text-[11px] tracking-[.08em] text-foreground">{account.providerCode ?? '—'}</td>
                   <td className="px-3 py-3 text-foreground">{account.plan ?? '—'}</td>
                  <td className="px-3 py-3">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <AccountStatusChip status={account.status} />
                      {isLocked(account.id) && <AccountLockedChip testId={`chip-locked-${account.id}`} />}
                    </span>
                  </td>
                   <td className="px-3 py-3 text-right font-semibold text-navy">{account.activePatientCount == null ? '—' : fmt(account.activePatientCount)}</td>
                  <td className="px-3 py-3 text-right text-foreground">
                     {monthlyRevenueOf(account) == null ? '—' : `$${fmt(monthlyRevenueOf(account)!)}`}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{formatDateKey(account.joinedKey, true)}</td>
                  <td className="px-5 py-3 text-right">
                    <Link
                      href={`/admin/accounts/${account.id}`}
                      aria-label={`Open ${account.officeName}`}
                      className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`}
                      data-testid={`link-account-${account.id}`}
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* Add-account dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Add a provider account</DialogTitle>
            <DialogDescription>
              Creates a durable unclaimed provider account and sends one claim invitation after the account is saved.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className={PANEL_LABEL}>Office name *</span>
              <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.officeName} onChange={setField('officeName')} placeholder="e.g. Beacon Hill Aesthetics" data-testid="input-account-office" />
            </label>
            <label className="block">
              <span className={PANEL_LABEL}>Provider name *</span>
              <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.providerName} onChange={setField('providerName')} placeholder="e.g. Dr. Maya Brooks" data-testid="input-account-provider" />
            </label>
            <label className="block">
              <span className={PANEL_LABEL}>Provider role</span>
              <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.providerRole} onChange={setField('providerRole')} placeholder="e.g. Medical Director" data-testid="input-account-role" />
            </label>
            <label className="block sm:col-span-2">
              <span className={PANEL_LABEL}>Address 1 *</span>
              <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.address1} onChange={setField('address1')} placeholder="e.g. 123 Main St" data-testid="input-account-address1" />
            </label>
            <label className="block sm:col-span-2">
              <span className={PANEL_LABEL}>Address 2</span>
              <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.address2} onChange={setField('address2')} placeholder="e.g. Suite 200" data-testid="input-account-address2" />
            </label>
            <label className="block sm:col-span-2">
              <span className={PANEL_LABEL}>City *</span>
              <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.city} onChange={setField('city')} placeholder="e.g. Boston" data-testid="input-account-city" />
            </label>
            <div className="block">
              <span className={PANEL_LABEL}>State *</span>
              <Popover open={stateOpen} onOpenChange={setStateOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    role="combobox"
                    aria-expanded={stateOpen}
                    className={`${INPUT_CLASS} mt-1 flex h-9 w-full items-center justify-between px-3 text-xs ${!form.state && 'text-muted-foreground'}`}
                    data-testid="select-account-state"
                  >
                    {form.state ? US_STATES.find(s => s.abbr === form.state)?.name || form.state : "Select state..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[200px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search state..." className="h-9 text-xs" />
                    <CommandList>
                      <CommandEmpty>No state found.</CommandEmpty>
                      <CommandGroup>
                        {US_STATES.map((state) => (
                          <CommandItem
                            key={state.abbr}
                            value={`${state.name} ${state.abbr}`}
                            onSelect={() => {
                              setForm(c => ({ ...c, state: state.abbr }));
                              setStateOpen(false);
                            }}
                            className="text-xs"
                          >
                            {state.name}
                            <Check
                              className={`ml-auto h-4 w-4 ${form.state === state.abbr ? "opacity-100" : "opacity-0"}`}
                            />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <label className="block">
              <span className={PANEL_LABEL}>ZIP Code *</span>
              <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.postalCode} onChange={setField('postalCode')} placeholder="e.g. 02108" maxLength={10} inputMode="numeric" autoComplete="postal-code" data-testid="input-account-zip" />
            </label>
            <div className="block">
              <span className={PANEL_LABEL}>Plan</span>
              <Select value={plan} onValueChange={(value) => setPlan(value as AccountPlan)}>
                <SelectTrigger className="mt-1 h-9 text-xs" data-testid="select-account-plan">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLANS.map((option) => (
                    <SelectItem key={option} value={option} className="text-xs">{option}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="block">
              <span className={PANEL_LABEL}>Claim email *</span>
              <input type="email" required className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.email} onChange={setField('email')} placeholder="frontdesk@office.example.com" data-testid="input-account-email" />
            </label>
            <label className="block sm:col-span-2">
              <span className={PANEL_LABEL}>Office phone *</span>
              <input type="tel" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.phone} onChange={setField('phone')} placeholder="(555) 000-0000" data-testid="input-account-phone" />
              <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">
                Contact number only — never used for sign-in, so the provider’s personal cell stays free for their own patient account.
              </span>
            </label>
          </div>
          {formError && <p role="alert" className="text-xs font-semibold text-destructive" data-testid="text-account-form-error">{formError}</p>}
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setOpen(false)}>
              Cancel
            </button>
             <button type="button" disabled={submitting} className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-account-create" onClick={submit}>
               {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}
