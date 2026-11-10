import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain browser module without declarations.
import { copyText, writeClipboard } from "../web/copy.js";

function fakeDocument(execResult: boolean | "throw", withClipboardData = true) {
  const listeners: Array<(event: unknown) => void> = [];
  const set: Record<string, string> = {};
  const doc = {
    body: { append() {} },
    createElement: () => ({
      value: "",
      style: {},
      setAttribute() {},
      select() {},
      remove() {},
    }),
    addEventListener: (_type: string, fn: (event: unknown) => void) => listeners.push(fn),
    removeEventListener() {},
    execCommand() {
      if (execResult === "throw") throw new Error("no");
      for (const fn of listeners)
        fn({
          clipboardData: withClipboardData
            ? { setData: (k: string, v: string) => (set[k] = v) }
            : null,
          preventDefault() {},
        });
      return execResult;
    },
  };
  return { doc, set };
}

describe("copy controls (EVL-APP-AC-23)", () => {
  it("copies plain text: a title line and the non-empty lines", () => {
    expect(copyText({ title: "Fracciones", lines: ["Calcula {expr}", "", "Halla {expr}"] })).toBe(
      "Fracciones\nCalcula {expr}\nHalla {expr}",
    );
    expect(copyText({ lines: ["a"] })).toBe("a");
  });

  it("falls back from the Clipboard API to execCommand, then to manual copy", async () => {
    const written: string[] = [];
    const ok = await writeClipboard("hola", {
      navigator: { clipboard: { writeText: async (text: string) => written.push(text) } },
    });
    expect(ok).toBe("clipboard");
    expect(written).toEqual(["hola"]);

    const denied = fakeDocument(true);
    const viaExec = await writeClipboard("hola", {
      navigator: {
        clipboard: {
          writeText: async () => {
            throw new Error("denied");
          },
        },
      },
      document: denied.doc,
    });
    expect(viaExec).toBe("execCommand");
    expect(denied.set["text/plain"]).toBe("hola");

    expect(await writeClipboard("hola", { navigator: {}, document: fakeDocument(false).doc })).toBe(
      "manual",
    );
    expect(
      await writeClipboard("hola", { navigator: {}, document: fakeDocument("throw").doc }),
    ).toBe("manual");
  });
});
