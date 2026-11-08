import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIPlugin, OpenAIProvider } from "../src/index.js";
import { fakeHandle, registration, registrations } from "./helpers.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("ChatGPT registration", () => {
  it("PO-AC-01: registers openai unchanged plus a separate chatgpt provider", () => {
    const all = registrations(createOpenAIPlugin());
    expect(all.map((r) => r.id)).toEqual(["openai", "chatgpt"]);
    const openai = registration(createOpenAIPlugin(), "openai");
    expect(openai.fields).toEqual([
      expect.objectContaining({ key: "apiKey", kind: "secret", required: true }),
    ]);
    expect(openai.auth).toBeUndefined();
  });

  it("PO-AC-02: chatgpt is sign-in only with one official browser method", () => {
    const chatgpt = registration(createOpenAIPlugin(), "chatgpt");
    expect(chatgpt.name).toBe("ChatGPT Plus/Pro");
    expect(chatgpt.fields).toEqual([]);
    expect(chatgpt.auth).toHaveLength(1);
    const method = chatgpt.auth?.[0];
    expect(method).toMatchObject({ id: "browser", kind: "oauth", label: "Continue with ChatGPT" });
    expect(method?.description).toMatch(/ChatGPT plan/);
    expect(method).not.toHaveProperty("unofficial");
    expect(typeof method?.start).toBe("function");
    expect(typeof method?.refresh).toBe("function");
  });

  it("PO-AC-02: the README states preview, eligibility and plan billing", () => {
    const readme = readFileSync(`${packageDir}/README.md`, "utf8");
    expect(readme).toMatch(/preview/i);
    expect(readme).toMatch(/open-source/i);
    expect(readme).toMatch(/locally hosted/i);
    expect(readme).toMatch(/ChatGPT plan/);
    expect(readme).not.toMatch(/intentionally unsupported/);
  });

  it("PO-AC-02: repository sweep finds no borrowed client or private backend", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
      .split("\0")
      .filter((f) => f && !f.endsWith("pnpm-lock.yaml") && !f.endsWith(".svg"));
    // Patterns are assembled at runtime so this file does not match itself.
    const forbidden = [
      ["chatgpt.com", "/backend-api"].join(""),
      ["device", "auth"].join(""),
      ["origin", "ator"].join(""),
      ["OpenAI", "-Beta"].join(""),
    ].map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    const codexClient = new RegExp(["\\bapp_", "[A-Za-z0-9]{20,}\\b"].join(""));
    const siwcHost = ["auth", ".openai.com"].join("");
    const hits: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(`${repoRoot}/${file}`, "utf8");
      } catch {
        continue;
      }
      for (const re of [...forbidden, codexClient]) if (re.test(text)) hits.push(`${file}: ${re}`);
      if (text.includes(siwcHost) && !file.startsWith("packages/plugin-openai/"))
        hits.push(`${file}: SIWC endpoint outside plugin-openai`);
    }
    expect(hits).toEqual([]);
  });

  it("PO-AC-10: chatgpt create() without request.oauth fails clearly on an older core", () => {
    const chatgpt = registration(createOpenAIPlugin(), "chatgpt");
    expect(() => chatgpt.create({ profile: {}, credentials: {} } as never)).toThrow(
      "ChatGPT sign-in requires Alisio >= 0.11",
    );
    const openai = registration(createOpenAIPlugin(), "openai");
    expect(
      openai.create({ profile: {}, credentials: { apiKey: "private-key" } } as never),
    ).toBeInstanceOf(OpenAIProvider);
  });

  it("PO-AC-18: openai keeps using its key with or without request.oauth", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const openai = registration(createOpenAIPlugin(), "openai");
    const { handle, calls } = fakeHandle(["tok"]);
    const p = openai.create({
      profile: {},
      credentials: { apiKey: "private-key" },
      oauth: handle,
    } as never);
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(calls.get).toBe(0);
    expect(() => openai.create({ profile: {}, credentials: {}, oauth: handle } as never)).toThrow(
      /API key is required/,
    );
    vi.unstubAllEnvs();
  });

  it("PO-AC-18: chatgpt never falls back to OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-key-value");
    const chatgpt = registration(createOpenAIPlugin(), "chatgpt");
    const { handle, calls } = fakeHandle(["tok"]);
    const p = await chatgpt.create({ profile: { model: "m" }, credentials: {}, oauth: handle });
    expect(p.id).toBe("chatgpt");
    expect(calls.get).toBe(0);
    vi.unstubAllEnvs();
  });
});
