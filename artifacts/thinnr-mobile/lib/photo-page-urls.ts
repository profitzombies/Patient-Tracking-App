/**
 * One-call photo pages for the account media rail.
 *
 * Every stored photo used to be its own authenticated request: <Image>
 * hits GET /patient-media/file, the server verifies the media token and
 * 302s to a signed URL. A grid of thirty photos was thirty round trips,
 * each carrying the full-size image. This module trades that for one POST
 * to /patient-media/urls per screen, which returns short-lived signed URLs
 * for a whole list of paths at a requested size (thumb for grids and chat
 * previews, medium for tap-in viewers).
 *
 * The contract for callers is a resolver, not a map: `urlFor(path)` gives
 * the page-signed URL when the page has landed and otherwise the per-photo
 * file route at the same size. So a grid renders on first paint, keeps
 * rendering if the page call fails, and simply gets cheaper once the page
 * arrives. The server decides per photo whether the asked size exists yet
 * (older photos are backfilled in the background) — a URL from either path
 * is always an image that exists.
 *
 * Pages only cover the account rail (paths under /objects/patient-media/)
 * and only while a media token is held; the demo persona holds none and
 * keeps its bundled seed images, so nothing here fires for it.
 */
import { useEffect, useMemo, useState } from 'react';
import { apiBase } from '@/lib/coach-api';
import { appendMediaToken, currentMediaToken } from '@/lib/media-token-holder';

export type PhotoSize = 'thumb' | 'medium' | 'original';

/** Server page ceiling — larger lists are split into sequential calls. */
export const PHOTO_PAGE_MAX = 100;

/** Re-sign this long before the server's expiresAt so a URL never goes stale mid-scroll. */
const REFRESH_LEAD_MS = 2 * 60 * 1000;
/** Bounds the refresh timer when expiresAt is missing or malformed. */
const DEFAULT_TTL_MS = 25 * 60 * 1000;

export const PATIENT_MEDIA_PREFIX = '/objects/patient-media/';

export function isPatientMediaPath(objectPath: string): boolean {
  return objectPath.startsWith(PATIENT_MEDIA_PREFIX);
}

/** Query suffix a per-photo file URL needs to ask for a size. */
export function sizeQuery(size?: PhotoSize): string {
  return size && size !== 'original' ? `&variant=${size}` : '';
}

/**
 * Display URL for one stored photo at a size — the per-photo 302 route.
 * Account media reads are token-authorized (the token minted at hydration
 * rides the URL because <Image> cannot send bearer headers); anything else
 * is a legacy object from the retired anonymous rail, served read-only.
 */
export function photoFileUrl(objectPath: string, size?: PhotoSize): string {
  if (isPatientMediaPath(objectPath)) {
    return appendMediaToken(
      `${apiBase()}/patient-media/file?path=${encodeURIComponent(objectPath)}${sizeQuery(size)}`,
    );
  }
  return `${apiBase()}/progress-photos/file?path=${encodeURIComponent(objectPath)}`;
}

export interface PhotoPage {
  urls: Map<string, { url: string; size: PhotoSize }>;
  expiresAt: number;
}

/**
 * Signs one page of account photos (≤ PHOTO_PAGE_MAX paths, one patient).
 * Throws on any failure — the hook below turns that into "keep the
 * per-photo fallback", and nothing else should swallow it.
 */
export async function fetchPhotoPage(
  paths: readonly string[],
  size: PhotoSize,
  options?: { signal?: AbortSignal },
): Promise<PhotoPage> {
  const mt = currentMediaToken();
  if (!mt) throw new Error('No media token held for this account.');
  const response = await fetch(`${apiBase()}/patient-media/urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths, variant: size, mt }),
    signal: options?.signal,
  });
  if (!response.ok) throw new Error(`Photo page signing failed (${response.status}).`);
  const json = (await response.json()) as { urls?: unknown; expiresAt?: unknown };
  if (!Array.isArray(json.urls)) throw new Error('Photo page returned an unexpected response.');
  const urls = new Map<string, { url: string; size: PhotoSize }>();
  for (const item of json.urls as Array<Record<string, unknown>>) {
    if (typeof item?.path !== 'string' || typeof item.url !== 'string') continue;
    const signed = item.size === 'thumb' || item.size === 'medium' ? item.size : 'original';
    urls.set(item.path, { url: item.url, size: signed });
  }
  const parsed = typeof json.expiresAt === 'string' ? Date.parse(json.expiresAt) : NaN;
  return { urls, expiresAt: Number.isFinite(parsed) ? parsed : Date.now() + DEFAULT_TTL_MS };
}

/** Splits an arbitrary list into server-sized pages, preserving order. */
export function chunkPaths(paths: readonly string[], max = PHOTO_PAGE_MAX): string[][] {
  const pages: string[][] = [];
  for (let i = 0; i < paths.length; i += max) pages.push(paths.slice(i, i + max));
  return pages;
}

/** Resolver handed to screens: the page URL when known, else the file route. */
export type PhotoUrlResolver = (objectPath: string) => string;

/**
 * Signs every account-rail path in `paths` at `size` with as few calls as
 * possible and returns a resolver. Paths that are not on the account rail
 * (legacy objects, seed ids) and every path until the page lands resolve to
 * the per-photo file route at the same size, so callers never branch.
 *
 * Re-fetches when the set of paths changes (a new photo added, one removed)
 * and shortly before the signed URLs expire. A failed page is logged and
 * leaves the fallback in place; the next paths change retries.
 */
export function usePhotoPageUrls(paths: readonly string[], size: PhotoSize): PhotoUrlResolver {
  // Stable identity for the SET of paths, so reorders and duplicate renders
  // do not re-sign the same page.
  const pageKey = useMemo(() => {
    const unique = Array.from(new Set(paths.filter(isPatientMediaPath))).sort();
    return unique.join('\n');
  }, [paths]);
  // The last landed page stays in service while a newer set of paths is
  // being signed (its URLs are still valid), and is dropped at expiry so a
  // failed refresh can never keep serving dead links.
  const [page, setPage] = useState<(PhotoPage & { size: PhotoSize }) | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (pageKey.length === 0 || !currentMediaToken()) return;
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const wanted = pageKey.split('\n');
    (async () => {
      const merged: PhotoPage['urls'] = new Map();
      let soonest = Number.POSITIVE_INFINITY;
      for (const chunk of chunkPaths(wanted)) {
        const result = await fetchPhotoPage(chunk, size, { signal: controller.signal });
        for (const [path, entry] of result.urls) merged.set(path, entry);
        soonest = Math.min(soonest, result.expiresAt);
      }
      if (controller.signal.aborted) return;
      const expiresAt = Number.isFinite(soonest) ? soonest : Date.now() + DEFAULT_TTL_MS;
      setPage({ size, urls: merged, expiresAt });
      const ttl = expiresAt - Date.now();
      refreshTimer = setTimeout(
        () => setRefreshTick((tick) => tick + 1),
        Math.max(ttl - REFRESH_LEAD_MS, 30_000),
      );
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn(`Photo page (${size}) unavailable; falling back to per-photo loads`, error);
    });
    return () => {
      controller.abort();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [pageKey, size, refreshTick]);

  return useMemo<PhotoUrlResolver>(() => {
    const live = page && page.size === size ? page : null;
    return (objectPath: string) =>
      (live && Date.now() < live.expiresAt ? live.urls.get(objectPath)?.url : undefined) ??
      photoFileUrl(objectPath, size);
  }, [page, size]);
}
