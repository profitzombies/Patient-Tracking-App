---
name: Expo font pipeline (Android tofu fix)
description: Why icon fonts must be preloaded at the root, and how the static-build font pipeline is kept canonical and verified.
---

# Expo font pipeline

**Rule 1 — preload icon fonts with text fonts.** Every font the app renders
(Google fonts AND `Feather.font` / `MaterialCommunityIcons.font` from
`@expo/vector-icons`) must be in the root layout's single `Font.loadAsync`
map, gating first render. Never rely on @expo/vector-icons' lazy per-icon
loading.
**Why:** lazy icon-font loading fails *silently* on real Android devices —
glyphs render as tofu/X boxes or junk PUA characters (Samsung fills some
private-use codepoints), while bundled images load fine, so the failure looks
like an "icons" bug rather than a font-delivery bug. Font-load failures must
surface a retry UI (system-font only — no custom fonts/icons in that screen),
never silently continue.

**Rule 2 — emitted asset URLs must be canonical.** Under pnpm, Metro emits
`unstable_path` values relative to the *artifact project root* with dot
segments (`./../../node_modules/.pnpm/…`) for hoisted packages — which is
where every font lives. The static-build script must collapse dot segments
(`path.posix.join`) when rewriting bundle/manifest URLs so the URL string
matches the on-disk layout produced by `path.join`.
**Why:** raw dotted URLs only work because most HTTP clients normalize
`/../` before requesting — device HTTP stacks and proxies are not guaranteed
to, and the byte-identical check can pass in Node (whose `fetch`/`URL`
normalizes) while a device 404s.

**How to verify:** `node scripts/verify-static-fonts.js` in the mobile
artifact after a build — proves extraction, canonical URLs, byte-identical
serving through serve.js (with query strings), and manifest URLs. The dev
flow can be spot-checked by fetching
`/assets/?unstable_path=<encoded project-root-relative path>` through the
Expo proxy domain and comparing sha256 to the node_modules source.
