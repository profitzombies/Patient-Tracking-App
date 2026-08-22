---
name: Image job handles expire — check disk first
description: How to verify generated media after long sessions instead of regenerating
---

Generated-media jobs (images etc.) can finish successfully while their job handles expire — a later `waitForJob` then rejects even though every output file landed on disk.

**Why:** In a long session, awaiting old media jobs after compaction produced rejections that looked like failures; the files were already present with real sizes. Regenerating would have wasted time and money.

**How to apply:** When a media job await fails or a session resumes, `ls -la` the target asset directories and trust nonzero file sizes over the job status. Only regenerate what is actually missing.
