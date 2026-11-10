import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { errorCode } from "../src/errors.js";
import { type Fixture, fixture } from "./service-fixture.js";

const open: Fixture[] = [];
async function setup(options?: Parameters<typeof fixture>[0]) {
  const f = await fixture(options);
  open.push(f);
  return f;
}
afterEach(async () => {
  for (const f of open.splice(0)) await f.cleanup();
});
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    return errorCode(error);
  }
  return "ok";
};
const work = (f: Fixture, id: string, path: string) =>
  join(f.root, "state", "projects", id, "work", ...path.split("/"));

describe("projects and generation", () => {
  it("creates a starter project, generates a proposal in a narrowed child session and keeps the chat", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "Bakery", stack: "vanilla" });
    expect(p.files.map((x: { path: string }) => x.path)).toEqual([
      "index.html",
      "script.js",
      "styles.css",
    ]);
    expect(await readFile(work(f, p.id, "index.html"), "utf8")).toContain("<h1>");

    f.answer({
      message: "I made a **bakery** page.",
      summary: "Bakery page",
      files: [
        { path: "index.html", content: "<html><body><h1>Fresh bread</h1></body></html>" },
        { path: "menu.html", content: "<h1>Menu</h1>" },
      ],
      delete: ["script.js"],
    });
    const { jobId } = await f.call("chat.send", {
      projectId: p.id,
      text: "A bakery site",
      locale: "es",
    });
    const job = await f.waitJob(jobId);
    expect(job.state).toBe("done");
    const keys = job.steps.map((s: { key: string }) => s.key);
    expect(keys[0]).toBe("thinking");
    expect(keys).toContain("writing");
    expect(keys).toContain("removing");
    expect(keys).toContain("reviewReady");
    expect(job.steps.find((s: { key: string }) => s.key === "writing").args).toMatchObject({
      file: "index.html",
      index: 1,
      count: 3,
    });
    expect(job.elapsedMs).toBeGreaterThanOrEqual(0);

    const spec = f.specs[0];
    expect(spec).toMatchObject({
      agent: "lmb-builder",
      parentId: "session-1",
      readOnly: true,
      tools: { allow: [] },
      permission: { write: "deny", process: "deny" },
      instructions: "instructions:build",
    });
    // Output budget follows the model's context window (64k here, half kept for the prompt);
    // no total-token cap, so continuations and batches fit in the host's own budget.
    expect(spec?.maxOutputTokens).toBe(32_000);
    expect(spec?.maxTokens).toBeUndefined();
    expect(f.prompts[0]).toContain("A bakery site");
    expect(f.prompts[0]).toMatch(/Spanish/);

    const view = await f.call("projects.get", { projectId: p.id });
    expect(view.proposal).toMatchObject({ summary: "Bakery page", fixAttempt: 0 });
    expect(view.chat.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(view.chat[1].text).toBe("I made a **bakery** page.");

    // A follow-up includes the conversation so far.
    f.answer({ message: "Sure.", files: [] });
    const second = await f.call("chat.send", { projectId: p.id, text: "And a menu?" });
    await f.waitJob(second.jobId);
    expect(f.prompts[1]).toContain("A bakery site");
    expect(f.prompts[1]).toContain("I made a **bakery** page.");
  });

  it("reviews a proposal per file: applies the chosen changes and deletions in place", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "Shop", stack: "vanilla" });
    f.answer({
      summary: "Two changes",
      files: [
        { path: "index.html", content: "<h1>New</h1>" },
        { path: "about.html", content: "<h1>About</h1>" },
      ],
      delete: ["script.js"],
    });
    await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "go" })).jobId);
    const proposal = await f.call("proposal.get", { projectId: p.id });
    expect(proposal.before["index.html"]).toContain("<h1>");
    expect(proposal.before["about.html"]).toBeNull();
    expect(proposal.deletes).toEqual(["script.js"]);

    const applied = await f.call("proposal.apply", {
      projectId: p.id,
      proposalId: proposal.id,
      files: ["about.html"],
      deletes: ["script.js"],
      dependencies: [],
    });
    expect(applied.proposal).toBeNull();
    expect(applied.revisions[0]).toMatchObject({ kind: "proposal", summary: "Two changes" });
    expect(await readFile(work(f, p.id, "about.html"), "utf8")).toBe("<h1>About</h1>");
    expect(await readFile(work(f, p.id, "index.html"), "utf8")).not.toBe("<h1>New</h1>");
    expect(existsSync(work(f, p.id, "script.js"))).toBe(false);
    expect(applied.chat.at(-1)).toMatchObject({ role: "notice", notice: "applied" });
  });

  it("applies changes while the live preview runs, so it hot-reloads (LMB-AC-05)", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "Live", stack: "vanilla" });
    await f.waitJob((await f.call("server.start", { projectId: p.id })).jobId);
    const r = f.runtimes[0];
    expect(r?.running).toBe(true);
    f.answer({ summary: "Edit", files: [{ path: "styles.css", content: "body{color:blue}" }] });
    await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "blue" })).jobId);
    const { id } = await f.call("proposal.get", { projectId: p.id });
    await f.call("proposal.apply", { projectId: p.id, proposalId: id, files: ["styles.css"] });
    expect(await readFile(work(f, p.id, "styles.css"), "utf8")).toBe("body{color:blue}");
    expect(r?.reloads).toBe(1);
    expect(r?.running).toBe(true);
  });

  it("keeps Lumbre-owned files out of the model's and the editor's reach (LMB-AC-06)", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "R", stack: "react" });
    expect(
      p.files.filter((x: { owned: boolean }) => x.owned).map((x: { path: string }) => x.path),
    ).toEqual(["package-lock.json", "package.json", "vite.config.js"]);
    f.answer({
      summary: "x",
      files: [
        { path: "vite.config.js", content: "export default {}" },
        { path: "src/App.jsx", content: "export default function App(){return null}" },
      ],
      dependencies: [
        { name: "lucide-react", version: "1.61.0" },
        { name: "left-pad", version: "1.3.0" },
      ],
    });
    await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "icons" })).jobId);
    const proposal = await f.call("proposal.get", { projectId: p.id });
    expect(Object.keys(proposal.files)).toEqual(["src/App.jsx"]);
    expect(proposal.dependencies).toEqual({ "lucide-react": "1.61.0" });
    expect(proposal.ignored).toEqual([
      { path: "vite.config.js", reason: "managed" },
      { name: "left-pad", reason: "not_allowed" },
    ]);
    const head = (await f.call("projects.get", { projectId: p.id })).head;
    expect(
      await failure(
        f.call("files.save", {
          projectId: p.id,
          path: "package.json",
          content: "{}",
          baseRevision: head,
        }),
      ),
    ).toBe("managed_file");
    expect(
      await failure(
        f.call("files.save", {
          projectId: p.id,
          path: "vite.config.js",
          content: "",
          baseRevision: head,
        }),
      ),
    ).toBe("managed_file");

    // Approving the package regenerates package.json and switches the next install to `npm install`.
    await f.call("proposal.apply", {
      projectId: p.id,
      proposalId: proposal.id,
      files: ["src/App.jsx"],
      dependencies: ["lucide-react"],
    });
    const pkg = await f.call("files.get", { projectId: p.id, path: "package.json" });
    expect(pkg.owned).toBe(true);
    expect(JSON.parse(pkg.content).dependencies["lucide-react"]).toBe("1.61.0");
    await mkdir(work(f, p.id, "node_modules"), { recursive: true });
    await writeFile(work(f, p.id, "package-lock.json"), '{"lockfileVersion":3}');
    await f.waitJob((await f.call("deps.install", { projectId: p.id })).jobId);
    expect(f.runtimes[0]?.installs).toEqual(["install"]);
  });

  it("blocks generation without a configured model and notes a model that disappeared", async () => {
    const none = await setup({ models: [] });
    const p = await none.call("projects.create", { title: "X", stack: "vanilla" });
    expect(await failure(none.call("chat.send", { projectId: p.id, text: "hi" }))).toBe("no_model");
    expect((await none.call("models.list")).available).toBe(false);

    const f = await setup({ models: [{ reference: "acme/fast" }], resolveFails: true });
    const q = await f.call("projects.create", { title: "Y", stack: "vanilla", model: "acme/gone" });
    f.answer({ message: "ok", files: [] });
    await f.waitJob((await f.call("chat.send", { projectId: q.id, text: "hi" })).jobId);
    const view = await f.call("projects.get", { projectId: q.id });
    expect(view.model).toBeNull();
    expect(view.chat.at(-1)).toMatchObject({ role: "assistant", modelFallback: true });
    expect(f.specs[0]?.model).toBeUndefined();
  });

  it("reports a failed generation in the chat with its code", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "X", stack: "vanilla" });
    f.answer("this is not json");
    const job = await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "hi" })).jobId);
    expect(job).toMatchObject({ state: "failed", error: "invalid_output" });
    const view = await f.call("projects.get", { projectId: p.id });
    expect(view.chat.at(-1)).toMatchObject({
      role: "notice",
      notice: "generation_failed",
      code: "invalid_output",
    });
  });
});

