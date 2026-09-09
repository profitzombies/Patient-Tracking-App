---
name: Implementation brief scope
description: Keep planning-session disclaimers out of tasks intended to deliver working features.
---

A proposed implementation task must describe work to build, even when its author is currently in Plan mode. Keep “nothing is being implemented yet” in the conversation, not as a prohibition inside the task's execution scope.

**Why:** A food-search task containing a planning-only disclaimer was completed and merged as a design document, while the user expected the feature to have been added. Merged status did not establish runtime implementation.

**How to apply:** Separate current-session authorization from the future executor's deliverables. Make task acceptance describe working behavior, and inspect the actual merged changes before telling the user a feature is implemented. Documentation-only work is a separate, explicit scope.