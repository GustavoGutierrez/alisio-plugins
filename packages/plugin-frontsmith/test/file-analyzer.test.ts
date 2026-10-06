import { describe, expect, it } from "vitest";
import { DefaultFileAnalyzer } from "../src/infrastructure/analysis/file-analyzer.js";

const analyzer = new DefaultFileAnalyzer();

describe("DefaultFileAnalyzer", () => {
  it("analyses a TSX file as one script with comments", () => {
    const analysis = analyzer.analyze(
      "src/A.tsx",
      `// frontsmith-disable-next-line FS-X -- why not\nexport const A = () => <div />;\n`,
    );
    expect(analysis.kind).toBe("script");
    expect(analysis.scripts).toHaveLength(1);
    expect(analysis.scripts[0]?.view.jsx[0]?.tag).toBe("div");
    expect(analysis.comments[0]).toMatchObject({ line: 1 });
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.lineCount).toBe(2);
  });

  it("turns an unparsable script into a FS-SRC-001 diagnostic", () => {
    const analysis = analyzer.analyze("src/bad.ts", "const x: = ;");
    expect(analysis.scripts).toEqual([]);
    expect(analysis.diagnostics).toMatchObject([{ code: "FS-SRC-001", line: 1 }]);
  });

  it("analyses css, scss and less files", () => {
    expect(analyzer.analyze("a.css", "a { color: red }").styles[0]).toMatchObject({
      syntax: "css",
      origin: "file",
    });
    expect(analyzer.analyze("a.scss", "$a: 1;").styles[0]?.syntax).toBe("scss");
    expect(analyzer.analyze("a.less", "@a: 1;").styles[0]?.syntax).toBe("less");
    expect(analyzer.analyze("a.sass", "a\n  color: red").kind).toBe("other");
  });

  it("splits a vue file into script, template and style with original positions", () => {
    const vue = `<template>\n  <img src="x.png">\n  <div v-html="raw"></div>\n</template>\n<script setup lang="ts">\nimport { ref } from "vue";\nconst n = ref<number>(0);\n</script>\n<style lang="scss">\n.a { color: red }\n</style>\n`;
    const analysis = analyzer.analyze("src/P.vue", vue);
    expect(analysis.kind).toBe("sfc");
    expect(analysis.scripts).toHaveLength(1);
    expect(analysis.scripts[0]).toMatchObject({ block: "setup" });
    expect(analysis.scripts[0]?.view.imports[0]).toMatchObject({
      specifier: "vue",
      loc: { line: 6, column: 1 },
    });
    expect(analysis.templates[0]).toMatchObject({ kind: "vue-sfc", origin: "block" });
    expect(analysis.templates[0]?.scan.elements.map((e) => [e.tag, e.line])).toEqual([
      ["img", 2],
      ["div", 3],
    ]);
    expect(analysis.styles[0]).toMatchObject({ syntax: "scss", origin: "block" });
    expect(analysis.styles[0]?.scan.declarations[0]).toMatchObject({ property: "color", line: 10 });
  });

  it("splits svelte files, including markup outside script and style", () => {
    const svelte = `<script context="module" lang="ts">export const a = 1;</script>\n<script lang="ts">export let name: string;</script>\n<h1>{name}</h1>\n{@html raw}\n<style>h1 { color: red }</style>`;
    const analysis = analyzer.analyze("src/S.svelte", svelte);
    expect(analysis.scripts.map((s) => s.block)).toEqual(["module", "script"]);
    expect(analysis.scripts[1]?.view.exportedLets).toMatchObject([{ name: "name", typed: true }]);
    expect(analysis.templates[0]).toMatchObject({ kind: "svelte", origin: "file" });
    expect(analysis.templates[0]?.scan.blocks.map((b) => b.kind)).toEqual(["@html"]);
    expect(analysis.templates[0]?.scan.elements.map((e) => e.tag)).toEqual(["h1"]);
    expect(analysis.styles).toHaveLength(1);
  });

  it("reads astro frontmatter as a script and the rest as markup", () => {
    const astro = `---\nimport A from "./A.astro";\n---\n<A title="x" />\n<img src="y">`;
    const analysis = analyzer.analyze("src/p.astro", astro);
    expect(analysis.scripts[0]).toMatchObject({ block: "frontmatter" });
    expect(analysis.scripts[0]?.view.imports[0]?.specifier).toBe("./A.astro");
    expect(analysis.templates[0]?.scan.elements.map((e) => e.tag)).toEqual(["A", "img"]);
  });

  it("scans html files and picks angular for component templates", () => {
    const html = `<img src="x"><script>const a = 1;</script>`;
    expect(analyzer.analyze("index.html", html).templates[0]?.kind).toBe("html");
    expect(
      analyzer.analyze("src/x.component.html", '<p [innerHTML]="h"></p>').templates[0]?.kind,
    ).toBe("angular");
  });

  it("scans angular inline templates at their file positions", () => {
    const ts = `import { Component } from "@angular/core";\n@Component({\n  selector: "x",\n  template: \`\n    <p [innerHTML]="h"></p>\n  \`,\n})\nexport class X {}\n`;
    const analysis = analyzer.analyze("src/x.component.ts", ts);
    const inline = analysis.templates.find((t) => t.origin === "angular-inline");
    expect(inline).toMatchObject({ kind: "angular", className: "X" });
    expect(inline?.scan.elements[0]).toMatchObject({ tag: "p", line: 5, column: 5 });
  });

  it("returns an empty analysis for other files", () => {
    expect(analyzer.analyze("data.json", "{}")).toMatchObject({
      kind: "other",
      scripts: [],
      styles: [],
      templates: [],
    });
  });
});
