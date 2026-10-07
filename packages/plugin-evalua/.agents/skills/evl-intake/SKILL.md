---
name: evl-intake
description: "Trigger: interview, intake, teacher profile, workspace setup, exam rounds, headless continuation, defaults."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

# Intake and defaults

Load before running the profile or exam interview.

- Profile questions are asked once ever per workspace; if `teacher.yaml` exists, never repeat them.
- Ask only what is unknown or not derivable. Same/bank is not asked when the count is 1; the bank
  size is asked only for `bank`.
- One round never exceeds four questions. Every closed question offers 2 to 4 options with exactly
  one recommended and a free-text escape.
- In a headless session the pending round is stored in `state.json`; continue with
  `/evalua:new id=value ...` (`<id>:text=...` carries free text).
- Every answered value is echoed in the ficha técnica for Gate A; nothing is silently defaulted.
