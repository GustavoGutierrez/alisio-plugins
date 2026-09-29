---
name: telemetry
description: "Trigger: latency, token cost, tool failures, regressions, usage questions. Read bounded telemetry summaries from the local store before guessing."
license: Apache-2.0
metadata:
  author: "alisio-contributors"
  version: "1.0"
---

## Activation Contract

Load this skill when a question is about how the agent has been performing, costing, or failing:
slow turns, token usage, model mix, tool error rate, recent sessions, or a suspected regression.
Telemetry is local-first and privacy-preserving; consult the local store through the read-only
`telemetry_*` tools instead of guessing.

## Hard Rules

- Telemetry is evidence about past runs, not a substitute for reading the current code. Verify a
  regression against the actual change before blaming it.
- Every tool returns a bounds envelope (`returned`, `total`, `truncated`, `hint`). When `truncated`
  is true, narrow the time window or raise `limit`; never assume the visible slice is the whole story.
- Content search only returns text when content capture is explicitly enabled. When capture is off,
  answer from metadata (counts, tokens, latency) and say that content is not recorded.
- Telemetry can reveal how someone works, which repositories they use, and what they type. Treat any
  captured content as sensitive: do not paste it elsewhere, and never enable capture without the
  operator's explicit decision.
- Remote export is opt-in. Local-only is the default; do not claim data left the machine unless
  remote export is configured and a flush succeeded.
- Never ask for or handle the OTLP credential. It exists only as an environment variable read at
  export time.

## Decision Gates

| Question | Tool | Notes |
| --- | --- | --- |
| Overall volume, errors, latency | `telemetry_summary` | Start here; default window is one day |
| Which models, and their token cost | `telemetry_models` | Compare input/output and cached input |
| Which tools fail or get slow | `telemetry_tools` | Look at error rate and effects |
| What happened recently | `telemetry_sessions` | Bounded session/run metadata |
| Find a specific captured text | `telemetry_search` | Requires content capture |

## Execution Steps

1. Pick a bounded window (`windowMinutes`) and a small `limit`; start with `telemetry_summary`.
2. Drill into `telemetry_models` and `telemetry_tools` to locate the regression.
3. Correlate timing with a code change, then confirm by reading the code.
4. If a store is empty or unavailable, say so plainly and continue without telemetry.

## References

- `README.md` in this package documents configuration, privacy defaults, and deletion.
