---
"@alisio/plugin-lumbre": patch
---

Fix "the model's answer was incomplete or malformed" on real models. The builder now answers in delimited file blocks that need no escaping (the old single-JSON answer is still accepted), new projects are planned first and written in batches sized to the output budget, and an answer cut by the output limit is continued automatically (up to three times) while every complete file is kept. When the provider reports no limits, Lumbre assumes a 128,000-token context and a 32,768-token output instead of 32,000/16,000, uses reported limits as they are, and retries once with Alisio's own limit if the provider rejects the estimate. Errors now tell a cut answer (`output_truncated`, keeping the files that arrived as a reviewable partial proposal) from a malformed one and name the provider failure category, and every job shows its model, limits (reported or estimated), token usage and continuations under Details.
