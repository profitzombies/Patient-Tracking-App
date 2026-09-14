---
name: Tailwind v4 CSS-variable utility syntax
description: Why shadcn components pasted from v3-era templates render unsized/unstyled under Tailwind v4, and the one-line grep that finds them.
---

Under Tailwind v4, `h-[--cell-size]` / `origin-[--radix-...]` / `bg-[--color-bg]` (v3 "bare variable" arbitrary values) generate **nothing** — no error, no class. v4 needs `h-(--cell-size)`; `[--cell-size:2rem]` (setting a var) is still fine.

**Why:** the date-range calendar rendered with cramped, unsized day cells because every cell-size utility in the shadcn calendar was silently dropped; the same dead syntax sat in select/popover/menu components (animation origins, max heights).

**How to apply:** when a shadcn/Radix component looks unstyled or unsized under this workspace, run `grep -rnE "[a-z]-\[--[a-zA-Z0-9-]+\]" src` and convert matches to the `-(--var)` form. Verify visually — typecheck and builds stay green either way.
