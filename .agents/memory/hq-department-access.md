---
name: HQ department access
description: Durable authorization rule for HQ identities, department roles, and live session classification.
---

Active HQ membership is the sole authority for HQ access and department permissions across the browser session, API guards, and database policies. The legacy profile role is only a compatibility projection and must not independently classify a person as HQ or grant full access.

**Why:** Department roles share a coarse profile role for compatibility. Reading only that profile role either blocks limited teammates as patients or accidentally grants them full Admin access, while service-role API calls can bypass otherwise-correct RLS.

**How to apply:** Resolve an active membership on every privileged request and signed-in session refresh, fail closed for invited/revoked/missing memberships, authorize explicit permissions before service-role reads, and return role-specific DTOs for field-restricted roles.