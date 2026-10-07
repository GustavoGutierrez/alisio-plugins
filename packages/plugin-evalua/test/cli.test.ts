import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

function capture() {
  const lines: string[] = [];
  return {
    lines,
    io: {
      log: (message: string) => lines.push(message),
      error: (message: string) => lines.push(message),
    },
  };
}

describe("alisio-evalua CLI", () => {
  it("prints the usage for help and an unknown command", async () => {
    const help = capture();
    expect(await main([], help.io)).toBe(0);
    expect(help.lines.join("\n")).toContain("alisio-evalua");
    const unknown = capture();
    expect(await main(["nope"], unknown.io)).toBe(2);
  });

  it("prints the knowledge base and a clean check", async () => {
    const kb = capture();
    expect(await main(["kb"], kb.io)).toBe(0);
    expect(JSON.parse(kb.lines.join("\n")).packs.map((pack: { id: string }) => pack.id)).toEqual([
      "algebra",
      "basic-math",
    ]);
    const check = capture();
    expect(await main(["check"], check.io)).toBe(0);
    expect(check.lines.join("\n")).toContain("check: ok");
  });

  it("reports the browser in doctor", async () => {
    const doctor = capture();
    expect(await main(["doctor"], doctor.io)).toBe(0);
    expect(doctor.lines.join("\n")).toContain("Knowledge base: ok");
  });
});
