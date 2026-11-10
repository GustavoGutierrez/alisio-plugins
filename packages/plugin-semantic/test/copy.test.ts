import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error -- plain browser module without declarations.
import { copyHtml, copyText, writeClipboard } from "../web/copy.js";
// @ts-expect-error -- plain browser module without declarations.
import { renderMarkdown } from "../web/markdown.js";

const citations = [
  { n: 1, sourceId: "aaaaaaaaaaaa", sourceName: "recetas.md", ordinal: 0, page: null },
];
const answer =
  "## Pasos\n\n- **Pre-entrenamiento**: miles de recetas [1].\n\n| A | B |\n| --- | --- |\n| x | `y` |\n\n```\ncode <b>\n```\n<script>alert(1)</script>";

describe("copy answers (O14)", () => {
  it("copies the Markdown source as plain text, citations as [n]", () => {
    expect(copyText(answer)).toBe(answer);
    expect(copyText(answer)).toContain("[1]");
  });

  it("copies formatted HTML with the expected tags and no buttons, scripts or handlers", () => {
    const html: string = copyHtml(answer, citations, renderMarkdown);
    const root = new JSDOM(html).window.document.body;
    expect(root.querySelector("h4")?.textContent).toBe("Pasos");
    expect(root.querySelector("li strong")?.textContent).toBe("Pre-entrenamiento");
    expect(root.querySelector("li")?.textContent).toContain("[1]");
    expect(root.querySelector("table td code")?.textContent).toBe("y");
    expect(root.querySelector("pre code")?.textContent).toBe("code <b>");
    expect(root.querySelector("button,script,a,img")).toBeNull();
    expect(
      [...root.querySelectorAll("*")]
        .flatMap((e) => e.getAttributeNames())
        .filter((a) => a.startsWith("on") || a === "class"),
    ).toEqual([]);
    expect(root.textContent).toContain("<script>alert(1)</script>");
  });

  it("uses the Clipboard API when it works", async () => {
    const write = vi.fn(async () => {});
    class ClipboardItem {
      constructor(readonly items: unknown) {}
    }
    const env = {
      navigator: { clipboard: { write, writeText: vi.fn() } },
      ClipboardItem,
      Blob,
      document: new JSDOM("").window.document,
    };
    expect(await writeClipboard({ text: "a", html: "<p>a</p>" }, env)).toBe("clipboard");
    expect(write).toHaveBeenCalledOnce();
  });

  it("falls back to execCommand when the Clipboard API throws, and to manual when both fail", async () => {
    const { window } = new JSDOM("<body></body>");
    const doc = window.document;
    const seen: Record<string, string> = {};
    (doc as unknown as { execCommand: (c: string) => boolean }).execCommand = () => {
      const data = { setData: (type: string, value: string) => (seen[type] = value) };
      const event = new window.Event("copy", { cancelable: true }) as Event & {
        clipboardData?: unknown;
      };
      Object.defineProperty(event, "clipboardData", { value: data });
      doc.dispatchEvent(event);
      return true;
    };
    const denied = {
      clipboard: {
        write: async () => Promise.reject(new Error("NotAllowedError")),
        writeText: async () => Promise.reject(new Error("NotAllowedError")),
      },
    };
    const env = { navigator: denied, ClipboardItem: class {}, Blob, document: doc };
    expect(await writeClipboard({ text: "plain", html: "<b>rich</b>" }, env)).toBe("execCommand");
    expect(seen).toEqual({ "text/plain": "plain", "text/html": "<b>rich</b>" });
    expect(await writeClipboard({ text: "plain" }, env)).toBe("execCommand");
    expect(doc.querySelector("textarea")).toBeNull();
    (doc as unknown as { execCommand: () => boolean }).execCommand = () => false;
    expect(await writeClipboard({ text: "plain", html: "<b>x</b>" }, env)).toBe("manual");
  });
});

describe("one copy component for every generated block (O14)", () => {
  // @ts-expect-error -- plain browser module without declarations.
  const load = () => import("../web/copy.js");
  const state = {
    chat: [
      { role: "user", text: "q" },
      { role: "assistant", text: "**A** [1]", citations },
    ],
    guide: { summary: "Overview [1].", citations, questions: ["When?", "Who?"] },
    summary: { summary: "- point [1]", citations },
    passage: { sourceName: "plan.pdf", page: 3, pageKind: "page", text: "Line <1>\nLine 2" },
    place: (p: { page: number }) => `Page ${p.page}`,
  };

  it("copies answers, the guide, the questions and a source summary as Markdown and rich HTML", async () => {
    const { copySourceFor, copyPayload } = await load();
    const answer = copyPayload(copySourceFor("chat:1", state), renderMarkdown, true);
    expect(answer.text).toBe("**A** [1]");
    expect(answer.html).toContain("<strong>A</strong> [1]");
    expect(copyPayload(copySourceFor("guide", state), renderMarkdown, false)).toEqual({
      text: "Overview [1].",
    });
    const questions = copyPayload(copySourceFor("questions", state), renderMarkdown, true);
    expect(questions.text).toBe("- When?\n- Who?");
    expect(questions.html).toContain("<ul><li>When?</li><li>Who?</li></ul>");
    const summary = copyPayload(copySourceFor("summary", state), renderMarkdown, true);
    expect(summary.html).toContain("<li>point [1]</li>");
    for (const p of [answer, questions, summary])
      expect(p.html).not.toMatch(/<button|<script|\son\w+=/);
  });

  it("copies a passage verbatim with a plain reference line", async () => {
    const { copySourceFor, copyPayload } = await load();
    const passage = copyPayload(copySourceFor("passage", state), renderMarkdown, true);
    expect(passage.text).toBe("Line <1>\nLine 2\n\n— plan.pdf, Page 3");
    expect(passage.html).toContain("Line &lt;1&gt;<br>Line 2");
    expect(passage.html).toContain("— plan.pdf, Page 3");
    expect(copySourceFor("passage", { ...state, passage: undefined })).toBeUndefined();
    expect(copySourceFor("chat:0", { ...state, chat: [] })).toBeUndefined();
  });
});
