import { validateProjectName, validateTaskName } from "./domain/identifiers.js";

export interface TaskRef {
  project: string;
  task: string;
}

/**
 * A task reference from a command: `<project>/<task>` or an attention item id
 * (`<kind>:<project>:<task>`). Both parts are validated identifiers.
 */
export function parseTaskRef(ref: string | undefined): TaskRef {
  const text = (ref ?? "").trim();
  const slash = /^([^/:\s]+)\/([^/:\s]+)$/.exec(text);
  const attention = /^[a-z-]+:([^/:\s]+):([^/:\s]+)$/.exec(text);
  const match = slash ?? attention;
  if (!match) {
    throw new Error(
      `Invalid task reference ${JSON.stringify(text.slice(0, 60))}: use <project>/<task> or an attention id`,
    );
  }
  return {
    project: validateProjectName(match[1] as string),
    task: validateTaskName(match[2] as string),
  };
}
