---
name: Stripe webhook endpoints from throwaway workspaces
description: Why Stripe emails about failing test webhooks, and the pruning rules that keep the shared sandbox account clean without two workspaces deleting each other.
---

Every workspace that boots the API server against the shared Stripe sandbox registers its own webhook endpoints on its own `.replit.dev` domain (task agents run in throwaway workspaces with a suffixed domain). When the workspace dies, the endpoints stay in Stripe, 404 forever, and Stripe emails the owner after ~2 days.

**Rule:** a running sandbox workspace prunes sibling endpoints (same route path, `.replit.dev` host, not its own host) only when the sibling's `/api/healthz` no longer answers and the endpoint is over an hour old. Never gate on age alone.

**Why:** age-only pruning made two long-lived workspaces delete each other in a 30-minute ping-pong (review finding). Production origins are `.replit.app`/custom and are never touched; the prune also refuses to run with live keys.

**How to apply:** the reconcile job re-runs endpoint registration every 30 minutes, so a workspace whose endpoint was pruned by a sibling self-heals without a restart. Registration is single-flight per process; do not add another caller that bypasses it (two concurrent registrations mint two secrets and one endpoint fails signature checks forever). A one-off cleanup can call the prune function from a tsx script; do not delete endpoints by hand in the dashboard while the workspace is running.
