import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain browser module without declarations.
import { copyPayload } from "../web/copy.js";
// @ts-expect-error -- plain browser module without declarations.
import * as derive from "../web/derive.js";
// @ts-expect-error -- plain browser module without declarations.
import { messages, resolveLocale } from "../web/i18n.js";
// @ts-expect-error -- plain browser module without declarations.
import { renderMarkdown } from "../web/markdown.js";

type Step = { phase: string; state: string };

describe("stepper (THA-AC-22)", () => {
  it("marks done, current and locked phases in lifecycle order", () => {
    expect(derive.PHASES).toEqual([
      "intake",
      "design",
      "outline",
      "sections",
      "review",
      "final",
      "submitted",
    ]);
    const steps = derive.stepper("outline") as Step[];
    expect(steps.map((s) => s.state)).toEqual([
      "done",
      "done",
      "current",
      "locked",
      "locked",
      "locked",
      "locked",
    ]);
    expect((derive.stepper(null) as Step[]).map((s) => s.state)).toEqual([
      "current",
      "locked",
      "locked",
      "locked",
      "locked",
      "locked",
      "locked",
    ]);
    expect((derive.stepper("submitted") as Step[]).every((s) => s.state === "done")).toBe(true);
  });
});

describe("chapter card actions (THA-AC-22)", () => {
  const keys = (section: unknown, spawn = true) =>
    (derive.sectionActions(section, spawn) as { key: string; disabled: boolean }[]).map((a) =>
      a.disabled ? `${a.key}!` : a.key,
    );
  it("offers the actions each status allows", () => {
    expect(keys({ id: "SEC-01", status: "planned", next: { action: "research.run" } })).toEqual([
      "research",
    ]);
    expect(keys({ id: "SEC-01", status: "planned", next: { action: "draft.run" } })).toEqual([
      "writeDraft",
    ]);
    expect(
      keys({ id: "SEC-01", status: "planned", next: { action: "wait", waitsFor: ["SEC-02"] } }),
    ).toEqual(["research!"]);
    expect(keys({ id: "SEC-01", status: "research_review" })).toEqual([
      "approveResearch",
      "searchMore",
      "addSource",
      "requestChanges",
    ]);
    expect(keys({ id: "SEC-01", status: "research_approved" })).toEqual([
      "writeDraft",
      "searchMore",
      "addSource",
    ]);
    expect(keys({ id: "SEC-01", status: "draft_review" })).toEqual([
      "approve",
      "requestChanges",
      "addFigure",
    ]);
    expect(keys({ id: "SEC-01", status: "approved" })).toEqual(["requestChanges", "addFigure"]);
  });
  it("disables child-spawning actions without a model (no_model) but keeps approvals", () => {
    expect(keys({ id: "SEC-01", status: "draft_review" }, false)).toEqual([
      "approve",
      "requestChanges!",
      "addFigure!",
    ]);
    expect(derive.canSpawn({ models: [], active: null })).toBe(false);
    expect(derive.canSpawn({ models: [], active: "openai/x" })).toBe(true);
    expect(derive.canSpawn(undefined)).toBe(true);
  });
});

