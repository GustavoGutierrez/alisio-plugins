import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AskQuestionsRequest, PluginAPI, ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { loadBrief } from "../src/index.js";
import { treeDirectories } from "../src/workspace.js";

const packsRoot = fileURLToPath(new URL("./fixtures/packs/", import.meta.url));
type Handler = (args: string, context?: { sessionId?: string }) => Promise<string>;
type Answers = Record<string, string | string[] | undefined>;

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

import { ThesisCoordinator } from "../src/coordinator.js";

async function harness(
  options: { interactive?: boolean; answers?: Answers[]; workspace?: string } = {},
) {
  const workspace = options.workspace ?? (await mkdtemp(join(tmpdir(), "thesis-test-")));
  if (!options.workspace) workspaces.push(workspace);
  const commands = new Map<string, Handler>();
  const info = new Map<string, unknown>();
  const tools = new Map<string, ToolDefinition>();
  const agents: string[] = [];
  const skills: string[] = [];
  const asked: AskQuestionsRequest[] = [];
  const queue = [...(options.answers ?? [])];
  const api = {
    commands: {
      register(name: string, handler: Handler, meta: unknown) {
        commands.set(name, handler);
        info.set(name, meta);
        return () => commands.delete(name);
      },
    },
    tools: {
      register(tool: ToolDefinition) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    resources: { agents: (p: string) => agents.push(p), skills: (p: string) => skills.push(p) },
    sessions: { workspace: () => workspace },
    ui: {
      status() {},
      interactive: () => options.interactive ?? false,
      async askQuestions(request: AskQuestionsRequest) {
        asked.push(request);
        return queue.shift() ?? {};
      },
    },
  } as unknown as PluginAPI;
  await plugin.setup(api);
  // Route package packs to the synthetic fixtures through a second coordinator bound to the same API.
  const coordinator = new ThesisCoordinator(api, { packsRoot, env: { LANG: "en_US.UTF-8" } });
  const run = (name: string, args = "") =>
    commands.get(name)?.(args, { sessionId: "parent" }) as Promise<string>;
  const direct = (name: "init" | "answer" | "status" | "check" | "pack", args = "") =>
    coordinator[name](args, "parent");
  return { workspace, commands, info, tools, agents, skills, asked, run, direct };
}

const round1: Answers = {
  language: "conversation",
  workType: "master_thesis",
  country: "CO",
  secondaryAbstract: "en",
};
const round2: Answers = {
  institution: "enter",
  "institution:text": "Example University; Engineering; Systems; Bogota",
  citationStyle: "auto",
  domain: "computer_science",
  approach: "recommended",
};
const round3: Answers = {
  title: "enter",
  "title:text": "Sample thesis title",
  topic: "enter",
  "topic:text": "How to verify evidence automatically",
  objective: "draft",
  justification: "draft",
};
const headlessRounds = [
  "language=conversation workType=master_thesis country=CO secondaryAbstract=en",
  "institution=enter institution:text=Example University; Engineering; Systems; Bogota citationStyle=auto domain=computer_science approach=recommended",
  "title=enter title:text=Sample thesis title topic=enter topic:text=How to verify evidence automatically objective=draft justification=draft",
];

function payload(result: { content: unknown[] } | undefined): Record<string, unknown> {
  if (!result) throw new Error("tool returned nothing");
  return JSON.parse((result.content[0] as { text: string }).text);
}

async function read(workspace: string, path: string) {
  return readFile(join(workspace, "thesis", path), "utf8");
}
async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("plugin registration", () => {
  it("registers metadata, commands, tools and resources", async () => {
    const { commands, tools, agents, skills, info } = await harness();
    expect(plugin).toMatchObject({
      id: "thesis",
      categories: ["methodology-harness"],
      apiVersion: 1,
    });
    expect([...commands.keys()].sort()).toEqual([
      "answer",
      "approve",
      "build",
      "check",
      "design",
      "doctor",
      "draft",
      "figure",
      "finalize",
      "init",
      "next",
      "norms",
      "outline",
      "pack",
      "research",
      "review",
      "revise",
      "setup",
      "status",
      "style",
    ]);
    expect(info.get("init")).toMatchObject({ argumentHint: expect.stringContaining("--lang") });
    expect([...tools.keys()].sort()).toEqual([
      "thesis_build",
      "thesis_check",
      "thesis_scholar_resolve",
      "thesis_scholar_search",
      "thesis_status",
    ]);
    expect(tools.get("thesis_status")?.effect).toBe("read");
    expect(tools.get("thesis_check")?.effect).toBe("read");
    expect(agents).toEqual(["../.agents/agents"]);
    expect(skills).toEqual(["../.agents/skills"]);
  });

  it("requires an active session", async () => {
    const { commands } = await harness();
    await expect(commands.get("status")?.("")).rejects.toThrow(/active Alisio session/);
  });
});

describe("/thesis:init interactive", () => {
  it("asks round 1 first with the language question and one recommended option", async () => {
    const { direct, asked } = await harness({
      interactive: true,
      answers: [round1, round2, round3],
    });
    await direct("init", "--lang es-CO");
    const first = asked[0]?.questions ?? [];
    expect(first.map((question) => question.id)).toEqual([
      "language",
      "workType",
      "country",
      "secondaryAbstract",
    ]);
    expect(first[0]?.question).toMatch(/language/i);
    for (const question of asked.flatMap((request) => request.questions)) {
      expect(question.options.length).toBeGreaterThanOrEqual(2);
      expect(question.options.length).toBeLessThanOrEqual(4);
      expect(question.options.filter((entry) => entry.recommended).length).toBeLessThanOrEqual(1);
    }
    expect(first[0]?.options.filter((entry) => entry.recommended)).toHaveLength(1);
    expect(first[0]?.options.find((entry) => entry.value === "other")?.textInput).toBeDefined();
    expect(asked.map((request) => request.questions.length)).toEqual([4, 4, 4]);
  });

  it("writes the tree, a valid thesis.yaml and compliance-profile.json", async () => {
    const { direct, workspace } = await harness({
      interactive: true,
      answers: [round1, round2, round3],
    });
    const message = await direct("init", "--lang es-CO");
    expect(message).toContain("Interview complete");

    const base = join(workspace, "thesis");
    for (const directory of treeDirectories) {
      expect(await exists(join(base, directory)), directory).toBe(true);
      expect((await stat(join(base, directory))).mode & 0o777).toBe(0o700);
    }
    expect(await read(workspace, ".gitignore")).toBe("build/\n");

    const loaded = loadBrief(await read(workspace, "thesis.yaml"));
    expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(loaded.brief).toMatchObject({
      language: "es-CO",
      workType: "master_thesis",
      secondaryAbstractLanguage: "en",
      title: "Sample thesis title",
      approach: "design_science",
      domain: { primary: "computer_science" },
      institution: {
        name: "Example University",
        faculty: "Engineering",
        program: "Systems",
        city: "Bogota",
        country: "CO",
      },
      citationStyle: "auto",
    });
    expect((await stat(join(base, "thesis.yaml"))).mode & 0o777).toBe(0o600);

    const profile = JSON.parse(await read(workspace, "compliance-profile.json"));
    expect(profile.citationStyle.value).toBe("apa-7");
    expect(profile.citationStyle.defaulted).toBe(true);
    expect(JSON.parse(await read(workspace, "research/intake.json"))).toMatchObject({
      title: "Sample thesis title",
      topic: "How to verify evidence automatically",
      objective: null,
    });

    const state = JSON.parse(
      await readFile(join(workspace, ".alisio", "thesis", "state.json"), "utf8"),
    );
    expect(state).toMatchObject({
      phase: "design",
      root: "thesis",
      intake: { completedRounds: [1, 2, 3] },
    });
    expect(state.pendingQuestions).toBeUndefined();
    expect(state.lastCheck.errors).toBe(0);
  });

  it("falls back to pending questions when an interactive round is skipped", async () => {
    const { direct, workspace } = await harness({ interactive: true, answers: [{}] });
    const message = await direct("init", "--lang es-CO");
    expect(message).toContain("/thesis:answer");
    const state = JSON.parse(
      await readFile(join(workspace, ".alisio", "thesis", "state.json"), "utf8"),
    );
    expect(state.pendingQuestions.round).toBe(1);
  });

  it("skips questions that thesis.yaml already answers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "thesis-test-"));
    workspaces.push(workspace);
    await mkdir(join(workspace, "thesis"));
    await writeFile(
      join(workspace, "thesis", "thesis.yaml"),
      "schemaVersion: 1\nlanguage: en\nworkType: monograph\nyear: 2026\ninstitution: { country: MX }\n",
    );
    const { direct, asked } = await harness({
      interactive: true,
      workspace,
      answers: [{ secondaryAbstract: "none" }],
    });
    await direct("init");
    expect(asked[0]?.questions.map((question) => question.id)).toEqual(["secondaryAbstract"]);
  });

  it("is idempotent: a second init keeps answers and does not re-ask", async () => {
    const { direct, asked, workspace } = await harness({
      interactive: true,
      answers: [round1, round2, round3],
    });
    await direct("init", "--lang es-CO");
    const before = await read(workspace, "thesis.yaml");
    const calls = asked.length;
    const again = await direct("init");
    expect(asked.length).toBe(calls);
    expect(again).toContain("Interview complete");
    expect(await read(workspace, "thesis.yaml")).toBe(before);
  });

  it("asks the presentation round on demand and updates the brief", async () => {
    const { direct, asked, workspace } = await harness({
      interactive: true,
      answers: [
        round1,
        round2,
        round3,
        { paper: "a4", palette: "tol-bright", fontProfile: "sans", aiDeclaration: "always" },
      ],
    });
    await expect(direct("init", "--presentation")).rejects.toThrow(/rounds 1 and 2/);
    await direct("init", "--lang es-CO");
    await direct("init", "--presentation");
    expect(asked.at(-1)?.questions.map((question) => question.id)).toEqual([
      "paper",
      "palette",
      "fontProfile",
      "aiDeclaration",
    ]);
    expect(loadBrief(await read(workspace, "thesis.yaml")).brief).toMatchObject({
      presentation: { paper: "a4", palette: "tol-bright", fontProfile: "sans" },
      aiUse: { declaration: "always" },
    });
  });

  it("rejects bad arguments", async () => {
    const { direct } = await harness();
    await expect(direct("init", "../escape")).rejects.toThrow(/Invalid thesis root|Unsafe/);
    await expect(direct("init", "a b")).rejects.toThrow(/Usage/);
    await expect(direct("init", "--wat")).rejects.toThrow(/Unknown option/);
    await expect(direct("init", "--lang not_a_tag")).rejects.toThrow(/BCP-47/);
  });
});

