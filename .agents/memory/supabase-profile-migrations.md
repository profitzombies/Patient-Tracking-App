---
name: Supabase profile migrations
description: Durable constraints for evolving THINNR's Supabase profile/RLS schema.
---

Profile RLS must never query `public.profiles` directly from within a
`public.profiles` policy. Use a fixed-search-path, `SECURITY DEFINER` helper
in a non-exposed schema for the narrow admin-role check, and create that helper
inside the same migration that references it.

**Why:** A legacy environment can already have the helper while a clean project
does not; assuming it exists makes the checked-in migration unreplayable.
Direct self-queries in an RLS policy recurse and can prevent all role lookups.

**How to apply:** Keep profile migrations idempotent and run an actual Supabase
Security Advisor check after apply. Any database-only staff allowlist must
support revocation: every related identity or assignment change computes the
complete desired role, including demotion on removal.