describe("automatic fix-up pass (LMB-AC-10)", () => {
  it("feeds a failing build to the model at most twice, each fix reviewed by the user", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "V", stack: "vite" });
    const fix = (n: number) => ({
      message: `Fixed the import (${n}).`,
      summary: `Fix ${n}`,
      files: [{ path: "src/main.js", content: `console.log(${n});` }],
    });
    f.answer(fix(1), fix(2));
    // Install happens once, then three builds fail.
    await f.waitJob((await f.call("deps.install", { projectId: p.id })).jobId);
    const r = f.runtimes[0];
    if (!r) throw new Error("no runtime");
    r.buildFailures = 3;

    const first = await f.waitJob((await f.call("preview.check", { projectId: p.id })).jobId);
    expect(first.state).toBe("done");
    expect(first.result).toMatchObject({ ok: false, attempt: 1 });
    expect(first.steps.map((s: { key: string }) => s.key)).toContain("fixing");
    expect(f.prompts[0]).toContain("SyntaxError: Unexpected token");
    expect(f.specs[0]?.instructions).toBe("instructions:fix");
    let proposal = await f.call("proposal.get", { projectId: p.id });
    expect(proposal.fixAttempt).toBe(1);
    await f.call("proposal.apply", {
      projectId: p.id,
      proposalId: proposal.id,
      files: ["src/main.js"],
    });

    const second = await f.waitJob((await f.call("preview.check", { projectId: p.id })).jobId);
    expect(second.result).toMatchObject({ ok: false, attempt: 2 });
    proposal = await f.call("proposal.get", { projectId: p.id });
    expect(proposal.fixAttempt).toBe(2);
    await f.call("proposal.apply", {
      projectId: p.id,
      proposalId: proposal.id,
      files: ["src/main.js"],
    });

    const third = await f.waitJob((await f.call("preview.check", { projectId: p.id })).jobId);
    expect(third).toMatchObject({ state: "failed", error: "build_failed" });
    expect(f.prompts.length).toBe(2);
    const view = await f.call("projects.get", { projectId: p.id });
    const notices = view.chat
      .filter((m: { role: string }) => m.role === "notice")
      .map((m: { notice: string }) => m.notice);
    expect(notices).toEqual([
      "build_failed",
      "applied",
      "build_failed",
      "applied",
      "fix_exhausted",
    ]);
    expect(view.revisions[0].kind).toBe("fix");

    // A good build resets the chain and stores a fresh thumbnail.
    const ok = await f.waitJob((await f.call("preview.check", { projectId: p.id })).jobId);
    expect(ok.result).toEqual({ ok: true });
    expect(ok.steps.map((s: { key: string }) => s.key)).toEqual(
      expect.arrayContaining(["building", "thumbnail", "done"]),
    );
  });

  it("probes the running preview instead of building", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "V", stack: "vite" });
    await f.waitJob((await f.call("server.start", { projectId: p.id })).jobId);
    const r = f.runtimes[0];
    const ok = await f.waitJob((await f.call("preview.check", { projectId: p.id })).jobId);
    expect(ok.result).toEqual({ ok: true });
    expect(r?.builds).toBe(0);
    expect(ok.steps.map((s: { key: string }) => s.key)).toContain("checking");
  });
});

