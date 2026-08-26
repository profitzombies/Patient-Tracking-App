---
name: In-app food camera handoff
description: How the full-screen food camera hands captures back to coach photo entry points, and where confirmation lives
---
The mobile app's Instagram-style food camera (full-screen surface component + its route screen) returns the RAW captured/picked asset through a module-level promise handoff: an entry point creates a request and pushes the camera route; the screen claims the request exactly once and settles `{ asset, source: 'camera' | 'library' }`, or null when the patient closes without choosing. First settle wins (later settles are no-ops), a new request settles an orphaned predecessor with null, and the route's unmount cleanup settles null so callers never hang.

**Why:** photo-prep sizing, the single blue "Use this photo" confirmation, photoKind stamping, and meal-slot pinning are entry-point concerns. Keeping the camera surface dumb (raw asset out) lets every coach entry point reuse one surface without double-confirming — the original system-camera handoff forced the patient to confirm the same photo twice.

**How to apply:** any new capture entry (progress photos, menu/label scan screens) should reuse the same handoff and stage-confirm-send seam instead of launching the system camera. Camera/media permission fallbacks live INSIDE the surface (library corner button, plain explanation, re-ask or Settings route — never a dead end), so entry points need no denied-camera branches. Web branches skip the route entirely: live capture controls are hidden on web and the picker flow stays as-is.
