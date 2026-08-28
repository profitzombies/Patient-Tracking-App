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

**RN-web corollary:** `alignSelf` on a `position: 'absolute'` box becomes CSS
`align-self`, and a non-auto self-alignment on an abspos box REPLACES
top/bottom inset stretching with block-axis alignment (css-align §6.4) — the
box collapses to content height on web while native Yoga renders fine, so RTR
suites stay green. Center absolute boxes with insets (`left: '50%'` + negative
margin), never `alignSelf`; a gBCR dump comparing inset-implied height against
the actual rect height pinpoints it fast.
