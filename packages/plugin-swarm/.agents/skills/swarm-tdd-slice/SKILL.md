---
name: swarm-tdd-slice
description: "Trigger: swarm tdd, behaviour slice, red green. Implement one behaviour slice at a time: failing test first, minimum code, green, commit with the test in the diff."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for the coder while implementing an approved task.

## Hard Rules

- Pick one behaviour slice at a time.
- Write the failing unit test first and run it to see it fail.
- Write the minimum production code to pass, then run the tests again.
- Commit only when green; the test file must appear in the commit diff.
- Keep the testable core free of input and output.

## Decision Gates

| Situation | Action |
| --- | --- |
| The test passes before you wrote code | The test is wrong; fix it first |
| Tests are red after the change | Do not commit; fix or revert |
| The slice is hard to test | Extract a pure function |

## Execution Steps

1. Choose the next slice.
2. Write the failing test.
3. Make it pass.
4. Refactor lightly.
5. Commit and repeat; hand off when every slice is done.

## Output Contract

A `handoff` envelope with evidence naming the test that proves each requirement.

## References

- `../../../README.md`