describe("export, zip, lifecycle", () => {
  it("exports into a new workspace folder only, and downloads a ZIP (LMB-AC-11)", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "Café Luna", stack: "next" });
    const out = await f.call("project.export", { projectId: p.id, folder: "sites/cafe" });
    expect(out.folder).toBe("sites/cafe");
    expect(await readFile(join(f.workspace, "sites", "cafe", "app", "page.jsx"), "utf8")).toContain(
      "export default",
    );
    expect(
      JSON.parse(await readFile(join(f.workspace, "sites", "cafe", "package.json"), "utf8"))
        .dependencies.next,
    ).toBeTruthy();
    expect(await failure(f.call("project.export", { projectId: p.id, folder: "sites/cafe" }))).toBe(
      "export_exists",
    );
    expect(await failure(f.call("project.export", { projectId: p.id, folder: "../escape" }))).toBe(
      "invalid_path",
    );
    await symlink(join(f.root), join(f.workspace, "link"));
    expect(
      await failure(f.call("project.export", { projectId: p.id, folder: "link/inside" })),
    ).toBe("export_exists");

    const z = await f.call("project.zip", { projectId: p.id });
    expect(z.name).toBe("cafe-luna.zip");
    expect(Buffer.from(z.base64, "base64").subarray(0, 2).toString()).toBe("PK");
  });

  it("is busy while a job or a preview runs, and dispose stops everything", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "B", stack: "vanilla" });
    expect(f.service.busy()).toBe(false);
    await f.waitJob((await f.call("server.start", { projectId: p.id })).jobId);
    expect(f.service.busy()).toBe(true);
    f.service.dispose();
    f.service.dispose();
    expect(f.service.busy()).toBe(false);
    expect(await failure(f.call("projects.list"))).toBe("unavailable");
  });

  it("guards concurrent edits, retries and cancellation", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "C", stack: "vanilla" });
    expect(
      await failure(
        f.call("files.save", {
          projectId: p.id,
          path: "a.js",
          content: "1",
          baseRevision: "00000000-0000-0000-0000-000000000000",
        }),
      ),
    ).toBe("conflict");
    const saved = await f.call(
      "files.save",
      { projectId: p.id, path: "a.js", content: "1", baseRevision: p.head },
      "same",
    );
    const again = await f.call(
      "files.save",
      { projectId: p.id, path: "a.js", content: "1", baseRevision: p.head },
      "same",
    );
    expect(again.head).toBe(saved.head);
    expect(
      await failure(
        f.call(
          "files.save",
          { projectId: p.id, path: "a.js", content: "2", baseRevision: p.head },
          "same",
        ),
      ),
    ).toBe("conflict");

    f.answer("__slow__");
    const { jobId } = await f.call("chat.send", { projectId: p.id, text: "slow" });
    for (let i = 0; i < 100 && !f.prompts.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await failure(f.call("chat.send", { projectId: p.id, text: "again" }))).toBe(
      "project_busy",
    );
    await f.call("jobs.cancel", { jobId });
    const job = await f.waitJob(jobId);
    expect(job.state).toBe("cancelled");
  });

  it("lists a damaged project without breaking the others and lets the user delete it", async () => {
    const f = await setup();
    const good = await f.call("projects.create", { title: "Good", stack: "vanilla" });
    const bad = await f.call("projects.create", { title: "Bad", stack: "vanilla" });
    await writeFile(join(f.root, "state", "projects", bad.id, "meta.json"), "{");
    const fresh = await fixtureFrom(f);
    const list = await fresh.invoke("projects.list", {}, f.ctx());
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: good.id, damaged: false }),
        { id: bad.id, damaged: true },
      ]),
    );
    expect(await failure(fresh.invoke("projects.get", { projectId: bad.id }, f.ctx()))).toBe(
      "damaged_project",
    );
    expect(await fresh.invoke("projects.delete", { projectId: bad.id }, f.ctx("del"))).toEqual({
      deleted: true,
    });
    fresh.dispose();
  });
});

