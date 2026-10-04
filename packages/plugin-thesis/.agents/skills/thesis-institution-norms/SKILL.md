---
name: thesis-institution-norms
description: "Trigger: institution norms, university regulation, faculty guide, rubric, writing guide, workspace policy pack, presentation profile, overrides."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when turning an institutional regulation, faculty guide, rubric or house writing guide into policy rules or a presentation profile.

## Hard Rules

- Write rules in the pack format: `ruleId`, `level`, `status`, `appliesWhen`, `requirement.kind` and `values`, `source` with a quoted location and `verification` with `lastChecked` and `basis`. Put them in a workspace pack under `thesis/policy-packs/` with a `manifest.yaml` (`packId`, `scope`, `version`, `appliesWhen`, optional `extends`).
- Scopes: international, country, region, institution, faculty, program and writing. Faculty and program rules live in `faculties/<slug>/` and `programs/<slug>/` inside the institution pack; the loader activates them only for the matching faculty and program.
- `requirement.kind` comes from the closed vocabulary (paper, page_margins, font, line_spacing, text_alignment, pagination, front_matter_order, required_section, heading_format, caption_position, citation_style, reference_format, length_limit, ethics_trigger, risk_classification, consent_requirement, data_protection, quotation_rule, attribution_rule, integrity_rule, ai_declaration, source_quality, evidence_minimum, reporting_guideline, objective_verbs, official_domain_allowlist). Your own kinds must be named `x-<name>`; no deterministic check consumes them.
- Classify each requirement by level: LAW, REGULATION, INSTITUTIONAL_RULE, PROGRAM_RULE, TECHNICAL_STANDARD, STYLE_GUIDE, METHODOLOGY_GUIDELINE or RECOMMENDATION. Precedence follows level and pack scope, never load order.
- To change a shipped rule, reuse its `ruleId` and set `overrides: true`; otherwise `/thesis:pack check` reports PCK-002. Two rules of equal precedence with different values are PCK-003.
- Quote the source location for every rule. Mark rules inferred from examples or from secondary documents as `basis: secondary_source`; use `official_text` only when you read the official text.
- When the guide prescribes layout, also produce a declarative presentation profile (paper, margins, fonts, spacing, headings, captions, page numbers, cover, front matter order). Never raw markup; unknown keys fail validation.
- Never invent a rule. Ambiguities become questions for the user. The user approves the extracted rules before anything is written.

## Decision Gates

| Situation | Action |
| --- | --- |
| The guide is a scanned PDF | Ask for text or extract carefully; mark uncertain readings as questions |
| A requirement is a recommendation | Use RECOMMENDATION level so it does not block |
| The rule overlaps a shipped one | Override with `overrides: true` and quote why |
| The rule only applies to one faculty or program | Place it under that faculty or program folder |
| The rule is a house writing convention | Use the writing scope and STYLE_GUIDE level |

## Execution Steps

1. Read the guide and list every requirement with its location and strength (must, should, may).
2. Classify level, scope and kind; pick `appliesWhen` from the allowed keys: country, language, workType, approach, studyDesign, domain, presentationStandard, citationStyle, ethicsTrigger, aiUse.
3. Draft the rule files and, when needed, the profile; show a summary to the user for approval.
4. After approval the coordinator writes them and runs `/thesis:pack check`; fix any PCK finding and re-run.

## Output Contract

Return strict JSON for `NormsDraft`: `pack` (`scope` institution, faculty, program, writing or international; `id` for writing and international packs; `description`; `appliesWhen`), `rules` (a flat list of rule mappings in the section 11.2 format, each with `ruleId`, `level`, `appliesWhen`, `requirement` (`kind` from the closed vocabulary or `x-<name>`, `values`), `source` and `verification` with `basis`), optional `profile` (YAML), `questions` and `sourceTrace` (rule, guide quote and location, effect). Field names are English; quoted source text keeps the guide's language. Code validates every rule with the pack loader (PCK-001, PCK-002, unknown kinds and `appliesWhen` keys) and writes only after the user approves.

## References

- `../../../README.md`
- `../thesis-policy/SKILL.md`
- `../thesis-csl-authoring/SKILL.md`
