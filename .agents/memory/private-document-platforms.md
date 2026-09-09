---
name: Private document platform boundaries
description: Cross-platform traps in Expo document selection, upload and private image viewing.
---

Treat browser File/Blob handling and native filesystem handling as separate adapters. Expo legacy filesystem functions can exist in the TypeScript declarations while their web implementation is unavailable.

**Why:** Native-adapter stubs allowed tests to pass even though every browser selection would call a missing filesystem implementation.

**How to apply:** Test the browser branch with unavailable native filesystem functions, and separately exercise the native upload, progress, failure and cancellation contract. Do not make mocks invent platform support.

Private native image sources need an absolute trusted API URL, bearer headers and disabled caching. Configuring the generated fetch client's base URL does not configure Expo Image.

**Why:** Relative authenticated image URLs work in browsers but fail on native devices, so web viewing is not proof that native private viewing works.

**How to apply:** Resolve image URLs through the existing configured API origin and test the actual native source object independently of the web blob viewer.

Temporary-file ownership starts when a native picker creates its cache copy, before validation or preparation succeeds.

**Why:** Screen-level cleanup cannot dispose rejected copies that were never handed to the screen, so validating MIME, size or a document header can otherwise leave private files behind.

**How to apply:** Keep ownership inside the adapter until successful handoff, clean failed preparations in `finally`, and never delete the user's original library/provider file.