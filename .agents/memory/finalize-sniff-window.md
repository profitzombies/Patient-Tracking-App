---
name: Finalize sniff window
description: Magic-byte head sniffs on uploaded images need a 64 KB head, not 4 KB
---

# Image finalize sniff window

Rule: when a finalize route validates stored bytes by sniffing a ranged head, download a 64 KB head — not 4 KB.

**Why:** JPEG detection has to WALK segments to the SOF size marker, and metadata-heavy files (Photoshop/XMP stacks, AI-generation APP11 tags, DSLR EXIF) routinely push SOF past 4 KB. A 4 KB window made finalize reject byte-identical, perfectly valid JPEGs — proven live: the app's own AI-generated pose fixtures carry a ~7.6 KB APP11 segment putting SOF at ~8.6 KB. APPn segment lengths cap at 64 KB, so a 64 KB head reaches SOF in practice.

**How to apply:** any upload-finalize route that re-validates stored image bytes (progress photos, thumbnails, future uploads). Pin the window in tests via the recorded download range, and prove new upload paths with a live curl roundtrip using a REAL fixture file — synthetic minimal images hide this class of bug.
