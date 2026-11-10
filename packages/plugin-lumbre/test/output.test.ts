import { describe, expect, it } from "vitest";
import { errorCode } from "../src/errors.js";
import { classifyFailure, mergeOutputs, planBatches, readOutput } from "../src/output.js";
import { blocks, cutInside, LANDING, legacy, MESSAGE } from "./fixtures/landing.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return errorCode(error);
  }
  return "ok";
};

describe("block output (0.1.1)", () => {
  it("fixture is a realistic 25-40 KB multi-file landing", () => {
    const size = Buffer.byteLength(blocks());
    expect(size).toBeGreaterThan(25_000);
    expect(size).toBeLessThan(40_000);
  });

  it("(a) reads a complete answer: files verbatim, no escaping needed", () => {
    const out = readOutput(blocks());
    expect(out.format).toBe("blocks");
    expect(out.done).toBe(true);
    expect(out.truncated).toBe(false);
    expect(out.cut).toBeNull();
    expect(Object.fromEntries(out.files.map((f) => [f.path, f.content]))).toEqual(LANDING);
    expect(out.message).toBe(MESSAGE);
    expect(out.summary).toBe("Bakery landing page");
    expect(out.deletes).toEqual(["script-old.js"]);
  });

  it("(b) keeps every complete block when the answer is cut mid-file", () => {
    const out = readOutput(cutInside(blocks(), "about.html"));
    expect(out.truncated).toBe(true);
    expect(out.done).toBe(false);
    expect(out.cut).toBe("about.html");
    expect(out.files.map((f) => f.path)).toEqual(["index.html", "styles.css", "script.js"]);
    expect(out.files[0]?.content).toBe(LANDING["index.html"]);
  });

  it("(c) tolerates prose and code fences around the whole answer and around one file", () => {
    const fenced = `Sure! Here is your site:\n\n\`\`\`text\n${blocks({ "a.html": "<h1>A</h1>\n" })}\n\`\`\`\n\nLet me know.`;
    const inner = blocks({ "b.css": "body{}\n" }).replace("body{}", "```css\nbody{}\n```");
    expect(readOutput(fenced).files).toEqual([{ path: "a.html", content: "<h1>A</h1>\n" }]);
    expect(readOutput(inner).files).toEqual([{ path: "b.css", content: "body{}\n" }]);
  });

  it("(d) still accepts the 0.1.0 single-JSON form", () => {
    const out = readOutput(legacy());
    expect(out.format).toBe("json");
    expect(out.truncated).toBe(false);
    expect(out.files.length).toBe(Object.keys(LANDING).length);
    expect(out.files.find((f) => f.path === "styles.css")?.content).toBe(LANDING["styles.css"]);
    // A cut JSON answer is reported as truncated, not as malformed.
    const cut = readOutput(legacy().slice(0, 9_000));
    expect(cut).toMatchObject({ format: "json", truncated: true, files: [] });
  });

  it("separates malformed answers from truncated ones", () => {
    expect(code(() => readOutput("I cannot help with that."))).toBe("invalid_output");
    expect(code(() => readOutput('{"files": "nope"} trailing'))).toBe("invalid_output");
    // A broken meta header does not lose the files.
    const broken = blocks({ "a.html": "x\n" }, { meta: "not json" }).replace('"not json"', "{oops");
    expect(readOutput(broken).files.length).toBe(1);
  });

  it("reads a plan of files with sizes", () => {
    const out = readOutput(
      `<<<LUMBRE-MESSAGE>>>\nPlan ready.\n<<<LUMBRE-END>>>\n<<<LUMBRE-PLAN>>>\nindex.html | large | page\nstyles.css | medium | styles\n- script.js | small | behaviour\n<<<LUMBRE-END>>>\n<<<LUMBRE-DONE>>>`,
    );
    expect(out.plan).toEqual([
      { path: "index.html", size: "large" },
      { path: "styles.css", size: "medium" },
      { path: "script.js", size: "small" },
    ]);
  });

  it("merges continuations: later complete blocks win, the cut file is replaced", () => {
    const first = readOutput(cutInside(blocks(), "about.html"));
    const rest = readOutput(
      blocks(
        {
          "about.html": LANDING["about.html"] as string,
          "assets/logo.svg": LANDING["assets/logo.svg"] as string,
        },
        { meta: {}, message: "" },
      ),
    );
    const merged = mergeOutputs(first, rest);
    expect(Object.fromEntries(merged.files.map((f) => [f.path, f.content]))).toEqual(LANDING);
    expect(merged).toMatchObject({ truncated: false, cut: null, done: true, message: MESSAGE });
    expect(merged.deletes).toEqual(["script-old.js"]);
  });

  it("groups planned files into batches that fit the output budget", () => {
    const plan = [
      { path: "a.html", size: "large" as const },
      { path: "b.css", size: "medium" as const },
      { path: "c.js", size: "small" as const },
      { path: "d.html", size: "large" as const },
    ];
    expect(planBatches(plan, 100_000)).toEqual([["a.html", "b.css", "c.js", "d.html"]]);
    expect(planBatches(plan, 16_000)).toEqual([["a.html"], ["b.css", "c.js"], ["d.html"]]);
    // A file larger than a batch still gets a batch of its own.
    expect(planBatches(plan, 2_000)).toEqual([["a.html"], ["b.css"], ["c.js"], ["d.html"]]);
  });

  it("classifies a child failure into a category without keeping its text", () => {
    expect(
      classifyFailure("The model x was cut off once by the output-token limit (16000 tokens)"),
    ).toBe("truncated");
    expect(classifyFailure("Request timed out after 300000 ms")).toBe("timeout");
    expect(classifyFailure("429 Too Many Requests: rate limit")).toBe("rate_limit");
    expect(classifyFailure("401 Unauthorized: invalid api key")).toBe("auth");
    expect(classifyFailure("maximum context length exceeded")).toBe("context_length");
    expect(classifyFailure("400 max_tokens is too large")).toBe("output_limit");
    expect(classifyFailure("socket hang up")).toBe("provider");
    expect(classifyFailure(undefined)).toBe("unknown");
  });
});
