import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { readState } from "../src/storage.js";
import {
  cleanup,
  harness,
  PROFILE_ANSWERS,
  ROUND1,
  ROUND2,
  ROUND3,
  scratchDir,
} from "./helpers/harness.js";

afterEach(cleanup);

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("plugin entry", () => {
  it("declares id, category and api version", () => {
    expect(plugin).toMatchObject({
      id: "evalua",
      apiVersion: 1,
      categories: ["methodology-harness"],
    });
  });

  it("registers the Phase 1 tools and commands and no resource directories", async () => {
    const h = await harness();
    expect([...h.tools.keys()].sort()).toEqual([
      "evalua_answer",
      "evalua_profile",
      "evalua_status",
    ]);
    expect([...h.commands.keys()].sort()).toEqual(["init", "new", "status"]);
    expect(h.resources).toEqual({ agents: 0, skills: 0 });
    expect(h.tools.get("evalua_status")?.effect).toBe("read");
    expect(h.tools.get("evalua_profile")?.effect).toBe("write");
    expect(h.tools.get("evalua_answer")?.effect).toBe("write");
  });
});

describe("interactive flow", () => {
  it("asks the profile once, then rounds 1 to 3, and stores a draft without creating a folder", async () => {
    const h = await harness({ answers: [PROFILE_ANSWERS, ROUND1, ROUND2, ROUND3] });
    const message = await h.run("new");
    expect(h.asked.map((r) => r.questions.map((q) => q.id))).toEqual([
      ["teacher_name", "institution", "logo", "subject"],
      ["topic", "grade", "level"],
      ["types", "count", "distribution", "columns"],
      ["pages", "time", "closing"],
    ]);
    for (const request of h.asked) expect(request.questions.length).toBeLessThanOrEqual(4);
    expect(await readFile(join(h.workspace, "evalua", "teacher.yaml"), "utf8")).toContain(
      "teacherName: Ana Perez",
    );
    const state = await readState(h.workspace);
    expect(state?.interview?.pending).toBeUndefined();
    expect(state?.draft).toMatchObject({
      title: "EVALUACIÓN DE MATEMÁTICAS - GRADO SÉPTIMO",
      theme: "NÚMEROS RACIONALES",
      schoolYear: 2026,
      questionCount: 10,
      itemTypes: { single_choice: 5, practice: 5 },
    });
    expect(await exists(join(h.workspace, "evalua", "exams"))).toBe(false);
    expect(message).toContain("EVALUACIÓN DE MATEMÁTICAS - GRADO SÉPTIMO");
    expect(message).toContain("Gate A");
  });

  it("never asks the profile questions again once teacher.yaml exists", async () => {
    const h = await harness({ answers: [PROFILE_ANSWERS, ROUND1, ROUND2, ROUND3] });
    await h.run("new");
    const second = await harness({ workspace: h.workspace, answers: [ROUND1, ROUND2, ROUND3] });
    await second.run("new");
    const ids = second.asked.flatMap((r) => r.questions.map((q) => q.id));
    expect(ids).not.toContain("teacher_name");
    expect(ids).not.toContain("institution");
    expect(second.asked).toHaveLength(3);
  });

  it("asks the bank follow-up only for bank distribution", async () => {
    const h = await harness({
      answers: [
        PROFILE_ANSWERS,
        ROUND1,
        { ...ROUND2, distribution: "bank" },
        { bank_size: "default", variants: "2" },
        ROUND3,
      ],
    });
    await h.run("new");
    expect(h.asked.map((r) => r.questions.map((q) => q.id))[3]).toEqual(["bank_size", "variants"]);
    const state = await readState(h.workspace);
    expect(state?.draft?.bank).toEqual({ size: 30, variants: 2 });
  });

  it("uses the command argument as the topic and skips that question", async () => {
    const h = await harness({
      answers: [PROFILE_ANSWERS, { grade: "octavo", level: "intermedio" }, ROUND2, ROUND3],
    });
    await h.run("new", "Ecuaciones lineales");
    expect(h.asked[1]?.questions.map((q) => q.id)).toEqual(["grade", "level"]);
    expect((await readState(h.workspace))?.draft?.theme).toBe("ECUACIONES LINEALES");
  });

  it("re-parks when an answer is invalid instead of advancing", async () => {
    const h = await harness({ answers: [PROFILE_ANSWERS, { ...ROUND1, level: "dificil" }] });
    const message = await h.run("new");
    expect(message).toContain("not allowed");
    const state = await readState(h.workspace);
    expect(state?.interview?.pending?.round).toBe("1");
    expect(state?.interview?.pending?.questions.map((q) => q.id)).toEqual(["level"]);
  });
});

