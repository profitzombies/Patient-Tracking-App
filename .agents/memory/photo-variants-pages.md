---
name: Photo variants & one-call photo pages
description: How progress/chat photo thumbnails, medium variants, and batch-signed photo pages work across API, mobile, and staff web — and the test seams that bit.
---
# Photo variants & one-call photo pages

**Rule:** photo display is a *resolver*, not a URL map. Clients ask one page endpoint for a whole list of photos at a size (thumb for grids/chat previews, medium for viewers); until the page lands, or if it fails, every photo resolves to its per-photo file route at the same size (`&variant=`). Originals are untouched and remain the download/export URL; the office DTO `url` stays original.

**Why:** a 30-photo grid used to be 30 authenticated redirects each carrying the full image. A map-based contract forced callers to branch on "loaded yet?" and blanked grids on a failed page; the resolver keeps first paint and failure paths identical to the old per-photo behavior.

**How to apply:**
- Variants are sibling objects (`<original>.thumb`, `.medium`), availability on the photo row; the server answers per item with the *actual* signed size (original when not yet backfilled) — clients label with that, never with "did the page have it".
- Medium pages are signed only when a viewer opens (mobile: `viewer.open ? paths : NO_PATHS`; web: react-query `enabled`). The suites mutation-check this.
- Legacy `/objects/progress-photos/` paths never take a variant and never join a page; demo persona holds no media token, so no page call fires.
- PatientProvider clears the media token during its mount/hydration reset: a Node suite must set the token AFTER the provider renders, before adding photos, to stand in for real hydration.
- Web viewer is a Radix Dialog: suites rendering it need the DOM-free dialog stub (office-admin-stubs); it drops `data-testid`, find it by `role="dialog"`.
- Lib files must import siblings via `@/lib/*` aliases — a relative import bypasses per-suite stub maps and loads real react-native under Node (TransformError).
