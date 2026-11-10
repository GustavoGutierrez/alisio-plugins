import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { composeInstructions, instructionFiles } from "../src/instructions.js";
import { stack } from "../src/presets.js";

const read = (p: string) => readFile(new URL(`../.agents/${p}`, import.meta.url), "utf8");
const root = (p: string) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

describe("packaged skills and attribution", () => {
  it("ships lmb-design adapted from Anthropic's and Vercel Labs' skills, with the Apache-2.0 text", async () => {
    const skill = await read("skills/lmb-design/SKILL.md");
    expect(skill).toMatch(/^---\nname: lmb-design\n/);
    expect(skill).toMatch(/description: "Trigger: /);
    expect(skill).toContain(
      "Anthropic's frontend-design skill (https://github.com/anthropics/skills, Apache",
    );
    expect(skill).toContain("Vercel Labs' agent-eval frontend-design skill");
    expect(skill).toContain("adapted and combined for Lumbre");
    expect(skill).not.toMatch(/screenshot/i);
    expect(skill).toMatch(/never load fonts from a CDN/);
    expect(skill).toMatch(/prefers-reduced-motion/);
    const license = await read("skills/lmb-design/LICENSE.txt");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
  });

  it("ships lmb-react-next with the MIT notice for Vercel's rules and Next.js 16 conventions", async () => {
    const skill = await read("skills/lmb-react-next/SKILL.md");
    expect(skill).toMatch(/^---\nname: lmb-react-next\n/);
    expect(skill).toContain("Adapted from Vercel's react-best-practices skill");
    expect(await read("skills/lmb-react-next/LICENSE.txt")).toMatch(
      /MIT License\n\nCopyright \(c\) Vercel, Inc\./,
    );
    const rules = await read("skills/lmb-react-next/references/react-rules.md");
    expect(rules).toContain("MIT License,\nCopyright (c) Vercel, Inc.");
    expect(rules).toContain("are left out");
    expect(rules).not.toMatch(/useSWR|new LRUCache|betterAll/);
    const next = await read("skills/lmb-react-next/references/next-file-conventions.md");
    expect(next).toContain(
      "Based on the Next.js documentation, MIT License, Copyright (c) Vercel, Inc.",
    );
    // Next.js 16 renamed middleware to proxy; the config export is still `config`.
    expect(next).toContain("export const config = { matcher: … }");
    expect(next).not.toMatch(/proxyConfig/);
    expect(next).toContain("https://nextjs.org/docs/app/api-reference/file-conventions/proxy");
    expect(next).toMatch(/params` is a \*\*Promise\*\*/);
    for (const name of [
      "default",
      "error",
      "layout",
      "loading",
      "not-found",
      "page",
      "parallel-routes",
      "route",
      "route-groups",
      "template",
      "intercepting-routes",
      "dynamic-routes",
    ])
      expect(next, name).toContain(
        `https://nextjs.org/docs/app/api-reference/file-conventions/${name}`,
      );
    const notices = await root("THIRD_PARTY_NOTICES.md");
    for (const text of [
      "anthropics/skills",
      "vercel-labs/agent-eval",
      "vercel-labs/agent-skills",
      "vercel/next.js",
      "Apache License 2.0",
      "MIT",
    ])
      expect(notices).toContain(text);
    const pkg = JSON.parse(await root("package.json"));
    expect(pkg.files).toEqual(expect.arrayContaining([".agents", "THIRD_PARTY_NOTICES.md"]));
  });
});

describe("instructions per mode and stack", () => {
  it("adds design guidance to plan and build passes, not to fixes", async () => {
    for (const mode of ["build", "agent", "plan"] as const)
      expect(await composeInstructions(mode, "vanilla"), mode).toContain("# Lumbre design");
    for (const mode of ["fix", "agentFix"] as const)
      expect(await composeInstructions(mode, "vanilla"), mode).not.toContain("# Lumbre design");
    expect(await composeInstructions("build", "vanilla")).not.toMatch(/^---\nname:/m);
  });

  it("adds React rules and Next.js conventions only for the stacks they apply to", () => {
    for (const s of ["vanilla", "vite", "astro"] as const)
      expect(
        instructionFiles("agent", s).some((f) => f.includes("lmb-react-next")),
        s,
      ).toBe(false);
    expect(instructionFiles("agent", "react")).toEqual(
      expect.arrayContaining(["skills/lmb-react-next/references/react-rules.md"]),
    );
    expect(
      instructionFiles("agent", "react").some((f) => f.includes("next-file-conventions")),
    ).toBe(false);
    expect(instructionFiles("build", "next")).toEqual(
      expect.arrayContaining([
        "skills/lmb-react-next/references/react-rules.md",
        "skills/lmb-react-next/references/next-file-conventions.md",
      ]),
    );
    expect(instructionFiles("agentFix", "next")).toContain(
      "skills/lmb-react-next/references/react-rules.md",
    );
    expect(instructionFiles("plan", "next")).toEqual(
      expect.arrayContaining(["skills/lmb-react-next/references/next-file-conventions.md"]),
    );
    expect(instructionFiles("plan", "next")).not.toContain(
      "skills/lmb-react-next/references/react-rules.md",
    );
  });

  it("offers self-hosted fonts to the npm stacks and keeps vanilla on system fonts", () => {
    expect(stack("vite").allowlist["@fontsource-variable/fraunces"]).toBe("5.3.0");
    expect(stack("next").allowlist["@fontsource/instrument-serif"]).toBe("5.3.0");
    expect(stack("vanilla", true).allowlist).toEqual({});
  });
});

describe("lmb-tailwind", () => {
  it("is attributed, licensed and only used for Tailwind stacks in build passes", async () => {
    const skill = await read("skills/lmb-tailwind/SKILL.md");
    expect(skill).toMatch(/^---\nname: lmb-tailwind\n/);
    expect(skill).toContain("wshobson/agents");
    expect(skill).toContain("Copyright (c) 2024 Seth Hobson");
    expect(await read("skills/lmb-tailwind/LICENSE.txt")).toContain(
      "Copyright (c) 2024 Seth Hobson",
    );
    expect(await root("THIRD_PARTY_NOTICES.md")).toContain("Seth Hobson");
    for (const s of ["vite", "react", "astro", "next"] as const)
      expect(instructionFiles("agent", s), s).toContain("skills/lmb-tailwind/SKILL.md");
    expect(instructionFiles("build", "vanilla", true)).toContain("skills/lmb-tailwind/SKILL.md");
    expect(
      instructionFiles("build", "vanilla", false).some((f) => f.includes("lmb-tailwind")),
    ).toBe(false);
    for (const mode of ["plan", "fix", "agentFix"] as const)
      expect(
        instructionFiles(mode, "react").some((f) => f.includes("lmb-tailwind")),
        mode,
      ).toBe(false);
  });

  it("only imports packages the stacks allow, and keeps framework-agnostic ones for Vite and Astro", async () => {
    const text = [
      await read("skills/lmb-tailwind/SKILL.md"),
      await read("skills/lmb-tailwind/references/tailwind-v4.md"),
      await read("skills/lmb-tailwind/references/components.md"),
    ].join("\n");
    const imported = [...text.matchAll(/(?:from|import)\s+"([^".][^"]*)"/g)]
      .map((m) => m[1] as string)
      .filter((p) => p !== "tailwindcss")
      .map((p) =>
        p.startsWith("@") ? p.split("/").slice(0, 2).join("/") : (p.split("/")[0] as string),
      );
    expect(imported.length).toBeGreaterThan(5);
    const react = stack("react").allowlist;
    const next = stack("next").allowlist;
    for (const pkg of imported) {
      expect(Object.hasOwn(react, pkg), pkg).toBe(true);
      expect(Object.hasOwn(next, pkg), pkg).toBe(true);
    }
    for (const pkg of ["clsx", "tailwind-merge", "class-variance-authority", "zod"])
      for (const s of ["vite", "astro"] as const)
        expect(Object.hasOwn(stack(s).allowlist, pkg), `${s}:${pkg}`).toBe(true);
    for (const pkg of ["lucide-react", "react-hook-form", "@radix-ui/react-slot"])
      for (const s of ["vite", "astro"] as const)
        expect(Object.hasOwn(stack(s).allowlist, pkg), `${s}:${pkg}`).toBe(false);
    expect(text).not.toMatch(/require\("tailwindcss-animate"\)|@plugin "tailwindcss-animate"/);
    expect(text).toContain("Never use `tailwindcss-animate`");
    // Every directive the skill teaches exists in the pinned Tailwind (checked with a real build).
    expect(stack("vite").dependencies.tailwindcss).toBe("4.3.3");
  });
});

describe("fewer dependencies first (owner rule)", () => {
  it("is stated in every skill and agent that writes code", async () => {
    for (const f of [
      "skills/lmb-design/SKILL.md",
      "skills/lmb-tailwind/SKILL.md",
      "skills/lmb-react-next/SKILL.md",
      "agents/lmb-builder.md",
      "agents/lmb-agent.md",
    ]) {
      const text = await read(f);
      expect(text, f).toContain("Fewer dependencies");
      expect(text, f).toContain("Astro pages stay zero-JS");
    }
  });
});