describe("headless continuation", () => {
  it("parks the pending round in state and continues from /evalua:new answers", async () => {
    const h = await harness({ interactive: false });
    const first = await h.run("new");
    expect(first).toContain("teacher_name");
    expect(first).toContain("/evalua:new");
    expect((await readState(h.workspace))?.interview?.pending?.round).toBe("profile");
    expect(h.asked).toHaveLength(0);

    const second = await h.run(
      "new",
      "teacher_name=enter teacher_name:text=Ana Perez institution=enter institution:text=Instituto Demo logo=none subject=math",
    );
    expect(await exists(join(h.workspace, "evalua", "teacher.yaml"))).toBe(true);
    expect(second).toContain("topic");

    await h.run("new", "topic=Fracciones grade=septimo level=basico");
    await h.run("new", "types=single_choice count=10 distribution=same columns=1");
    const done = await h.run("new", "pages=auto time=90-pencil closing=none");
    expect(done).toContain("Gate A");
    const state = await readState(h.workspace);
    expect(state?.draft?.durationMinutes).toBe(90);
    expect(state?.interview?.pending).toBeUndefined();
  });

  it("evalua_answer persists answers for the pending round and reports the next one", async () => {
    const h = await harness({ interactive: false });
    await h.run("new");
    const wrong = await h.tool("evalua_answer", { answers: { bogus: "x" } });
    expect(wrong.isError).toBe(true);
    const ok = await h.tool("evalua_answer", {
      answers: {
        teacher_name: "enter",
        "teacher_name:text": "Ana",
        institution: "enter",
        "institution:text": "Demo",
        logo: "none",
        subject: "math",
      },
    });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("topic");
    expect((await readState(h.workspace))?.interview?.pending?.round).toBe("1");
  });

  it("evalua_answer without a pending round is a clear error", async () => {
    const h = await harness({ interactive: false });
    const result = await h.tool("evalua_answer", { answers: { a: "b" } });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no pending/i);
  });
});

describe("init", () => {
  it("runs only the profile round and honors a custom root", async () => {
    const h = await harness({ answers: [PROFILE_ANSWERS] });
    const message = await h.run("init", "docs/evalua");
    expect(await exists(join(h.workspace, "docs", "evalua", "teacher.yaml"))).toBe(true);
    expect(h.asked).toHaveLength(1);
    expect(message).toContain("docs/evalua");
    expect((await readState(h.workspace))?.root).toBe("docs/evalua");
  });

  it("refuses an unsafe root and refuses to move an existing workspace", async () => {
    const h = await harness();
    await expect(h.run("init", "../escape")).rejects.toThrow();
    const ok = await harness({ answers: [PROFILE_ANSWERS] });
    await ok.run("init");
    await expect(ok.run("init", "other")).rejects.toThrow(/cannot be moved/);
  });

  it("does not ask again when the profile exists, unless --edit", async () => {
    const h = await harness({ answers: [PROFILE_ANSWERS] });
    await h.run("init");
    const again = await h.run("init");
    expect(h.asked).toHaveLength(1);
    expect(again).toContain("already");
    h.queue({ teacher_name: "keep", institution: "keep", logo: "keep", subject: "keep" });
    await h.run("init", "--edit");
    expect(h.asked).toHaveLength(2);
    expect(h.asked[1]?.questions[0]?.options[0]?.value).toBe("keep");
    expect(await readFile(join(h.workspace, "evalua", "teacher.yaml"), "utf8")).toContain(
      "Ana Perez",
    );
  });

  it("copies a valid logo and re-asks only the logo question on an invalid one", async () => {
    const source = join(await scratchDir(), "school.png");
    await writeFile(source, PNG);
    const h = await harness({
      answers: [{ ...PROFILE_ANSWERS, logo: "path", "logo:text": "/scratch/p/missing.png" }],
    });
    const failed = await h.run("init");
    expect(failed).toMatch(/not found/i);
    expect((await readState(h.workspace))?.interview?.pending?.questions.map((q) => q.id)).toEqual([
      "logo",
    ]);
    h.queue({ logo: "path", "logo:text": source });
    await h.run("init");
    expect(await readFile(join(h.workspace, "evalua", "assets", "logo.png"))).toEqual(PNG);
    expect(await readFile(join(h.workspace, "evalua", "teacher.yaml"), "utf8")).toContain(
      "logo: assets/logo.png",
    );
  });
});

