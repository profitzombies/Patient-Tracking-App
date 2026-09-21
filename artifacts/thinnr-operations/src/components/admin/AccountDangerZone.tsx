import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { BTN_SECONDARY } from '@/components/patient/heritage';

/** Keep workflows mounted across toggles so drafts and pending requests survive. */
export function AccountDangerZone({ children, status }: { children: ReactNode; status?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-6 rounded-lg border border-destructive/30 bg-[#fff0f0]/30 p-5 shadow-sm" data-testid="section-danger-zone">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={headingId} className="text-sm font-semibold text-destructive">Danger zone</h3>
            {status}
          </div>
          <p className="mt-1.5 max-w-[68ch] text-xs leading-relaxed text-muted-foreground">
            Sensitive office actions: offboarding, entire-office exports, legal holds, and account access.
            Expanding this section does not change access or perform an action.
          </p>
        </div>
        <button type="button" className={`${BTN_SECONDARY} min-h-9 px-3 text-xs`}
          aria-expanded={open} aria-controls={contentId}
          data-testid="button-toggle-danger-zone" onClick={() => setOpen((value) => !value)}>
          {open ? 'Collapse danger zone' : 'Expand danger zone'}
          <ChevronDown size={14} aria-hidden="true" className={open ? 'rotate-180' : ''} />
        </button>
      </div>
      <div id={contentId} hidden={!open} data-testid="danger-zone-content">
        <div className="mt-5 space-y-5 border-t border-destructive/20 pt-5">{children}</div>
      </div>
    </section>
  );
}