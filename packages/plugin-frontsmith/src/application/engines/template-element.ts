import { ELEMENT_PARAMS, readElementSpec, runElementSpec } from "./element-match.js";
import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const PARAMS = [...ELEMENT_PARAMS, "includeJsx", "blocks"] as const;

/**
 * Elements of Vue, Svelte, Angular, Astro and HTML templates, with the same params as
 * `jsx-element`. `blocks` (owner extension, FS-SVT-001) instead reports template blocks such as
 * Svelte `{@html}`; `includeJsx` also evaluates the spec on JSX.
 */
export const templateElement: Engine = {
  id: "template-element",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    const blocks = reader.regex("blocks");
    readElementSpec(reader, blocks === undefined);
    reader.bool("includeJsx");
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, PARAMS);
    const blocks = reader.regex("blocks");
    const spec = readElementSpec(reader, blocks === undefined);
    const jsx = reader.bool("includeJsx") === true;
    const findings: RawFinding[] = [];
    if (blocks) {
      for (const analysis of context.files)
        for (const piece of analysis.templates)
          for (const block of piece.scan.blocks)
            if (blocks.test(block.kind))
              findings.push({
                file: analysis.path,
                line: block.line,
                column: block.column,
                detail: `{${block.kind} ${block.expression}}`.replace(/\s+}/, "}"),
              });
      return { findings };
    }
    return { findings: runElementSpec(context, spec, { jsx, templates: true }) };
  },
};