describe("status", () => {
  it("reports no workspace, pending interview and draft ready", async () => {
    const h = await harness({ interactive: false });
    expect(await h.run("status")).toMatch(/no evalua workspace/i);
    await h.run("new");
    expect(await h.run("status")).toMatch(/profile.*pending|pending.*profile/i);
    const tool = JSON.parse((await h.tool("evalua_status")).text);
    expect(tool).toMatchObject({
      initialized: true,
      profile: false,
      pendingRound: "profile",
      draft: false,
    });
    expect(tool.pendingQuestionIds).toEqual(["teacher_name", "institution", "logo", "subject"]);
  });

  it("lists exam folders found on disk and the draft summary", async () => {
    const h = await harness({ answers: [PROFILE_ANSWERS, ROUND1, ROUND2, ROUND3] });
    await h.run("new");
    await mkdir(join(h.workspace, "evalua", "exams", "02-algo"), { recursive: true });
    const status = JSON.parse((await h.tool("evalua_status")).text);
    expect(status.draft).toBe(true);
    expect(status.exams).toEqual(["02-algo"]);
    expect(status.nextExamNumber).toBe(3);
    expect(await h.run("status")).toContain("Gate A");
    expect(await readdir(join(h.workspace, "evalua", "exams"))).toEqual(["02-algo"]);
  });
});

describe("evalua_profile", () => {
  it("gets, sets and validates the profile", async () => {
    const h = await harness();
    expect((await h.tool("evalua_profile", { action: "get" })).text).toMatch(/no teacher profile/i);
    const set = await h.tool("evalua_profile", {
      action: "set",
      teacherName: "Ana",
      institution: "Demo",
    });
    expect(set.isError).toBe(false);
    const got = JSON.parse((await h.tool("evalua_profile", { action: "get" })).text);
    expect(got.profile).toMatchObject({
      teacherName: "Ana",
      institution: "Demo",
      subject: "Matemáticas",
      paper: "letter",
    });
    const bad = await h.tool("evalua_profile", { action: "set", paper: "legal" });
    expect(bad.isError).toBe(true);
    const merged = await h.tool("evalua_profile", { action: "set", subject: "Álgebra" });
    expect(merged.isError).toBe(false);
    expect(
      JSON.parse((await h.tool("evalua_profile", { action: "get" })).text).profile,
    ).toMatchObject({
      teacherName: "Ana",
      subject: "Álgebra",
    });
  });

  it("rejects SVG logos and accepts a PNG by path", async () => {
    const h = await harness();
    const dir = await scratchDir();
    await writeFile(join(dir, "a.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await writeFile(join(dir, "a.png"), PNG);
    await h.tool("evalua_profile", { action: "set", teacherName: "Ana", institution: "Demo" });
    expect(
      (await h.tool("evalua_profile", { action: "set", logoPath: join(dir, "a.svg") })).isError,
    ).toBe(true);
    const ok = await h.tool("evalua_profile", { action: "set", logoPath: join(dir, "a.png") });
    expect(ok.isError).toBe(false);
    expect(await exists(join(h.workspace, "evalua", "assets", "logo.png"))).toBe(true);
    const removed = await h.tool("evalua_profile", { action: "set", removeLogo: true });
    expect(removed.isError).toBe(false);
    expect(
      JSON.parse((await h.tool("evalua_profile", { action: "get" })).text).profile.logo,
    ).toBeUndefined();
  });

  it("requires name and institution for the first set", async () => {
    const h = await harness();
    const result = await h.tool("evalua_profile", { action: "set", subject: "Algebra" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/teacherName/);
  });
});