describe("headless init and /thesis:answer", () => {
  it("returns the questions with answer syntax and reaches the same files as interactive", async () => {
    const interactive = await harness({ interactive: true, answers: [round1, round2, round3] });
    await interactive.direct("init", "--lang es-CO");

    const headless = await harness();
    const first = await headless.direct("init", "--lang es-CO");
    expect(first).toContain("round 1 of 3");
    expect(first).toMatch(/language: In which language/);
    expect(first).toContain("conversation: Conversation language (es-CO) (recommended)");
    expect(first).toContain("/thesis:answer");
    expect(await exists(join(headless.workspace, "thesis", "thesis.yaml"))).toBe(false);

    const second = await headless.direct("answer", `-- ${headlessRounds[0]}`);
    expect(second).toContain("round 2 of 3");
    const third = await headless.direct("answer", headlessRounds[1] as string);
    expect(third).toContain("round 3 of 3");
    const done = await headless.direct(
      "answer",
      JSON.stringify(
        Object.fromEntries(
          (headlessRounds[2] as string).split(/ (?=\w+(?::text)?=)/).map((pair) => {
            const index = pair.indexOf("=");
            return [pair.slice(0, index), pair.slice(index + 1)];
          }),
        ),
      ),
    );
    expect(done).toContain("Interview complete");

    for (const file of ["thesis.yaml", "compliance-profile.json", "research/intake.json"]) {
      expect(await read(headless.workspace, file), file).toBe(
        await read(interactive.workspace, file),
      );
    }
  });

  it("validates answers against the option domain and records nothing on error", async () => {
    const { direct, workspace } = await harness();
    await direct("init", "--lang es-CO");
    const bad = await direct(
      "answer",
      "workType=wizard country=CO language=conversation secondaryAbstract=en",
    );
    expect(bad).toContain("No answers were recorded");
    expect(bad).toContain('workType: "wizard" is not allowed');
    const state = JSON.parse(
      await readFile(join(workspace, ".alisio", "thesis", "state.json"), "utf8"),
    );
    expect(state.intake.answers).toEqual({});
    expect(state.pendingQuestions.questions).toHaveLength(4);
  });

  it("keeps unanswered questions pending after a partial answer", async () => {
    const { direct, workspace } = await harness();
    await direct("init", "--lang es-CO");
    const partial = await direct("answer", "workType=master_thesis language=conversation");
    expect(partial).toContain("country: In which country");
    expect(partial).toContain("secondaryAbstract");
    expect(partial).not.toContain("workType: What kind");
    const state = JSON.parse(
      await readFile(join(workspace, ".alisio", "thesis", "state.json"), "utf8"),
    );
    expect(state.pendingQuestions.questions.map((q: { id: string }) => q.id)).toEqual([
      "country",
      "secondaryAbstract",
    ]);
    expect(state.intake.answers.workType).toBe("master_thesis");
  });

  it("reads an unknown value as free text when the question has an other option", async () => {
    const { direct, workspace } = await harness();
    await direct("init", "--lang es-CO");
    await direct("answer", "language=pt-BR workType=monograph country=mx secondaryAbstract=none");
    const state = JSON.parse(
      await readFile(join(workspace, ".alisio", "thesis", "state.json"), "utf8"),
    );
    expect(state.intake.answers).toMatchObject({
      language: "other",
      "language:text": "pt-BR",
      country: "other",
      "country:text": "mx",
    });
    expect(loadBrief(await read(workspace, "thesis.yaml")).brief).toMatchObject({
      language: "pt-BR",
      institution: { country: "MX" },
      searchLanguages: ["pt", "en"],
    });
  });

  it("rejects an invalid BCP-47 tag, missing required text and unknown ids", async () => {
    const { direct } = await harness();
    await direct("init", "--lang es-CO");
    const invalid = await direct(
      "answer",
      "language=klingon-forever workType=monograph country=CO secondaryAbstract=none",
    );
    expect(invalid).toMatch(/language: language text must be a BCP-47 tag/);
    const missingText = await direct("answer", "country=other");
    expect(missingText).toMatch(/needs free text/);
    const unknown = await direct("answer", "bogus=1");
    expect(unknown).toMatch(/Expected id=value pairs|Unknown question id/);
    const stray = await direct("answer", "hello language=en");
    expect(stray).toMatch(/Unrecognized text/);
  });

  it("refuses to answer when nothing is pending", async () => {
    const { direct } = await harness();
    await expect(direct("answer", "language=en")).rejects.toThrow(/Run \/thesis:init first/);
    const { direct: second } = await harness({
      interactive: true,
      answers: [round1, round2, round3],
    });
    await second("init", "--lang es-CO");
    await expect(second("answer", "language=en")).rejects.toThrow(/no pending/i);
  });
});

