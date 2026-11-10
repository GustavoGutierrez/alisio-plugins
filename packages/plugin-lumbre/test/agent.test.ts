// 0.2.0 agent mode: tool loop into a per-job draft, plan approval, Continue, autofix, review.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allowedTools, toolPrefix } from "../src/tools.js";
import { blocks } from "./fixtures/landing.js";
import { type FakeRun, type Fixture, fixture } from "./service-fixture.js";

const open: Fixture[] = [];
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture({ toolCalling: true, ...options });
  open.push(f);
  return f;
}
afterEach(async () => {
  for (const f of open.splice(0)) await f.cleanup();
});

const write = (path: string, content: string) => ({
  name: "lumbre_write_file",
  input: { path, content },
});
const done = (summary = "Bakery page", message = "Listo: **panadería**.") => ({
  name: "lumbre_done",
  input: { summary, message },
});
const work = (f: Fixture, id: string, path: string) =>
  join(f.root, "state", "projects", id, "work", ...path.split("/"));
/** A project past its starter revision. */
async function existing(f: Fixture, stack = "vanilla") {
  const p = await f.call("projects.create", { title: "La Espiga", stack });
  await f.call("files.save", {
    projectId: p.id,
    path: "notes.md",
    content: "x",
    baseRevision: p.head,
  });
  return p;
}
const send = async (f: Fixture, projectId: string, input: Record<string, unknown> = {}) =>
  f.waitJob((await f.call("chat.send", { projectId, text: "Una panadería", ...input })).jobId);

describe("agent build (AGT-AC-02, AGT-AC-04)", () => {
  it("works in a read-only child with exactly Lumbre's prefixed tools, writing only the draft", async () => {
    const f = await setup();
    const p = await existing(f);
    const run: FakeRun = {
      calls: [
        { name: "lumbre_progress", input: { message: "Writing the page" } },
        { name: "lumbre_list_files" },
        write("index.html", "<h1>Pan</h1>\n"),
        write("menu.html", "<h1>Menú</h1>\n"),
        { name: "lumbre_edit_file", input: { path: "menu.html", find: "Menú", replace: "Carta" } },
        { name: "lumbre_delete_file", input: { path: "script.js" } },
        done(),
      ],
      text: "Done.",
    };
    f.respond(run);
    const job = await send(f, p.id);
    expect(job.state).toBe("done");
    expect(f.specs[0]).toMatchObject({
      agent: "lmb-agent",
      readOnly: true,
      permission: { write: "deny", process: "deny" },
      maxTurns: 40,
      instructions: "instructions:agent",
      tools: { allow: allowedTools("build") },
    });
    expect(toolPrefix("alisio.lumbre")).toBe("p_1515755981");
    expect(f.specs[0]?.tools?.allow).toContain("p_1515755981_lumbre_write_file");
    expect(f.toolResults.every((r) => (r as { ok: boolean }).ok)).toBe(true);
    // The project is unchanged until the review is applied.
    expect(existsSync(work(f, p.id, "menu.html"))).toBe(false);
    const proposal = await f.call("proposal.get", { projectId: p.id });
    expect(proposal.files).toEqual({
      "index.html": "<h1>Pan</h1>\n",
      "menu.html": "<h1>Carta</h1>\n",
    });
    expect(proposal.deletes).toEqual(["script.js"]);
    expect(job.agent.timeline.map((e: { kind: string }) => e.kind)).toEqual([
      "thinking",
      "progress",
      "write",
      "write",
      "edit",
      "delete",
      "done",
    ]);
    expect(job.diagnostics).toMatchObject({ mode: "agent", runs: 1, toolCalls: 7 });
    const view = await f.call("projects.get", { projectId: p.id });
    expect(view.agent).toBeNull();
    expect(view.chat.at(-1)).toMatchObject({
      role: "assistant",
      text: "Listo: **panadería**.",
      proposalId: proposal.id,
    });
    await f.call("proposal.apply", {
      projectId: p.id,
      proposalId: proposal.id,
      files: ["menu.html"],
    });
    expect(await readFile(work(f, p.id, "menu.html"), "utf8")).toBe("<h1>Carta</h1>\n");
  });

  it("refuses tool calls that do not come from a running Lumbre job (AGT-AC-01)", async () => {
    const f = await setup();
    const p = await existing(f);
    expect(
      await f.service.agentTool("lumbre_write_file", { path: "x.html", content: "x" }, undefined),
    ).toEqual({
      ok: false,
      error: "not_in_lumbre_job",
    });
    expect(await f.service.agentTool("lumbre_list_files", {}, "main-session")).toEqual({
      ok: false,
      error: "not_in_lumbre_job",
    });
    f.respond({ calls: [write("a.html", "a"), done()] });
    await send(f, p.id);
    // After the job, its child cannot change anything either.
    expect(
      await f.service.agentTool("lumbre_write_file", { path: "b.html", content: "b" }, "child-1"),
    ).toEqual({
      ok: false,
      error: "not_in_lumbre_job",
    });
  });
});

