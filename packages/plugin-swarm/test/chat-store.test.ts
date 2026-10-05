import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatStore, MAX_CHAT_HISTORY } from "../src/app/chat-store.js";
import { tempDir } from "./helpers.js";

const message = (text: string, from: "operator" | "lieutenant" = "operator") => ({
  from,
  text,
  at: "2026-01-02T03:04:05.000Z",
});

describe("ChatStore", () => {
  it("starts empty and persists appended messages across instances", async () => {
    const dir = await tempDir();
    const store = new ChatStore(dir);
    expect(await store.read()).toEqual([]);
    await store.append(message("hi"), message("hello", "lieutenant"));
    expect((await new ChatStore(dir).read()).map((entry) => entry.text)).toEqual(["hi", "hello"]);
  });

  it("keeps only the newest messages within the bound", async () => {
    const store = new ChatStore(await tempDir());
    for (let index = 0; index < MAX_CHAT_HISTORY + 10; index += 1) {
      await store.append(message(`m${index}`));
    }
    const history = await store.read();
    expect(history).toHaveLength(MAX_CHAT_HISTORY);
    expect(history.at(-1)?.text).toBe(`m${MAX_CHAT_HISTORY + 9}`);
    expect(history[0]?.text).toBe("m10");
  });

  it("truncates oversized text and writes a private schema-versioned file", async () => {
    const dir = await tempDir();
    await new ChatStore(dir).append(message("x".repeat(20000)));
    const raw = JSON.parse(await readFile(join(dir, ".alisio", "swarm", "chat.json"), "utf8"));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.messages[0].text.length).toBeLessThanOrEqual(8000);
  });

  it("treats a corrupt or foreign file as an empty history instead of failing", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".alisio", "swarm"), { recursive: true });
    const file = join(dir, ".alisio", "swarm", "chat.json");
    await writeFile(file, "{not json");
    expect(await new ChatStore(dir).read()).toEqual([]);
    await writeFile(file, JSON.stringify({ schemaVersion: 2, messages: [message("x")] }));
    expect(await new ChatStore(dir).read()).toEqual([]);
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, messages: [message("ok"), { from: "root", text: 1 }] }),
    );
    expect((await new ChatStore(dir).read()).map((entry) => entry.text)).toEqual(["ok"]);
  });
});
