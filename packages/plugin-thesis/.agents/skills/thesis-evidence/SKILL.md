---
name: thesis-evidence
description: "Trigger: evidence statuses, appraisal, VERIFIED_PRIMARY, CONTEXTUAL_ONLY, retraction, permitted use, evidence packet."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when appraising sources, deciding what may be cited, or building an evidence packet.

## Hard Rules

- Statuses: VERIFIED_PRIMARY (official domain, law, standard, report or dataset), VERIFIED_PEER_REVIEWED (journal or conference metadata confirmed by Crossref or OpenAlex), VERIFIED_AUTHORITATIVE_GREY, CONTEXTUAL_ONLY, UNVERIFIED, REJECTED. Only the first three are citable.
- A DOI must resolve, the title must match closely (token similarity at least 0.85) and the first author and year (plus or minus one) must agree; otherwise the record is UNVERIFIED. Code decides this, not you.
- Retracted works are REJECTED and may only be cited to discuss the retraction. Duplicates merge into the oldest record.
- You may downgrade a status; never upgrade beyond what verification allows. CONTEXTUAL_ONLY becomes citable for one section only after the user approves it explicitly.
- Appraisal records relevance, evidence type, limitations, supported topics, location in the work and permitted use. Limitations are mandatory even for strong sources.
- An evidence packet for the writer contains citation key, full reference, permitted use, location and limitations for citable records only.

## Decision Gates

| Situation | Action |
| --- | --- |
| A record is UNVERIFIED | Exclude it from the packet; tell the user what was missing |
| A record is CONTEXTUAL_ONLY and needed | Ask the user to approve it for that section |
| A source is relevant but weak | Keep with low relevance and explicit limitations |
| A source disagrees with the others | Keep both and mark the conflict in the dossier |
| The user supplies a source by hand | Send it through verification like any other |

## Execution Steps

1. Read the candidate records with their verification results.
2. Assign relevance, evidence type, limitations, supports, location and permitted use.
3. Propose a status only within what the verification result allows.
4. Produce the packet for the writer from citable records only.

## Output Contract

Return strict JSON for `AppraisalSet`, with one entry per verified candidate (identified by its `handle`, for example `C01`) and no entry for unverified ones. The optional `status` may only downgrade the status code assigned; an upgrade is rejected.

## References

- `../../../README.md`
- `../thesis-search/SKILL.md`
- `../thesis-citations/SKILL.md`
