---
name: Untrusted PDF processing boundaries
description: Resource isolation and production-build verification for private document rendering.
---

Bound untrusted parsing and native decoding outside the API process, including time, concurrent work, output and native memory. A small output canvas does not bound the size of embedded images being decoded.

**Why:** A PDF can open and report its page count while a later page is corrupt, and native canvas allocations are not bounded by the JavaScript heap limit alone.

**How to apply:** Validate all page references and resources before acceptance, preserve original bytes, terminate failed workers, and confirm that a healthy request still succeeds afterward. Never return a truncated extraction as successful.

Verify the emitted worker and native-module resolution, not only source-level tests.

**Why:** Type checking and document tests passed while the API bundle failed on the platform-specific canvas binary; a generic external pattern for file extensions did not cover the package import.

**How to apply:** Verify production artifact execution after parser or bundler changes; source tests alone do not cover runtime native-module resolution.