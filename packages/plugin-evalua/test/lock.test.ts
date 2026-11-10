import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { LockTimeoutError, Mutex } from "../src/lock.js";
import { readState, stateFile } from "../src/storage.js";
import { appHarness } from "./helpers/app-harness.js";
import { cleanup } from "./helpers/harness.js";

afterEach(cleanup);

describe("chat and app writers (EVL-APP-AC-04)", () => {
  it("serializes a chat tool and an app mutation, and refuses a stale revision without writing", async () => {
    const h = await appHarness({ interactive: false });
    await h.profile();
    const seen = (await h.call("status")).value.revision;
    // The chat changes the state: an interview starts.
    const [chat, app] = await Promise.all([
      h.chat.run("new"),
      h.call("profile.save", {
        teacherName: "Ana Perez",
        institution: "Instituto Cristiano Demo",
        subject: "Álgebra",
        paper: "a4",
        language: "es",
        expectedRevision: seen,
      }),
    ]);
    expect(chat).toContain("Entrevista");
    // Whichever ran second saw a different state: the app's write was refused, or it ran first.
    const state = await readState(h.workspace);
    expect(state?.interview?.pending?.round).toBe("1");
    if (app.error) {
      expect(app.error).toBe("state_changed");
      expect(await readFile(stateFile(h.workspace), "utf8")).toContain('"round": "1"');
    } else expect(app.value.profile.subject).toBe("Álgebra");

    const before = await readFile(stateFile(h.workspace), "utf8");
    const stale = await h.call("draft.discard", { expectedRevision: seen });
    expect(stale.error).toBe("state_changed");
    expect(await readFile(stateFile(h.workspace), "utf8")).toBe(before);
  });

  it("makes the app wait for a chat command holding the lock", async () => {
    const h = await appHarness();
    await h.profile();
    const order: string[] = [];
    const held = h.coordinator.lock.run(async () => {
      order.push("chat:in");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("chat:out");
    });
    const app = h.call("draft.discard").then((result) => {
      order.push("app");
      return result;
    });
    await held;
    expect((await app).error).toBeUndefined();
    expect(order).toEqual(["chat:in", "chat:out", "app"]);
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("Mutex (D2)", () => {
  it("runs critical sections one at a time, in arrival order", async () => {
    const lock = new Mutex();
    const events: string[] = [];
    const section = (name: string) =>
      lock.run(async () => {
        events.push(`${name}:in`);
        await tick();
        events.push(`${name}:out`);
        return name;
      });
    const results = await Promise.all([section("a"), section("b"), section("c")]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["a:in", "a:out", "b:in", "b:out", "c:in", "c:out"]);
    expect(lock.locked).toBe(false);
  });

  it("releases the lock when a section throws", async () => {
    const lock = new Mutex();
    await expect(
      lock.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await lock.run(async () => "next")).toBe("next");
  });

  it("gives up waiting after the timeout without running the section", async () => {
    const lock = new Mutex();
    let release: () => void = () => undefined;
    const held = lock.run(() => new Promise<void>((resolve) => (release = resolve)));
    let ran = false;
    await expect(
      lock.run(
        async () => {
          ran = true;
        },
        { timeoutMs: 10 },
      ),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(ran).toBe(false);
    release();
    await held;
    expect(await lock.run(async () => "free")).toBe("free");
  });
});
