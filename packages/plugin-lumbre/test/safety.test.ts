import { describe, expect, it } from "vitest";
import { errorCode, LumbreError } from "../src/errors.js";
import {
  cleanLog,
  exportFolder,
  filePath,
  isManagedPath,
  sameCaseConflict,
  validateFileSet,
} from "../src/safety.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return errorCode(error);
  }
  return "ok";
};

describe("file paths", () => {
  it("accepts relative text files of the supported kinds", () => {
    for (const p of ["index.html", "src/App.jsx", "app/api/hello/route.js", "src/pages/a.astro"])
      expect(filePath(p)).toBe(p);
  });

  it("rejects traversal, absolute, hidden, generated and binary-looking paths", () => {
    for (const p of [
      "../x.js",
      "/etc/passwd.txt",
      "a/../../b.js",
      ".env",
      "src/.secret.js",
      "node_modules/x/index.js",
      "dist/index.html",
      ".next/x.js",
      "C:/x.js",
      "a\\b.js",
      "image.png",
      "noext",
      "src/main.ts",
      "x\u0000.js",
      `${"a/".repeat(9)}x.js`,
      "",
    ])
      expect(
        code(() => filePath(p)),
        p,
      ).toBe("invalid_path");
  });

  it("flags preset-owned configuration and lockfiles as managed, in any letter case", () => {
    for (const p of [
      "package.json",
      "Package-Lock.json",
      "vite.config.js",
      "astro.config.mjs",
      "next.config.mjs",
      "postcss.config.cjs",
      "tailwind.config.js",
      "jsconfig.json",
      "tsconfig.json",
      "yarn.lock",
    ])
      expect(isManagedPath(p, []), p).toBe(true);
    expect(isManagedPath("styles/tailwind.css", ["styles/tailwind.css"])).toBe(true);
    expect(isManagedPath("src/App.jsx", [])).toBe(false);
  });

  it("detects names that only differ in letter case", () => {
    expect(sameCaseConflict(["Index.html", "index.html"])).toBe("index.html");
    expect(sameCaseConflict(["a.js", "b.js"])).toBeUndefined();
  });
});

describe("file sets", () => {
  it("bounds the number of files and their total size", () => {
    const many = Object.fromEntries(Array.from({ length: 151 }, (_, i) => [`f${i}.js`, "x"]));
    expect(code(() => validateFileSet(many))).toBe("too_large");
    expect(code(() => validateFileSet({ "a.js": "x".repeat(400_001) }))).toBe("too_large");
    expect(validateFileSet({ "a.js": "1" })).toEqual({ "a.js": "1" });
  });
});

describe("export folders", () => {
  it("accepts a plain relative folder and rejects anything that could escape", () => {
    expect(exportFolder("my-site")).toBe("my-site");
    expect(exportFolder("sites/My Site 2")).toBe("sites/My Site 2");
    for (const f of ["../x", "/abs", ".hidden", "a//b", "a/./b", "C:/x", "x\\y", ""])
      expect(
        code(() => exportFolder(f)),
        f,
      ).toBe("invalid_path");
  });
});

describe("logs and errors", () => {
  it("strips terminal escapes and redacts secret-looking assignments", () => {
    const out = cleanLog("\u001b[31mfail\u001b[0m token=abc123 API_KEY: xyz");
    expect(out).toContain("fail");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("xyz");
  });

  it("maps errors to codes without carrying messages", () => {
    expect(errorCode(new LumbreError("conflict"))).toBe("conflict");
    expect(errorCode(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("cancelled");
    expect(errorCode(new Error("secret detail"))).toBe("operation_failed");
  });
});
