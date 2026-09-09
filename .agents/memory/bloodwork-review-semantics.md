---
name: Bloodwork review semantics
description: User-approved distinction between extracted bloodwork, editable transcription and clinical review.
---

Bloodwork must include structured extracted results in Supabase, not only stored source documents. Save extraction as unreviewed without mandatory confirmation. Both the owning patient and authorized providers may correct the transcription; neither extraction nor an edit implies clinical sign-off.

**Why:** The user explicitly superseded the original document-only/no-extraction scope and rejected a required provider-confirmation step. Treating provider edits as approval would silently reintroduce a workflow they did not request.

**How to apply:** Preserve source reports and correction attribution, label extracted values honestly, and keep edit authorization separate from any future clinical-review semantics. Product recommendations based on bloodwork are a possible later phase, not authorization to implement recommendation logic now.