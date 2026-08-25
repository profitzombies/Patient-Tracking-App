---
name: Web admin persona gate
description: How to visually verify THINNR operations admin pages — they sit behind the sign-in gate, so static screenshots only show the sign-in card.
---

Operations-web admin routes (`/admin/...`) render the sign-in page for anonymous visitors; the guided-demo bypass stores a persona in **sessionStorage**, which the static Screenshot tool cannot set.

**Why:** a direct screenshot of any admin deep link returns the "THINNR Operations" sign-in card, which is easy to misread as a broken page.

**How to apply:** verify admin UI through the testing subagent: expand "Exploring? Browse the guided demo without an account" on `/`, pick the HQ (or office) persona, then deep-link in the same tab session. Demo personas are read-only — write actions show a friendly nudge toast, so layout checks are safe. Real course/video ids for deep links come from Supabase REST (`training_videos.module_id` → `training_modules.course_id`; videos have no direct course column).
