import { OfficeAccessSetup } from '@/components/billing/OfficeAccessSetup';
import { PANEL_LABEL } from '@/components/patient/heritage';

export default function PaymentMethods() {
  return <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 sm:px-6">
    <header>
      <p className={PANEL_LABEL}>Payments · Office billing</p>
      <h1 className="mt-2 font-serif text-2xl font-bold text-navy">Payment methods</h1>
      <p className="mt-2 text-sm text-muted-foreground">Manage the bank account and two cards your office uses to pay THINNR.</p>
    </header>
    <OfficeAccessSetup management />
  </main>;
}