---
"@alisio/plugin-evalua": patch
---

Two interview fixes. A slash-command answer whose ids do not belong to the pending round no longer
resets the interview: it now reports which ids were sent, which round is pending and that nothing was
reset. And the coordinator instructions now state that a round is answered only with what the teacher
actually said, and that an option marked `(text)` must always carry its `id:text=` value.
