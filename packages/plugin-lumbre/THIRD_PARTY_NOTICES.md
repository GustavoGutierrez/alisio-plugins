# Third-party notices

## Design guidance (`.agents/skills/lmb-design/SKILL.md`)

The `lmb-design` skill is adapted and combined for Lumbre from:

- **frontend-design** by Anthropic, from https://github.com/anthropics/skills
  (`skills/frontend-design`), licensed under the Apache License 2.0.
- **frontend-design** by Vercel Labs, from https://github.com/vercel-labs/agent-eval
  (`packages/playground/.agents/skills/frontend-design`), licensed under the Apache License 2.0.

Both were modified: shortened, merged, and adapted to Lumbre's stacks, font rules, languages and
plan format. The full license text ships in `.agents/skills/lmb-design/LICENSE.txt`.

## React rules (`.agents/skills/lmb-react-next/references/react-rules.md`)

Adapted from **react-best-practices** by Vercel Engineering, from
https://github.com/vercel-labs/agent-skills (`skills/react-best-practices`), whose skill declares the
MIT License. Copyright (c) Vercel, Inc. Condensed and adapted for Lumbre (rules needing packages
outside Lumbre's allowlist removed). The MIT license text ships in
`.agents/skills/lmb-react-next/LICENSE.txt`.

## Next.js file conventions (`.agents/skills/lmb-react-next/references/next-file-conventions.md`)

Based on the Next.js documentation (https://github.com/vercel/next.js, `docs/01-app`), MIT
License, Copyright (c) Vercel, Inc.; summarized and adapted for Lumbre's JavaScript projects and
the pinned Next.js 16 release. The MIT license text ships in
`.agents/skills/lmb-react-next/LICENSE.txt`.

## Tailwind guidance (`.agents/skills/lmb-tailwind/`)

Adapted from **tailwind-design-system** in https://github.com/wshobson/agents
(`plugins/frontend-mobile-development/skills/tailwind-design-system`), MIT License, Copyright (c)
2024 Seth Hobson. Rewritten for Lumbre: Tailwind 4.3 directives verified against the Tailwind CSS
documentation and a 4.3.3 build, and the variant/UI library patterns replaced with plain Tailwind
and local helpers. The MIT license text ships in `.agents/skills/lmb-tailwind/LICENSE.txt`.
