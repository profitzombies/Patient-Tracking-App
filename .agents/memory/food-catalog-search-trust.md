---
name: Food catalog search trust
description: Rules for turning external and curated search matches into safe, patient-visible foods
---

- **A text match is not yet a loggable food.** **Why:** Open Food Facts can match the right words while omitting serving size or one of the four required macros; weakening validation would let incomplete or nonsensical nutrition into the diary. **How to apply:** keep the all-fields parser gate; when an important generic or restaurant item is missing, add a reviewed catalog row with cited nutrition instead of accepting partial upstream data.
- **Search failures use patient-safe copy, never transport details.** **Why:** generated client errors can contain an entire HTML 404 page such as `Cannot GET`, which is confusing and exposes internal routing. **How to apply:** sanitize catalog exceptions at the catalog client seam; HTTP prefixes, route diagnostics, and markup collapse to one short retry message while local saved-food results remain usable.
- **Reviewed aliases must win before the database applies its result limit.** **Why:** client/server presentation sorting cannot restore a friendly identity that the search RPC already omitted. **How to apply:** add exact aliases and their rank to the SQL search seam, then prove the intended source with an exact-query `limit=1` check; use presentation mapping only for labels and final tie-breaking.