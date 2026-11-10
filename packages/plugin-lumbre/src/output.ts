// Reading the builder's answer (0.1.1). Files arrive as delimited blocks that need no escaping:
//
//   <<<LUMBRE-META>>>      {"summary": "...", "delete": [...], "dependencies": [...]}   <<<LUMBRE-END>>>
//   <<<LUMBRE-MESSAGE>>>   short Markdown for the person                                  <<<LUMBRE-END>>>
//   <<<LUMBRE-PLAN>>>      one "path | small|medium|large | purpose" line per file      <<<LUMBRE-END>>>
//   <<<LUMBRE-FILE path="index.html">>>   the complete file                             <<<LUMBRE-END>>>
//   <<<LUMBRE-DONE>>>
//
// Markers are whole lines. Prose and code fences around them are ignored, so is a fence wrapping
// one file. When the answer is cut by the output limit, every COMPLETE block is kept and the cut
// one is reported, so the caller can ask for a continuation. The single-JSON answer of 0.1.0 is
// still accepted as a fallback. Nothing here validates paths: see `validateOutput`.
import { LumbreError } from "./errors.js";

export type PlanSize = "small" | "medium" | "large";
export interface PlanEntry {
  path: string;
  size: PlanSize;
}
/** The design token plan (lmb-design): shown in the plan card, used by the build. */
export interface DesignPlan {
  direction: string;
  palette: Array<{ name: string; hex: string }>;
  type: Array<{ role: string; font: string }>;
  layout: string;
  wireframe: string;
  principles: string[];
}

export interface RawOutput {
  format: "blocks" | "json";
  message: string;
  summary: string;
  files: Array<{ path: string; content: string }>;
  deletes: unknown[];
  dependencies: unknown[];
  plan: PlanEntry[] | null;
  design: DesignPlan | null;
  /** The answer ended with <<<LUMBRE-DONE>>> (or was a complete JSON object). */
  done: boolean;
  /** Path of a file block the answer stopped inside. */
  cut: string | null;
  /** Some block was left open, or the JSON answer stopped early. */
  truncated: boolean;
}

const START =
  /^\s*<<<LUMBRE-(FILE|META|MESSAGE|PLAN|DESIGN)(?:\s+path=(?:"([^"]*)"|'([^']*)'))?\s*>>>\s*$/;
