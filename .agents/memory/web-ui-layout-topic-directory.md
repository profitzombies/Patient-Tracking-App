---
name: Web UI, layout & Tailwind topic directory
description: Index of the web layout, Tailwind and component-behaviour lessons that used to sit one-per-line in MEMORY.md; open the named file for the detail.
---

Grouped to keep the MEMORY.md index short. Each bullet names the topic file in this
directory that holds the full lesson.

- [tailwind-v4-var-syntax.md](tailwind-v4-var-syntax.md) — `h-[--x]` (v3 form) is silently dropped by v4; use `h-(--x)`; grep ui/ when a shadcn part renders unsized.
- [tailwind-theme-color-mapping.md](tailwind-theme-color-mapping.md) — a css var only becomes a utility class once mapped --color-* in @theme inline; unmapped bg-chart-*/text-warn render nothing.
- [indefinite-height-flex.md](indefinite-height-flex.md) — h-full collapses in min-h-full columns; shell-hosted roots must not add min-h-[100dvh]; RN-web alignSelf kills inset stretch.
- [menu-rail-fluid.md](menu-rail-fluid.md) — collapsed rails size blocks fluidly (w-full in gutters + overflow-hidden); fixed-width clipping slices box edges and was rejected.
- [table-overflow-phone.md](table-overflow-phone.md) — sr-only spans escape overflow-x wrappers and widen the page; truncate max-w caps drive table min-content; measure page AND wrapper at 390px.
- [fixed-table-width-budget.md](fixed-table-width-budget.md) — truncate needs table-fixed; reserve widths for all but one column and keep the sum under the card width.
- [clickable-surfaces.md](clickable-surfaces.md) — review rejects focusable div/tr click targets; use stretched-link cards or one announced row link plus a pointer-only tr onClick.
- [a11y-announced-errors.md](a11y-announced-errors.md) — ErrorBox self-announces (alert role + live region; never nest live regions); blocked CTAs intercept taps via aria-disabled.
- [hq-toast-layer.md](hq-toast-layer.md) — sound rides the variant; Radix won't announce in-place morphs; progress toasts pin against eviction; gated writes return landed booleans.
- [scoped-style-font-reset.md](scoped-style-font-reset.md) — `.root button{font:inherit}` beats class font-size rules; use font-family:inherit in mockup style blocks.
- [setup-action-feedback.md](setup-action-feedback.md) — setup buttons use BusyLabel + ref locks; RTR suites must read button text from instance children, not props.
