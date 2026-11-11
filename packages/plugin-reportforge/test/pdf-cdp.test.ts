import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chromeArgs, isAllowedRequest, PdfError, printPdf } from "../src/pdf/cdp.js";

type Message = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
type Handler = (m: Message, child: FakeChild) => unknown;

const PDF = Buffer.from("%PDF-1.7\n%fake\n");

/** A fake Chromium on `--remote-debugging-pipe`: fd 3 carries commands in, fd 4 answers out. */
class FakeChild extends EventEmitter {
  readonly commands = new PassThrough();
  readonly replies = new PassThrough();
  readonly stdio = [null, null, new PassThrough(), this.commands, this.replies];
  readonly stderr = this.stdio[2] as PassThrough;
  readonly sent: Message[] = [];
  killed: string[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 4242;
  constructor(
    readonly args: string[],
    handlers: Record<string, Handler>,
  ) {
    super();
    let buffer = "";
    this.commands.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let i = buffer.indexOf("\0"); i !== -1; i = buffer.indexOf("\0")) {
        const message = JSON.parse(buffer.slice(0, i)) as Message;
        buffer = buffer.slice(i + 1);
        this.sent.push(message);
        const handler = handlers[message.method] ?? DEFAULTS[message.method];
        const result = handler ? handler(message, this) : {};
        if (result === NEVER) continue;
        this.reply({ id: message.id, result });
      }
    });
  }
  reply(message: unknown): void {
    this.replies.write(`${JSON.stringify(message)}\0`);
  }
  event(method: string, params: unknown, sessionId = "S1"): void {
    this.reply({ method, params, sessionId });
  }
  kill(signal: string): boolean {
    this.killed.push(signal);
    this.signalCode = signal;
    setTimeout(() => this.emit("close", null), 0);
    return true;
  }
}

const NEVER = Symbol("never");
const DEFAULTS: Record<string, Handler> = {
  "Browser.getVersion": () => ({ product: "HeadlessChrome/140.0.0.0" }),
  "Target.createTarget": () => ({ targetId: "T1" }),
  "Target.attachToTarget": () => ({ sessionId: "S1" }),
  "Page.getFrameTree": () => ({ frameTree: { frame: { id: "F1" } } }),
  "Runtime.evaluate": () => ({ result: { value: true } }),
  "Page.printToPDF": () => ({ data: PDF.toString("base64") }),
};

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rf-cdp-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function launcher(handlers: Record<string, Handler> = {}) {
  const children: FakeChild[] = [];
  const calls: { file: string; args: string[] }[] = [];
  const spawn = (file: string, args: string[]) => {
    calls.push({ file, args });
    const child = new FakeChild(args, handlers);
    children.push(child);
    return child as never;
  };
  return { spawn, children, calls };
}
const profileOf = (child: FakeChild) =>
  child.args.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length) ?? "";

