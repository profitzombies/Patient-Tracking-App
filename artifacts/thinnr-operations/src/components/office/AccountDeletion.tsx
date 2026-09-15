/**
 * Staff-facing views of a PATIENT-initiated account deletion.
 *
 *  - DeletionChip: the grace-period marker on roster rows and the record
 *    header. It counts down to the purge so staff know the record is on
 *    borrowed time; the patient can still cancel by signing in.
 *  - DeletionBanner: the record-level announcement (alert) with the same
 *    countdown and what will happen.
 *  - DeletedAccountsSection: PII-free tombstones. After a purge there is no
 *    name, contact, or clinical data left to show; the section exists so the
 *    roster's lifetime count and the deletion stay explainable.
 *  - DeletedRecordNotice: the 410 view when a record link points at a purged
 *    account.
 */
import { Link } from 'wouter';
import { ShieldAlert, ShieldOff } from 'lucide-react';
import type { DeletedAccount, PatientDeletionState } from '@/lib/office-roster';

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Whole days until the purge is due (never negative); null when no schedule loaded. */
export function graceDaysLeft(deletion: PatientDeletionState, now: Date = new Date()): number | null {
  if (!deletion.purgeAfter) return null;
  const ms = Date.parse(deletion.purgeAfter) - now.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function describeGrace(deletion: PatientDeletionState, now: Date = new Date()): string {
  const days = graceDaysLeft(deletion, now);
  if (days === null) return 'Deletion requested';
  if (days === 0) return 'Deletion due today';
  return `Deletes in ${days} day${days === 1 ? '' : 's'}`;
}

export function DeletionChip({ deletion, testId }: { deletion: PatientDeletionState; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-[#d5a7a7] bg-[#fff0f0] px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] text-destructive"
      title={`The patient requested account deletion on ${formatDate(deletion.requestedAt)}. They can cancel by signing in before the purge.`}
    >
      <ShieldAlert size={10} aria-hidden="true" />
      {describeGrace(deletion)}
    </span>
  );
}

export function DeletionBanner({ deletion }: { deletion: PatientDeletionState }) {
  const days = graceDaysLeft(deletion);
  return (
    <div
      role="alert"
      data-testid="patient-deletion-banner"
      className="flex items-start gap-3 rounded-[9px] border border-[#d5a7a7] bg-[#fff0f0] px-4 py-3 text-sm text-destructive"
    >
      <ShieldAlert size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div>
        <p className="font-semibold">
          This patient asked to delete their account on {formatDate(deletion.requestedAt)}.
          {' '}
          {days === null
            ? 'The record will be permanently removed when the grace period ends.'
            : days === 0
              ? 'The purge is due today.'
              : `Everything here is permanently removed in ${days} day${days === 1 ? '' : 's'}${deletion.purgeAfter ? ` (${formatDate(deletion.purgeAfter)})` : ''}.`}
        </p>
        <p className="mt-1 text-destructive/80">
          Only the patient can cancel, by signing in to the app before then. Staff cannot cancel, hurry, or undo a deletion; after the purge this page shows a record-removed notice and no clinical data.
        </p>
      </div>
    </div>
  );
}

export function DeletedAccountsSection({ accounts }: { accounts: DeletedAccount[] }) {
  if (accounts.length === 0) return null;
  return (
    <section
      aria-labelledby="deleted-accounts-heading"
      data-testid="deleted-accounts"
      className="mt-6 rounded-[9px] border border-border bg-card shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id="deleted-accounts-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldOff size={14} aria-hidden="true" className="text-muted-foreground" />
          Deleted accounts
          <span className="rounded-sm border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{accounts.length}</span>
        </h2>
        <p className="text-xs text-muted-foreground">
          Patients who deleted their own accounts. Their data is gone; these rows keep the office's counts honest.
        </p>
      </div>
      <ul className="divide-y divide-border/70">
        {accounts.map((account) => (
          <li key={account.id} data-testid={`deleted-account-${account.id}`} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-2.5 text-xs">
            <span className="font-medium text-foreground">Former patient · <span className="font-mono text-muted-foreground">{account.id.slice(0, 8)}</span></span>
            <span className="text-muted-foreground">
              {account.enrolledOn ? `Enrolled ${formatDate(account.enrolledOn)}` : 'Never enrolled'}
              {account.programId ? ` · ${account.programId.toUpperCase()}` : ''}
              {account.wasActivated ? '' : ' · never activated'}
            </span>
            <span className="text-muted-foreground">
              {account.requestedAt ? `Requested ${formatDate(account.requestedAt)} · ` : ''}Purged {formatDate(account.purgedAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DeletedRecordNotice({ message, deleted }: { message: string; deleted: DeletedAccount | null }) {
  return (
    <div data-testid="patient-record-deleted" className="rounded-[9px] border border-border bg-card px-6 py-10 text-center shadow-xs">
      <ShieldOff size={28} aria-hidden="true" className="mx-auto text-muted-foreground" />
      <h1 className="mt-4 font-serif text-2xl text-navy">Record removed</h1>
      <p role="status" className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{message}</p>
      {deleted && (
        <dl className="mx-auto mt-4 grid max-w-sm grid-cols-2 gap-x-6 gap-y-1 text-left text-xs">
          <dt className="text-muted-foreground">Purged</dt>
          <dd className="font-medium text-foreground">{formatDate(deleted.purgedAt)}</dd>
          {deleted.requestedAt && (
            <>
              <dt className="text-muted-foreground">Requested</dt>
              <dd className="font-medium text-foreground">{formatDate(deleted.requestedAt)}</dd>
            </>
          )}
          {deleted.enrolledOn && (
            <>
              <dt className="text-muted-foreground">Enrolled</dt>
              <dd className="font-medium text-foreground">{formatDate(deleted.enrolledOn)}</dd>
            </>
          )}
        </dl>
      )}
      <Link href="/patients" className="mt-6 inline-flex h-9 items-center rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Back to patients
      </Link>
    </div>
  );
}
