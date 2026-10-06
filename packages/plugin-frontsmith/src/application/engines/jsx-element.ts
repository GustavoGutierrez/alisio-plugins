import { ELEMENT_PARAMS, readElementSpec, runElementSpec } from "./element-match.js";
import { ParamReader } from "./params.js";
import type { Engine } from "./types.js";

const PARAMS = [...ELEMENT_PARAMS, "includeTemplates"] as const;

/** Elements of JSX files; `includeTemplates` also evaluates the same spec on template pieces. */
export const jsxElement: Engine = {
  id: "jsx-element",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    readElementSpec(reader, true);
    reader.bool("includeTemplates");
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, PARAMS);
    const spec = readElementSpec(reader, true);
    const templates = reader.bool("includeTemplates") === true;
    return { findings: runElementSpec(context, spec, { jsx: true, templates }) };
  },
};
