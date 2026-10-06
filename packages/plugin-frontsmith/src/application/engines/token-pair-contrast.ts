import { contrastRatio, minimumRatio, parseColor } from "../../domain/color/contrast.js";
import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const PARAMS = ["target", "margin"] as const;

export const tokenPairContrast: Engine = {
  id: "token-pair-contrast",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    reader.oneOf("target", ["AA", "AAA"], true);
    reader.number("margin", 0);
    return reader.errors;
  },
  run(context) {
    if (!context.tokens) return { findings: [], skipped: "no tokens.json for this run" };
    const reader = new ParamReader(context.params, PARAMS);
    const target = reader.oneOf("target", ["AA", "AAA"], true) ?? "AA";
    const margin = reader.number("margin", 0) ?? 0;
    const { values, pairs, path } = context.tokens;
    const findings: RawFinding[] = [];
    for (const pair of pairs) {
      const foreground = values[pair.fg];
      const background = values[pair.bg];
      if (!foreground || !background) {
        findings.push({
          file: path,
          line: 1,
          column: 1,
          detail: `${pair.fg} on ${pair.bg}: a token has no value`,
        });
        continue;
      }
      for (const theme of Object.keys(foreground)) {
        const bgValue = background[theme];
        if (bgValue === undefined) continue;
        const fg = parseColor(foreground[theme] as string);
        const bg = parseColor(bgValue);
        // Spec 12.1: an unsupported colour format is a REVIEW item, never a blocker, never PASS.
        if (!fg || !bg) {
          findings.push({
            file: path,
            line: 1,
            column: 1,
            detail: `${pair.fg} on ${pair.bg} (${theme}): unsupported color format`,
            review: true,
          });
          continue;
        }
        const ratio = contrastRatio(fg, bg);
        const minimum = minimumRatio(pair.kind, target) + margin;
        if (ratio < minimum)
          findings.push({
            file: path,
            line: 1,
            column: 1,
            detail: `${pair.fg} on ${pair.bg} (${theme}): ${ratio.toFixed(2)}:1 is below ${minimum}:1`,
          });
      }
    }
    return { findings };
  },
};
