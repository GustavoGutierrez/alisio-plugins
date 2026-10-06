import type { ReviewEnvelope } from "../../domain/envelopes/review.js";
import { document, mdTable, section } from "./md.js";

/** `review.md`: every finding of every review run, strongest first. */
export function renderReviewMd(reviews: readonly ReviewEnvelope[], feature: string): string {
  const rank = { BLOCKER: 0, MAJOR: 1, MINOR: 2, NIT: 3 } as const;
  const blocks = reviews.map((review, index) =>
    section(
      `Review run ${index + 1}: ${review.verdict}`,
      mdTable(
        ["Severity", "Dimension", "Location", "Claim", "Evidence", "Fix", "Criterion"],
        [...review.findings]
          .sort((a, b) => rank[a.severity] - rank[b.severity])
          .map((f) => [
            f.severity,
            f.dimension,
            `${f.file}:${f.line}`,
            f.claim,
            f.evidence,
            f.fix,
            f.acRef ?? "",
          ]),
      ),
    ),
  );
  return document(`# Review: ${feature}`, ...blocks);
}
