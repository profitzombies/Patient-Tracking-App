---
name: Coach no-dash voice
description: How the coach's em/en-dash ban is enforced structurally (strings + streams), and the traps around error paths, catalog names, and test fixtures.
---

The coach must never show an em/en dash. Prompts alone cannot guarantee it, so enforcement is structural:

- Whole strings (canned text, JSON fields from the model) go through `stripDashes` at every user-visible call site (per-pipeline `cleanCoachText` composition; the shared `cleanModelText` stays untouched because training transcripts must remain verbatim).
- The streamed pipeline uses a chunk-bridging smoother (`DashSmoother`) that holds back a short trailing run (digits/spaces/dashes) so a dash split across SSE chunk boundaries still rewrites. Digit ranges become hyphens; other dashes become ", " with punctuation cleanup.

**Why:** a live demo surfaced dashes surviving prompt-level bans; and a dash arriving as its own chunk defeats any per-chunk regex.

**How to apply:**
- Any rewriting smoother MUST be drained on EVERY terminal path that can still write — normal end, stop, and the mid-stream error catch (drain filter+smoother to the wire before writing the error event, guarded on client-abort). Otherwise held tails are silently dropped.
- Official/canonical catalog names ("Canned Tuna – Water Packed") are de-dashed at DISPLAY time only, after id-based validation — never mutate the canonical wording used for matching.
- A stream smoother changes SSE chunk boundaries: tests that pin `data: {"content":...}` shapes must be updated to the new boundaries, and keep at least one deliberately dashed fixture as proof the pipeline strips it.