/** A second activation over the same state directory. */
async function fixtureFrom(f: Fixture) {
  const { Service } = await import("../src/service.js");
  return new Service({ ...f.service.deps }).init();
}

describe("Astro React feature through the review", () => {
  it("never lets the model edit the config, and applies the vetted transform when approved", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "A", stack: "astro" });
    f.answer({
      summary: "Island",
      files: [
        { path: "astro.config.mjs", content: "export default {}" },
        { path: "src/components/Counter.jsx", content: "export default () => null;" },
      ],
      dependencies: [{ name: "@astrojs/react", version: "7.1.1" }],
    });
    await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "a counter" })).jobId);
    const proposal = await f.call("proposal.get", { projectId: p.id });
    expect(proposal.ignored).toEqual([{ path: "astro.config.mjs", reason: "managed" }]);
    expect(proposal.dependencies).toEqual({ "@astrojs/react": "7.1.1" });
    await f.call("proposal.apply", {
      projectId: p.id,
      proposalId: proposal.id,
      files: ["src/components/Counter.jsx"],
      dependencies: ["@astrojs/react"],
    });
    const config = await f.call("files.get", { projectId: p.id, path: "astro.config.mjs" });
    expect(config.owned).toBe(true);
    expect(config.content).toContain("integrations: [react()]");
    expect(await readFile(work(f, p.id, "astro.config.mjs"), "utf8")).toContain(
      "integrations: [react()]",
    );
    const pkg = JSON.parse(
      (await f.call("files.get", { projectId: p.id, path: "package.json" })).content,
    );
    expect(pkg.dependencies).toMatchObject({
      react: "19.3.1",
      "react-dom": "19.3.1",
      "@astrojs/react": "7.1.1",
    });
  });
});
