import { describe, expect, it } from "vitest";
import { errorCode } from "../src/errors.js";
import { budget, buildPrompt, parseOutput } from "../src/generate.js";
import { stack } from "../src/presets.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return errorCode(error);
  }
  return "ok";
};

describe("token budget (LMB-AC-07, 0.1.1)", () => {
  it("uses the limits the provider reports, without an artificial cap", () => {
    const big = budget({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    expect(big).toMatchObject({
      contextTokens: 1_000_000,
      outputTokens: 128_000,
      contextSource: "provider",
      outputSource: "provider",
    });
    const mid = budget({ contextWindow: 200_000, maxOutputTokens: 64_000 });
    expect(mid.outputTokens).toBe(64_000);
    // Never more than the catalog value (a child's limit is sent to the provider as is).
    expect(budget({ contextWindow: 1_000_000, maxOutputTokens: 8_192 }).outputTokens).toBe(8_192);
    // Half of the context stays for the prompt.
    const small = budget({ contextWindow: 16_000, maxOutputTokens: 16_000 });
    expect(small.outputTokens).toBe(8_000);
    expect(small.inputChars).toBeLessThan(big.inputChars);
  });

  it("assumes a modern context and a generous output when the catalog reports nothing", () => {
    // The owner's case: OpenCode Go reports no limits for deepseek-v4.1-flash.
    const unknown = budget({});
    expect(unknown).toMatchObject({
      contextTokens: 128_000,
      outputTokens: 32_768,
      contextSource: "estimated",
      outputSource: "estimated",
    });
    expect(unknown.inputChars).toBeGreaterThan(200_000);
    expect(budget(undefined).contextTokens).toBe(128_000);
    // Context reported, output not: a generous output that still leaves room for input.
    expect(budget({ contextWindow: 1_000_000 })).toMatchObject({
      outputTokens: 32_768,
      outputSource: "estimated",
    });
  });

  it("refuses a context too small to hold a useful request", () => {
    expect(code(() => budget({ contextWindow: 4_000 }))).toBe("context_limit");
  });
});

describe("prompt", () => {
  const files = { "index.html": "<h1>Hi</h1>", "styles.css": "h1{color:red}" };
  it("includes the stack rules, managed files, allowlist, recent chat and the files", () => {
    const { prompt, omitted } = buildPrompt({
      stack: stack("react"),
      request: "Add a pricing section",
      chat: [
        { id: "1", role: "user", text: "Make a bakery site", at: 1 },
        { id: "2", role: "assistant", text: "Done: hero and menu.", at: 2 },
      ],
      files,
      owned: ["package.json", "vite.config.js"],
      inputChars: 50_000,
      locale: "es",
    });
    expect(prompt).toContain("Add a pricing section");
    expect(prompt).toContain("Make a bakery site");
    expect(prompt).toContain("Done: hero and menu.");
    expect(prompt).toContain("vite.config.js");
    expect(prompt).toContain('"lucide-react":"1.61.0"');
    expect(prompt).toContain("h1{color:red}");
    expect(prompt).toContain('<<<LUMBRE-FILE path="relative/path.ext">>>');
    expect(prompt).not.toMatch(/Answer with ONE JSON object/);
    expect(prompt).toMatch(/Spanish/);
    expect(omitted).toEqual([]);
  });

  it("keeps the newest chat turns and lists files it could not fit", () => {
    const chat = Array.from({ length: 60 }, (_, i) => ({
      id: String(i),
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      text: `turn-${i} ${"x".repeat(400)}`,
      at: i,
    }));
    const big = { "index.html": "<h1>Hi</h1>", "big.js": "y".repeat(30_000) };
    const { prompt, omitted } = buildPrompt({
      stack: stack("vanilla"),
      request: "Change the title",
      chat,
      files: big,
      owned: [],
      inputChars: 12_000,
      locale: "en",
    });
    expect(prompt).toContain("turn-59");
    expect(prompt).not.toContain("turn-0 ");
    expect(omitted).toEqual(["big.js"]);
    expect(prompt).toContain("big.js");
    expect(prompt.length).toBeLessThanOrEqual(12_000 + 4_000);
  });

  it("adds the build log for a fix-up pass", () => {
    const { prompt } = buildPrompt({
      stack: stack("vite"),
      request: "",
      chat: [],
      files,
      owned: [],
      inputChars: 50_000,
      locale: "en",
      errorLog: "SyntaxError: Unexpected token (3:4)",
    });
    expect(prompt).toContain("SyntaxError: Unexpected token (3:4)");
    expect(prompt).toMatch(/fix/i);
  });
});

describe("output parsing (LMB-AC-06)", () => {
  const current = { "index.html": "<h1>Old</h1>", "styles.css": "h1{}", "old.js": "1" };
  const s = stack("react");
  const parse = (value: unknown) =>
    parseOutput(typeof value === "string" ? value : JSON.stringify(value), {
      stack: s,
      current,
      owned: ["package.json", "vite.config.js", "package-lock.json"],
    });

  it("accepts changed files, deletions and allowlisted packages; drops unchanged files", () => {
    const out = parse({
      message: "I added a **pricing** table.",
      summary: "Pricing table",
      files: [
        { path: "index.html", content: "<h1>New</h1>" },
        { path: "styles.css", content: "h1{}" },
        { path: "src/Pricing.jsx", content: "export default () => null;" },
      ],
      delete: ["old.js"],
      dependencies: [{ name: "lucide-react", version: "1.61.0" }],
    });
    expect(out.files).toEqual({
      "index.html": "<h1>New</h1>",
      "src/Pricing.jsx": "export default () => null;",
    });
    expect(out.deletes).toEqual(["old.js"]);
    expect(out.dependencies).toEqual({ "lucide-react": "1.61.0" });
    expect(out.message).toBe("I added a **pricing** table.");
    expect(out.ignored).toEqual([]);
  });

  it("never applies managed files or packages outside the allowlist and reports them", () => {
    const out = parse({
      summary: "x",
      files: [
        { path: "vite.config.js", content: "evil" },
        { path: "package.json", content: "{}" },
        { path: "../escape.js", content: "x" },
        { path: "index.html", content: "<h1>ok</h1>" },
      ],
      delete: ["package-lock.json", "missing.js"],
      dependencies: [
        { name: "left-pad", version: "1.3.0" },
        { name: "lucide-react", version: "^1.0.0" },
      ],
    });
    expect(Object.keys(out.files)).toEqual(["index.html"]);
    expect(out.deletes).toEqual([]);
    expect(out.dependencies).toEqual({});
    expect(out.ignored).toEqual([
      { path: "vite.config.js", reason: "managed" },
      { path: "package.json", reason: "managed" },
      { path: "../escape.js", reason: "invalid_path" },
      { path: "package-lock.json", reason: "managed" },
      { path: "missing.js", reason: "not_found" },
      { name: "left-pad", reason: "not_allowed" },
      { name: "lucide-react", reason: "not_allowed" },
    ]);
  });

  it("reads JSON inside code fences or surrounding prose, and rejects malformed or empty output", () => {
    const fenced =
      'Here you go:\n```json\n{"summary":"s","files":[{"path":"index.html","content":"<p>x</p>"}]}\n```';
    expect(Object.keys(parse(fenced).files)).toEqual(["index.html"]);
    expect(code(() => parse("not json at all"))).toBe("invalid_output");
    expect(code(() => parse({ summary: "s", files: "nope" }))).toBe("invalid_output");
    // A conversational answer with no changes is valid: it is just a chat reply.
    const reply = parse({ message: "Which colors do you like?", files: [] });
    expect(reply.files).toEqual({});
    expect(reply.message).toBe("Which colors do you like?");
  });

  it("rejects duplicate paths and names that only differ in case", () => {
    expect(
      code(() =>
        parse({
          files: [
            { path: "a.js", content: "1" },
            { path: "A.js", content: "2" },
          ],
        }),
      ),
    ).toBe("invalid_output");
  });
});
