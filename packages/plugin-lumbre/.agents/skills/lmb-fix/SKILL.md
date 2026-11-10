---
name: lmb-fix
description: "Trigger: a Lumbre project fails to build or its dev server reports errors. Rules for the automatic, bounded fix-up pass."
---

## Fix-up pass

- Read the build or dev-server log in the prompt and find the root cause: a syntax error, a wrong
  import path, a missing export, an unknown package or a framework rule.
- Make the smallest change that fixes it. Do not redesign, rename or reformat unrelated code.
- If the error needs a package, request it in `dependencies` only when it is in the allowlist;
  otherwise rewrite the code so it does not need the package.
- Never change configuration, `package.json` or lockfiles; they are managed by Lumbre.
- In `message`, explain in one or two plain sentences what was wrong and what you changed.
