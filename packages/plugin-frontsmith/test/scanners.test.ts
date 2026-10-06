import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/domain/jsonc.js";
import { scanCss } from "../src/infrastructure/scanners/css.js";
import { extractSfc, maskedSource } from "../src/infrastructure/scanners/sfc.js";
import { scanTemplate } from "../src/infrastructure/scanners/template.js";

const props = (css: string, syntax: "css" | "scss" | "less" = "css") =>
  scanCss(css, syntax).declarations.map((d) => `${d.property}:${d.value}${d.important ? "!" : ""}`);

const tags = (source: string, kind: Parameters<typeof scanTemplate>[1] = "html") =>
  scanTemplate(source, kind).elements.map((e) => e.tag);

describe("css scanner", () => {
  it("reads declarations with position, selector and !important", () => {
    const scan = scanCss(
      "html,\nbody {\n  overflow-x: hidden;\n  color : red !important;\n}\n",
      "css",
    );
    expect(scan.errors).toEqual([]);
    expect(scan.rules).toHaveLength(1);
    expect(scan.rules[0]?.selectors).toEqual(["html", "body"]);
    expect(scan.declarations).toMatchObject([
      { property: "overflow-x", value: "hidden", important: false, line: 3, column: 3 },
      { property: "color", value: "red", important: true, line: 4, column: 3 },
    ]);
  });

  it("ignores comments and keeps them for suppression lookups", () => {
    const scan = scanCss("/* a: b; */ .x { /* c: d */ color: red; }", "css");
    expect(props("/* a: b; */ .x { /* c: d */ color: red; }")).toEqual(["color:red"]);
    expect(scan.comments.map((c) => c.text.trim())).toEqual(["a: b;", "c: d"]);
  });

  it("keeps ; and } inside strings and url()", () => {
    const css = `.a { content: "a;b}c"; background: url(data:image/png;base64,AAA=); color: blue; }
.b { background: url("x;y.png") no-repeat; }`;
    expect(props(css)).toEqual([
      'content:"a;b}c"',
      "background:url(data:image/png;base64,AAA=)",
      "color:blue",
      'background:url("x;y.png") no-repeat',
    ]);
  });

  it("tracks at-rule context for nested rules", () => {
    const css = `@layer utilities { @media (min-width: 600px) { .u { margin: 0 !important; } } }
@supports (display: grid) { .g { display: grid } }`;
    const scan = scanCss(css, "css");
    const margin = scan.declarations.find((d) => d.property === "margin");
    expect(margin?.atRules).toEqual([
      { name: "layer", prelude: "utilities" },
      { name: "media", prelude: "(min-width: 600px)" },
    ]);
    const grid = scan.declarations.find((d) => d.property === "display");
    expect(grid?.atRules).toEqual([{ name: "supports", prelude: "(display: grid)" }]);
  });

  it("records at-rule blocks such as @font-face and statements such as @apply", () => {
    const css = `@font-face { font-family: X; src: url(x.woff2); font-display: swap; }
@font-face { font-family: Y; src: url(y.woff2); }
.btn { @apply px-2 py-1; }
@import "x.css";`;
    const scan = scanCss(css, "css");
    const faces = scan.atRules.filter((a) => a.name === "font-face");
    expect(faces).toHaveLength(2);
    expect(faces[0]?.declarations.map((d) => d.property)).toEqual([
      "font-family",
      "src",
      "font-display",
    ]);
    expect(faces[1]?.declarations.map((d) => d.property)).toEqual(["font-family", "src"]);
    expect(scan.atRules.filter((a) => a.name === "apply")).toMatchObject([
      { prelude: "px-2 py-1", hasBlock: false },
    ]);
    expect(scan.atRules.find((a) => a.name === "import")?.hasBlock).toBe(false);
  });

  it("handles custom properties with braces and var() references", () => {
    const css = `:root { --a: { b: c }; --brand: #2563eb; --pad: 4px; }
.x { color: var(--brand); margin: var(--pad, 8px) var(--missing); }`;
    const scan = scanCss(css, "css");
    expect(scan.customProperties.map((c) => c.name)).toEqual(["--a", "--brand", "--pad"]);
    expect(scan.customProperties[0]?.value).toBe("{ b: c }");
    expect(scan.varRefs.map((r) => [r.name, r.hasFallback])).toEqual([
      ["--brand", false],
      ["--pad", true],
      ["--missing", false],
    ]);
  });

  it("resolves nested selectors with & for scss and supports // comments", () => {
    const scss = `$gap: 4px; // a: b;
.card { color: red; // trailing
  .title { margin: $gap; }
  &:hover, &.on { opacity: .5; }
}`;
    const scan = scanCss(scss, "scss");
    const selectors = scan.rules.map((r) => r.selectors);
    expect(selectors).toEqual([[".card"], [".card .title"], [".card:hover", ".card.on"]]);
    expect(scan.declarations.map((d) => d.property)).toEqual([
      "$gap",
      "color",
      "margin",
      "opacity",
    ]);
    expect(scan.declarations[0]?.value).toBe("4px");
  });

  it("does not treat // as a comment in plain css or inside urls", () => {
    expect(props(".a { background: url(http://x/y.png); }", "css")).toEqual([
      "background:url(http://x/y.png)",
    ]);
    expect(props(".a { background: url(//cdn/y.png); }", "scss")).toEqual([
      "background:url(//cdn/y.png)",
    ]);
  });

  it("treats scss interpolation as opaque", () => {
    const scan = scanCss(".a-#{$n} { width: #{$w}px; }", "scss");
    expect(scan.rules[0]?.selectors).toEqual([".a-#{$n}"]);
    expect(scan.declarations[0]).toMatchObject({ property: "width", value: "#{$w}px" });
  });

  it("scans keyframes selectors and tailwind v4 @theme blocks", () => {
    const css = `@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
@theme { --color-brand: #123456; --spacing-4: 1rem; }`;
    const scan = scanCss(css, "css");
    expect(scan.rules.map((r) => r.selectors[0])).toEqual(["from", "to"]);
    expect(scan.customProperties.map((c) => c.name)).toEqual(["--color-brand", "--spacing-4"]);
    expect(scan.customProperties[0]?.atRules).toEqual([{ name: "theme", prelude: "" }]);
  });

  it("reports unterminated constructs without throwing", () => {
    expect(scanCss(".a { color: red", "css").errors.length).toBeGreaterThan(0);
    expect(scanCss("/* open", "css").errors.length).toBeGreaterThan(0);
    expect(scanCss('.a { content: "x', "css").errors.length).toBeGreaterThan(0);
    expect(scanCss("}}}", "css").errors.length).toBeGreaterThan(0);
  });

  it("scans less variables and mixin calls without crashing", () => {
    const less = `@c: #fff;\n.mixin(@a) { color: @a; }\n.b { .mixin(red); background: @c; }`;
    const scan = scanCss(less, "less");
    expect(scan.declarations.map((d) => d.property)).toContain("background");
  });
});

