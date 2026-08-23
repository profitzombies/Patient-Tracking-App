/**
 * Shared Heritage patterns for the patient-record family.
 *
 * Every patient-record module (record page, nutrition section, charts, photo
 * timeline) consumes these recipes instead of restating literals, so the whole
 * record reads as one family: cream section cards with serif Playfair titles,
 * hairline insets, soft 9/7/5px geometry, and cobalt/warm/risk status tints
 * whose hexes mirror the mobile app's Heritage palette
 * (artifacts/thinnr-mobile/constants/colors.ts).
 */
import type { ReactNode } from "react";

/** Uppercase micro-label (Inter, wide tracking) above values and definition terms. */
export const MICRO_LABEL = "text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground";

/** Slightly larger micro-label for form fields and inner-panel headings. */
export const PANEL_LABEL = "text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground";

/** Status chips sit on the small 5px radius step. */
const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.06em]";
/** Cobalt tint — healthy / primary states. */
export const CHIP_COBALT = `${CHIP_BASE} border-accent-border bg-accent text-primary`;
/** Warm tint — paused / caution states (warn hexes shared with mobile). */
export const CHIP_WARM = `${CHIP_BASE} border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]`;
/** Risk tint — overdue / cancelled / missed states. */
export const CHIP_RISK = `${CHIP_BASE} border-[#d5a7a7] bg-[#fff0f0] text-destructive`;

/** Dark warm-accent text tone (mobile `warnText`) for warm annotations on paper. */
export const WARM_TEXT = "#b65c22";

/** Text inputs, selects, and textareas share one field shape. */
export const INPUT_CLASS =
  "rounded-md border border-border bg-card px-3 text-xs normal-case tracking-normal text-foreground shadow-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring";

export const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-md bg-primary text-xs font-semibold text-primary-foreground shadow-xs transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const BTN_SECONDARY =
  "inline-flex items-center justify-center gap-2 rounded-md border border-border bg-card text-xs font-semibold text-foreground shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Inline text action (cobalt link). */
export const LINK_ACTION =
  "rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Inset sub-panel (forms, summaries, strips) inside a section card. */
export const INSET = "rounded-md border border-border bg-secondary";

/** Inner "document" panel (diary, chart panels) inside a section card. */
export const PANEL = "rounded-md border border-border bg-paper-alt";

interface SectionCardProps {
  title: ReactNode;
  sub?: ReactNode;
  /** Right-aligned header slot for chips or actions. */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * Cream Heritage section card with a serif title header row.
 * Bodies bring their own padding so joined grids and tables can run edge to edge.
 */
export function SectionCard({ title, sub, action, className, children }: SectionCardProps) {
  return (
    <section className={`overflow-hidden rounded-lg border border-card-border bg-card shadow-soft ${className ?? ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="font-serif text-base font-bold leading-snug tracking-[.01em] text-navy">{title}</h2>
          {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
