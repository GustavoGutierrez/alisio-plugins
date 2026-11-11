---
"@alisio/plugin-evalua": patch
---

"Draft with AI" in the Wording step now works for every exam. The step lists every kind of
exercise of the chosen topics, even when the plan asks for a kind of question a topic does not
offer (for example an exam drafted with an older version). Evalua reads the model's answer more
patiently (reasoning blocks, code fences, extra text, a formula written instead of `{expr}`) and
asks once more when the first answer is unusable. When drafting still fails, the message says why:
the model could not be reached, its answer could not be read, or its sentences had no place for
the formula. An exam made only of bank questions turns drafting off with a short note, since its
wording is already fixed. Saving the wording always keeps it, and says so when the questions could
not be created again.
