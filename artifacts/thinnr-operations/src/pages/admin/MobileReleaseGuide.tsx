/**
 * HQ → System health → Mobile release guide.
 *
 * Renders docs/mobile-release.md (the repository's plain-language guide to
 * building, testing, submitting and hot-fixing the patient app through EAS)
 * so a non-engineer can follow it from the dashboard. The markdown is bundled
 * at build time with Vite's ?raw import, so the page is always the version
 * of the guide that shipped with this dashboard build — no network fetch, no
 * separate hosting. react-markdown never renders raw HTML, so document
 * content cannot inject markup into the page.
 *
 * HQ-only, same gate as System health (routing in App.tsx).
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'wouter';
import { PageHeader } from '@/components/admin/primitives';
import guideMarkdown from '../../../../../docs/mobile-release.md?raw';

/** Headings step down one level: the page header already carries the H1. */
const components: Components = {
  h1: () => null,
  h2: ({ children }) => <h2 className="mt-8 font-serif text-lg font-bold leading-snug text-navy first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-5 text-sm font-bold text-navy">{children}</h3>,
  p: ({ children }) => <p className="mt-3 text-[13px] leading-relaxed text-foreground">{children}</p>,
  ul: ({ children }) => <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed">{children}</ul>,
  ol: ({ children }) => <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed">{children}</ol>,
  li: ({ children }) => <li className="marker:text-primary">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-navy">{children}</strong>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-2">{children}</a>
  ),
  code: ({ children }) => <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[12px] text-navy">{children}</code>,
  pre: ({ children }) => (
    <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-secondary p-3 text-[12px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0">{children}</pre>
  ),
  hr: () => <hr className="my-6 border-border" />,
  table: ({ children }) => (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border bg-secondary px-2 py-1.5 text-left font-semibold text-navy">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1.5 align-top">{children}</td>,
};

export default function MobileReleaseGuide() {
  return (
    <div className="mx-auto max-w-[920px] px-5 py-7 md:px-8">
      <Link href="/admin/system-health" className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" data-testid="link-back-system-health">
        <ArrowLeft size={13} aria-hidden="true" /> System health
      </Link>
      <PageHeader
        kicker="Manage"
        title="Mobile release guide"
        sub="How to build the THINNR patient app for the App Store and Google Play, get it onto test phones, submit it, ship a fix without a store review, and roll back. Kept in the repository as docs/mobile-release.md."
      />
      <article className="mt-6 rounded-lg border border-card-border bg-card p-6 shadow-soft" data-testid="mobile-release-guide">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{guideMarkdown}</ReactMarkdown>
      </article>
    </div>
  );
}
