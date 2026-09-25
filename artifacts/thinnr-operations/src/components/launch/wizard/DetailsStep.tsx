import { useEffect, useRef, useState } from 'react';
import { INPUT_CLASS } from '@/components/patient/heritage';
import { useLaunchWrite, type LaunchState } from '@/hooks/use-launch';
import { InlineError, StepFrame, WizardFooter, readable } from './ui';

const FIELDS: Array<{ key: keyof LaunchState['details']; label: string; wide?: boolean; type?: string; autoComplete?: string; max?: number }> = [
  { key: 'officeName', label: 'Practice name', wide: true, autoComplete: 'organization' },
  { key: 'providerName', label: 'Provider name', autoComplete: 'name' },
  { key: 'email', label: 'Contact email', type: 'email', autoComplete: 'email' },
  { key: 'phone', label: 'Office phone', type: 'tel', autoComplete: 'tel' },
  { key: 'address1', label: 'Street address', wide: true, autoComplete: 'address-line1' },
  { key: 'address2', label: 'Suite or unit (optional)', wide: true, autoComplete: 'address-line2' },
  { key: 'city', label: 'City', autoComplete: 'address-level2' },
  { key: 'state', label: 'State', autoComplete: 'address-level1', max: 40 },
  { key: 'postalCode', label: 'ZIP code', autoComplete: 'postal-code', max: 10 },
];

export function DetailsStep({ launch, readOnly, onNext }: { launch: LaunchState; readOnly: boolean; onNext: () => void }) {
  const [details, setDetails] = useState({ ...launch.details });
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const baseline = useRef(launch.version);
  const write = useLaunchWrite('details');
  useEffect(() => {
    if (!dirty) { setDetails({ ...launch.details }); baseline.current = launch.version; }
  }, [launch, dirty]);
  const missing = FIELDS.filter((field) => field.key !== 'address2' && !details[field.key].trim());
  const confirm = async () => {
    if (readOnly || (launch.detailsConfirmed && !dirty)) { onNext(); return; }
    setError('');
    try {
      const result = await write.save({ expectedVersion: baseline.current, details });
      if (result) { baseline.current = result.version; setDirty(false); onNext(); }
    } catch (failure) { setError(readable(failure, 'Details could not be saved.')); }
  };
  return <StepFrame testId="wizard-step-details" eyebrow="Step 1" title="Confirm your practice details"
    sub="This is the address and contact information patients and THINNR will use. Check it over and fix anything that has changed.">
    <form className="grid gap-4 rounded-lg border border-card-border bg-card p-5 shadow-soft sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
      <fieldset disabled={readOnly || write.isPending} className="contents">
        {FIELDS.map((field) => <label key={field.key} className={`block text-xs font-semibold text-navy ${field.wide ? 'sm:col-span-2' : ''}`}>
          {field.label}
          <input className={`${INPUT_CLASS} mt-1.5 h-11 w-full text-sm`} value={details[field.key]} required={field.key !== 'address2'}
            type={field.type ?? 'text'} autoComplete={field.autoComplete} maxLength={field.max ?? 320}
            data-testid={`wizard-detail-${field.key}`}
            onChange={(event) => { setDirty(true); setDetails({ ...details, [field.key]: event.target.value }); }} />
        </label>)}
      </fieldset>
      <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
    </form>
    {dirty && launch.version !== baseline.current && <InlineError message="Setup changed on another screen while you were editing. Your edits are still here; saving will check them against the latest version." />}
    {error && <InlineError message={error} />}
    <WizardFooter onContinue={() => void confirm()} busy={write.isPending}
      canContinue={readOnly || missing.length === 0}
      hint={missing.length ? `Fill in ${missing.map((field) => field.label.toLowerCase()).join(', ')}.` : null}
      continueLabel={readOnly || (launch.detailsConfirmed && !dirty) ? 'Continue' : 'Confirm and continue'} />
  </StepFrame>;
}
