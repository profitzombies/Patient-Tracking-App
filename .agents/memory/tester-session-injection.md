---
name: Signing the testing subagent in as real staff
description: Principle for getting the browser tester past code-login screens without pasting credentials through chat.
---

**Rule:** never hand the tester a long-lived token or JWT through chat text; never leave any sign-in helper in the served app tree.

**Why:** a pasted JWT arrived with one mangled character and every API call 401'd — indistinguishable from an app bug until the token was diffed. Email code login also needs an env-override restart and burns the small per-hour send cap.

**How to apply:** mint sessions for THROWAWAY identities server-side, deliver them through a temporary, gitignored/deleted-after helper that seeds the app's own storage keys (the app requires both the auth-library session AND its device-memory login stamp; a session without the stamp is signed out on load), and tear down the helper plus the identities before completing. Real user accounts are never used for tester sessions.
