import { addPrepared, type GateBuilder, type Prepared } from "./aggregate.js";

/**
 * A check whose evidence the application layer may or may not have produced. Missing evidence of a
 * required check is BLOCKED, never PASS (spec 2.3); of an optional one it is SKIPPED.
 */
export function addEvidence(
  builder: GateBuilder,
  id: string,
  prepared: Prepared | undefined,
  options: { required: boolean; missing: string },
): void {
  if (prepared) {
    addPrepared(builder, id, prepared);
    return;
  }
  if (options.required) {
    builder.add(id, "BLOCKED", options.missing);
    builder.finding(id, "G-EVIDENCE", "blocker", "BLOCKED", options.missing);
  } else builder.add(id, "SKIPPED", options.missing, { required: false });
}
