---
"@alisio/plugin-evalua": minor
---

Wire agent-authored item instructions end to end. The exam spec stores `itemPrompts` (per item
family, with `{expr}` for the item's math); `evalua_exam` gains `action: "set-prompts"` to save them
into `exam.yaml`; and `generateExam` applies them to any family while the answer and the distractors
stay computed by code. The `evl-coordinator` and `evl-item-author` agents now propose the wording for
the questionnaire they determined, so any exam topic can read as the questions the teacher wants.
