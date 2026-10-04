---
name: thesis-search
description: "Trigger: scholarly search, OpenAlex, Crossref, arXiv, literature search plan, candidate sources, grey literature, official sources."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when planning or selecting literature for a section's research step.

## Hard Rules

- Discovery is not verification. You may select candidates; only code verification (Crossref or OpenAlex match, retraction check, official-domain check) makes a record citable.
- Source order of preference: primary and official, then peer-reviewed indexed, then authoritative grey literature, then contextual (theses, preprints, conference abstracts), then discovery-only (general web, Google Scholar).
- Build queries per research topic and per search language of the brief. Use specific terms, synonyms and the field's dominant language for international topics. Record the year range and why.
- Copy identifiers exactly as tools return them. Never type a DOI, arXiv id or URL from memory and never invent authors, years or titles.
- Use the host web tools only when they are available to you. Their absence is reported, not an error. Official legal and standards texts come from official domains the policy allowlists.
- Respect rate limits: one query per intent, no repeated queries from the search log.

## Decision Gates

| Situation | Action |
| --- | --- |
| A topic returns no results | Broaden terms or years once, then report the gap; do not pad with weak sources |
| Only preprints exist | Select them as contextual and say so |
| A result has no DOI | Keep it if it is relevant and from an official domain; otherwise mark it low confidence |
| Two records look identical | Select one and note the duplicate; code merges them |
| A source is paywalled | Use the open-access link if given; never describe contents you could not see |

## Execution Steps

1. Read the section plan: purpose, topics, evidence needs and the brief's search languages.
2. Write the `SearchPlan` with queries, sources and year range per topic.
3. After code runs the queries, select candidates and return the `CandidateSet` with the reason for each.
4. List topics with no adequate source as gaps.

## Output Contract

Return strict JSON for `SearchPlan` or `CandidateSet`: identifiers exactly as returned by tools, the title, first-author family name and year exactly as returned (code compares them with Crossref or OpenAlex), a one-sentence relevance reason, and the topic each record serves.

## References

- `../../../README.md`
- `../thesis-evidence/SKILL.md`
