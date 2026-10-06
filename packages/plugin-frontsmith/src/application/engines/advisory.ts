import { ParamReader } from "./params.js";
import type { Engine } from "./types.js";

/** Advisory rules carry guidance for agents and reviewers; they never produce findings. */
export const advisory: Engine = {
  id: "advisory",
  validateParams(params) {
    const reader = new ParamReader(params, ["guidance"]);
    reader.string("guidance", true);
    return reader.errors;
  },
  run() {
    return { findings: [], skipped: "advisory rule" };
  },
};
