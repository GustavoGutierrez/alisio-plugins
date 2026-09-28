# Diagram types: verified minimal syntax

Every snippet below was rendered to SVG by `scripts/render-diagrams.mjs` with its pinned toolchain
(`@mermaid-js/mermaid-cli@12.0.0`, bundling `mermaid@12.0.0`) before being written down. Copy a
snippet, replace the labels, and render. Each type also lists the pitfall that breaks it most often.

## Version honesty notes

- **`usecase-beta` requires Mermaid 12.** It landed in Mermaid 12.0.0 and has no 11.x backport. On
  `@mermaid-js/mermaid-cli@11.17.0` (mermaid 11.17.2) it fails with
  `UnknownDiagramError: No diagram type detected matching given configuration for text: usecase-beta`.
  The renderer pins `@mermaid-js/mermaid-cli@12.0.0`, the lowest CLI that renders all ten types.
- **C4 is flagged experimental upstream** (`C4 Diagram 🦺⚠️` in the Mermaid docs). It renders, but its
  layout is fragile with many nodes and its syntax may change between releases.
- **No type failed on the pinned version.** All ten render on `@12.0.0`; the only failure observed was
  `usecase-beta` on the 11.x line, whose workaround is to keep the `@12.0.0` pin.
- **Mermaid 12 changed the default look.** Flowcharts and sequence diagrams render differently than
  under Mermaid 11. Add `mermaid.config.json` beside the sources with `{"look": "classic"}` to keep the
  earlier appearance; Wayfinder does exactly that.

## flowchart

```mermaid
flowchart TD
  A[Start] --> B{Decision}
  B -->|yes| C[Do it]
  B -->|no| D[Skip]
```

Pitfall: `end` is a reserved word and cannot start a node id, and unquoted labels break on `(`, `)`,
`[`, `]`, `{`, `}`, and `"`. Wrap such text in quotes.

## sequenceDiagram

```mermaid
sequenceDiagram
  actor User
  participant API
  User->>API: Request
  API-->>User: Response
```

Pitfall: every `alt`/`opt`/`loop` needs a matching `end`; a stray or missing `end` fails the whole
diagram. A colon in a message label is fine, but the label itself must stay on one line.

## classDiagram (UML)

```mermaid
classDiagram
  class Animal {
    +String name
    +makeSound() void
  }
  class Dog
  Animal <|-- Dog
```

Pitfall: the arrow direction carries the meaning. `Animal <|-- Dog` reads "Dog inherits Animal";
reversing it silently inverts the model. A class named after a keyword (`class`, `namespace`) fails.

## stateDiagram-v2

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
  Running --> Idle : stop
  Running --> [*]
```

Pitfall: use `stateDiagram-v2`, not the legacy `stateDiagram`. A transition label is everything after
the first `:` on the line, so an unescaped second `:` is taken literally rather than as a separator.

## C4 (experimental)

```mermaid
C4Context
  title System Context
  Person(user, "User", "A person")
  System(sys, "System", "The system")
  Rel(user, sys, "Uses")
```

Pitfall: the keyword is case-sensitive (`C4Context`, `C4Container`, `C4Component`, `C4Dynamic`,
`C4Deployment`). Upstream marks C4 experimental; keep diagrams small, because the layout overlaps
nodes as the graph grows.

## erDiagram

```mermaid
erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ ORDER_LINE : contains
```

Pitfall: entity names are case-sensitive and a relationship must have exactly one cardinality token
on each side of the line (`||`, `o{`, `|{`, `}o`, …). A missing or doubled symbol fails to parse.

## usecase-beta (Mermaid 12+)

```mermaid
usecase-beta
direction LR
actor Customer
systemBoundary Storefront
  Browse("Browse catalogue")
  Checkout("Checkout")
end
Customer --> Browse
Customer --> Checkout
Checkout ..> : include Browse
```

Pitfall: one statement per physical line — a second statement on the same line is a parse error.
Actors are never inferred from a relationship, so declare every actor with `actor ID`. Use
`..> : include` / `..> : extend` for UML include/extend semantics; an association label containing the
words include or extend is still a plain association.

## gantt

```mermaid
gantt
  title Release plan
  dateFormat YYYY-MM-DD
  section Build
  Design :a1, 2026-01-01, 5d
  Implement :after a1, 10d
```

Pitfall: `dateFormat` must appear before the first task. A task line missing both a date and a
duration silently drops out of the chart instead of erroring.

## mindmap

```mermaid
mindmap
  root((Plugin))
    Sources
      renderer
    Docs
      README
```

Pitfall: hierarchy comes from indentation, so mixing tabs and spaces breaks the tree. Node shapes use
exact delimiters (`((circle))`, `(rounded)`, `[square]`); a mismatched pair fails to parse.

## gitGraph

```mermaid
gitGraph
  commit id: "init"
  branch feature
  checkout feature
  commit id: "work"
  checkout main
  merge feature
```

Pitfall: order is stateful — `merge` needs the branch to exist and the current checkout to be its
target. This type illustrates a branching strategy; do not paste real repository history into it.
