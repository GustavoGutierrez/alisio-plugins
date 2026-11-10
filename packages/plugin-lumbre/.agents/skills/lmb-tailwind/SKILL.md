---
name: lmb-tailwind
description: "Trigger: style a Lumbre project that uses Tailwind CSS v4. Turn the design token plan into @theme tokens and write clean, accessible, mobile-first utility markup."
license: MIT (see LICENSE.txt)
---

> Adapted from the tailwind-design-system skill of wshobson/agents
> (https://github.com/wshobson/agents), MIT License, Copyright (c) 2024 Seth Hobson; adapted for
> Lumbre's Tailwind 4.3 presets and package allowlists (LICENSE.txt in this folder).

# Tailwind CSS v4 in Lumbre

Lumbre's Tailwind stacks pin Tailwind CSS 4.3. There is no `tailwind.config.js` (it is managed and
not used): all configuration lives in the project's CSS entry, after `@import "tailwindcss";`.

| Stack | CSS entry |
| --- | --- |
| HTML/CSS/JS + Tailwind | `styles/input.css` (compiled to `styles/tailwind.css`, never edit that) |
| Vite + Tailwind | `src/style.css` |
| React + Vite + Tailwind | `src/index.css` |
| Astro + Tailwind | `src/styles/global.css` |
| Next.js | `app/globals.css` |

## Rules

0. **Fewer dependencies first:** prefer plain HTML/CSS, framework components and native elements (`<dialog>`, `<details>`, `popover`, form validation attributes) when they do the job. Request a package only when it clearly simplifies the work or is required, and say why in your message. Astro pages stay zero-JS unless a part truly needs interactivity.
1. **Tokens first.** Turn the design token plan (lmb-design) into `@theme` tokens with semantic
   names: `--color-surface`, `--color-ink`, `--color-accent`, `--font-display`, `--font-body`,
   radii and shadows only if the plan needs them. Then use `bg-surface`, `text-ink`,
   `font-display`. Hex or OKLCH values are both fine.
2. **No ad-hoc values when a token exists:** never `bg-[#9a3b1e]` for a palette color, and no
   arbitrary values for spacing or sizes the default scale already covers.
3. **Mobile first:** unprefixed classes are for small screens; add `sm:`, `md:`, `lg:` for larger
   ones. Check that nothing overflows at 360 px.
4. **Accessible states:** every interactive element gets a visible `focus-visible:` style (for
   example `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`),
   real `disabled:` styles, and text contrast of at least 4.5:1 with its background token.
5. **Motion:** animations live as keyframes inside `@theme` with an `--animate-*` token and are used
   with `motion-safe:`; add `motion-reduce:` overrides where motion carries meaning.
6. **Dark mode** only when the plan calls for it: `dark:` follows the system setting by default;
   for a toggle, declare `@custom-variant dark (&:where(.dark, .dark *));` and switch a class.
7. **Reuse through components, not CSS:** repeat utility lists inside one framework component
   (React, Astro) or one HTML partial pattern. Use `@utility` for a genuinely reusable one-word
   utility and `@layer components` rarely.
8. **Packages:** only the stack's allowlist (see the table in `references/components.md`): on React
   stacks the standard `cn()` (`clsx` + `tailwind-merge`), `cva` variants, Radix primitives with
   `asChild`, `lucide-react` icons and `react-hook-form` + `zod`; elsewhere the plain fallbacks.
   Never use `tailwindcss-animate` (Tailwind v3 era).

Read `references/tailwind-v4.md` for the exact v4 directives and dark-mode/animation recipes, and
`references/components.md` before writing buttons, cards, forms, dialogs or grids.
