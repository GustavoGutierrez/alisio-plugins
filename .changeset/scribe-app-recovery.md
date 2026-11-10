---
"@alisio/plugin-scribe": patch
---

Scribe no longer gets stuck on "Scribe is unavailable" after a single transient host error (for example when returning to Alisio): the studio re-checks before showing that screen, which now has a "Try again" button and recovers on its own when the window is shown again, restoring the open document.

Adds a Spanish README (`README.es.md`) mirroring the English one.