describe("/thesis:status and thesis_status", () => {
  it("reports an uninitialized workspace", async () => {
    const { run, tools, workspace } = await harness();
    expect(await run("status")).toContain("not initialized");
    const result = await tools.get("thesis_status")?.execute({}, { workspace } as never);
    expect(payload(result)).toMatchObject({
      initialized: false,
    });
  });

  it("summarizes phase, gates and the next step after init", async () => {
    const { direct, tools, workspace } = await harness({
      interactive: true,
      answers: [round1, round2, round3],
    });
    await direct("init", "--lang es-CO");
    const text = await direct("status");
    expect(text).toContain("Phase: design");
    expect(text).toContain("Human gates: A pending, B pending, OUTLINE pending, C pending");
    expect(text).toMatch(/Next: \/thesis:design/);
    const result = await tools.get("thesis_status")?.execute({}, { workspace } as never);
    expect(payload(result)).toMatchObject({
      initialized: true,
      phase: "design",
      intake: { completedRounds: [1, 2, 3], pendingRound: null },
    });
  });

  it("shows the pending round while the interview is open", async () => {
    const { direct } = await harness();
    await direct("init", "--lang es-CO");
    const text = await direct("status");
    expect(text).toContain("round 1 awaits answers");
    expect(text).toContain("/thesis:answer");
  });
});