const END = /^\s*<<<LUMBRE-END>>>\s*$/;
const DONE = /^\s*<<<LUMBRE-DONE>>>\s*$/;
const FENCE = /^\s*(```|~~~)/;

export const FORMAT_HELP = `Answer in this exact format (markers on their own lines, files verbatim, no escaping, no code fences):
<<<LUMBRE-META>>>
{"summary": "one line, at most 80 characters", "delete": ["path/to/remove.ext"], "dependencies": [{"name": "exact-name", "version": "exact.version"}]}
<<<LUMBRE-END>>>
<<<LUMBRE-MESSAGE>>>
Short Markdown reply to the person.
<<<LUMBRE-END>>>
<<<LUMBRE-FILE path="relative/path.ext">>>
the complete content of the file
<<<LUMBRE-END>>>
(one FILE block per created or changed file)
<<<LUMBRE-DONE>>>`;

const empty = (format: RawOutput["format"]): RawOutput => ({
  format,
  message: "",
  summary: "",
  files: [],
  deletes: [],
  dependencies: [],
  plan: null,
  design: null,
  done: false,
  cut: null,
  truncated: false,
});

/** Drops one code fence wrapping a whole block. */
function unfence(lines: string[]) {
  const first = lines.findIndex((l) => l.trim() !== "");
  let last = lines.length - 1;
  while (last >= 0 && lines[last]?.trim() === "") last--;
  if (
    first !== -1 &&
    last > first &&
    FENCE.test(lines[first] ?? "") &&
    FENCE.test(lines[last] ?? "")
  )
    return lines.slice(first + 1, last);
  return lines;
}

function readPlan(lines: string[]): PlanEntry[] {
  const plan: PlanEntry[] = [];
  for (const line of lines) {
    const parts = line
      .replace(/^\s*[-*\d.)]+\s+/, "")
      .split("|")
      .map((p) => p.trim().replace(/^`|`$/g, ""));
    const path = parts[0];
    if (!path || /\s/.test(path) || !path.includes(".")) continue;
    const size = (["small", "medium", "large"] as const).find((s) => parts[1]?.toLowerCase() === s);
    if (!plan.some((p) => p.path === path)) plan.push({ path, size: size ?? "medium" });
  }
  return plan;
}

const clip = (value: string, max: number) => value.trim().slice(0, max);

/**
 * The DESIGN block, one `key: value` per line (no JSON, so the wireframe needs no escaping):
 *   direction: Organic, sun-warmed bakery
 *   color: Masa #F2E3C6          (4-6 lines)
 *   type: display | Fraunces     (role | font)
 *   layout: one sentence
 *   principle: one line           (repeatable)
 *   wireframe:                    (every following line, as drawn)
 */
export function readDesign(lines: string[]): DesignPlan | null {
  const design: DesignPlan = {
    direction: "",
    palette: [],
    type: [],
    layout: "",
    wireframe: "",
    principles: [],
  };
  const wire: string[] = [];
  let inWire = false;
  for (const line of lines) {
    if (inWire) {
      if (wire.length < 30) wire.push(line.slice(0, 100));
      continue;
    }
    const m = /^\s*[-*]?\s*([a-z]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = (m[1] as string).toLowerCase();
    const value = m[2] as string;
    if (key === "wireframe") {
      inWire = true;
      if (value.trim()) wire.push(value.slice(0, 100));
    } else if (key === "direction") design.direction = clip(value, 160);
    else if (key === "layout") design.layout = clip(value, 300);
    else if (key === "principle" && design.principles.length < 6)
      design.principles.push(clip(value, 200));
    else if ((key === "color" || key === "colour") && design.palette.length < 8) {
      const hex = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(value);
      if (!hex) continue;
      const raw = (hex[1] as string).toLowerCase();
      const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
      const name = clip(value.replace(hex[0], "").replace(/[|:]/g, " "), 40) || `#${full}`;
      design.palette.push({ name, hex: `#${full}` });
    } else if (key === "type" && design.type.length < 4) {
      const [role, font] = value.split("|").map((v) => v.trim());
      if (role && font) design.type.push({ role: clip(role, 30), font: clip(font, 80) });
    }
  }
  design.wireframe = wire.join("\n").replace(/\s+$/, "");
  return design.palette.length || design.type.length || design.layout || design.wireframe
    ? design
    : null;
}

function readMeta(out: RawOutput, text: string) {
  try {
    const meta = JSON.parse(text) as Record<string, unknown>;
    if (!meta || typeof meta !== "object") return;
    if (typeof meta.summary === "string") out.summary = meta.summary;
    if (typeof meta.message === "string" && !out.message) out.message = meta.message;
    const del = meta.delete ?? meta.deletes;
    if (Array.isArray(del)) out.deletes.push(...del);
    if (Array.isArray(meta.dependencies)) out.dependencies.push(...meta.dependencies);
    else if (meta.dependencies && typeof meta.dependencies === "object")
      for (const [name, version] of Object.entries(meta.dependencies))
        out.dependencies.push({ name, version });
  } catch {
    // A broken header never costs the files; the summary falls back to the message.
  }
}

function readBlocks(text: string): RawOutput | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!lines.some((l) => START.test(l))) return undefined;
  const out = empty("blocks");
  const files = new Map<string, string>();
  let open: { kind: string; path: string; body: string[] } | undefined;
  const close = () => {
    if (!open) return;
    const body = open.kind === "FILE" ? unfence(open.body) : open.body;
    const value = body.join("\n");
    if (open.kind === "FILE") files.set(open.path, value ? `${value}\n` : "");
    else if (open.kind === "MESSAGE") out.message = value.trim();
    else if (open.kind === "META") readMeta(out, value.trim());
    else if (open.kind === "PLAN") out.plan = readPlan(body);
    else if (open.kind === "DESIGN") out.design = readDesign(body);
    open = undefined;
  };
  for (const line of lines) {
    if (open) {
      if (END.test(line)) {
        close();
        continue;
      }
      const start = START.exec(line);
      // A new block before END: the model forgot the marker; the previous block ends here.
      if (start) close();
      else {
        open.body.push(line);
        continue;
      }
    }
    if (DONE.test(line)) {
      out.done = true;
      continue;
    }
    const start = START.exec(line);
    if (start) open = { kind: start[1] as string, path: start[2] ?? start[3] ?? "", body: [] };
  }
  if (open) {
    out.truncated = true;
    if (open.kind === "FILE") out.cut = open.path;
    else if (open.kind === "MESSAGE") out.message = open.body.join("\n").trim();
    open = undefined;
  }
  out.files = [...files].map(([path, content]) => ({ path, content }));
  return out;
}

