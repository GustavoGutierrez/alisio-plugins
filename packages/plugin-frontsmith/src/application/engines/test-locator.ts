import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const PARAMS = [
  "fragile",
  "calls",
  "forbidCalls",
  "requireAssertions",
  "assertionCalls",
  "flagWithoutAlternative",
] as const;
const DEFAULT_CALLS = ["locator", "$", "$$", "querySelector", "querySelectorAll", "find", "get"];
const DEFAULT_FRAGILE = String.raw`^//|^\(//|:nth-(?:child|of-type)|\s>\s|\s*>\s*[A-Za-z.]|(?:^|[\s>+~])\.[A-Za-z_-]|\[class[*^$~|]?=`;
const DEFAULT_ASSERTIONS = String.raw`^(?:expect|assert|verify|check|should)(?:\(\)|\.|$)|(?:^|\.)should$|^cy\.|toHaveScreenshot|^t\.`;
const SKIPPED = /\.(?:skip|todo|fixme)$/;

export const testLocator: Engine = {
  id: "test-locator",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    if (params.fragile !== true) reader.regex("fragile");
    reader.strings("calls");
    reader.regex("forbidCalls");
    reader.bool("requireAssertions");
    reader.regex("assertionCalls");
    const flag = reader.object("flagWithoutAlternative");
    if (flag) {
      const inner = new ParamReader(flag, ["call", "alternatives"]);
      inner.regex("call", true);
      inner.regex("alternatives", true);
      for (const error of inner.errors) reader.errors.push(`flagWithoutAlternative.${error}`);
    }
    const configured = [
      "fragile",
      "forbidCalls",
      "requireAssertions",
      "flagWithoutAlternative",
    ].some((key) => params[key] !== undefined && params[key] !== false);
    if (!configured) reader.errors.push("no check configured");
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, PARAMS);
    const fragileParam = context.params.fragile;
    const fragile =
      fragileParam === undefined
        ? undefined
        : new RegExp(fragileParam === true ? DEFAULT_FRAGILE : (fragileParam as string), "u");
    const calls = new Set(reader.strings("calls") ?? DEFAULT_CALLS);
    const forbid = reader.regex("forbidCalls");
    const requireAssertions = reader.bool("requireAssertions") === true;
    const assertion = reader.regex("assertionCalls") ?? new RegExp(DEFAULT_ASSERTIONS, "u");
    const flagRaw = reader.object("flagWithoutAlternative") as
      | { call: string; alternatives: string }
      | undefined;
    const flag = flagRaw
      ? { call: new RegExp(flagRaw.call, "u"), alternatives: new RegExp(flagRaw.alternatives, "u") }
      : undefined;
    const findings: RawFinding[] = [];
    for (const analysis of context.files)
      for (const piece of analysis.scripts) {
        for (const call of piece.view.calls) {
          const last = call.callee.split(".").pop() ?? call.callee;
          const at = { file: analysis.path, line: call.loc.line, column: call.loc.column };
          if (fragile && calls.has(last)) {
            const first = call.args[0];
            if (
              first &&
              (first.kind === "string" || first.kind === "template") &&
              first.value !== undefined &&
              fragile.test(first.value)
            )
              findings.push({ ...at, detail: `fragile locator "${first.value}"` });
          }
          if (forbid?.test(call.callee))
            findings.push({ ...at, detail: `${call.callee}() is not allowed in tests` });
        }
        for (const test of piece.view.testCases) {
          const at = { file: analysis.path, line: test.loc.line, column: test.loc.column };
          if (
            requireAssertions &&
            test.hasBody &&
            !SKIPPED.test(test.callee) &&
            !test.calls.some((c) => assertion.test(c))
          )
            findings.push({ ...at, detail: `test "${test.name}" has no assertion` });
          if (
            flag &&
            test.hasBody &&
            test.calls.some((c) => flag.call.test(c)) &&
            !test.calls.some((c) => flag.alternatives.test(c))
          )
            findings.push({
              ...at,
              detail: `test "${test.name}" selects by test id without a role or label query`,
            });
        }
      }
    return { findings };
  },
};
