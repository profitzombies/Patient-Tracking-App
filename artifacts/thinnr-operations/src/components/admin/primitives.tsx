/**
 * Shared Heritage patterns for the HQ admin family.
 *
 * The admin pages reuse the patient-record recipes (chips, buttons, section
 * cards) from components/patient/heritage.tsx and add the handful of shapes
 * that only exist at HQ: page scaffolding, metric tiles, status chips for
 * account/team/course states, and the "preview" banner that labels the
 * training and files mockups. Keeping them here means every admin screen
 * reads as one family and matches the office desk next door.
 */
import type { ReactNode } from 'react';
import { Eye } from 'lucide-react';
import { CHIP_COBALT, CHIP_WARM } from '@/components/patient/heritage';

/**
 * Standard admin page container — spans the full content column, keeping only
 * the comfortable edge padding. (The office pages keep their own centered
 * measure; prose inside HQ pages stays readable via per-element ch caps.)
 */
export function AdminPage({ children }: { children: ReactNode }) {
  return <div className="w-full px-4 py-6 md:px-8 md:py-8">{children}</div>;
}

interface PageHeaderProps {
  kicker: string;
  title: ReactNode;
  sub?: ReactNode;
  /** Right-aligned slot for the page's primary action. */
  action?: ReactNode;
}

export function PageHeader({ kicker, title, sub, action }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">{kicker}</p>
        <h1 className="mt-1 font-serif text-[26px] font-bold leading-tight tracking-[-.01em] text-navy">{title}</h1>
        {sub && <p className="mt-1.5 max-w-[68ch] text-xs leading-relaxed text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </header>
  );
}

interface MetricTileProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  testId?: string;
}

/** Cream stat tile — the admin cousin of the office Overview's Metric card. */
export function MetricTile({ label, value, detail, testId }: MetricTileProps) {
  return (
    <div className="rounded-lg border border-card-border bg-card p-4 shadow-soft">
      <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">{label}</p>
      <p className="mt-2 font-serif text-[26px] font-bold leading-none tracking-[-.01em] text-navy" data-testid={testId}>
        {value}
      </p>
      {detail && <p className="mt-2 text-[11px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

/** Labels the training/files mockups so nobody mistakes them for live tools. */
export function PreviewBanner({ children }: { children: ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-3" role="note">
      <Eye size={15} className="mt-0.5 shrink-0 text-[#b65c22]" aria-hidden="true" />
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[.12em] text-[#b65c22]">Preview</p>
        <p className="mt-0.5 text-xs leading-relaxed text-foreground">{children}</p>
      </div>
    </div>
  );
}

export function AccountStatusChip({ status }: { status: 'active' | 'pending' }) {
  return status === 'active' ? (
    <span className={CHIP_COBALT}>Active</span>
  ) : (
    <span className={CHIP_WARM}>Pending</span>
  );
}

export function TeamStatusChip({ status }: { status: 'active' | 'invited' }) {
  return status === 'active' ? (
    <span className={CHIP_COBALT}>Active</span>
  ) : (
    <span className={CHIP_WARM}>Invited</span>
  );
}

export function CourseStatusChip({ status }: { status: 'published' | 'draft' }) {
  return status === 'published' ? (
    <span className={CHIP_COBALT}>Published</span>
  ) : (
    <span className={CHIP_WARM}>Draft</span>
  );
}

/**
 * Best-effort clipboard write. Returns whether it landed so callers can word
 * the toast honestly (some browsers block the API outside secure contexts).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
