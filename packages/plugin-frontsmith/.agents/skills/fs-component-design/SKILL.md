---
name: fs-component-design
description: "Trigger: designing or writing UI components and their styling: polymorphic typing, variant maps, compound slots, refs, controlled state, Tailwind rules and recipes."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this when planning or writing components. It states the component API rules and the styling rules the deterministic checks also enforce.

## Hard Rules

- Reuse a component with the same behaviour and contract before writing a variant. Avoid premature abstraction: abstract when behaviour and contract match, not when markup looks alike.
- Type every prop. No `any` props. Avoid piles of boolean props: use a variant map or a discriminated union.
- Polymorphic `as` props must be typed so the allowed props follow the element; otherwise do not offer `as`.
- Components that wrap a native element forward the ref (not needed where the framework passes refs as props, as in React 19).
- Do not define a component inside another component's body. Never use an array index as a list key when the list can change.
- Controlled or uncontrolled, not both; document which.
- A native control (`button`, `a`, `input`) before a `div` with roles; custom widgets follow the authoring pattern completely.
- No inline styles for design values; use tokens.
- Tailwind: write complete class names, never interpolate fragments such as `bg-${color}-600`; use a static variant map; the order of classes does not decide the cascade; generated CSS must be checked, not assumed.
- Do not hide overflow to fix layout; find the element that overflows.

## Decision Gates

| Question | Answer |
|---|---|
| Two components differ only by style | One component with a variant map |
| Parts must be composed freely (menu, tabs, dialog) | Compound components with slots |
| Parent decides the element | Polymorphic `as`, typed |
| Value known only at runtime | CSS variable with validation, not generated class names |
| Component depends on its container size | Container query; media query for the page |
| Style conflict between utilities | Remove one; do not rely on order |

Tailwind rules in short: map semantic tokens to utilities (`bg-action`, not a repeated HEX); theme values for repeated decisions, arbitrary values only for justified exceptions; the unprefixed utility is the base and `sm:` means from that breakpoint up; use `hover:`, `focus-visible:`, `disabled:`, `aria-` and `data-` variants for real states; define reduced motion and themes through tokens; check Preflight when integrating legacy content; keep custom CSS for complex composition and avoid mass `@apply`; follow the installed major version.

Recipes (what a recipe must define): a data table needs a caption or label, header cells with scope, sortable headers as buttons with the sort state exposed, sticky header and the scroll owner stated, truncation rules with a title or expansion, an empty and an error row, and a density choice. A form field needs a visible label, help and error text associated with the control, an invalid state that is not colour alone, and a disabled state with an explanation where needed. A dialog needs a name, focus entry, a trap, return of focus and escape handling. A button needs a visible label or an accessible name, default, hover, pressed, focus-visible, disabled and loading states as applicable, and a minimum target size.

## Execution Steps

1. Find the closest existing component and read its API and tests.
2. Decide: reuse, extend or new; write the decision down in the plan or the summary.
3. Define the props with types, defaults and which are required.
4. Use semantic HTML and the native control first.
5. Style with tokens and complete class names or CSS variables; use flow (grid, flex, gap) instead of coordinates.
6. Cover the states the contract lists, including long and empty content.
7. Check keyboard operation and focus visibility.

## Output Contract

Component files that follow these rules, or a plan entry that states the decision. Findings of the deterministic checks are the measure of compliance.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
