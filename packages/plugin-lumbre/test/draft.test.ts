import { describe, expect, it } from "vitest";
import { Draft } from "../src/draft.js";
import { stack } from "../src/presets.js";

const base = { "index.html": "<h1>Hi</h1>\n<p>One</p>\n<p>One</p>\n", "styles.css": "h1{}\n" };
const make = () => new Draft(stack("react"), ["package.json", "vite.config.js"], base, "rev-1");

describe("agent draft (AGT-AC-03, AGT-AC-04)", () => {
  it("lists, reads and overlays changes without touching the base files", () => {
    const d = make();
    expect(d.write("src/App.jsx", "export default () => null;\n")).toMatchObject({
      ok: true,
      created: true,
    });
    expect(d.remove("styles.css")).toMatchObject({ ok: true });
    const list = d.list();
    expect(list.map((f) => [f.path, f.changed, f.owned])).toEqual([
      ["index.html", false, false],
      ["package.json", false, true],
      ["src/App.jsx", true, false],
      ["vite.config.js", false, true],
    ]);
    expect(d.read("styles.css")).toMatchObject({ ok: false, error: "not_found" });
    expect(d.read("index.html", 4, 7)).toMatchObject({
      ok: true,
      content: "Hi</h1>",
      total: 34,
      truncated: true,
    });
    expect(base["styles.css"]).toBe("h1{}\n");
    expect(d.state.counts).toMatchObject({ write: 1, delete: 1, read: 1 });
  });

  it("edits by exact, unique search and replace", () => {
    const d = make();
    expect(d.edit("index.html", "Hi", "Hola")).toMatchObject({ ok: true });
    expect(d.read("index.html").content).toContain("<h1>Hola</h1>");
    expect(d.edit("index.html", "<p>One</p>", "x")).toMatchObject({
      ok: false,
      error: "not_unique",
    });
    expect(d.edit("index.html", "missing", "x")).toMatchObject({ ok: false, error: "not_found" });
    expect(d.edit("nope.html", "a", "b")).toMatchObject({ ok: false, error: "not_found" });
  });

  it("enforces paths, managed files, the allowlist and the size limits", () => {
    const d = make();
    expect(d.write("../x.js", "x")).toMatchObject({ ok: false, error: "invalid_path" });
    expect(d.write("vite.config.js", "x")).toMatchObject({ ok: false, error: "managed_file" });
    expect(d.write("package.json", "{}")).toMatchObject({ ok: false, error: "managed_file" });
    expect(d.remove("package.json")).toMatchObject({ ok: false, error: "managed_file" });
    expect(d.write("Index.html", "x")).toMatchObject({ ok: false, error: "conflict" });
    expect(d.write("big.js", "x".repeat(400_001))).toMatchObject({ ok: false, error: "too_large" });
    expect(d.addDependency("lucide-react", "1.61.0")).toMatchObject({ ok: true });
    expect(d.addDependency("left-pad", "1.3.0")).toMatchObject({ ok: false, error: "not_allowed" });
    expect(d.state.deps).toEqual({ "lucide-react": "1.61.0" });
    for (let i = 0; i < 148; i++) d.write(`f${i}.js`, "1");
    expect(d.write("one-too-many.js", "1")).toMatchObject({ ok: false, error: "too_large" });
  });

  it("records a bounded timeline and turns into raw output for review", () => {
    const d = make();
    d.progress("Adding the menu");
    d.write("index.html", "<h1>New</h1>\n");
    d.remove("styles.css");
    d.finish("Menu added", "I added the **menu**.");
    expect(d.state.timeline.map((e) => e.kind)).toEqual(["progress", "write", "delete", "done"]);
    const raw = d.toRaw();
    expect(raw).toMatchObject({
      summary: "Menu added",
      message: "I added the **menu**.",
      files: [{ path: "index.html", content: "<h1>New</h1>\n" }],
      deletes: ["styles.css"],
      done: true,
    });
    for (let i = 0; i < 400; i++) d.progress(`step ${i}`);
    expect(d.state.timeline.length).toBe(300);
    // State survives a round trip (persisted per job).
    const again = new Draft(stack("react"), [], base, "rev-1", JSON.parse(JSON.stringify(d.state)));
    expect(again.toRaw().files).toEqual(raw.files);
  });
});