describe("/thesis:check and thesis_check", () => {
  it("runs checks, writes build/check-report.json and updates the state", async () => {
    const { direct, workspace } = await harness({
      interactive: true,
      answers: [round1, round2, round3],
    });
    await direct("init", "--lang es-CO");
    const text = await direct("check", "G0");
    expect(text).toContain("Checks passed");
    const report = JSON.parse(await read(workspace, "build/check-report.json"));
    expect(report.ok).toBe(true);
    await writeFile(join(workspace, "thesis", "thesis.yaml"), "language: [broken\n");
    expect(await direct("check")).toContain("Checks failed");
    await expect(direct("check", "G99")).rejects.toThrow(/Unknown gate/);
  });

  it("is read-only through the tool and validates input", async () => {
    const { direct, tools, workspace } = await harness({
      interactive: true,
      answers: [round1, round2, round3],
    });
    await direct("init", "--lang es-CO");
    await rm(join(workspace, "thesis", "build", "check-report.json"), { force: true });
    const tool = tools.get("thesis_check");
    const ok = await tool?.execute({ gates: ["G0"] }, { workspace } as never);
    expect(payload(ok)).toMatchObject({ ok: true });
    expect(await exists(join(workspace, "thesis", "build", "check-report.json"))).toBe(false);
    const bad = await tool?.execute({ gates: ["G99"] }, { workspace } as never);
    expect(bad?.isError).toBe(true);
    const badSection = await tool?.execute({ section: "intro" }, { workspace } as never);
    expect(badSection?.isError).toBe(true);
    const noWorkspace = await tool?.execute({}, {
      workspace: await mkdtemp(join(tmpdir(), "thesis-empty-")),
    } as never);
    expect(noWorkspace?.isError).toBe(true);
  });
});

