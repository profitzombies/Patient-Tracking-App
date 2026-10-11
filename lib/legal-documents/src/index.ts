/**
 * THINNR public legal documents: Privacy Policy, Terms of Use, and the Health
 * data notice, versioned together.
 *
 * `documents/version.json` is the single knob. Bumping `version` re-prompts
 * every patient (the consent policy version derives from it); flipping
 * `status` to "final" removes the draft banner. The markdown in `documents/`
 * is canonical and is compiled into `generated.ts` so every runtime (Node,
 * Vite, Metro) ships byte-identical text.
 */
import {
  GENERATED_DOCUMENTS,
  LEGAL_DOCUMENTS_EFFECTIVE_DATE,
  LEGAL_DOCUMENTS_STATUS,
  LEGAL_DOCUMENTS_VERSION,
} from "./generated";

export { LEGAL_DOCUMENTS_EFFECTIVE_DATE, LEGAL_DOCUMENTS_STATUS, LEGAL_DOCUMENTS_VERSION };

export type LegalDocumentSlug = "privacy" | "terms" | "health-data";
export type LegalDocumentStatus = "draft" | "final";

export interface LegalDocument {
  slug: LegalDocumentSlug;
  title: string;
  markdown: string;
}

/** Wire shape of `GET /api/legal/documents`, also the bundled offline copy. */
export interface LegalDocumentsBundle {
  version: string;
  effectiveDate: string;
  status: LegalDocumentStatus;
  documents: LegalDocument[];
}

export const LEGAL_DOCUMENT_SLUGS: readonly LegalDocumentSlug[] = ["privacy", "terms", "health-data"];

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = GENERATED_DOCUMENTS.map((document) => ({
  slug: document.slug,
  title: document.title,
  markdown: document.markdown,
}));

export function legalDocument(slug: LegalDocumentSlug): LegalDocument {
  const found = LEGAL_DOCUMENTS.find((document) => document.slug === slug);
  if (!found) throw new Error(`unknown legal document: ${slug}`);
  return found;
}

export function legalDocumentsBundle(): LegalDocumentsBundle {
  return {
    version: LEGAL_DOCUMENTS_VERSION,
    effectiveDate: LEGAL_DOCUMENTS_EFFECTIVE_DATE,
    status: LEGAL_DOCUMENTS_STATUS,
    documents: LEGAL_DOCUMENTS.map((document) => ({ ...document })),
  };
}

export function isLegalDocumentSlug(value: unknown): value is LegalDocumentSlug {
  return typeof value === "string" && (LEGAL_DOCUMENT_SLUGS as readonly string[]).includes(value);
}

/** Banner copy shown above draft documents; null once the text is final. */
export function draftNotice(status: LegalDocumentStatus): string | null {
  return status === "draft"
    ? "Draft pending counsel review. This wording may change before it is final; the version and effective date will update when it does."
    : null;
}

/** "September 1, 2026" from an ISO day, independent of the device time zone. */
export function formatEffectiveDate(isoDay: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!match) return isoDay;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const month = months[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : isoDay;
}

/** Bundles compare by version string: ISO days sort lexicographically. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return candidate > current;
}

// ── Markdown subset ─────────────────────────────────────────────────────────
// The documents use a deliberately small subset (ATX headings, paragraphs,
// "- " bullets, "1. " numbered items, **bold**, [links](url)). One parser
// feeds both the web and the native renderer so the two never drift.

export interface LegalInline {
  text: string;
  bold?: boolean;
  href?: string;
}

export type LegalBlock =
  | { type: "heading"; level: 1 | 2 | 3; inlines: LegalInline[] }
  | { type: "paragraph"; inlines: LegalInline[] }
  | { type: "list"; ordered: boolean; items: LegalInline[][] };

const INLINE_TOKEN = /(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

export function parseLegalInlines(text: string): LegalInline[] {
  const inlines: LegalInline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) inlines.push({ text: text.slice(last, index) });
    const token = match[0];
    if (token.startsWith("**")) {
      inlines.push({ text: token.slice(2, -2), bold: true });
    } else {
      const close = token.indexOf("](");
      inlines.push({ text: token.slice(1, close), href: token.slice(close + 2, -1) });
    }
    last = index + token.length;
  }
  if (last < text.length) inlines.push({ text: text.slice(last) });
  return inlines;
}

export function parseLegalMarkdown(markdown: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", inlines: parseLegalInlines(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({ type: "list", ordered: list.ordered, items: list.items.map(parseLegalInlines) });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^-\s+(.+)$/.exec(line);
    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        inlines: parseLegalInlines(heading[2].trim()),
      });
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1].trim());
    } else if (list) {
      // Continuation line of the previous item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** Plain text of an inline run, for titles and accessibility labels. */
export function inlineText(inlines: LegalInline[]): string {
  return inlines.map((inline) => inline.text).join("");
}
