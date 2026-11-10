---
"@alisio/plugin-semantic": patch
---

Notebook fixes and improvements: answers render Markdown safely with clickable citation chips everywhere (and the model is told to cite as [n]); a per-notebook model selector with a visible fallback when the chosen model disappears; a clear "connect a model" state instead of failing questions; copy buttons (text or formatted) for answers, the guide and summaries; the guide, source summaries and ticked sources now persist; the "New notebook" card is centered. Fixes the Notebook disappearing from the Apps menu after a while ("This app is no longer available"): one workspace closing no longer unregisters the app of another, and the frame recovers from a transient host error instead of locking.