describe("/thesis:pack", () => {
  async function ready() {
    const h = await harness({ interactive: true, answers: [round1, round2, round3] });
    await h.direct("init", "--lang es-CO");
    return h;
  }

  it("lists shipped and workspace packs with their state", async () => {
    const { direct } = await ready();
    const text = await direct("pack", "list");
    expect(text).toContain("- CO [country, shipped]");
    expect(text).toContain(": active");
    expect(text).toContain("- global [global, shipped]");
  });

  it("scaffolds an institution pack that passes check and becomes active", async () => {
    const { direct, workspace } = await ready();
    const created = await direct("pack", "new institution example-university");
    expect(created).toContain("policy-packs/institutions/CO/example-university/");
    const manifest = await read(
      workspace,
      "policy-packs/institutions/CO/example-university/manifest.yaml",
    );
    expect(manifest).toContain("packId: CO-example-university");
    expect(manifest).toContain("extends: CO");
    expect(manifest).toContain("appliesWhen: { country: CO }");
    const checked = await direct("pack", "check");
    expect(checked).toContain("Checks passed");
    expect(checked).toMatch(/PCK-010/);
    expect(await direct("pack", "list")).toContain(
      "- CO-example-university [institution, workspace]",
    );
    await expect(direct("pack", "new institution example-university")).rejects.toThrow(
      /already exists/,
    );
    expect(await direct("pack", "new faculty engineering")).toContain("faculties/engineering/");
    await expect(direct("pack", "new program systems")).resolves.toContain("programs/systems/");
  });

  it("reports PCK-002 for an accidental shadow and explains rules and values", async () => {
    const { direct, workspace } = await ready();
    const dir = join(workspace, "thesis", "policy-packs", "writing", "house");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.yaml"), "packId: house\nscope: writing\nversion: '1'\n");
    await writeFile(
      join(dir, "r.yaml"),
      "ruleId: TEST.GLOBAL.AI.DECLARATION\nlevel: STYLE_GUIDE\nstatus: active\nrequirement: { kind: ai_declaration, values: { required: false } }\nsource: { reference: r }\nverification: { lastChecked: '2026-10-04', basis: official_text }\n",
    );
    const checked = await direct("pack", "check");
    expect(checked).toContain("Checks failed");
    expect(checked).toContain("PCK-002");
    const rule = await direct("pack", "explain TEST.CO.PRIVACY.PERSONAL");
    expect(rule).toMatch(/TEST\.CO\.PRIVACY\.PERSONAL: applied/);
    expect(rule).toContain("LAW");
    const value = await direct("pack", "explain citationStyle");
    expect(value).toContain("citationStyle = apa-7");
    expect(value).toContain("TEST.GLOBAL.CITATION.DEFAULT");
    expect(await direct("pack", "explain nothing-here")).toContain("Nothing matches");
  });

  it("validates usage", async () => {
    const { direct } = await ready();
    await expect(direct("pack", "")).rejects.toThrow(/Usage/);
    await expect(direct("pack", "new bogus x")).rejects.toThrow(/Unknown scope/);
    await expect(direct("pack", "new country Mexico")).rejects.toThrow(/ISO code/);
    await expect(direct("pack", "new faculty eng")).rejects.toThrow(/institution pack first/);
    await expect(direct("pack", "explain")).rejects.toThrow(/Usage/);
  });
});

describe("/thesis:doctor", () => {
  it("prints a report-only summary", async () => {
    const { run } = await harness();
    const text = await run("doctor");
    expect(text).toContain("report only");
    expect(text).toMatch(/Typst/);
    expect(text).toMatch(/Chrome-family browser/);
    expect(text).toMatch(/Vendored Typst package mitex 0\.2\.7/);
  });
});

describe("state directory", () => {
  it("never leaves temp files behind", async () => {
    const { direct, workspace } = await harness({
      interactive: true,
      answers: [round1, round2, round3],
    });
    await direct("init", "--lang es-CO");
    const names = await readdir(join(workspace, ".alisio", "thesis"));
    expect(names).toEqual(["state.json"]);
    expect(
      (await readdir(join(workspace, "thesis"))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
