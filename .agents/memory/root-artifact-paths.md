---
name: Root artifact URL paths
description: The operations web app is the root artifact — dev/test URLs are root-relative, and SPA fallback masks wrong-prefix probes.
---

The operations web app is the ROOT artifact: it serves at `/` on the dev domain (BASE_PATH=/), so its pages live at root-relative paths like `/menu`, `/patients` — NOT `/thinnr-operations/menu`.

**Why:** a tester run failed with the app's own in-app 404 because the test plan prefixed paths with the artifact dir name. Vite's SPA fallback returns index.html (HTTP 200) for ANY unknown path, so a wrong-prefix URL still boots the app (then 404s in the router), and `curl`-probing a module under a wrong prefix returns index.html — a false "stale bundle" signal.

**How to apply:** when writing tester plans or curl probes for this app, use root paths. To check served freshness, request the module at the ROOT path (e.g. `/src/OfficeApp.tsx`) and grep for a new-code marker; confirm the running process env with `/proc/<pid>/environ` (PORT, BASE_PATH) when in doubt. Other artifacts (expo, api-server, mockup-sandbox) keep their own prefixes/domains.