describe("template scanner", () => {
  it("reads tags, attributes with every quoting style and positions", () => {
    const scan = scanTemplate(
      `<div class="a" id='b' hidden data-x=raw>\n  <img src="x.png" alt=""/>\n</div>`,
      "html",
    );
    const [div, img] = scan.elements;
    expect(div).toMatchObject({ tag: "div", parent: -1, line: 1, column: 1 });
    expect(div?.attrs.map((a) => [a.name, a.value, a.hasValue])).toEqual([
      ["class", "a", true],
      ["id", "b", true],
      ["hidden", undefined, false],
      ["data-x", "raw", true],
    ]);
    expect(img).toMatchObject({ tag: "img", selfClosing: true, parent: 0, line: 2, column: 3 });
    expect(img?.attrs.find((a) => a.name === "alt")?.value).toBe("");
    expect(scan.errors).toEqual([]);
  });

  it("treats void elements as childless and builds the parent chain", () => {
    const scan = scanTemplate("<ul><li>a<br>b</li><li><input type=text></li></ul>", "html");
    expect(scan.elements.map((e) => [e.tag, e.parent])).toEqual([
      ["ul", -1],
      ["li", 0],
      ["br", 1],
      ["li", 0],
      ["input", 3],
    ]);
    expect(scan.elements[1]?.hasText).toBe(true);
    expect(scan.elements[3]?.hasText).toBe(false);
  });

  it("does not parse raw text elements or comments as markup", () => {
    const scan = scanTemplate(
      `<!-- <b>no</b> --><script>if (a < b) { x = "<i>" }</script><style>a > b { }</style><p>ok</p>`,
      "html",
    );
    expect(scan.elements.map((e) => e.tag)).toEqual(["script", "style", "p"]);
    expect(scan.comments).toHaveLength(1);
  });

  it("keeps comment-like and tag-like text inside attribute values", () => {
    const scan = scanTemplate(`<a title="<!-- x -->" data-tpl="<b>">t</a>`, "html");
    expect(scan.elements.map((e) => e.tag)).toEqual(["a"]);
    expect(scan.comments).toHaveLength(0);
    expect(scan.elements[0]?.attrs.map((a) => a.value)).toEqual(["<!-- x -->", "<b>"]);
  });

  it("reads vue directives, shorthands and dynamic arguments", () => {
    const scan = scanTemplate(
      `<MyList v-for="item in items" :key="item.id" @click.prevent="go(item)" v-bind:[prop]="v" #default="{ a }" v-html="raw" />`,
      "vue-sfc",
    );
    expect(scan.elements[0]?.attrs.map((a) => a.name)).toEqual([
      "v-for",
      ":key",
      "@click.prevent",
      "v-bind:[prop]",
      "#default",
      "v-html",
    ]);
    expect(scan.elements[0]?.attrs[0]?.value).toBe("item in items");
    expect(scan.elements[0]?.attrs[1]).toMatchObject({ dynamic: true });
    expect(scan.elements[0]?.selfClosing).toBe(true);
  });

  it("keeps > inside quoted attribute values", () => {
    expect(tags(`<div :a="x > 1 ? 'a' : 'b'"><span>t</span></div>`, "vue-sfc")).toEqual([
      "div",
      "span",
    ]);
  });

  it("reads svelte attributes, blocks and expressions", () => {
    const scan = scanTemplate(
      `<button on:click|once={() => count < 3 && go()} class:active={on} {...rest} {disabled}>\n{#each items as item (item.id)}\n<li>{item.name}</li>\n{:else}\n<p>none</p>\n{/each}\n{@html raw}\n</button>`,
      "svelte",
    );
    expect(scan.elements.map((e) => e.tag)).toEqual(["button", "li", "p"]);
    expect(scan.elements[0]?.attrs.map((a) => a.name)).toEqual([
      "on:click|once",
      "class:active",
      "{...rest}",
      "{disabled}",
    ]);
    expect(scan.elements[0]?.attrs[0]?.value).toBe("() => count < 3 && go()");
    expect(scan.blocks.map((b) => b.kind)).toEqual(["#each", ":else", "/each", "@html"]);
    expect(scan.blocks.find((b) => b.kind === "@html")).toMatchObject({ line: 7 });
    expect(scan.elements[1]?.hasText).toBe(true);
  });

  it("reads angular bindings, interpolation and control flow", () => {
    const scan = scanTemplate(
      `<input [(ngModel)]="name" (keyup.enter)="go()" [innerHTML]="html" *ngIf="a < b">\n<p>{{ a < b ? 'x' : 'y' }}</p>\n@if (user) {\n  <span>hi</span>\n} @else {\n  <i>no</i>\n}\n`,
      "angular",
    );
    expect(scan.elements.map((e) => e.tag)).toEqual(["input", "p", "span", "i"]);
    expect(scan.elements[0]?.attrs.map((a) => a.name)).toEqual([
      "[(ngModel)]",
      "(keyup.enter)",
      "[innerHTML]",
      "*ngIf",
    ]);
    expect(scan.blocks.map((b) => b.kind)).toEqual(["@if", "@else"]);
    expect(scan.elements[1]?.hasText).toBe(true);
  });

  it("does not mistake an email address for angular control flow", () => {
    expect(scanTemplate("<p>mail me@if.example now</p>", "angular").blocks).toEqual([]);
  });

  it("scans astro markup and ignores expression contents", () => {
    const scan = scanTemplate(
      `<ul>{items.map((i) => <li>{i}</li>)}</ul><Layout title="x" />`,
      "astro",
    );
    expect(scan.elements.map((e) => e.tag)).toEqual(["ul", "Layout"]);
  });

  it("recovers from unclosed and stray tags without throwing", () => {
    const scan = scanTemplate("<div><span></div></p><b", "html");
    expect(scan.elements.map((e) => e.tag)).toEqual(["div", "span"]);
    expect(scan.errors.length).toBeGreaterThan(0);
  });
});

