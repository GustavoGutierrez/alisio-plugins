# React rules for Lumbre (condensed)

Adapted from Vercel's react-best-practices skill (vercel-labs/agent-skills), MIT License,
Copyright (c) Vercel, Inc.; condensed and adapted for Lumbre's small JavaScript projects. Rules that
need packages outside Lumbre's allowlist (for example SWR, lru-cache, better-all) are left out.

## CRITICAL: no waterfalls

- Start independent async work together: `const [a, b] = await Promise.all([getA(), getB()])`,
  never one `await` after another when the second does not need the first.
- Await only where the value is used: move an `await` into the branch that needs it, and check
  cheap synchronous conditions before awaiting anything.
- In route handlers, start promises early and await them late.
- In Next.js server components, fetch in parallel in the component that needs the data; wrap slow
  parts in `<Suspense fallback={…}>` so the rest of the page streams first.

## CRITICAL: small bundles

- Import from the module that defines a thing, not from a barrel file that re-exports everything
  (with `lucide-react`, import each icon by name from the package root, which is tree-shaken).
- Load heavy, rarely used components only when needed (`React.lazy` + `Suspense` in Vite;
  `next/dynamic` in Next.js).
- Keep import paths and file reads statically analyzable (no `import(variable)`, no building paths
  from user input).
- Load anything not needed for the first paint (analytics, chat widgets) after hydration, and only
  when the feature is used.

## HIGH: server and client boundaries (Next.js)

- Components are Server Components by default. Add `"use client"` only to the components that need
  state, effects, event handlers or browser APIs, as low in the tree as possible; keep pages and
  layouts on the server.
- Pass client components only the data they render: small, serializable props, not whole records.
  Do not pass the same data twice under different props.
- Never keep request data in module-level variables on the server: concurrent requests share the
  module and one visitor's data can leak into another's page. Pass it down as props.
- Treat Server Actions and route handlers like public endpoints: validate their input (with `zod`
  when it is in the allowlist) and check permissions inside them.
- Hoist static work (reading a constant file, building a static list) to module level, not per
  request.

## MEDIUM: rendering and re-renders

- Derive values during render instead of copying props into state with an effect; put interaction
  logic in event handlers, not in effects that watch state.
- Never define a component inside another component (it remounts on every render). Hoist static JSX
  out of components.
- Use functional updates (`setCount((n) => n + 1)`), lazy initial state for expensive values
  (`useState(() => compute())`) and primitive values in effect dependencies.
- Use a ternary (`cond ? <A /> : null`) instead of `cond && <A />` when `cond` can be `0` or `""`.
- For values that differ between server and browser (time, `localStorage`), render a stable
  placeholder on the server and fill it in after mounting, so hydration does not flicker or warn.
- Long lists: `content-visibility: auto` on items, and `startTransition`/`useDeferredValue` to keep
  typing responsive while a large list re-renders.
- Animate a wrapper element instead of an SVG element, and keep SVG coordinates short.

## LOWER: plain JavaScript

- Use `Map`/`Set` for repeated lookups, return early, combine `filter` + `map` passes, hoist
  regular expressions out of loops, and group DOM style changes into one class change.
