---
name: Coach context across response pipelines
description: Verify historical recall and personalization beyond the default prose response.
---

Cross-cutting Coach context changes need coverage across specialized responses, not only the final plain-chat prompt.

**Why:** An earlier-chat question containing recipe words successfully retrieved history but was then routed into recipe generation, discarding the recall result. Plain-chat and retrieval tests alone missed the user-visible failure.

**How to apply:** Test intent collisions and ambiguity before specialized dispatch, and assert approved context reaches recommendation-generating prompts. Keep visual facts extraction evidence-based; a remembered preference must not change what the model says is physically present in a photo.