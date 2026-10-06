---
name: fs-architecture
description: "Trigger: planning the technical solution: minimal architecture, layer boundaries, dependency direction, container and presentational split, atomic levels and decision records."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this in the plan phase and when the architecture configuration is proposed or reviewed. Input: spec, UI contract, repository context, the architecture configuration (or none) and the pattern catalog.

## Hard Rules

- Solve the feature with the least complexity compatible with the existing code, the present requirements and the patterns already adopted. No layers, abstractions or dependencies "just in case".
- Follow the repository's own organisation. Change it only with a recorded decision.
- Use patterns only from the catalog, by id. A pattern outside the catalog needs a decision record.
- Dependencies point in the allowed direction. Planned imports that cross a forbidden boundary are plan defects, not implementation details.
- Every new dependency is listed with its reason and needs human approval.
- Never widen the scope of the spec.
- L3 plans contain at least one decision record and at least one risk of category security or privacy.

## Decision Gates

| Question | Answer |
|---|---|
| Does a component exist that fits? | Reuse it; extend only if the contract allows |
| Local or shared state? | Local unless two unrelated parts need it |
| Server data? | A server cache with explicit invalidation; not a global store |
| Needs a decision record? | New pattern, new dependency, contract change, irreversible or costly-to-reverse choice |
| No architecture configuration exists at L2 or higher | Propose one in the plan; it becomes active when the plan is approved |

Layer presets: feature-sliced design (app, pages, widgets, features, entities, shared; imports go down, slices do not import each other, each slice exposes a public API); hexagonal (domain, application, infrastructure, interface; the domain imports nothing outside itself); layered (each layer imports lower ones). Atomic levels (atom, molecule, organism, template, page) only order composition.

Container and presentational: presentational components receive data and callbacks and hold no fetching; containers connect state and data. Keep the split where it already exists.

## Execution Steps

1. Read the spec, the UI contract and the nearest existing implementation.
2. List components: new, modified or reused, each with path, responsibility, atomic level, role, patterns and props.
3. Decide who owns each piece of state: local, shared, server cache, url or form, with the tool and location.
4. Describe the data flow and, per operation, the error cases and the states they map to.
5. Check each planned file against the layers and each planned import against the allowed directions.
6. List new dependencies with reasons; list risks by category; write decision records for the choices that qualify.
7. Break the work into tasks following the task contract skill and order them by dependency.
8. Include an architecture configuration only if none exists and the project needs one.

## Output Contract

One plan envelope: summary, components, state, dataFlow, contracts, errors, dependencies, adrs, risks, architectureConfig and tasks.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
