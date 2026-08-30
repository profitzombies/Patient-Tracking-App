/**
 * Provider accounts — every sub-account under the THINNR umbrella.
 *
 * Rows and additions are durable live provider records. Existing imported
 * rows may have intentionally unavailable account fields.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { Plus } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { AccountLockedChip, AccountStatusChip, AdminPage, PageHeader } from '@/components/admin/primitives';
import { useAccountLocks } from '@/contexts/account-locks';
import { useHqData } from '@/contexts/hq-data';
import { monthlyRevenueOf, type AccountPlan } from '@/data/hq/accounts';
import { ProviderAccountError } from '@/lib/provider-accounts';
import { formatDateKey } from '@/data/nutrition-data';

const fmt = (value: number) => value.toLocaleString('en-US');
const PLANS: AccountPlan[] = ['Core', 'Plus', 'Concierge'];

const EMPTY_FORM = {
  officeName: '',
  providerName: '',
  providerRole: 'Practitioner',
  city: '',
  state: '',
  email: '',
  phone: '',
};

export default function Accounts() {
  const { accounts, accountsStatus, accountsError, addAccount, settingsValues } = useHqData();
  const { isLocked } = useAccountLocks();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  // The org setting seeds the plan choice — a small proof the settings page
  // actually feeds the rest of the demo.
  const defaultPlan = (settingsValues['provider-accounts.default-plan'] as AccountPlan) ?? 'Plus';
  const [plan, setPlan] = useState<AccountPlan>(defaultPlan);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const openDialog = () => {
    setForm(EMPTY_FORM);
    setPlan(defaultPlan);
    setFormError(null);
    setOpen(true);
  };

  const setField = (key: keyof typeof EMPTY_FORM) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async () => {
    if (submitting) return;
    const officeName = form.officeName.trim();
    const providerName = form.providerName.trim();
    const email = form.email.trim().toLowerCase();
    if (!officeName || !providerName || !email) {
      setFormError('Office name, provider name, and a claim email are required.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const created = await addAccount({
        officeName, providerName,
        providerRole: form.providerRole.trim() || 'Practitioner',
        city: form.city.trim(),
        state: form.state.trim().toUpperCase().slice(0, 2),
        plan,
        email,
        phone: form.phone.trim(),
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
        action={
          <button type="button" className={`${BTN_PRIMARY} h-9 px-3.5`} data-testid="button-add-account" onClick={openDialog}>
            <Plus size={14} aria-hidden="true" />
            Add provider account
          </button>
        }
      />

      <SectionCard title="All accounts" sub={accountsStatus === 'ready' ? `${accounts.length} offices under the umbrella` : 'Live provider directory'}>
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
              {accounts.map((account) => (
                <tr key={account.id} className="border-b border-border transition hover:bg-accent/40 last:border-b-0" data-testid={`row-account-${account.id}`}>
                  <td className="px-5 py-3">
                    <b className="block text-xs font-semibold text-navy">{account.officeName}</b>
                     <small className="text-[10px] text-muted-foreground">{[account.city, account.state].filter(Boolean).join(', ') || '—'}</small>
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
                  <td className="px-3 py-3 text-right font-semibold text-navy">{fmt(account.activePatientCount)}</td>
                  <td className="px-3 py-3 text-right text-foreground">
                     {monthlyRevenueOf(account) == null ? '—' : `$${fmt(monthlyRevenueOf(account)!)}`}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{formatDateKey(account.joinedKey, true)}</td>
                  <td className="px-5 py-3 text-right">
                    <Link
                      href={`/admin/accounts/${account.id}`}
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
            <label className="block">
              <span className={PANEL_LABEL}>City</span>
              <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.city} onChange={setField('city')} placeholder="e.g. Boston" data-testid="input-account-city" />
            </label>
            <label className="block">
              <span className={PANEL_LABEL}>State</span>
              <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.state} onChange={setField('state')} placeholder="e.g. MA" maxLength={2} data-testid="input-account-state" />
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
              <span className={PANEL_LABEL}>Office phone</span>
              <input className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={form.phone} onChange={setField('phone')} placeholder="(555) 000-0000" data-testid="input-account-phone" />
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
