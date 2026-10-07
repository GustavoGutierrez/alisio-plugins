---
name: evl-blueprint
description: "Trigger: blueprint, tabla de especificaciones, level, cognitive mix, recall apply reason, distribution, bank, stratification."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

# Blueprint

Load before building or editing the exam blueprint.

- The blueprint is a table of topic x cognitive demand x item type whose counts sum to
  `questionCount` (or the bank size). Code builds it from the level's `cognitiveMix` by largest
  remainder; the teacher may edit it at Gate A.
- Levels: básico direct and routine; intermedio 2 to 3 steps; avanzado multi-step with
  justification; genio non-routine and reasoning-heavy.
- For `bank`, the blueprint is built for the bank size and every variant draws proportionally from
  every cell (stratified), so all variants keep the same shape.
- `EVL-EXM-001` when the type counts or the blueprint do not sum to the total; `EVL-EXM-004` when the
  cognitive mix drifts by more than one item per cell.
