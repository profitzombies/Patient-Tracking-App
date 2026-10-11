/**
 * Shared chrome for the public (no session) legal pages: /privacy, /terms,
 * /health-data, /support and /delete-account. Same cream canvas, serif brand
 * mark and "Not Medical Advice" footer as the rest of the public side.
 */
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import {
  draftNotice,
  formatEffectiveDate,
  type LegalDocumentStatus,
} from '@workspace/legal-documents';

export const PUBLIC_LEGAL_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/health-data', label: 'Health data' },
  { href: '/support', label: 'Support' },
  { href: '/delete-account', label: 'Delete account' },
] as const;

export function LegalFrame({
  title,
  lede,
  children,
  current,
}: {
  title: string;
  lede?: string;
  children: ReactNode;
  current?: (typeof PUBLIC_LEGAL_LINKS)[number]['href'];
}) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background font-sans text-foreground">
      <header className="mx-auto flex w-full max-w-[760px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 pt-7 sm:px-8">
        <Link href="~/" className="font-serif text-[26px] text-navy" aria-label="THINNR home">
          THINNR
        </Link>
        <nav aria-label="Legal pages" className="flex flex-wrap gap-x-4 gap-y-1">
          {PUBLIC_LEGAL_LINKS.map((link) => (
            <Link
              key={link.href}
              href={`~${link.href}`}
              aria-current={link.href === current ? 'page' : undefined}
              className={`text-xs font-semibold hover:underline ${link.href === current ? 'text-navy underline' : 'text-muted-foreground'}`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-[760px] flex-1 px-5 py-8 sm:px-8">
        <article className="rounded-lg border border-card-border bg-card px-5 py-7 shadow-lifted sm:px-9 sm:py-9">
          <h1 className="font-serif text-[30px] leading-tight text-navy sm:text-[34px]">{title}</h1>
          {lede ? <p className="mt-2 text-sm text-muted-foreground">{lede}</p> : null}
          {children}
        </article>
      </main>
      <footer className="border-t border-border bg-sidebar px-5 py-2 text-center">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Not Medical Advice</p>
      </footer>
    </div>
  );
}

/** Effective date line plus the draft banner (which disappears once final). */
export function DocumentStatus({
  effectiveDate,
  status,
  version,
}: {
  effectiveDate: string;
  status: LegalDocumentStatus;
  version: string;
}) {
  const notice = draftNotice(status);
  return (
    <div className="mt-4 space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" data-testid="legal-effective-date">
        Effective {formatEffectiveDate(effectiveDate)} · version {version}
      </p>
      {notice ? (
        <p
          role="note"
          data-testid="legal-draft-banner"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900"
        >
          {notice}
        </p>
      ) : null}
    </div>
  );
}
