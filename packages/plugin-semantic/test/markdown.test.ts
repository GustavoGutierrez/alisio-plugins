import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain browser module without declarations.
import { renderMarkdown } from "../web/markdown.js";

const citations = [
  { n: 1, sourceId: "aaaaaaaaaaaa", sourceName: "recetas.md", ordinal: 0, page: null },
  { n: 2, sourceId: "bbbbbbbbbbbb", sourceName: "plan.pdf", ordinal: 3, page: 2 },
];
const dom = (html: string) =>
  new JSDOM(`<div id="r">${html}</div>`).window.document.querySelector("#r") as HTMLElement;
const render = (md: string) => dom(renderMarkdown(md, citations));

describe("safe Markdown renderer (0.1.1)", () => {
  it("renders the owner's example: list item, bold label and a citation chip", () => {
    const root = render(
      "- **Pre-entrenamiento**: mostrarle al aprendiz miles de recetas generales de todo el mundo [1].",
    );
    const li = root.querySelector("ul > li");
    expect(li?.querySelector("strong")?.textContent).toBe("Pre-entrenamiento");
    const chip = li?.querySelector("button.cite");
    expect(chip?.textContent).toBe("1");
    expect(chip?.getAttribute("data-source")).toBe("aaaaaaaaaaaa");
    expect(chip?.getAttribute("data-ordinal")).toBe("0");
    expect(root.textContent).not.toMatch(/\*\*|^- /);
  });

  it("supports paragraphs, breaks, headings, emphasis and inline code", () => {
    const root = render(
      "# Title\n## Sub\n### Small\n\nLine one\nline two with *italic*, _also_ and `a <b>`.\n\nSecond paragraph",
    );
    expect([...root.querySelectorAll("h3,h4,h5")].map((h) => h.textContent)).toEqual([
      "Title",
      "Sub",
      "Small",
    ]);
    const paragraphs = root.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.querySelector("br")).not.toBeNull();
    expect([...root.querySelectorAll("em")].map((e) => e.textContent)).toEqual(["italic", "also"]);
    expect(root.querySelector("code")?.textContent).toBe("a <b>");
  });

  it("renders fenced code without formatting or citations inside", () => {
    const root = render("```js\nconst a = **b** [1] <i>x</i>;\n```");
    expect(root.querySelector("pre code")?.textContent).toBe("const a = **b** [1] <i>x</i>;");
    expect(root.querySelector("pre button")).toBeNull();
  });

  it("renders ordered, unordered and nested lists", () => {
    const root = render(
      "1. First [2]\n2. Second\n   - nested a\n   - nested **b** [1]\n3. Third\n\n* star\n+ plus",
    );
    const ol = root.querySelector("ol");
    expect(ol?.children).toHaveLength(3);
    const nested = ol?.children[1]?.querySelector("ul");
    expect(nested?.children).toHaveLength(2);
    expect(nested?.querySelector("strong button.cite, button.cite")?.textContent).toBe("1");
    expect(ol?.children[0]?.querySelector("button.cite")?.textContent).toBe("2");
    expect(root.querySelectorAll("ul")[1]?.children).toHaveLength(2);
  });

  it("renders blockquotes, tables and horizontal rules", () => {
    const root = render(
      "> quoted **text** [1]\n> more\n\n---\n\n| Item | Value |\n| --- | ---: |\n| Flour | 2 kg [2] |\n| Salt | *1 g* |",
    );
    expect(root.querySelector("blockquote strong")?.textContent).toBe("text");
    expect(root.querySelector("blockquote button.cite")).not.toBeNull();
    expect(root.querySelector("hr")).not.toBeNull();
    const table = root.querySelector("table");
    expect([...(table?.querySelectorAll("th") ?? [])].map((th) => th.textContent)).toEqual([
      "Item",
      "Value",
    ]);
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(table?.querySelector("tbody td button.cite")?.textContent).toBe("2");
    expect(table?.querySelector("tbody em")?.textContent).toBe("1 g");
  });

  it("renders links as plain text and never injects HTML from model text", () => {
    const root = render(
      '[click](javascript:alert(1)) <img src=x onerror="alert(1)"> <script>alert(2)</script> **<b>x</b>** `</code><svg onload=1>` [3] [1"><img>]',
    );
    expect(root.querySelector("a,img,script,svg,b")).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(root.textContent).toContain("<script>alert(2)</script>");
    expect(root.textContent).toContain("click (javascript:alert(1))");
    // Unknown citation numbers stay as text; only known ones become chips.
    expect(root.querySelectorAll("button.cite")).toHaveLength(0);
    expect(root.textContent).toContain("[3]");
    const attrs = [...root.querySelectorAll("*")].flatMap((el) => el.getAttributeNames());
    expect(attrs.filter((a) => a.startsWith("on"))).toEqual([]);
  });

  it("renders several citations in one group and next to each other", () => {
    const root = render("Both [1, 2] and [1][2].");
    expect([...root.querySelectorAll("button.cite")].map((b) => b.textContent)).toEqual([
      "1",
      "2",
      "1",
      "2",
    ]);
  });
});
