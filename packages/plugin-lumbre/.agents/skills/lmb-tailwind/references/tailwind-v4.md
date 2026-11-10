# Tailwind CSS v4 directives for Lumbre (verified with Tailwind 4.3.3)

Adapted from wshobson/agents' tailwind-design-system (MIT, Copyright (c) 2024 Seth Hobson) and
checked against the Tailwind CSS v4 documentation (https://tailwindcss.com/docs/functions-and-directives,
https://tailwindcss.com/docs/theme, https://tailwindcss.com/docs/dark-mode) and a real 4.3.3 build.

## The CSS entry

```css
@import "tailwindcss";

@theme {
  /* From the design token plan: semantic names, hex or OKLCH. */
  --color-surface: #fbf3e6;
  --color-ink: #2a211c;
  --color-accent: oklch(52% 0.15 40);
  --color-leaf: #6b7f4a;
  --font-display: Georgia, "Times New Roman", serif;
  --font-body: ui-sans-serif, system-ui, sans-serif;

  --animate-rise: rise 0.5s ease-out both;
  @keyframes rise {
    from { opacity: 0; translate: 0 0.75rem; }
    to { opacity: 1; translate: 0 0; }
  }
}

@layer base {
  body {
    @apply bg-surface text-ink font-body antialiased;
  }
}
```

- `@theme { --color-x: … }` creates `bg-x`, `text-x`, `border-x`, `outline-x`…;
  `--font-x` creates `font-x`; `--animate-x` creates `animate-x` (keyframes inside `@theme` are
  emitted when used).
- `@theme inline { --color-x: var(--something); }` when a token points to another variable.
- `--color-*: initial;` inside `@theme` removes the default palette (only when the plan replaces it
  completely).
- Self-hosted fonts (npm stacks only, from the allowlist): import the package once (for example
  `@import "@fontsource-variable/fraunces";` in the CSS entry, or an import in the root component),
  then set `--font-display: "Fraunces Variable", serif;`. Plain HTML/CSS/JS uses system stacks.

## Other directives and variants that exist in 4.3

| Need | Write |
| --- | --- |
| Class-based dark mode | `@custom-variant dark (&:where(.dark, .dark *));` then `dark:bg-ink` |
| A custom variant | `@variant` / `@custom-variant name (selector);` |
| A reusable one-class utility | `@utility text-balance-tight { text-wrap: balance; letter-spacing: -0.02em; }` |
| Component classes (rarely) | `@layer components { .btn { @apply rounded-full px-5 py-2.5; } }` |
| Gradients | `bg-linear-to-r from-surface to-accent` (the v4 name; avoid `bg-gradient-to-*`) |
| Container queries | `@container` on the parent, `@sm:grid-cols-2` on children |
| Entry transitions | `starting:opacity-0` with `transition-discrete`, or native `@starting-style` |
| Reduced motion | `motion-safe:animate-rise motion-reduce:animate-none` |

## Dark mode

- Default: `dark:` follows `prefers-color-scheme`. Use it when the plan wants both themes without a
  switch.
- With a switch: declare the custom variant above, toggle `document.documentElement.classList`
  with a small script, remember the choice in `localStorage`, and set the class before the first
  paint (an inline script in the `<head>`) to avoid a flash. In Next.js render the toggle in a
  `"use client"` component.
- Prefer redefining tokens for dark mode over doubling every class:
  `.dark { --color-surface: #1d1714; --color-ink: #f3e9dc; }` after the `@theme` block.

## Animation

Keep to one orchestrated moment (lmb-design): define keyframes in `@theme`, apply with
`motion-safe:`, and stagger with an inline `style="animation-delay: …"` only inside that moment.
No animation library is needed; never use `tailwindcss-animate` (Tailwind v3 era).
