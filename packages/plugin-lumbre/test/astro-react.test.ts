import { describe, expect, it } from "vitest";
import { Draft } from "../src/draft.js";
import { validateOutput } from "../src/generate.js";
import { readOutput } from "../src/output.js";
import { allowedDependency, allowlistFor, ownedFiles, packageJson, stack } from "../src/presets.js";

const astro = stack("astro");
const REACT = { "@astrojs/react": "7.1.1" };

describe("Astro React islands (owner decision)", () => {
  it("keeps Astro free of React until @astrojs/react is approved", () => {
    expect(allowedDependency(astro, "@astrojs/react", "7.1.1")).toBe(true);
    expect(allowedDependency(astro, "lucide-react", "1.61.0")).toBe(false);
    expect(allowedDependency(astro, "@radix-ui/react-dialog", "1.3.1")).toBe(false);
    const pkg = JSON.parse(packageJson(astro, {}));
    expect(pkg.dependencies.react).toBeUndefined();
    expect(ownedFiles(astro, {})["astro.config.mjs"]).not.toContain("@astrojs/react");
  });

  it("adds React and the vetted integration to the managed config once approved", () => {
    const pkg = JSON.parse(packageJson(astro, REACT));
    expect(pkg.dependencies).toMatchObject({
      "@astrojs/react": "7.1.1",
      react: "19.3.1",
      "react-dom": "19.3.1",
    });
    const config = ownedFiles(astro, REACT)["astro.config.mjs"] as string;
    expect(config).toContain('import react from "@astrojs/react";');
    expect(config).toContain("integrations: [react()],");
    expect(config).toContain("strictPort: true");
    expect(allowedDependency(astro, "lucide-react", "1.61.0", REACT)).toBe(true);
    expect(Object.keys(allowlistFor(astro, REACT))).toEqual(
      expect.arrayContaining(["react-hook-form", "@radix-ui/react-slot"]),
    );
  });

  it("accepts React packages requested together with the feature, in either order", () => {
    const raw = readOutput(
      JSON.stringify({
        files: [],
        dependencies: [
          { name: "lucide-react", version: "1.61.0" },
          { name: "@astrojs/react", version: "7.1.1" },
        ],
      }),
    );
    const out = validateOutput(raw, { stack: astro, current: {}, owned: ["astro.config.mjs"] });
    expect(out.dependencies).toEqual({ "@astrojs/react": "7.1.1", "lucide-react": "1.61.0" });
    expect(out.ignored).toEqual([]);
    const plain = validateOutput(
      readOutput(JSON.stringify({ dependencies: [{ name: "lucide-react", version: "1.61.0" }] })),
      {
        stack: astro,
        current: {},
        owned: [],
      },
    );
    expect(plain.ignored).toEqual([{ name: "lucide-react", reason: "not_allowed" }]);
    const draft = new Draft(astro, [], {}, "r");
    expect(draft.addDependency("lucide-react", "1.61.0")).toMatchObject({
      ok: false,
      error: "not_allowed",
    });
    expect(draft.addDependency("@astrojs/react", "7.1.1")).toMatchObject({ ok: true });
    expect(draft.addDependency("lucide-react", "1.61.0")).toMatchObject({ ok: true });
  });
});
