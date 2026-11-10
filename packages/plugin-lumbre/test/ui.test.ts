import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../src/errors.js";
// @ts-expect-error -- plain browser modules without declarations.
import { copyPayload } from "../web/copy.js";
// @ts-expect-error -- plain browser module without declarations.
import * as derive from "../web/derive.js";
// @ts-expect-error -- plain browser module without declarations.
import { hunks, lineDiff, stats } from "../web/diff.js";
// @ts-expect-error -- plain browser module without declarations.
import { messages } from "../web/i18n.js";
// @ts-expect-error -- plain browser module without declarations.
import { escapeHtml, renderMarkdown } from "../web/markdown.js";
// @ts-expect-error -- plain browser module without declarations.
import { renderThumbnail, sanitizeHtml, scopeCss, scopeSelector } from "../web/thumbnail.js";

type Op = { type: "same" | "add" | "del"; text: string; a?: number; b?: number };

describe("line diff", () => {
  const rebuild = (ops: Op[]) => ({
    before: ops.filter((o) => o.type !== "add").map((o) => o.text),
    after: ops.filter((o) => o.type !== "del").map((o) => o.text),
  });
  it("reconstructs both sides and finds a minimal edit", () => {
    const before = "a\nb\nc\nd\ne";
    const after = "a\nB\nc\nd\ne\nf";
    const ops = lineDiff(before, after) as Op[];
    expect(rebuild(ops)).toEqual({ before: before.split("\n"), after: after.split("\n") });
    expect(stats(ops)).toEqual({ added: 2, removed: 1 });
    expect(ops.find((o) => o.type === "add" && o.text === "f")?.b).toBe(6);
  });
  it("handles new, emptied and random files", () => {
    expect(lineDiff(null, "x\ny")).toEqual([
      { type: "add", text: "x", b: 1 },
      { type: "add", text: "y", b: 2 },
    ]);
    expect(stats(lineDiff("x\ny", ""))).toEqual({ added: 0, removed: 2 });
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed % 4;
    };
    for (let n = 0; n < 40; n++) {
      const a = Array.from({ length: 1 + (n % 9) }, () => String(rand()));
      const b = Array.from({ length: 1 + ((n * 3) % 11) }, () => String(rand()));
      const ops = lineDiff(a.join("\n"), b.join("\n")) as Op[];
      expect(rebuild(ops)).toEqual({ before: a, after: b });
    }
    expect(lineDiff("x\n".repeat(4000), "y\n".repeat(4000))).toBeNull();
  });
  it("groups changes into hunks with context", () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l2\n", "L2\n").replace("l25", "L25");
    const groups = hunks(lineDiff(before, after), 2) as Op[][];
    expect(groups.length).toBe(2);
    expect(groups[0]?.map((o) => o.text)).toEqual(["l0", "l1", "l2", "L2", "l3", "l4"]);
  });
});

describe("feedback helpers (LMB-AC-14)", () => {
  it("names the missing permission from the host effect, falling back to the action's", () => {
    expect(derive.responseError({ error: "not_permitted", effect: "process" }, "write")).toBe(
      "not_permitted_process",
    );
    expect(derive.responseError({ error: "not_permitted" }, "process")).toBe(
      "not_permitted_process",
    );
    expect(derive.responseError({ result: { error: "conflict" } }, "write")).toBe("conflict");
    expect(derive.responseError({ result: { value: 1 } }, "read")).toBeNull();
  });
  it("shows progress, elapsed time and a slow hint", () => {
    expect(derive.formatElapsed(65_000)).toBe("1:05");
    expect(derive.formatElapsed(3_723_000)).toBe("1:02:03");
    const view = derive.jobView(
      {
        state: "running",
        progress: 0.5,
        elapsedMs: 25_000,
        stage: { key: "writing" },
        steps: [{ key: "thinking" }, { key: "writing" }],
      },
      10_000,
      9_000,
    );
    expect(view).toMatchObject({ running: true, percent: 50, elapsed: "0:26", slow: true });
    expect(view.steps).toEqual([{ key: "thinking" }]);
    expect(derive.jobView({ state: "failed", error: "build_failed" }).error).toBe("build_failed");
    expect(derive.jobView({ state: "running", progress: null }).percent).toBeNull();
  });
  it("builds the apply input from the ticked review items", () => {
    const proposal = {
      id: "p",
      projectId: "x",
      files: { "a.html": "1", "b.css": "2" },
      deletes: ["old.js"],
      dependencies: { zod: "4.6.7" },
      before: { "a.html": "0", "b.css": null, "old.js": "x" },
    };
    expect(derive.proposalEntries(proposal)).toEqual([
      { path: "a.html", status: "changed" },
      { path: "b.css", status: "added" },
      { path: "old.js", status: "deleted" },
    ]);
    const all = derive.allItems(proposal);
    all.delete("file:b.css");
    expect(derive.applyInput(proposal, all)).toEqual({
      projectId: "x",
      proposalId: "p",
      files: ["a.html"],
      deletes: ["old.js"],
      dependencies: ["zod"],
    });
  });
});