describe("findings, jobs and next step (THA-AC-22)", () => {
  it("groups findings by severity with the blocking count", () => {
    const groups = derive.findingGroups([
      { id: "FND-0001", severity: "minor", status: "open" },
      { id: "FND-0002", severity: "critical", status: "open" },
      { id: "FND-0003", severity: "major", status: "dismissed" },
      { id: "FND-0004", severity: "major", status: "open" },
    ]);
    expect(
      groups.groups.map((g: { severity: string; items: unknown[] }) => [
        g.severity,
        g.items.length,
      ]),
    ).toEqual([
      ["critical", 1],
      ["major", 2],
      ["minor", 1],
    ]);
    expect(groups.blocking).toBe(2);
  });

  it("maps role progress lines to plain labels and job kinds to titles", () => {
    expect(derive.progressLabel("thesis-librarian: running")).toEqual({ key: "role_librarian" });
    expect(derive.progressLabel("thesis-evidence-auditor: running")).toEqual({
      key: "role_evidence_auditor",
    });
    expect(derive.progressLabel("compiling with Typst")).toEqual({ text: "compiling with Typst" });
    expect(derive.jobTitle({ kind: "draft.run", target: "SEC-03" })).toEqual({
      key: "job_draft",
      target: "SEC-03",
    });
    expect(derive.formatElapsed(65_000)).toBe("1:05");
  });

  it("turns the backend next step into one primary card", () => {
    expect(
      derive.nextCard({
        nextStep: { action: "finalize.run", phase: "review", reasonKey: "finalize" },
        gates: { C: { status: "pending" } },
      }),
    ).toMatchObject({ action: "approve", target: "C", screen: "build" });
    expect(
      derive.nextCard({
        nextStep: { action: "approve", target: "A", phase: "design", reasonKey: "approve_gate_a" },
        gates: {},
      }),
    ).toMatchObject({ screen: "plans", reasonKey: "approve_gate_a" });
    expect(
      derive.nextCard({
        nextStep: {
          action: "approve",
          target: "SEC-02",
          phase: "sections",
          reasonKey: "approve_draft",
        },
        gates: {},
      }),
    ).toMatchObject({ screen: "chapters", target: "SEC-02" });
    expect(
      derive.nextCard({
        nextStep: {
          action: "draft.run",
          target: "SEC-02",
          phase: "sections",
          reasonKey: "write_draft",
        },
        gates: {},
      }),
    ).toMatchObject({ run: true, action: "draft.run", input: { section: "SEC-02" } });
  });

  it("names a missing permission from the host effect, else from the action", () => {
    expect(derive.responseError({ error: "not_permitted", effect: "process" }, "write")).toBe(
      "not_permitted_process",
    );
    expect(derive.responseError({ error: "not_permitted" }, derive.effectOf("build.run"))).toBe(
      "not_permitted_process",
    );
    expect(derive.effectOf("approve")).toBe("write");
    expect(derive.effectOf("status")).toBe("read");
    expect(derive.responseError({ result: { error: "busy" } }, "write")).toBe("busy");
    expect(derive.responseError({ result: { value: 1 } }, "read")).toBeNull();
  });

  it("flags interrupted runs only when no job is running", () => {
    const sections = [
      { id: "SEC-01", status: "drafting" },
      { id: "SEC-02", status: "approved" },
    ];
    expect(derive.staleSections({ sections, job: null })).toEqual(["SEC-01"]);
    expect(derive.staleSections({ sections, job: { id: "job-1" } })).toEqual([]);
  });
});

describe("i18n (THA-AC-23)", () => {
  it("defines every key in English and Spanish", () => {
    const walk = (en: unknown, es: unknown, at: string): string[] => {
      if (typeof en === "function") return typeof es === "function" ? [] : [at];
      if (en && typeof en === "object") {
        const missing: string[] = [];
        for (const key of new Set([...Object.keys(en), ...Object.keys(es ?? {})]))
          missing.push(
            ...walk(
              (en as Record<string, unknown>)[key],
              (es as Record<string, unknown> | undefined)?.[key],
              `${at}.${key}`,
            ),
          );
        return missing;
      }
      return typeof es === typeof en && es !== undefined ? [] : [at];
    };
    expect(walk(messages.en, messages.es, "")).toEqual([]);
    expect(walk(messages.es, messages.en, "")).toEqual([]);
  });

  it("follows the host locale: es-CO is Spanish, fr is English", () => {
    expect(resolveLocale("es-CO")).toBe("es");
    expect(resolveLocale("ES")).toBe("es");
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });

  it("has singular and plural forms", () => {
    expect(messages.en.sectionsApproved(1, 1)).toContain("1 of 1 chapter approved");
    expect(messages.en.sectionsApproved(2, 5)).toContain("2 of 5 chapters approved");
    expect(messages.es.sectionsApproved(1, 1)).toContain("1 de 1 capítulo aprobado");
    expect(messages.es.sectionsApproved(2, 5)).toContain("2 de 5 capítulos aprobados");
  });

  it("never adds the disclaimer to copied content", () => {
    const source = { text: "# Marco\n\nTexto [@lopez2020].", markdown: true };
    for (const formatted of [false, true]) {
      const payload = copyPayload(source, renderMarkdown, formatted);
      for (const locale of ["en", "es"]) {
        expect(payload.text).not.toContain(messages[locale].disclaimer);
        expect(payload.html ?? "").not.toContain(messages[locale].disclaimer);
      }
    }
  });
});

describe("safe Markdown for thesis text", () => {
  it("escapes HTML, hides claim anchors, shows citations as chips and links as text", () => {
    const html = renderMarkdown(
      "<!-- claim:c1 -->\nLa evidencia <script>x</script> [@lopez2020; @diaz2019] y [ver](https://ejemplo.org)[^1].\n\n[^1]: Nota.",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("claim:c1");
    expect(html).toContain('<span class="cite-key">lopez2020</span>');
    expect(html).toContain('<span class="cite-key">diaz2019</span>');
    expect(html).not.toContain("<a ");
    expect(html).toContain("ver (https://ejemplo.org)");
    expect(html).toContain('<sup class="fn">1</sup>');
    const plain = renderMarkdown("Texto [@lopez2020].", { chips: false });
    expect(plain).toContain("[@lopez2020]");
  });
});
