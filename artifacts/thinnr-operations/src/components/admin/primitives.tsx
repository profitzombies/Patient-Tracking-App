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
import { Eye, Lock } from 'lucide-react';
import { CHIP_COBALT, CHIP_RISK, CHIP_WARM } from '@/components/patient/heritage';
import { OFFICE_KIND_LABEL, type OfficeKind } from '@/data/hq/accounts';

/**
 * Standard admin page container — spans the full content column, keeping only
 * the comfortable edge padding. (The office pages keep their own centered
 * measure; prose inside HQ pages stays readable via per-element ch caps.)
 */
export function AdminPage({ children }: { children: ReactNode }) {
  return <div className="w-full px-4 py-6 md:px-8 md:py-8">{children}</div>;
}

/** Used by the route gate before an unauthorized page has a chance to mount. */
export function UnauthorizedState({ role }: { role: string | null }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16 md:px-8" role="alert" data-testid="status-admin-unauthorized">
      <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">Access restricted</p>
      <h1 className="mt-2 font-serif text-2xl font-bold text-navy">You don’t have access to this HQ section.</h1>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Your {role ?? 'current'} department role does not include this page. Choose an available section from the navigation.
      </p>
    </div>
  );
}

interface PageHeaderProps {
  kicker: string;
  title: ReactNode;
  sub?: ReactNode;
  /** Right-aligned slot for the page's primary action. */
  action?: ReactNode;
  /** Extra classes for pages that keep a centered measure (e.g. the video editor). */
  className?: string;
}

export function PageHeader({ kicker, title, sub, action, className }: PageHeaderProps) {
  return (
    <header className={`mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 ${className ?? ''}`}>
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

export function AccountStatusChip({ status }: { status: 'active' | 'needs_setup' | 'locked' | 'offboarding' | 'offboarded' }) {
  return status === 'active' ? (
    <span className={CHIP_COBALT}>Active</span>
  ) : status === 'locked' ? (
    <span className={CHIP_RISK}>Disabled</span>
  ) : status === 'offboarding' ? (
    <span className={CHIP_WARM}>Offboarding</span>
  ) : status === 'offboarded' ? (
    <span className="inline-flex items-center rounded-sm border border-border bg-secondary px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] text-muted-foreground">
      Offboarded
    </span>
  ) : (
    <span className={CHIP_WARM}>Needs setup</span>
  );
}

/** The dedicated App Review office — store reviewers sign in here; it is not a customer. */
export function AppReviewChip({ testId }: { testId?: string }) {
  return (
    <span className={CHIP_WARM} data-testid={testId} title="Apple and Google reviewers sign in to this office. It is not a customer and is left out of health, retention and counts.">
      App Review
    </span>
  );
}

/**
 * The office kind. Resellers are the default and wear no chip; a software-only
 * office is called out wherever HQ reads the account so the missing Marketing
 * Assets / Training and the shorter included period are never a surprise.
 */
export function OfficeKindChip({ kind, testId }: { kind: OfficeKind; testId?: string }) {
  if (kind !== 'software') return null;
  return (
    <span className={CHIP_COBALT} data-testid={testId} title="Software-only practice: no Marketing Assets or Training, the software agreement, and the shorter free period.">
      {OFFICE_KIND_LABEL.software}
    </span>
  );
}

/** Risk chip for accounts THINNR has locked out of the office side. */
export function AccountLockedChip({ testId }: { testId?: string }) {
  return (
    <span className={CHIP_RISK} data-testid={testId}>
      <Lock size={9} aria-hidden="true" />
      Locked
    </span>
  );
}

export function TeamStatusChip({ status }: { status: 'active' | 'pending' }) {
  return status === 'active' ? (
    <span className={CHIP_COBALT}>Active</span>
  ) : (
    <span className={CHIP_WARM}>Pending</span>
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
