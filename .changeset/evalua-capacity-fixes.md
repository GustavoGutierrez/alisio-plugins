---
"@alisio/plugin-evalua": patch
---

Fix exams that could not be created ("slot could not be filled", "the exam has 12 items").

- Factoring draws roots up to ±5..9 (from the level's coefficient range) instead of ±3, so every
  level offers 38 to 136 distinct trinomials instead of 12. Every item still verifies.
- The basic-math "Powers and roots" topic now uses the existing `powers-roots` family besides its
  bank items, so it is no longer limited to three questions.
- The app wizard and the chat interview offer only the item types the chosen topic supports
  (multiple choice with several answers is not offered for any shipped topic), and accept the same
  values.
- Before recording a plan, the app and the chat dry-run the seeded generation. A topic that cannot
  fill the request gets a plain message naming the topic, the kind of question and the maximum
  available, instead of a dead "Create the questions" after Gate A. A blocked generation shows
  the same message, with the raw finding codes as a small technical detail.
- A generator that throws on one seed is a rejected candidate, no longer a crash of the whole run.
- The first-run teacher profile form shows the logo picker; the chosen logo is previewed locally
  and uploaded right after the profile is saved.
