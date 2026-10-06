import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const domainRoot = new URL("../src/domain/", import.meta.url).pathname;

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("domain purity", () => {
  it("imports neither node built-ins nor the SDK nor outer layers", async () => {
    const offenders: string[] = [];
    for (const file of await files(domainRoot)) {
      const text = await readFile(file, "utf8");
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (match) => match[1] ?? "",
      );
      for (const specifier of specifiers) {
        const bad =
          specifier.startsWith("node:") ||
          specifier.startsWith("@alisio/") ||
          specifier.startsWith("@babel/") ||
          /(^|\/)(application|infrastructure|interface)\//.test(specifier);
        if (bad) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
