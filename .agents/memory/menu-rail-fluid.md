---
name: Fluid menu rail collapse
description: Collapsed side-menu rails must size blocks fluidly; fixed-width content clipped at the rail edge was rejected.
---

The live side menu (shared SideMenu component, used by the office Shell, AdminShell, and the lab's Porcelain preview) collapses to its 68px rail by sizing every block FLUIDLY: blocks are `w-full` inside `px-3` gutters with `overflow-hidden` + `whitespace-nowrap`, so at 68px each block becomes a self-contained 44px icon box with symmetric margins, and labels/badges clip away inside their own box.

**Why:** the earlier approach — laying content at a fixed expanded width and clipping the aside at 68px — sliced the workspace card, CTA, and active-row fill at the rail's right edge. The user explicitly rejected that ("cut off to the right-hand side"; boxes must mirror the left side's margins).

**How to apply:** any new block added to the menu must follow the same recipe (w-full in the gutter, overflow-hidden, icon in a `w-11` leading well, nowrap text); controls that make no sense at 44px (gear, sign-out) render only when `expanded`. Hairline dividers open each section so the collapsed rail reads as organized groups. The lab's RailFrame still uses fixed-width clipping for the five archived design previews only — don't copy it for live UI.
