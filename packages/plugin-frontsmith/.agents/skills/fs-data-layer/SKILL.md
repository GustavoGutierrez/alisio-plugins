---
name: fs-data-layer
description: "Trigger: implementing the data layer of a frontend task: contract-first clients and types, error mapping, schema-valid mocks and state ownership; never invented endpoints."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this for a task of the data layer. The contract files named in the plan are the only source of operations, fields and errors.

## Hard Rules

- The frontend never invents endpoints, field names, nullability, pagination or error semantics. If the contract does not say it, ask.
- Generate types from the contract when that is reasonable; otherwise hand-write them from it and cite the operation id.
- Validate mocks against the contract schema. A mock that the contract would reject is a defect.
- An incompatible contract change is a separate decision: return status `blocked` with the question.
- Do not patch a backend inconsistency locally without recording it as a deviation.
- Record optional fields, `null`, errors and pagination explicitly.
- Respect the state owner of the plan: local, shared, server cache, url or form. Do not move state between owners on your own.

## Decision Gates

For each operation you must know: what success is, which business errors can occur, which technical errors can occur, which messages may be shown, which codes are recoverable, when to retry and what happens on timeout or loss of connectivity.

| Contract kind | Source |
|---|---|
| REST | OpenAPI file |
| GraphQL | schema file |
| Events | AsyncAPI or the agreed schema |
| Third-party SDK | the pinned version and its documentation |

| State owner | Typical home |
|---|---|
| local | the component |
| shared | a store with a narrow interface |
| server cache | a query cache with keys and invalidation |
| url | route and search parameters |
| form | the form library or controlled state |

## Execution Steps

1. Read the task, the plan entry, the named contract files and the operation ids.
2. Write or generate the types from the contract.
3. Implement the client call with the error mapping defined in the plan.
4. Implement the state holder in the owner the plan chose.
5. Write mocks that validate against the schema and tests that cover success, each mapped error, empty data and timeout.
6. Run the validation commands; note anything the contract left open as a question.

## Output Contract

One task-result envelope. Questions carry any contract gap; a blocked status names the missing operation or the incompatible change.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
