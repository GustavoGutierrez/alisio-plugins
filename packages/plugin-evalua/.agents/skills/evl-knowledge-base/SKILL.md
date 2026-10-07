---
name: evl-knowledge-base
description: "Trigger: pack, topic, knowledge base, pack.yaml, topic yaml, family, requires, extends, overrides, EVL-KB."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

# Knowledge base

Load before reading or authoring a pack.

- One central structure answers "what the plugin knows": packs of topics with objectives, level
  calibration and sources (`family` or `bank`).
- Layers: workspace (`<root>/knowledge-packs/`) wins over shipped (`knowledge/packs/`). An id or
  code collision without `overrides: true` is `EVL-KB-002`.
- `requires` and `extends` must resolve without cycles (`EVL-KB-003`); a topic referencing an unknown
  family or a missing bank file is `EVL-KB-004`; a bad calibration is `EVL-KB-005`; a missing
  objective for a declared level is the warning `EVL-KB-006`; a static item whose own `check` fails is
  `EVL-KB-007`.
- YAML is core schema with no aliases; file sizes and counts are capped. Adding a pack or a topic is
  data, never code.
