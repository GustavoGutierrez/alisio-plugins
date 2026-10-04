---
name: thesis-policy
description: "Trigger: policy pack, compliance profile, citation style, presentation standard, ICONTEC, APA, institution rules. Explain resolved rules."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when the user asks which rules apply, why a citation style or layout was chosen, or how to change it. Policy is resolved by code from packs; you explain it.

## Hard Rules

- Policy is data. Shipped packs (global, country) and workspace packs under `thesis/policy-packs/` go through the same loader and the same resolver. Never describe law from memory; read the compliance profile and cite `ruleId` and source.
- Precedence is by rule level and pack scope, never by load order: law, regulation, institution, faculty, program, rubric, institutional template, selected style, global default. Equal precedence with different values is a conflict that must be fixed.
- `citationStyle: auto` and `presentation.standard: auto` resolve from the highest-precedence rule that sets them, or fall back to `apa-7` and `generic` (or the presentation that matches the citation style) and are marked as defaults. Tell the user to confirm defaults with their program.
- Colombia never auto-enables ICONTEC. Without an institution rule the user's own answer decides.
- Rules with `basis: secondary_source` come from university guides rather than the official text. List them so the user can confirm them with the program. An institution rule overrides them.
- A workspace rule replaces a shipped rule only with `overrides: true`; otherwise `/thesis:pack check` reports PCK-002.
- You explain policy; you do not give legal advice and you never say that consent or ethics review is unnecessary.

## Decision Gates

| Situation | Action |
| --- | --- |
| User asks why a style was chosen | Run `/thesis:pack explain citationStyle` and relay the trail, highest precedence first |
| User's program requires something the packs lack | Point to `thesis-institution-norms` and `/thesis:pack new` |
| Two rules conflict | Name both sources and ask which has higher authority; fix by level, scope or `supersedes` |
| A rule looks outdated | Say when it was last verified and ask the user to confirm with their program |
| User wants to bypass a rule | Explain the consequence and the rule's source; any exception comes from the institution, as a rule file |

## Execution Steps

1. Read `compliance-profile.json` (or run `thesis_check` for G0) and note the resolved citation style, presentation standard, AI declaration requirement and applied rules.
2. For any value the user asks about, run `/thesis:pack explain <value>` and quote the trail.
3. List defaults and secondary-source rules that still need confirmation.
4. When the user decides, record it in `thesis.yaml` (citationStyle, presentation.standard) or as an institution rule; then re-run `/thesis:check`.

## Output Contract

Return the resolved value, its source (rule, brief, default, derived), the ruleId trail, which rules need confirmation and the exact next action.

## References

- `../../../README.md`
- `../thesis-institution-norms/SKILL.md`
