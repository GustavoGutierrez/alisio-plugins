---
name: evl-closing-text
description: "Trigger: closing, quote, bible, verse, citation, source, catalogue, teacher text, EVL-DOC-003."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

# Closing text

Load before choosing or reviewing a closing text.

- A closing text comes only from a sourced catalogue or from the teacher. Never write a quote or a
  verse from memory and never invent a source.
- Entries carry `text`, a `source` and tags; selection filters by kind and language, scores by tag
  overlap with the exam's keywords and breaks ties by `sha256(examId + id)`.
- The teacher may pin an entry id or supply their own text, stored verbatim and marked
  `teacher-provided`.
- A copyrighted translation is not shipped in the package; a teacher who wants one adds it to the
  workspace quotes layer (`<root>/quotes/*.yaml`). `EVL-DOC-003` fires when a closing text has no
  catalogue or teacher source.
