/**
 * Full legal text for in-app reading (consent screen, Account → Privacy &
 * data). The app bundles the current documents from the shared
 * `@workspace/legal-documents` build so they read offline, and asks the API
 * for the published bundle when the bundled copy is not the version the
 * server requires (an older app after a text bump).
 *
 * Consent integrity rule: a patient may only agree to a policy version whose
 * text they can read. `resolveLegalDocuments` therefore picks the copy that
 * carries EXACTLY the required version (bundled or server) and flags
 * everything else as not current; the consent screen refuses to record
 * agreement until a current copy is available, and the reader labels an
 * outdated copy as such. Without a required version (no account state), the
 * server copy wins only when strictly newer than the bundled one.
 *
 * Pure apart from the fetch, so the privacy-controls suite can drive it.
 */
import {
  LEGAL_DOCUMENT_SLUGS,
  isLegalDocumentSlug,
  isNewerVersion,
  legalDocumentsBundle,
  type LegalDocument,
  type LegalDocumentsBundle,
} from '@workspace/legal-documents';
import { apiBase } from '@/lib/coach-api';

export type { LegalDocumentSlug, LegalDocumentsBundle } from '@workspace/legal-documents';

export type LegalSource = 'bundled' | 'server';

export interface LoadedLegalDocuments {
  bundle: LegalDocumentsBundle;
  source: LegalSource;
  /**
   * True when `bundle.version` is the version the patient is asked to agree
   * to (or when no required version is known). False means the reader is
   * showing the best copy it has, which is NOT the text behind the consent.
   */
  current: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates the wire bundle; returns null for anything the app can't trust. */
export function parseLegalBundle(raw: unknown): LegalDocumentsBundle | null {
  if (!isRecord(raw)) return null;
  const { version, effectiveDate, status } = raw;
  if (typeof version !== 'string' || version.length === 0) return null;
  if (typeof effectiveDate !== 'string' || effectiveDate.length === 0) return null;
  if (status !== 'draft' && status !== 'final') return null;
  if (!Array.isArray(raw.documents)) return null;
  const documents: LegalDocument[] = [];
  for (const entry of raw.documents) {
    if (!isRecord(entry) || !isLegalDocumentSlug(entry.slug)) return null;
    if (typeof entry.title !== 'string' || typeof entry.markdown !== 'string' || entry.markdown.length === 0) return null;
    documents.push({ slug: entry.slug, title: entry.title, markdown: entry.markdown });
  }
  // Every document the app knows how to open must be present.
  if (!LEGAL_DOCUMENT_SLUGS.every(slug => documents.some(document => document.slug === slug))) return null;
  return { version, effectiveDate, status, documents };
}

export function bundledLegalDocuments(requiredVersion: string | null = null): LoadedLegalDocuments {
  const bundle = legalDocumentsBundle();
  return { bundle, source: 'bundled', current: requiredVersion === null || bundle.version === requiredVersion };
}

/**
 * Picks the copy to show.
 *
 * With a required version: the copy carrying exactly that version (bundled
 * first — byte-identical by build — then server); otherwise the newest copy
 * available, flagged `current: false`.
 *
 * Without one: the server bundle only when strictly newer than the bundled
 * one. Same version → bundled.
 */
export function resolveLegalDocuments(
  bundled: LegalDocumentsBundle,
  fromServer: LegalDocumentsBundle | null,
  requiredVersion: string | null,
): LoadedLegalDocuments {
  if (requiredVersion !== null) {
    if (bundled.version === requiredVersion) return { bundle: bundled, source: 'bundled', current: true };
    if (fromServer && fromServer.version === requiredVersion) return { bundle: fromServer, source: 'server', current: true };
    if (fromServer && isNewerVersion(fromServer.version, bundled.version)) {
      return { bundle: fromServer, source: 'server', current: false };
    }
    return { bundle: bundled, source: 'bundled', current: false };
  }
  if (fromServer && isNewerVersion(fromServer.version, bundled.version)) {
    return { bundle: fromServer, source: 'server', current: true };
  }
  return { bundle: bundled, source: 'bundled', current: true };
}

/** @deprecated kept for callers without a required version; see resolveLegalDocuments. */
export function preferLegalDocuments(
  bundled: LegalDocumentsBundle,
  fromServer: LegalDocumentsBundle | null,
): LoadedLegalDocuments {
  return resolveLegalDocuments(bundled, fromServer, null);
}

let inflight: Promise<LegalDocumentsBundle | null> | null = null;
// Last bundle the server handed over. Lets the consent screen's successful
// load feed the reader (and the reverse) without a second round trip, and
// keeps a current copy readable if the network drops between the two.
let lastServerBundle: LegalDocumentsBundle | null = null;

/** The most recent server bundle this process received, if any. */
export function cachedServerLegalDocuments(): LegalDocumentsBundle | null {
  return lastServerBundle;
}

/** Test seam: forget the cached server bundle. */
export function resetLegalDocumentsCache(): void {
  lastServerBundle = null;
  inflight = null;
}

/** GET /api/legal/documents — open route, no token; null on any failure. */
export function fetchLegalDocuments(): Promise<LegalDocumentsBundle | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await fetch(`${apiBase()}/legal/documents`, { headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      const parsed = parseLegalBundle(await response.json());
      if (parsed) lastServerBundle = parsed;
      return parsed;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Loads the copy to show for `requiredVersion`. Skips the network entirely
 * when the bundled copy (or an already-fetched server copy) is that
 * version; otherwise asks the API and falls back to the best copy on hand.
 */
export async function loadLegalDocuments(requiredVersion: string | null = null): Promise<LoadedLegalDocuments> {
  const bundled = legalDocumentsBundle();
  if (requiredVersion !== null) {
    if (bundled.version === requiredVersion) return resolveLegalDocuments(bundled, null, requiredVersion);
    if (lastServerBundle && lastServerBundle.version === requiredVersion) {
      return resolveLegalDocuments(bundled, lastServerBundle, requiredVersion);
    }
  }
  const fromServer = (await fetchLegalDocuments()) ?? lastServerBundle;
  return resolveLegalDocuments(bundled, fromServer, requiredVersion);
}
