---
name: lmb-design
description: "Trigger: plan or build the look of a Lumbre page. Distinctive, subject-grounded visual design: token plan, typography, layout, restrained motion and plain copy."
license: Apache-2.0 (see LICENSE.txt)
---

> Adapted from Anthropic's frontend-design skill (https://github.com/anthropics/skills, Apache
> License 2.0) and Vercel Labs' agent-eval frontend-design skill
> (https://github.com/vercel-labs/agent-eval, Apache License 2.0); adapted and combined for Lumbre.
> Full license text: LICENSE.txt in this folder.

# Lumbre design

Work like the design lead of a studio known for giving every client a distinct identity. The client
has rejected templated proposals before: make deliberate, specific choices about palette,
typography and layout for THIS brief. **The person's own brief always wins**: when they name a
style, colors, fonts or a look (even one listed below as a default), follow it exactly.

## Ground the design in the subject

Name the subject, the audience and the page's primary job before designing. The subject's world
(its industry, materials, vernacular) is where distinctive choices come from: a bakery in Bogotá
and an analytics dashboard must not look alike. Write real content for that subject, in the
person's language (the language of their request), and never invent facts presented as real
(prices, reviews, numbers); mark placeholders plainly.

Choose ONE clear aesthetic direction from a wide range, picked from the subject and never by habit:
minimal, editorial, organic, retro-futuristic, playful, luxury/refined, brutalist, art deco,
soft/pastel, industrial, and so on. Vary across projects, including light and dark themes. Match
the implementation's complexity to the direction: refined designs need precision and restraint, not
more effects.

## Principles

- **Hero:** open with the most characteristic thing of the subject's world (a headline, an image,
  an interactive moment). "Big number + small label + gradient accent" is the default treatment;
  use it only if it is truly the best option.
- **Typography carries the personality.** One family or two clearly distinct ones, a clear type
  scale with intentional weights and spacing, lines under about 80 characters (serif body text gets
  a little more line height). Avoid overused faces (Inter, Roboto, Arial, Space Grotesk) unless the
  brief asks for them.
- **Fonts in Lumbre:** never load fonts from a CDN or a remote URL. On Vite, React, Astro and
  Next.js use an allowlisted `@fontsource` package (request it as an extra package, then import it);
  on plain HTML/CSS/JavaScript (with or without Tailwind) use a system font stack chosen for the
  direction (for example `ui-serif, Georgia, serif` or `ui-rounded, "SF Pro Rounded", system-ui`).
- **Avoid these tells of a generated page:** one accented word in a headline; ALL-CAPS labels;
  unnecessary labels above content; numbered markers (01 / 02 / 03) on content that is not a
  sequence; meta strings joined with middle dots; "→" appended to every link.
- **Structure is information:** borders, dividers, numbering and labels must say something about
  the content, not decorate it.
- **Atmosphere** (a subject-appropriate background, texture or pattern) only when it serves the
  brief.
- **Motion:** one orchestrated moment at most (one page-load sequence or one reveal); motion that
  answers the person's actions is welcome; no fade-and-slide on every section, no hover effect on
  every card, no custom cursors; always respect `prefers-reduced-motion`.

Recent generated design clusters around a few defaults: a warm cream background with a serif
display and a terracotta accent; near-black with one acid-green or vermilion accent; broadsheet
layouts with hairline rules and zero radius; the SaaS card kit (identical rounded cards, one radius
everywhere, the same soft grey shadow, gradient washes); template chrome (tracked-out eyebrows,
monospace data labels). They are legitimate for some briefs, but where the brief leaves an axis
free, do not spend that freedom on one of them.

## Process: plan, review against the brief, build

1. **Token plan** (in Plan mode this is the DESIGN block shown to the person):
   - Color: the base palette as 4–6 named hex values.
   - Type: the typefaces and their roles (display, body, accent).
   - Layout: a one-sentence concept plus a small ASCII wireframe, with alignment guidance.
   - Principles: what makes this page unique.
2. **Review the plan against the brief:** if a part reads like the default you would produce for
   any similar page, revise it and say what changed.
3. **Build from the plan:** on Tailwind stacks put the palette and type roles in the theme
   (`@theme { --color-…; --font-… }` in the CSS entry) and use those names, not ad-hoc utility soup
   or one-off hex values; on plain CSS use custom properties on `:root`. Keep selector specificity
   flat so section and component rules do not cancel each other.

## Fewer dependencies

**Fewer dependencies first:** prefer plain HTML/CSS, framework components and native elements (`<dialog>`, `<details>`, `popover`, form validation attributes) when they do the job. Request a package only when it clearly simplifies the work or is required, and say why in your message. Astro pages stay zero-JS unless a part truly needs interactivity.

## Restraint and quality floor

Spend boldness in one place and keep everything around it quiet; before finishing, remove one
accessory. Always: responsive down to 360 px wide, visible keyboard focus, `prefers-reduced-motion`
respected, text contrast of at least 4.5:1, harmonious palette. Review your own files before calling
the work done: read them back and check the plan, the quality floor and the brief.

## Writing in the design

Words exist to make the page easier to understand and use. Write from the visitor's side, in plain
active language: a button says exactly what happens ("Reservar mesa", "Book a table"), and the same
action keeps the same name throughout. Errors explain what went wrong and how to fix it; empty
states invite an action. Sentence case, no filler, tone matched to the brand and audience.
