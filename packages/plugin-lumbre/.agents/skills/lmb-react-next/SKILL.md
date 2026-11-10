---
name: lmb-react-next
description: "Trigger: write or fix React (Vite) or Next.js code in a Lumbre project. Performance and correctness rules for small apps, plus Next.js 16 App Router file conventions."
license: MIT (see LICENSE.txt)
---

> Adapted from Vercel's react-best-practices skill (vercel-labs/agent-skills), MIT License,
> Copyright (c) Vercel, Inc. (`references/react-rules.md`; license text in LICENSE.txt).
> `references/next-file-conventions.md` is based on the Next.js documentation, MIT License,
> Copyright (c) Vercel, Inc.

# React and Next.js in Lumbre

Lumbre projects are small (Astro projects with React islands follow the React rules for their islands): a few pages or components in plain JavaScript (`.jsx`/`.js`, no
TypeScript), with only the packages of the stack's allowlist. Apply these rules while writing code,
not as a later optimization pass.

- **React (Vite) and Next.js:** follow `references/react-rules.md`. The CRITICAL and HIGH rules
  always apply; the rest when the code touches that area.
- **Next.js:** read `references/next-file-conventions.md` whenever you create, rename or move a
  route, a layout, an error or loading state, a route handler or a metadata file. The Next.js
  version is pinned by Lumbre (16.x); never use the conventions of older versions.
- **Fewer dependencies first:** prefer plain HTML/CSS, framework components and native elements (`<dialog>`, `<details>`, `popover`, form validation attributes) when they do the job. Request a package only when it clearly simplifies the work or is required, and say why in your message. Astro pages stay zero-JS unless a part truly needs interactivity.
- A rule that needs a package outside the allowlist does not apply; write the plain-React
  equivalent instead.
