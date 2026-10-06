import type { ArchiveEnvelope } from "../../domain/envelopes/archive.js";
import { bullets, document, section } from "./md.js";

/** `retro.md`: the seven retrospective questions answered from evidence. */
export function renderRetroMd(
  archive: ArchiveEnvelope,
  feature: string,
  dropped: readonly string[],
): string {
  const r = archive.retrospective;
  return document(
    `# Retrospective: ${feature}`,
    section("What escaped the gates", bullets(r.escaped)),
    section("What detected each error", bullets(r.detectedBy)),
    section("Which instructions were ambiguous", bullets(r.ambiguities)),
    section("What context was missing", bullets(r.missingContext)),
    section("Which checks were costly but not useful", bullets(r.costlyChecks)),
    section("What could be automated", bullets(r.automationCandidates)),
    section(
      "Rule candidates",
      bullets(archive.ruleCandidates.map((c) => `${c.id}: ${c.rationale}`)),
    ),
    ...(dropped.length > 0 ? [section("Candidates dropped", bullets(dropped))] : []),
  );
}