describe("plan approval", () => {
  it("plans with read-only tools, shows the token plan, then builds exactly the approved plan", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "La Espiga", stack: "vanilla" });
    f.respond({
      calls: [{ name: "lumbre_list_files" }, write("index.html", "nope")],
      text: `## Plan\n- Hero with the oven photo\n- Menu and opening hours\n\n<<<LUMBRE-DESIGN>>>\ndirection: Organic, sun-warmed\ncolor: Masa #F2E3C6\ncolor: Horno #9A3B1E\ncolor: Carbón #2A211C\ncolor: Hoja #6B7F4A\ntype: display | Georgia serif\ntype: body | system-ui\nlayout: Left-aligned hero, menu in two columns.\nprinciple: One warm accent.\nwireframe:\n| logo      menu |\n| headline [img] |\n<<<LUMBRE-END>>>`,
    });
    const job = await send(f, p.id, { mode: "plan" });
    expect(job.state).toBe("done");
    expect(f.specs[0]).toMatchObject({
      instructions: "instructions:plan",
      tools: { allow: allowedTools("plan") },
    });
    expect(allowedTools("plan")).toEqual([
      "p_1515755981_lumbre_list_files",
      "p_1515755981_lumbre_read_file",
    ]);
    expect(f.toolResults[1]).toEqual({ ok: false, error: "not_allowed_in_plan" });
    expect(f.prompts[0]).toMatch(/PLAN ONLY/);
    expect(f.prompts[0]).toContain("<<<LUMBRE-DESIGN>>>");
    let view = await f.call("projects.get", { projectId: p.id });
    const plan = view.chat.at(-1);
    expect(plan.text).toContain("Hero with the oven photo");
    expect(plan.text).not.toContain("LUMBRE");
    expect(plan.plan.status).toBe("pending");
    expect(plan.plan.design.palette).toHaveLength(4);
    expect(plan.plan.design.wireframe).toContain("headline [img]");
    expect(view.proposal).toBeNull();
    // A plan leaves no draft behind (no "paused" card after planning).
    await new Promise((r) => setTimeout(r, 400));
    expect((await f.call("projects.get", { projectId: p.id })).agent).toBeNull();

    f.respond({ calls: [write("index.html", "<h1>Pan</h1>\n"), done()] });
    const build = await send(f, p.id, { mode: "build", planId: plan.id, text: "Build this plan" });
    expect(build.state).toBe("done");
    expect(f.prompts[1]).toContain("# Approved plan (build exactly this)");
    expect(f.prompts[1]).toContain("Hero with the oven photo");
    view = await f.call("projects.get", { projectId: p.id });
    expect(view.chat.find((m: { id: string }) => m.id === plan.id).plan.status).toBe("approved");
    expect(view.proposal).not.toBeNull();

    // Discarding a plan stops its card from asking.
    f.respond({ text: "## Another plan" });
    await send(f, p.id, { mode: "plan" });
    view = await f.call("projects.get", { projectId: p.id });
    const second = view.chat.at(-1);
    view = await f.call("plan.discard", { projectId: p.id, messageId: second.id });
    expect(view.chat.at(-1).plan.status).toBe("discarded");
  });
});

