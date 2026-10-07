---
"@alisio/plugin-evalua": patch
---

Add the in-page layout audit (spec 11.4). When a browser prints each density preset it also runs a
deterministic in-page script that reports horizontal overflow, overlapping item boxes, text below
the legibility floor, display formulas wider than their column and answer space below the floor.
The chosen preset's report becomes `EVL-LAY-002` (error) for a real problem and `EVL-LAY-004`
(warning) for a scaled formula. Also correct the README install command to `alisio install
npm:@alisio/plugin-evalua` and document `alisio install --update` and the local `alisio --plugin`
form.
