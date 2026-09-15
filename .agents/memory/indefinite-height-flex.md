---
name: Indefinite-height flex chains
description: Percentage heights (h-full) silently collapse inside min-h-full/auto-height flex columns; use flex stretch instead.
---

The rule: inside a container whose height is indefinite (e.g. a `min-h-full`
or `flex-1` column whose `height` property is `auto`), `h-full` on a child
resolves against `auto` and collapses to content height — and to **zero** for
a wrapper whose only child is absolutely positioned. Setting an explicit
`height` also disables the default flex `align-items: stretch`, so the child
gets neither behavior.

**Why:** the /menu design-lab stage sat in a `min-h-full` column; every menu
panel used `h-full` and rendered content-height (dark rails stopped short of
the stage bottom), and the hover-rail wrapper collapsed to 0px so the slim
rail was invisible. Diagnostic tell: a sibling *without* `h-full` stretched
correctly — flex stretch works exactly where percentage heights fail.

**How to apply:** for full-height children of a flex row/column in this app,
omit height classes entirely (let stretch do it) and give inner fillers
`flex flex-col` + `min-h-0 flex-1`. Reserve `h-full`/`h-[100dvh]` for nodes
whose parent height is genuinely definite. Screenshots catch this class of
bug; DOM/a11y assertions do not.

**Paged-carousel corollary:** a horizontal paging `ScrollView` sizes its
content container to its children, so a page styled `{ width, height: '100%' }`
resolves against an indefinite height and can render an invisible (zero-height)
image. Measure the pager's own box with `onLayout` and give each page that
explicit width AND height — the same measurement then drives the paging math
(`round(contentOffset.x / pageWidth)`), so one source of truth covers both.

**RN-web corollary:** `alignSelf` on a `position: 'absolute'` box becomes CSS
`align-self`, and a non-auto self-alignment on an abspos box REPLACES
top/bottom inset stretching with block-axis alignment (css-align §6.4) — the
box collapses to content height on web while native Yoga renders fine, so RTR
suites stay green. Center absolute boxes with insets (`left: '50%'` + negative
margin), never `alignSelf`; a gBCR dump comparing inset-implied height against
the actual rect height pinpoints it fast.

**Shell-hosted page roots size to the shell's content area, never to the viewport.** The staff shells already subtract a header and a footer from the viewport; a page root that also demands full viewport height overflows the content area, the outer shell becomes the scroller, and anything pinned to the page's bottom edge (a composer, a scroll-to-newest target) lands off-screen while DOM-presence checks still pass. **How to apply:** verify pinned-bottom UI by measuring its rect against the viewport, not by asserting it exists.
