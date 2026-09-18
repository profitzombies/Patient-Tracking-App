/**
 * Live patient progress photos for staff: a thumbnail grid that opens a
 * medium-size viewer, with the original kept for download.
 *
 * Display URLs come from ONE page-signing call per size instead of one
 * authenticated redirect per <img>: thumbnails are signed with the grid,
 * medium only once the viewer opens. Until a page lands — or if it fails —
 * every photo falls back to the record's own URL (the original), so the
 * grid always renders; older photos whose variants are still being
 * backfilled are served as originals by the server itself.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BTN_SECONDARY, LINK_ACTION } from "@/components/patient/heritage";
import { fetchOfficePatientPhotoPage, type OfficePhotoSize, type OfficeProgressPhoto } from "@/lib/office-roster";

/** Signed page URLs stay valid ~15 min; re-sign well inside that. */
const PAGE_STALE_MS = 10 * 60 * 1000;

interface LiveProgressPhotosProps {
  patientId: string;
  office: string | null;
  photos: OfficeProgressPhoto[];
  patientName: string;
  /** Renders the date under each photo (the page owns its date format). */
  formatDate: (dateKey: string) => string;
}

export function photoPageQueryKey(
  office: string | null,
  patientId: string,
  variant: OfficePhotoSize,
  ids: readonly string[],
) {
  return ["office-patient-photo-page", office ?? "own", patientId, variant, ids.join(",")] as const;
}

function usePhotoPage(
  patientId: string,
  office: string | null,
  ids: string[],
  variant: OfficePhotoSize,
  enabled: boolean,
) {
  return useQuery({
    queryKey: photoPageQueryKey(office, patientId, variant, ids),
    queryFn: () => fetchOfficePatientPhotoPage(patientId, ids, variant, office),
    enabled: enabled && ids.length > 0,
    staleTime: PAGE_STALE_MS,
    refetchInterval: PAGE_STALE_MS,
    retry: false,
  });
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid aspect-square w-full place-items-center bg-accent p-3 text-center text-[10px] text-muted-foreground">
      {children}
    </div>
  );
}

export function LiveProgressPhotos({ patientId, office, photos, patientName, formatDate }: LiveProgressPhotosProps) {
  const viewable = photos.filter((photo) => Boolean(photo.url));
  const ids = viewable.map((photo) => photo.id);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const isOpen = openIndex !== null;

  const thumbs = usePhotoPage(patientId, office, ids, "thumb", true);
  const mediums = usePhotoPage(patientId, office, ids, "medium", isOpen);

  // A shrinking list (photo removed by the patient) must not strand the viewer.
  useEffect(() => {
    if (openIndex !== null && openIndex >= viewable.length) setOpenIndex(viewable.length ? viewable.length - 1 : null);
  }, [openIndex, viewable.length]);

  if (photos.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-secondary p-6 text-center text-xs text-muted-foreground">
        No progress photos have been uploaded.
      </div>
    );
  }

  const current = openIndex !== null ? viewable[openIndex] : null;
  const caption = (photo: OfficeProgressPhoto) => `${formatDate(photo.dateKey)}${photo.angle ? ` · ${photo.angle}` : ""}`;

  return (
    <>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="live-progress-photos">
        {photos.map((photo) => {
          const index = viewable.findIndex((candidate) => candidate.id === photo.id);
          const thumb = thumbs.data?.get(photo.id);
          const thumbUrl = thumb?.url ?? photo.url;
          return (
            <li key={photo.id} className="overflow-hidden rounded-lg border border-border bg-card">
              {photo.url && thumbUrl ? (
                <button
                  type="button"
                  data-testid={`live-progress-photo-${photo.id}`}
                  aria-label={`View ${photo.label || "progress"} photo for ${patientName}`}
                  onClick={() => setOpenIndex(index)}
                  className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt"
                >
                  <img
                    src={thumbUrl}
                    alt=""
                    className="aspect-square w-full bg-accent object-cover"
                    loading="lazy"
                    data-photo-size={thumb?.size ?? "original"}
                  />
                </button>
              ) : (
                <Placeholder>Photo preview unavailable.</Placeholder>
              )}
              <figcaption className="block p-2">
                <b className="text-xs text-navy">{photo.label || "Progress photo"}</b>
                <p className="text-[10px] text-muted-foreground">{caption(photo)}</p>
              </figcaption>
            </li>
          );
        })}
      </ul>

      <Dialog open={isOpen} onOpenChange={(open) => { if (!open) setOpenIndex(null); }}>
        <DialogContent className="max-w-3xl" data-testid="live-progress-photo-viewer">
          {current ? (
            <>
              <DialogHeader>
                <DialogTitle>{current.label || "Progress photo"}</DialogTitle>
                <DialogDescription>
                  {caption(current)} · Photo {(openIndex ?? 0) + 1} of {viewable.length} for {patientName}
                </DialogDescription>
              </DialogHeader>
              <div className="grid max-h-[70vh] place-items-center overflow-hidden rounded-md bg-navy/95">
                <img
                  key={current.id}
                  src={mediums.data?.get(current.id)?.url ?? current.url ?? undefined}
                  alt={`${current.label || "Progress"} photo for ${patientName}, ${caption(current)}`}
                  className="max-h-[70vh] w-auto max-w-full object-contain"
                  data-photo-size={mediums.data?.get(current.id)?.size ?? "original"}
                />
              </div>
              <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={BTN_SECONDARY}
                    aria-label="Previous photo"
                    disabled={(openIndex ?? 0) <= 0}
                    onClick={() => setOpenIndex((index) => (index === null ? null : Math.max(0, index - 1)))}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    type="button"
                    className={BTN_SECONDARY}
                    aria-label="Next photo"
                    disabled={(openIndex ?? 0) >= viewable.length - 1}
                    onClick={() => setOpenIndex((index) => (index === null ? null : Math.min(viewable.length - 1, index + 1)))}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
                {/* Downloads always take the untouched original, never a variant. */}
                <a
                  className={`${LINK_ACTION} inline-flex items-center gap-1.5`}
                  href={current.url ?? undefined}
                  download
                  target="_blank"
                  rel="noreferrer"
                  data-testid="live-progress-photo-download"
                >
                  <Download size={13} /> Download original
                </a>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
