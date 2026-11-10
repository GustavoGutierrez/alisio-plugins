# Component patterns with Tailwind (Lumbre)

Adapted from wshobson/agents' tailwind-design-system (MIT, Copyright (c) 2024 Seth Hobson). Every
library below is used ONLY when it is in the current stack's allowlist (the prompt lists it): ask
for it as an extra package first, with the exact version. Without it, use the plain fallback.

| Library | React + Vite, Next.js | Vite, Astro | HTML/CSS/JS + Tailwind |
| --- | --- | --- | --- |
| `clsx`, `tailwind-merge`, `class-variance-authority`, `zod` | yes | yes | no (no bundler) |
| `lucide-react`, `react-hook-form`, `@hookform/resolvers`, `@radix-ui/react-*` | yes | no | no |

## `cn()`: joining and merging classes

With `clsx` and `tailwind-merge` allowed (`src/lib/utils.js`, or `app/_lib/utils.js` in Next.js):

```js
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
```

Plain fallback (no packages; later conflicting classes are NOT removed, so avoid conflicts):

```js
export const cn = (...parts) => parts.flat().filter(Boolean).join(" ");
```

## Variants with `class-variance-authority`

```jsx
import { cva } from "class-variance-authority";
import { cn } from "../lib/utils.js";

const button = cva(
  "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: { primary: "bg-accent text-surface hover:bg-ink", quiet: "text-ink hover:bg-ink/5" },
      size: { md: "px-5 py-2.5 text-base", lg: "px-6 py-3 text-lg" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({ variant, size, className, ...props }) {
  return <button className={cn(button({ variant, size }), className)} {...props} />;
}
```

Plain fallback: an object of class lists per variant (`const variants = { primary: "…" }`) joined
with `cn()`. In Astro, pass `variant` as a component prop; in plain HTML write the class lists.

## `asChild` with Radix `Slot` (React stacks)

```jsx
import { Slot } from "@radix-ui/react-slot";

export function Button({ asChild = false, className, variant, size, ...props }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(button({ variant, size }), className)} {...props} />;
}
// <Button asChild><a href="/reservar">Reservar mesa</a></Button>
```

## Dialogs, menus, tabs (React stacks)

- With `@radix-ui/react-dialog` (and `react-dropdown-menu`, `react-tabs`, `react-accordion`,
  `react-popover`, `react-tooltip`, `react-label`): they handle focus, Escape and ARIA; style their
  parts with tokens and animate with `data-[state=open]:` variants under `motion-safe:`.
- Without them (and in Vite, Astro or plain HTML): the native `<dialog>` element (`showModal()`) or
  the `popover` attribute, animated with `starting:` / `@starting-style` and `transition-discrete`.
  Keep focus inside an open dialog and return it to the trigger on close.
- In Next.js, components using Radix or state are Client Components (`"use client"`).

## Forms with `react-hook-form` and `zod` (React stacks)

```jsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

const schema = z.object({ name: z.string().min(2), email: z.email() });

export function ContactForm({ onSubmit }) {
  const { register, handleSubmit, formState: { errors } } = useForm({ resolver: zodResolver(schema) });
  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" aria-invalid={!!errors.email} aria-describedby="email-error" {...register("email")} />
      {errors.email && <p id="email-error" role="alert" className="text-sm text-accent">{errors.email.message}</p>}
    </form>
  );
}
```

- Always a visible `<label>`, `aria-describedby` for help and errors, errors announced with
  `role="alert"`.
- Validate on the server too (Next.js route handlers or server actions, with the same `zod` schema).
- Without these packages: native validation attributes (`required`, `type="email"`, `minlength`)
  and a small `submit` handler.

## Cards, grids, icons

- One radius and one shadow scale from the tokens; vary them with hierarchy. Cards only for repeated
  items, never every section (lmb-design).
- Grids: `grid gap-6 sm:grid-cols-2 lg:grid-cols-3`; components that reflow by their own width:
  `@container` with `@md:` variants.
- Icons: `lucide-react` on React stacks (import each icon by name, `aria-hidden="true"` next to
  visible text); elsewhere inline SVG.