describe("continue until done (AGT-AC-05)", () => {
  it("continues twice by itself, then pauses; Continue resumes on the same child with a goal", async () => {
    const f = await setup();
    const p = await existing(f);
    f.respond(
      { calls: [write("a.html", "a")], turnsExceeded: true },
      { calls: [write("b.html", "b")], turnsExceeded: true },
      { calls: [write("c.html", "c")], text: "I stopped." },
    );
    const job = await send(f, p.id);
    expect(job.state).toBe("done");
    expect(job.result).toEqual({ paused: true });
    expect(
      job.steps
        .filter((s: { key: string }) => s.key === "agentContinuing")
        .map((s: { args: unknown }) => s.args),
    ).toEqual([{ part: 2 }, { part: 3 }]);
    let view = await f.call("projects.get", { projectId: p.id });
    expect(view.agent).toMatchObject({ phase: "paused", pausedReason: "turns", changed: 3 });
    expect(view.chat.at(-1)).toMatchObject({ notice: "agent_paused" });
    expect(f.service.busy()).toBe(false);

    f.respond({ calls: [write("d.html", "d"), done()] });
    const resumed = await f.waitJob(
      (await f.call("agent.continue", { projectId: p.id, goal: "Add the opening hours" })).jobId,
    );
    expect(resumed.state).toBe("done");
    expect(new Set(f.runs)).toEqual(new Set(["child-1"]));
    expect(f.prompts[3]).toMatch(/Continue the build/);
    expect(f.prompts[3]).toContain("Add the opening hours");
    const proposal = await f.call("proposal.get", { projectId: p.id });
    expect(Object.keys(proposal.files).sort()).toEqual(["a.html", "b.html", "c.html", "d.html"]);
    view = await f.call("projects.get", { projectId: p.id });
    expect(view.agent).toBeNull();
  });

  it("keeps the draft on Cancel, stays reviewable early, and is busy only while running (AGT-AC-08, AGT-AC-09)", async () => {
    const f = await setup();
    const p = await existing(f);
    f.respond({ calls: [write("a.html", "<h1>A</h1>")], wait: true });
    const { jobId } = await f.call("chat.send", { projectId: p.id, text: "go" });
    for (let i = 0; i < 200 && !f.toolResults.length; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(f.service.busy()).toBe(true);
    await f.call("jobs.cancel", { jobId });
    const job = await f.waitJob(jobId);
    expect(job.state).toBe("cancelled");
    expect(f.service.busy()).toBe(false);
    let view = await f.call("projects.get", { projectId: p.id });
    expect(view.agent).toMatchObject({ phase: "paused", pausedReason: "cancelled", changed: 1 });
    // A new activation over the same state still shows the paused draft.
    const { Service } = await import("../src/service.js");
    const again = await new Service({ ...f.service.deps }).init();
    expect((await again.invoke("projects.get", { projectId: p.id }, f.ctx())).agent.phase).toBe(
      "paused",
    );
    again.dispose();
    view = await f.call("agent.review", { projectId: p.id });
    const proposal = await f.call("proposal.get", { projectId: p.id });
    expect(proposal.files).toEqual({ "a.html": "<h1>A</h1>" });
    expect(proposal.partial).toEqual({ received: 1, missing: [] });
    expect(view.agent).toBeNull();
  });
});

describe("models without tool calling (AGT-AC-06)", () => {
  it("detects a 0.1.1 answer instead of tool calls and finishes through the block path", async () => {
    const f = await setup({ toolCalling: "unknown" });
    const p = await existing(f);
    f.respond({ text: blocks({ "index.html": "<h1>Pan</h1>\n" }) });
    const job = await send(f, p.id);
    expect(job.state).toBe("done");
    expect(job.diagnostics.mode).toBe("blocks");
    expect(Object.keys((await f.call("proposal.get", { projectId: p.id })).files)).toEqual([
      "index.html",
    ]);
    // The model is remembered: the next request goes straight to the block format.
    f.respond({ text: blocks({ "about.html": "<h1>Nosotros</h1>\n" }) });
    await send(f, p.id, { text: "about page" });
    expect(f.prompts[1]).toContain("<<<LUMBRE-FILE path=");
    expect(f.prompts[1]).not.toMatch(/^BUILD:/m);
  });

  it("uses the block path directly when the catalog says the model has no tools", async () => {
    const f = await setup({ toolCalling: false });
    const p = await existing(f);
    f.respond({ text: blocks({ "index.html": "<h1>Pan</h1>\n" }) });
    const job = await send(f, p.id);
    expect(job.kind).toBe("generate");
    expect(f.specs[0]?.agent).toBe("lmb-builder");
  });
});

describe("autofix before review (AGT-AC-07)", () => {
  it("builds the draft copy with the installed packages, fixes twice on the same child, then reviews", async () => {
    const f = await setup({ draftBuildFailures: 2 });
    const p = await existing(f, "vite");
    await f.waitJob((await f.call("deps.install", { projectId: p.id })).jobId);
    await mkdir(work(f, p.id, "node_modules"), { recursive: true });
    await writeFile(work(f, p.id, "node_modules/marker.txt"), "x");
    f.respond(
      { calls: [write("src/main.js", "broken("), done()] },
      {
        calls: [
          {
            name: "lumbre_edit_file",
            input: { path: "src/main.js", find: "broken(", replace: "fixed(" },
          },
          done(),
        ],
      },
      {
        calls: [
          {
            name: "lumbre_edit_file",
            input: { path: "src/main.js", find: "fixed(", replace: "fixed()" },
          },
          done(),
        ],
      },
    );
    const job = await send(f, p.id);
    expect(job.result).toEqual({ needsCheck: true });
    expect((await f.call("projects.get", { projectId: p.id })).agent.phase).toBe("needs_check");
    const check = await f.waitJob((await f.call("agent.check", { projectId: p.id })).jobId);
    expect(check.state).toBe("done");
    expect(
      check.steps
        .filter((s: { key: string }) => s.key === "fixingDraft")
        .map((s: { args: unknown }) => s.args),
    ).toEqual([
      { round: 1, max: 2 },
      { round: 2, max: 2 },
    ]);
    expect(f.prompts[1]).toMatch(/automatic fix 1 of 2/);
    expect(f.prompts[1]).toContain("SyntaxError");
    expect(new Set(f.runs)).toEqual(new Set(["child-1"]));
    const draftRuntime = f.runtimes.find((r) => /[\\/]draft$/.test(r.options.dir));
    expect(draftRuntime?.builds).toBe(3);
    const projectRuntime = f.runtimes.find((r) => /[\\/]projects[\\/][^\\/]+$/.test(r.options.dir));
    expect(projectRuntime?.builds ?? 0).toBe(0);
    const draftWork = join(f.root, "state", "projects", p.id, "draft", "work");
    expect(await readFile(join(draftWork, "src", "main.js"), "utf8")).toBe("fixed()");
    expect(await readFile(join(draftWork, "node_modules", "marker.txt"), "utf8")).toBe("x");
    expect(
      existsSync(work(f, p.id, "src/main.js")) &&
        (await readFile(work(f, p.id, "src/main.js"), "utf8")),
    ).not.toBe("fixed()");
    const proposal = await f.call("proposal.get", { projectId: p.id });
    expect(proposal.files["src/main.js"]).toBe("fixed()");
    expect(proposal.checkFailed).toBeUndefined();
    expect(check.diagnostics.fixRounds).toBe(2);
  });

  it("hands the draft to review with a warning when it still fails after two fixes", async () => {
    const f = await setup({ draftBuildFailures: 5 });
    const p = await existing(f, "vite");
    f.respond(
      { calls: [write("src/main.js", "x("), done()] },
      { calls: [done()] },
      { calls: [done()] },
    );
    await send(f, p.id);
    const check = await f.waitJob((await f.call("agent.check", { projectId: p.id })).jobId);
    expect(check.result).toMatchObject({ checkFailed: true });
    expect((await f.call("proposal.get", { projectId: p.id })).checkFailed).toBe(true);
    const view = await f.call("projects.get", { projectId: p.id });
    expect(view.chat.at(-1)).toMatchObject({ notice: "agent_check_failed" });
  });
});
