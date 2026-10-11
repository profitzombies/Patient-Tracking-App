/**
 * /privacy, /terms and /health-data: the bundled document rendered from the
 * shared markdown subset. The web ships the same `@workspace/legal-documents`
 * build as the API, so the page needs no fetch and never shows a stale copy.
 */
import {
  LEGAL_DOCUMENTS_EFFECTIVE_DATE,
  LEGAL_DOCUMENTS_STATUS,
  LEGAL_DOCUMENTS_VERSION,
  inlineText,
  legalDocument,
  parseLegalMarkdown,
  type LegalBlock,
  type LegalDocumentSlug,
  type LegalInline,
} from '@workspace/legal-documents';
import { DocumentStatus, LegalFrame } from './LegalFrame';

const ROUTE_BY_SLUG: Record<LegalDocumentSlug, '/privacy' | '/terms' | '/health-data'> = {
  privacy: '/privacy',
  terms: '/terms',
  'health-data': '/health-data',
};

function Inlines({ inlines }: { inlines: LegalInline[] }) {
  return (
    <>
      {inlines.map((inline, index) => {
        if (inline.href) {
          const external = /^https?:/.test(inline.href);
          return (
            <a
              key={index}
              href={inline.href}
              className="font-semibold text-primary underline-offset-2 hover:underline"
              {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
            >
              {inline.text}
            </a>
          );
        }
        return inline.bold ? <strong key={index} className="font-semibold text-foreground">{inline.text}</strong> : <span key={index}>{inline.text}</span>;
      })}
    </>
  );
}

export function LegalBlocks({ blocks }: { blocks: LegalBlock[] }) {
  return (
    <div className="mt-6 space-y-4 text-[15px] leading-7 text-foreground/90">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          if (block.level === 1) return null; // the page title already carries it
          const Tag = block.level === 2 ? 'h2' : 'h3';
          return (
            <Tag
              key={index}
              className={block.level === 2 ? 'pt-3 font-serif text-[22px] leading-snug text-navy' : 'pt-1 text-base font-semibold text-navy'}
            >
              <Inlines inlines={block.inlines} />
            </Tag>
          );
        }
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul';
          return (
            <Tag key={index} className={`space-y-1.5 pl-6 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <Inlines inlines={item} />
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={index}>
            <Inlines inlines={block.inlines} />
          </p>
        );
      })}
    </div>
  );
}

export default function LegalDocumentPage({ slug }: { slug: LegalDocumentSlug }) {
  const document = legalDocument(slug);
  const blocks = parseLegalMarkdown(document.markdown);
  const heading = blocks.find((block) => block.type === 'heading' && block.level === 1);
  const title = heading && heading.type === 'heading' ? inlineText(heading.inlines) : document.title;
  return (
    <LegalFrame title={title} current={ROUTE_BY_SLUG[slug]}>
      <DocumentStatus
        effectiveDate={LEGAL_DOCUMENTS_EFFECTIVE_DATE}
        status={LEGAL_DOCUMENTS_STATUS}
        version={LEGAL_DOCUMENTS_VERSION}
      />
      <LegalBlocks blocks={blocks} />
    </LegalFrame>
  );
}
