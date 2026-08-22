import { useState } from "react";
import { UserRound } from "lucide-react";
import { formatDateKey, type ProgressPhoto } from "@/data/nutrition-data";

interface PhotoTimelineProps {
  photos: ProgressPhoto[];
  patientName: string;
}

function PhotoFrame({ photo, patientName, className }: { photo: ProgressPhoto; patientName: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!photo.imageUrl || failed) {
    return (
      <div className={`grid place-items-center bg-[#e3e9f5] text-[#93a5c8] ${className ?? ""}`} role="img" aria-label={`${photo.label} milestone placeholder for ${patientName}`}>
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
      className={`bg-[#e3e9f5] object-cover ${className ?? ""}`}
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
      <div className="grid h-32 place-items-center border border-dashed border-[#bdc9dc] bg-[#f8f9fc] p-6 text-center text-xs text-[#718099]">
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
              className={`relative border bg-white text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315fc0] ${isSelected ? "border-[#315fc0] shadow-[inset_0_0_0_1px_#315fc0]" : "border-[#dfe5ef] hover:border-[#9eb2d9]"}`}
            >
              {isSelected && comparePair.length === 2 && (
                <span className="absolute left-0 top-0 z-10 bg-[#315fc0] px-1.5 py-0.5 text-[9px] font-bold text-white">
                  {selectionIndex === 0 ? "A" : "B"}
                </span>
              )}
              <PhotoFrame photo={photo} patientName={patientName} className="aspect-square w-full" />
              <span className="block border-t border-[#dfe5ef] p-2">
                <span className="flex items-baseline justify-between gap-2">
                  <b className="text-xs text-[#172c56]">{photo.label}</b>
                  <span className="font-mono text-[10px] text-[#3156a2]">{photo.weight.toFixed(1)} lbs</span>
                </span>
                <span className="mt-0.5 flex items-baseline justify-between gap-2 text-[10px] text-[#7b879d]">
                  <span>{formatDateKey(photo.dateKey, true)}</span>
                  {delta !== 0 && <span className="font-mono">{delta < 0 ? "−" : "+"}{Math.abs(delta).toFixed(1)}</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {before && after && comparePair.length === 2 ? (
        <div className="mt-4 border border-[#dfe5ef] bg-[#f8f9fc]">
          <p className="border-b border-[#dfe5ef] px-3 py-2 text-[9px] font-bold uppercase tracking-[.12em] text-[#74839d]">
            Compare · {before.label} vs {after.label}
          </p>
          <div className="grid gap-px bg-[#dfe5ef] sm:grid-cols-[1fr_auto_1fr]">
            {[before, after].map((photo, index) => (
              <div key={photo.id} className="bg-white p-3">
                <PhotoFrame photo={photo} patientName={patientName} className="aspect-square w-full" />
                <p className="mt-2 flex items-baseline justify-between text-xs">
                  <b className="text-[#172c56]">{index === 0 ? "A" : "B"} · {photo.label}</b>
                  <span className="font-mono text-[#3156a2]">{photo.weight.toFixed(1)} lbs</span>
                </p>
                <p className="mt-0.5 text-[10px] text-[#7b879d]">{formatDateKey(photo.dateKey, true)}</p>
              </div>
            ))}
            <div className="order-first grid place-items-center bg-[#f8f9fc] px-4 py-3 text-center sm:order-none sm:w-36">
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#8793a8]">Change</p>
                <p className={`mt-1 font-mono text-xl ${after.weight <= before.weight ? "text-[#3156a2]" : "text-[#97631e]"}`}>
                  {after.weight <= before.weight ? "−" : "+"}{Math.abs(after.weight - before.weight).toFixed(1)} lbs
                </p>
                <p className="mt-1 text-[10px] text-[#7b879d]">
                  over {Math.round((new Date(`${after.dateKey}T12:00:00`).getTime() - new Date(`${before.dateKey}T12:00:00`).getTime()) / 86_400_000)} days
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-[10px] text-[#718099]">Select any two milestones to compare them side by side.</p>
      )}
    </div>
  );
}
