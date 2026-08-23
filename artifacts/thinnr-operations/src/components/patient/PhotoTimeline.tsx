import { useState } from "react";
import { UserRound } from "lucide-react";
import { formatDateKey, type ProgressPhoto } from "@/data/nutrition-data";
import { MICRO_LABEL, PANEL_LABEL } from "./heritage";

interface PhotoTimelineProps {
  photos: ProgressPhoto[];
  patientName: string;
}

function PhotoFrame({ photo, patientName, className }: { photo: ProgressPhoto; patientName: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!photo.imageUrl || failed) {
    return (
      <div className={`grid place-items-center bg-accent text-primary/50 ${className ?? ""}`} role="img" aria-label={`${photo.label} milestone placeholder for ${patientName}`}>
        <span className="flex flex-col items-center gap-1.5">
          <UserRound size={34} strokeWidth={1.4} />
          <span className="text-[8px] font-bold uppercase tracking-[.12em]">No preview</span>
        </span>
      </div>
    );
  }
  return (
    <img
      src={photo.imageUrl}
      alt={`${photo.label} progress photo logged by ${patientName}`}
      loading="lazy"
      className={`bg-accent object-cover ${className ?? ""}`}
      onError={() => setFailed(true)}
    />
  );
}

/** Milestone photo timeline with a two-up compare view. */
export function PhotoTimeline({ photos, patientName }: PhotoTimelineProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    photos.length >= 2 ? [photos[0].id, photos[photos.length - 1].id] : photos.map((photo) => photo.id),
  );

  if (photos.length === 0) {
    return (
      <div className="grid h-32 place-items-center rounded-md border border-dashed border-border bg-secondary p-6 text-center text-xs text-muted-foreground">
        No progress photos have been logged yet.
      </div>
    );
  }

  const toggle = (id: string) => {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((existing) => existing !== id);
      if (current.length < 2) return [...current, id];
      return [current[1], id];
    });
  };

  const comparePair = photos
    .filter((photo) => selectedIds.includes(photo.id))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const [before, after] = comparePair;
  const baseline = photos[0];

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {photos.map((photo) => {
          const selectionIndex = comparePair.findIndex((candidate) => candidate.id === photo.id);
          const isSelected = selectionIndex >= 0;
          const delta = photo.weight - baseline.weight;
          return (
            <button
              key={photo.id}
              onClick={() => toggle(photo.id)}
              aria-pressed={isSelected}
              className={`relative overflow-hidden rounded-lg border bg-card text-left shadow-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isSelected ? "border-primary shadow-[inset_0_0_0_1px_hsl(var(--primary))]" : "border-border hover:border-primary/50"}`}
            >
              {isSelected && comparePair.length === 2 && (
                <span className="absolute left-0 top-0 z-10 rounded-br-md bg-primary px-1.5 py-0.5 text-[9px] font-bold text-primary-foreground">
                  {selectionIndex === 0 ? "A" : "B"}
                </span>
              )}
              <PhotoFrame photo={photo} patientName={patientName} className="aspect-square w-full" />
              <span className="block border-t border-border p-2">
                <span className="flex items-baseline justify-between gap-2">
                  <b className="font-serif text-xs font-bold text-navy">{photo.label}</b>
                  <span className="font-mono text-[10px] text-primary">{photo.weight.toFixed(1)} lbs</span>
                </span>
                <span className="mt-0.5 flex items-baseline justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{formatDateKey(photo.dateKey, true)}</span>
                  {delta !== 0 && <span className="font-mono">{delta < 0 ? "−" : "+"}{Math.abs(delta).toFixed(1)}</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {before && after && comparePair.length === 2 ? (
        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-secondary">
          <p className={`border-b border-border px-3 py-2 ${PANEL_LABEL}`}>
            Compare · {before.label} vs {after.label}
          </p>
          <div className="grid gap-px bg-border sm:grid-cols-[1fr_auto_1fr]">
            {[before, after].map((photo, index) => (
              <div key={photo.id} className="bg-card p-3">
                <PhotoFrame photo={photo} patientName={patientName} className="aspect-square w-full rounded-md" />
                <p className="mt-2 flex items-baseline justify-between text-xs">
                  <b className="font-serif font-bold text-navy">{index === 0 ? "A" : "B"} · {photo.label}</b>
                  <span className="font-mono text-primary">{photo.weight.toFixed(1)} lbs</span>
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{formatDateKey(photo.dateKey, true)}</p>
              </div>
            ))}
            <div className="order-first grid place-items-center bg-secondary px-4 py-3 text-center sm:order-none sm:w-36">
              <div>
                <p className={MICRO_LABEL}>Change</p>
                <p className={`mt-1 font-mono text-xl ${after.weight <= before.weight ? "text-primary" : "text-[#b65c22]"}`}>
                  {after.weight <= before.weight ? "−" : "+"}{Math.abs(after.weight - before.weight).toFixed(1)} lbs
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  over {Math.round((new Date(`${after.dateKey}T12:00:00`).getTime() - new Date(`${before.dateKey}T12:00:00`).getTime()) / 86_400_000)} days
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-[10px] text-muted-foreground">Select any two milestones to compare them side by side.</p>
      )}
    </div>
  );
}
