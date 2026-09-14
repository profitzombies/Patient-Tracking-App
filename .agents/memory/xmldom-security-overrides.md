---
name: xmldom security overrides
description: Why xmldom security floors must preserve each parent dependency's expected parser contract.
---

Pin patched `@xmldom/xmldom` releases by parent dependency rather than forcing every consumer onto the newest major line.

**Why:** The 0.9 parser validates `DOMParser.parseFromString` arguments more strictly than 0.8. A global 0.9 override can pass audits while breaking DOCX extraction in consumers built against the 0.8 behavior.

**How to apply:** When remediating xmldom advisories, keep 0.8-range parents on the latest patched 0.8 release and only move 0.9-range parents to the patched 0.9 release. Run a real document extraction test, not only an install or audit.