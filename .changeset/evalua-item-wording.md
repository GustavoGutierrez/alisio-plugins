---
"@alisio/plugin-evalua": minor
---

Every item now carries a real, concise Spanish instruction instead of a bare expression (for example
"Simplifica la fracción {expr} hasta su forma irreducible." or "Resuelve la ecuación: {expr}"), for
all families, so any exam topic reads as a question rather than just a number and an operation. A
topic source can override the instruction with agent-authored templates through `params.prompts`,
where `{expr}` is replaced by the item's math, so the coordinator can phrase the questions for the
questionnaire it determined.