describe("markdown and copy (LMB-AC-15)", () => {
  it("escapes model text before formatting", () => {
    const html = renderMarkdown(
      "Hi <script>alert(1)</script> **bold** `x<y`\n\n- one\n- two\n\n```\n<b>\n```",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>x&lt;y</code>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<pre><code>&lt;b&gt;</code></pre>");
    expect(renderMarkdown("[site](javascript:alert(1))")).not.toMatch(/<a\b/);
    expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;");
  });
  it("copies the Markdown source as text, and styled HTML with formatting", () => {
    expect(copyPayload("**x**", renderMarkdown, false)).toEqual({ text: "**x**" });
    const rich = copyPayload("| a |\n|---|\n| b |", renderMarkdown, true);
    expect(rich.html).toContain('<table style="border-collapse:collapse">');
  });
});

describe("static thumbnail (LMB-AC-13)", () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const parser = new window.DOMParser();

  it("drops scripts, handlers, embeds and external URLs; keeps inline images and mapped SVGs", () => {
    const { doc, styles, bodyClass } = sanitizeHtml(
      `<html class="dark"><head><style>h1{color:red}</style><link rel="stylesheet" href="https://x.test/a.css"></head>
       <body class="page"><script>alert(1)</script><h1 onclick="alert(1)" style="color:blue">Hi</h1>
       <iframe src="https://x.test"></iframe><img src="https://x.test/t.png"><img src="logo.svg"><img src="data:image/png;base64,AA==">
       <a href="javascript:alert(1)">x</a><a href="#top">top</a><form action="https://x.test"><input autofocus></form>
       <object data="x"></object><svg><use href="https://x.test/s.svg#a"></use></svg></body></html>`,
      { "logo.svg": "data:image/svg+xml;base64,PHN2Zy8+" },
      parser,
    );
    const html = doc.body.innerHTML;
    expect(styles).toEqual(["h1{color:red}"]);
    expect(bodyClass).toBe("page");
    expect(html).not.toMatch(
      /<script|<iframe|<object|<form|onclick|javascript:|https?:|autofocus/i,
    );
    expect(html).toContain('style="color:blue"');
    expect(html).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"');
    expect(html).toContain('src="data:image/png;base64,AA=="');
    expect(html).toContain('href="#top"');
  });

  it("scopes document selectors to wrappers inside the shadow root and neutralizes imports and URLs", () => {
    expect(scopeSelector("html, body > main, :root, :host, .html-note, tbody")).toBe(
      ".lmb-root, .lmb-body > main, .lmb-root, .lmb-root, .html-note, tbody",
    );
    const css = scopeCss(
      '@import url("https://x.test/a.css");@charset "utf-8";/* c */ body{margin:0;background:url(https://x.test/bg.png)} @media (min-width:600px){html body h1{font-size:4rem}} @layer base{:root,:host{--c:red}} @keyframes spin{to{transform:rotate(1turn)}} .icon{background:url("data:image/svg+xml;base64,AA")} a::after{content:"}"}',
    );
    expect(css).not.toMatch(/@import|@charset|https?:/);
    expect(css).toContain(".lmb-body{margin:0;background:none}");
    expect(css).toContain("@media (min-width:600px){.lmb-root .lmb-body h1{font-size:4rem}}");
    expect(css).toContain("@layer base{.lmb-root,.lmb-root{--c:red}}");
    expect(css).toContain("@keyframes spin{to{transform:rotate(1turn)}}");
    expect(css).toContain('url("data:image/svg+xml;base64,AA")');
    expect(css).toContain('a::after{content:"}"}');
  });

  it("draws into an inert, contained shadow root and never adds scripts", async () => {
    const host = window.document.createElement("div");
    window.document.body.append(host);
    const drawn = renderThumbnail(
      host,
      {
        kind: "static",
        html: '<body><div style="position:fixed;inset:0;z-index:99999">overlay</div><script>x()</script><h1>Bakery</h1></body>',
        css: ["div{position:fixed!important;z-index:2147483647}"],
        assets: {},
      },
      window.document,
    );
    expect(drawn).toBe(true);
    const shadow = host.shadowRoot as ShadowRoot;
    expect(shadow.querySelector("script")).toBeNull();
    const viewport = shadow.querySelector(".lmb-viewport") as HTMLElement;
    expect(viewport.hasAttribute("inert")).toBe(true);
    expect(viewport.getAttribute("aria-hidden")).toBe("true");
    expect(shadow.querySelector(".lmb-body h1")?.textContent).toBe("Bakery");
    const style = shadow.querySelector("style")?.textContent ?? "";
    expect(style).toMatch(/\.lmb-viewport\{[^}]*overflow:hidden[^}]*contain:strict/);
    // The host carries layout and paint containment in Lumbre's own stylesheet.
    const own = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
    expect(own).toMatch(
      /\.thumb-canvas \{[^}]*overflow: hidden;[^}]*contain: strict;[^}]*isolation: isolate;/,
    );
    expect(renderThumbnail(host, { kind: "none", html: "" }, window.document)).toBe(false);
  });
});