describe("CDP PDF printing", () => {
  it("prints the HTML offline with the report's CSS page size and cleans up", async () => {
    const fake = launcher();
    const pdf = await printPdf(
      { executable: "/usr/bin/chromium", html: "<!doctype html><p>Hi</p>" },
      { spawn: fake.spawn, tmpRoot: root, platform: "linux" },
    );
    expect(Buffer.from(pdf).equals(PDF)).toBe(true);
    const [child] = fake.children;
    expect(fake.calls[0]?.file).toBe("/usr/bin/chromium");
    expect(child.args).toEqual(
      expect.arrayContaining(["--headless=new", "--remote-debugging-pipe"]),
    );
    expect(child.args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
    const methods = child.sent.map((m) => m.method);
    expect(methods).toEqual(
      expect.arrayContaining([
        "Network.emulateNetworkConditions",
        "Fetch.enable",
        "Page.setDocumentContent",
      ]),
    );
    expect(methods.indexOf("Fetch.enable")).toBeLessThan(
      methods.indexOf("Page.setDocumentContent"),
    );
    const offline = child.sent.find((m) => m.method === "Network.emulateNetworkConditions");
    expect(offline?.params.offline).toBe(true);
    const content = child.sent.find((m) => m.method === "Page.setDocumentContent");
    expect(content?.params).toEqual({ frameId: "F1", html: "<!doctype html><p>Hi</p>" });
    expect(content?.sessionId).toBe("S1");
    const print = child.sent.find((m) => m.method === "Page.printToPDF");
    expect(print?.params).toMatchObject({ printBackground: true, preferCSSPageSize: true });
    expect(child.killed).toEqual(["SIGKILL"]);
    expect(existsSync(profileOf(child))).toBe(false);
    expect(profileOf(child).startsWith(root)).toBe(true);
  });

  it("blocks every page request except data: URLs", async () => {
    const fake = launcher({
      "Fetch.enable": (_m, child) => {
        child.event("Fetch.requestPaused", {
          requestId: "a",
          request: { url: "https://evil.test/x.png" },
        });
        child.event("Fetch.requestPaused", {
          requestId: "b",
          request: { url: "data:image/png;base64,AA==" },
        });
        child.event("Fetch.requestPaused", {
          requestId: "c",
          request: { url: "file:///etc/passwd" },
        });
        return {};
      },
    });
    await printPdf(
      { executable: "chrome", html: "<p>x</p>" },
      { spawn: fake.spawn, tmpRoot: root, platform: "linux" },
    );
    const child = fake.children[0];
    const failed = child.sent
      .filter((m) => m.method === "Fetch.failRequest")
      .map((m) => m.params.requestId);
    const continued = child.sent
      .filter((m) => m.method === "Fetch.continueRequest")
      .map((m) => m.params.requestId);
    expect(failed.sort()).toEqual(["a", "c"]);
    expect(continued).toEqual(["b"]);
    expect(isAllowedRequest("data:text/plain,hi")).toBe(true);
    expect(isAllowedRequest("http://127.0.0.1/")).toBe(false);
    expect(isAllowedRequest("blob:null/1")).toBe(false);
    expect(isAllowedRequest("not a url")).toBe(false);
  });

  it("rejects an answer that is not a PDF", async () => {
    const fake = launcher({
      "Page.printToPDF": () => ({ data: Buffer.from("<html>").toString("base64") }),
    });
    await expect(
      printPdf(
        { executable: "c", html: "x" },
        { spawn: fake.spawn, tmpRoot: root, platform: "linux" },
      ),
    ).rejects.toThrow("pdf_invalid");
    expect(fake.children[0].killed).toEqual(["SIGKILL"]);
  });

  it("rejects a PDF over the size limit", async () => {
    const fake = launcher();
    await expect(
      printPdf(
        { executable: "c", html: "x", maxBytes: 4 },
        { spawn: fake.spawn, tmpRoot: root, platform: "linux" },
      ),
    ).rejects.toThrow("pdf_too_large");
  });

  it("kills the browser and removes the profile when cancelled", async () => {
    const fake = launcher({ "Page.printToPDF": () => NEVER });
    const controller = new AbortController();
    const done = printPdf(
      { executable: "c", html: "x", signal: controller.signal },
      { spawn: fake.spawn, tmpRoot: root, platform: "linux" },
    );
    for (
      let i = 0;
      i < 200 && !fake.children[0]?.sent.some((m) => m.method === "Page.printToPDF");
      i++
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    controller.abort();
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PdfError);
    expect((error as Error).message).toBe("pdf_cancelled");
    const child = fake.children[0];
    expect(child.killed).toEqual(["SIGKILL"]);
    expect(existsSync(profileOf(child))).toBe(false);
  });

  it("does not launch anything when already cancelled", async () => {
    const fake = launcher();
    const controller = new AbortController();
    controller.abort();
    await expect(
      printPdf(
        { executable: "c", html: "x", signal: controller.signal },
        { spawn: fake.spawn, tmpRoot: root, platform: "linux" },
      ),
    ).rejects.toThrow("pdf_cancelled");
    expect(fake.calls).toHaveLength(0);
  });

  it("times out, then kills the browser", async () => {
    const fake = launcher({ "Browser.getVersion": () => NEVER });
    await expect(
      printPdf(
        { executable: "c", html: "x", timeoutMs: 50 },
        { spawn: fake.spawn, tmpRoot: root, platform: "linux" },
      ),
    ).rejects.toThrow("pdf_timeout");
    expect(fake.children[0].killed).toEqual(["SIGKILL"]);
  });

  it("reports a browser that cannot start or exits early", async () => {
    const failing = (_file: string, args: string[]) => {
      const child = new FakeChild(args, { "Browser.getVersion": () => NEVER });
      setTimeout(
        () => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
        0,
      );
      return child as never;
    };
    await expect(
      printPdf(
        { executable: "c", html: "x" },
        { spawn: failing, tmpRoot: root, platform: "linux" },
      ),
    ).rejects.toThrow("pdf_browser_failed");

    const exiting = (_file: string, args: string[]) => {
      const child = new FakeChild(args, { "Browser.getVersion": () => NEVER });
      setTimeout(() => {
        child.exitCode = 1;
        child.emit("close", 1);
      }, 0);
      return child as never;
    };
    await expect(
      printPdf(
        { executable: "c", html: "x" },
        { spawn: exiting, tmpRoot: root, platform: "linux" },
      ),
    ).rejects.toThrow("pdf_browser_failed");
  });

  it("re-checks a one-page fit in the printing browser before printing", async () => {
    const fake = launcher();
    await printPdf(
      { executable: "c", html: "x", fitHeight: 1031 },
      { spawn: fake.spawn, tmpRoot: root, platform: "linux" },
    );
    const sent = fake.children[0].sent;
    const methods = sent.map((m) => m.method);
    const media = sent.find((m) => m.method === "Emulation.setEmulatedMedia");
    expect(media?.params).toEqual({ media: "print" });
    const fit = sent.filter((m) => m.method === "Runtime.evaluate").at(-1);
    expect(String(fit?.params.expression)).toContain("1031");
    expect(methods.indexOf("Emulation.setEmulatedMedia")).toBeLessThan(
      methods.indexOf("Page.printToPDF"),
    );

    const plain = launcher();
    await printPdf(
      { executable: "c", html: "x" },
      { spawn: plain.spawn, tmpRoot: root, platform: "linux" },
    );
    expect(plain.children[0].sent.some((m) => m.method === "Emulation.setEmulatedMedia")).toBe(
      false,
    );
  });

  it("adds --no-sandbox only for root and never loads a URL from the command line", () => {
    expect(chromeArgs("/p", false)).not.toContain("--no-sandbox");
    expect(chromeArgs("/p", true)).toContain("--no-sandbox");
    expect(chromeArgs("/p", false).at(-1)).toBe("about:blank");
  });
});
