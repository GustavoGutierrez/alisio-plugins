---
"@alisio/plugin-evalua": patch
---

Resolve a free-text topic to a knowledge-base topic. The interview now offers three topic
suggestions instead of two, and a description the teacher types in their own words is matched to a
known `<pack>/<topic>` (by name and keywords) so the exam is generated instead of silently coming out
empty. An unmatched description is still kept as free text but produces no items, so the coordinator
is instructed to resolve the topic with `evalua_kb` and answer with the exact topic id.