describe("frame strings (LMB-AC-14)", () => {
  const shape = (value: unknown): unknown =>
    typeof value === "function"
      ? "fn"
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .map(([k, v]) => [k, shape(v)])
              .sort(),
          )
        : typeof value;
  it("has the same keys in English and Spanish", () => {
    expect(shape(messages.es)).toEqual(shape(messages.en));
  });
  it("explains every error code and every job stage in both languages", async () => {
    for (const lang of ["en", "es"] as const) {
      for (const code of ERROR_CODES)
        expect(messages[lang].errors[code], `${lang}:${code}`).toBeTruthy();
      for (const code of ["not_permitted_write", "not_permitted_process", "timeout", "network"])
        expect(messages[lang].errors[code], `${lang}:${code}`).toBeTruthy();
    }
    const service = await readFile(new URL("../src/service.ts", import.meta.url), "utf8");
    const stages = new Set(
      [...service.matchAll(/this\.stage\(\s*job,\s*"([a-zA-Z]+)"/g)].map((m) => m[1] as string),
    );
    for (const extra of [
      "thinking",
      "thinkingChanges",
      "fixing",
      "writing",
      "removing",
      "preparing",
    ])
      stages.add(extra);
    for (const stage of stages) {
      expect(messages.en.stage[stage], stage).toBeTruthy();
      expect(messages.es.stage[stage], stage).toBeTruthy();
    }
    expect(messages.en.disclaimer).toBe(
      "Lumbre can make mistakes; review the code before using it.",
    );
    expect(messages.es.disclaimer).toBe(
      "Lumbre puede cometer errores; revisa el código antes de usarlo.",
    );
    expect(messages.en.awaitingApproval).toBe("Waiting for your approval in Alisio…");
    expect(messages.en.stage.continuing({ part: 2 })).toBe("Writing more files… (part 2)");
    expect(messages.es.stage.continuing({ part: 2 })).toBe("Escribiendo más archivos… (parte 2)");
    expect(messages.en.notice.output_partial(3)).toBe(
      "The model stopped before finishing. I kept the 3 files that arrived; ask it to continue or pick a model with a larger output limit.",
    );
    expect(messages.en.notice.output_partial(1)).toContain("I kept the file that arrived");
    for (const lang of ["en", "es"] as const)
      for (const reason of [
        "truncated",
        "timeout",
        "rate_limit",
        "auth",
        "context_length",
        "output_limit",
        "provider",
        "unknown",
        "invalid_output",
        "output_truncated",
      ])
        expect(messages[lang].reasons[reason], `${lang}:${reason}`).toBeTruthy();
  });
});