describe("single-file component extraction", () => {
  const vue = `<template>\n  <div><template v-if="a"><b>x</b></template></div>\n</template>\n<script setup lang="ts">\nimport { ref } from "vue";\nconst n = ref(0);\n</script>\n<style scoped lang="scss">\n.a { color: red }\n</style>\n`;

  it("finds vue blocks with attributes and content positions", () => {
    const { blocks, errors } = extractSfc(vue, "vue");
    expect(errors).toEqual([]);
    expect(blocks.map((b) => b.kind)).toEqual(["template", "script", "style"]);
    const script = blocks.find((b) => b.kind === "script");
    expect(script).toMatchObject({ lang: "ts", startLine: 4 });
    expect(script?.attrs.setup).toBe(true);
    expect(script?.content.trim().startsWith("import { ref }")).toBe(true);
    expect(blocks.find((b) => b.kind === "style")).toMatchObject({ lang: "scss", startLine: 8 });
    expect(blocks.find((b) => b.kind === "template")?.content).toContain('<template v-if="a">');
  });

  it("masks everything but chosen blocks so positions are preserved", () => {
    const { blocks } = extractSfc(vue, "vue");
    const script = blocks.find((b) => b.kind === "script");
    const masked = maskedSource(vue, script ? [script] : []);
    expect(masked.length).toBe(vue.length);
    expect(masked.split("\n")).toHaveLength(vue.split("\n").length);
    expect(masked.split("\n")[4]).toBe('import { ref } from "vue";');
    expect(masked).not.toContain("<template>");
    const template = blocks.find((b) => b.kind === "template");
    const templateMasked = maskedSource(vue, template ? [template] : []);
    expect(templateMasked.split("\n")[1]).toContain("<div>");
    expect(templateMasked).not.toContain("import");
  });

  it("finds svelte instance and module scripts and styles", () => {
    const svelte = `<script context="module">export const a = 1;</script>\n<script lang="ts">export let name: string;</script>\n<h1>{name}</h1>\n<style>h1 { color: red }</style>`;
    const { blocks } = extractSfc(svelte, "svelte");
    expect(blocks.map((b) => [b.kind, b.attrs.context ?? b.lang ?? ""])).toEqual([
      ["script", "module"],
      ["script", "ts"],
      ["style", ""],
    ]);
  });

  it("reads astro frontmatter as a script block", () => {
    const astro = `---\nimport A from "./A.astro";\nconst x = 1;\n---\n<A title={x} />\n<style>a { color: red }</style>`;
    const { blocks } = extractSfc(astro, "astro");
    expect(blocks.map((b) => b.kind)).toEqual(["frontmatter", "style"]);
    expect(blocks[0]?.content).toContain("const x = 1;");
    expect(blocks[0]?.startLine).toBe(2);
  });

  it("reports an unclosed block instead of throwing", () => {
    expect(extractSfc("<script>let a = 1;", "vue").errors.length).toBeGreaterThan(0);
  });
});

describe("tsconfig reading", () => {
  it("reads comments and trailing commas as the import resolver does", () => {
    expect(
      parseJsonc('{ // c\n "compilerOptions": { "paths": { "@/*": ["src/*",], }, }, }'),
    ).toEqual({
      compilerOptions: { paths: { "@/*": ["src/*"] } },
    });
  });
});
