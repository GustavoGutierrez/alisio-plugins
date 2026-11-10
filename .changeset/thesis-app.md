---
"@alisio/plugin-thesis": minor
---

Adds **Thesis Studio** ("Estudio de tesis"), a full-page guided app for Alisio 0.11.6 or newer: a progress bar over the seven phases and one "Next step" button, the interview as a wizard, the research and chapter plans with their gates, a chapters board, the evidence library, the review findings, checks, PDF builds with an in-app preview and download, Gate C and the final document, and settings (model, rules and styles, ethics requirements, file editors, Typst setup). It follows Alisio's language (English or Spanish) and light or dark theme. Long work runs in the background with progress and Cancel.

Every command, tool, agent and the chat keep working as before; on older hosts the app is simply not registered and `/thesis:status` names the Alisio version it needs. New for the chat: only one surface changes a thesis at a time, so a state-changing command run while the app is working answers `Blocked: Thesis Studio is running ...`; and a model chosen in the app (`settings.model`) is used by every assistant, chat included, with a note when it is not available. The README's SDK range now matches the package (`>=0.9.0 <0.12.0`).