function readJson(text: string): RawOutput {
  const trimmed = text.trim();
  const attempts = [
    trimmed,
    trimmed.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/\s*```[\s\S]*$/, ""),
    trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1),
  ];
  for (const attempt of attempts) {
    let value: unknown;
    try {
      value = JSON.parse(attempt);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    const out = empty("json");
    out.done = true;
    const list = (v: unknown) => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v)) throw new LumbreError("invalid_output");
      return v;
    };
    const files = new Map<string, string>();
    for (const f of list(raw.files)) {
      const path = (f as { path?: unknown })?.path;
      const content = (f as { content?: unknown })?.content;
      if (typeof path !== "string" || typeof content !== "string")
        throw new LumbreError("invalid_output");
      files.set(path, content);
    }
    out.files = [...files].map(([path, content]) => ({ path, content }));
    out.deletes = list(raw.delete);
    out.dependencies = Array.isArray(raw.dependencies)
      ? raw.dependencies
      : raw.dependencies && typeof raw.dependencies === "object"
        ? Object.entries(raw.dependencies).map(([name, version]) => ({ name, version }))
        : [];
    out.message = typeof raw.message === "string" ? raw.message : "";
    out.summary = typeof raw.summary === "string" ? raw.summary : "";
    return out;
  }
  // An object that never closed is a cut answer, not a malformed one.
  const body = trimmed.replace(/^```(?:json)?\s*/i, "");
  if (
    body.startsWith("{") &&
    /"(files|message|summary)"\s*:/.test(body) &&
    !/\}\s*(```)?\s*$/.test(body)
  )
    return { ...empty("json"), truncated: true };
  throw new LumbreError("invalid_output");
}

/** Parses one answer of the builder (blocks, else the legacy JSON object). */
export function readOutput(text: string): RawOutput {
  return readBlocks(String(text ?? "")) ?? readJson(String(text ?? ""));
}

/** Joins a continuation onto what already arrived: later complete files win. */
export function mergeOutputs(base: RawOutput | undefined, next: RawOutput): RawOutput {
  if (!base) return next;
  const files = new Map(base.files.map((f) => [f.path, f.content]));
  for (const f of next.files) files.set(f.path, f.content);
  return {
    format: base.format === "blocks" || next.format === "blocks" ? "blocks" : "json",
    message: base.message || next.message,
    summary: base.summary || next.summary,
    files: [...files].map(([path, content]) => ({ path, content })),
    deletes: [...base.deletes, ...next.deletes.filter((d) => !base.deletes.includes(d))],
    dependencies: [...base.dependencies, ...next.dependencies],
    plan: base.plan ?? next.plan,
    design: base.design ?? next.design,
    done: next.done,
    cut: next.cut,
    truncated: next.truncated,
  };
}

const SIZE_TOKENS: Record<PlanSize, number> = { small: 1_500, medium: 4_000, large: 9_000 };

/** Splits planned files into batches whose estimated size fits 60% of the output budget. */
export function planBatches(plan: PlanEntry[], outputTokens: number): string[][] {
  const capacity = Math.floor(outputTokens * 0.6);
  const batches: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const entry of plan) {
    const cost = SIZE_TOKENS[entry.size];
    if (current.length && used + cost > capacity) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(entry.path);
    used += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

export type FailureCategory =
  | "truncated"
  | "timeout"
  | "rate_limit"
  | "auth"
  | "context_length"
  | "output_limit"
  | "provider"
  | "unknown";

/** The kind of a child-session failure; its text (which may echo content) is never kept. */
export function classifyFailure(error: string | undefined): FailureCategory {
  if (!error) return "unknown";
  const e = error.toLowerCase();
  if (/cut off|output-token limit|max output tokens/.test(e)) return "truncated";
  if (
    /max_tokens|max_output_tokens|max_completion_tokens|maximum.*output|output.*too large/.test(e)
  )
    return "output_limit";
  if (/context|too long|prompt is too large|maximum.*tokens/.test(e)) return "context_length";
  if (/time(d)? ?out|deadline/.test(e)) return "timeout";
  if (/rate.?limit|429|quota|too many requests/.test(e)) return "rate_limit";
  if (/401|403|unauthori|forbidden|api key|credential/.test(e)) return "auth";
  return "provider";
}
