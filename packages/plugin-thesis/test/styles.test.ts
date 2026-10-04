import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject, runChecks } from "../src/checks/index.js";
import { typstProfile } from "../src/render/adapters/typst-pdf/profile.js";
import { listStyles } from "../src/style-commands.js";
import { inspectCsl, loadCatalog, readShippedStyle, shippedStyleIds } from "../src/styles/csl.js";
import { resolveCitationStyle, resolvePresentationProfile } from "../src/styles/discovery.js";
import {
  loadShippedProfile,
  parseProfileText,
  resolveWorkspaceProfile,
  shippedProfileIds,
} from "../src/styles/profile.js";
import { parseXml, XmlError } from "../src/styles/xml.js";
import { cleanSamples, sampleThesis } from "./helpers/sample.js";

afterEach(cleanSamples);

const validCsl = (id = "thesis-test", extra = "") => `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
  <info>
    <title>Test</title>
    <id>${id}</id>
    <updated>2026-10-04T00:00:00+00:00</updated>
    <rights license="http://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</rights>
    ${extra}
  </info>
  <citation><layout><text variable="title"/></layout></citation>
  <bibliography><layout><text variable="title"/></layout></bibliography>
</style>`;

describe("safe XML reader", () => {
  it("parses elements, attributes, comments, CDATA and predefined entities", () => {
    const root = parseXml(
      '<?xml version="1.0"?><!-- c --><a x="1 &amp; 2"><b>t &lt; u</b><c/><![CDATA[<raw>]]></a>',
    );
    expect(root).toMatchObject({ name: "a", attrs: { x: "1 & 2" } });
    expect(root.children.map((child) => child.name)).toEqual(["b", "c"]);
    expect(root.children[0]?.text).toBe("t < u");
    expect(root.text).toBe("<raw>");
  });

  it("rejects DOCTYPE, ENTITY, custom entities and malformed markup", () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow(XmlError);
    expect(() => parseXml('<!DOCTYPE a SYSTEM "http://evil/x.dtd"><a/>')).toThrow(/DOCTYPE/);
    expect(() => parseXml("<a>&xxe;</a>")).toThrow(/not allowed/);
    expect(() => parseXml("<a><b></a>")).toThrow(XmlError);
    expect(() => parseXml("<a x=1/>")).toThrow(XmlError);
    expect(() => parseXml("<a/><b/>")).toThrow(XmlError);
    expect(() => parseXml(`<a>${"<b>".repeat(80)}`)).toThrow(XmlError);
  });
});

describe("CSL-001", () => {
  it("accepts the shipped styles", () => {
    expect(loadCatalog().map((entry) => entry.id)).toEqual([
      "apa-7",
      "ieee",
      "icontec-ntc1486-2022",
    ]);
    for (const entry of loadCatalog()) {
      const style = readShippedStyle(entry.id);
      expect(inspectCsl(style?.text ?? "").issues, entry.id).toEqual([]);
      expect(style?.text).toContain("<rights");
    }
    expect(readShippedStyle("icontec-ntc1486-2022")?.provisional).toBe(true);
    expect(
      inspectCsl(readShippedStyle("icontec-ntc1486-2022")?.text ?? "").info?.citationFormat,
    ).toBe("note");
  });

  it("accepts a valid workspace style; the id may be a URL ending in the stem", () => {
    const shipped = shippedStyleIds();
    expect(inspectCsl(validCsl(), { stem: "thesis-test", shipped }).issues).toEqual([]);
    expect(
      inspectCsl(validCsl("https://example.org/styles/thesis-test"), {
        stem: "thesis-test",
        shipped,
      }).issues,
    ).toEqual([]);
  });

  it("rejects DOCTYPE/entities, shadowed and mismatched ids, parents and missing parts", () => {
    const shipped = shippedStyleIds();
    const messages = (text: string, stem = "thesis-test") =>
      inspectCsl(text, { stem, shipped })
        .issues.map((issue) => issue.message)
        .join(" | ");
    expect(messages('<!DOCTYPE style [<!ENTITY x "y">]>' + validCsl())).toMatch(
      /DOCTYPE or ENTITY/,
    );
    expect(messages(validCsl("apa-7"), "apa-7")).toMatch(/shadows/);
    expect(messages(validCsl("apa"), "apa")).toMatch(/shadows/);
    expect(messages(validCsl("other"))).toMatch(/must match/);
    expect(
      messages(
        validCsl("thesis-test", '<link href="https://x.org/parent" rel="independent-parent"/>'),
      ),
    ).toMatch(/independent-parent/);
    expect(messages(validCsl().replace(/<rights[\s\S]*?<\/rights>/, ""))).toMatch(/<rights>/);
    expect(
      messages(validCsl().replace("<bibliography>", "<x>").replace("</bibliography>", "</x>")),
    ).toMatch(/<bibliography>/);
    expect(
      messages(
        validCsl().replace('class="in-text" version="1.0"', 'class="in-text" version="1.1"'),
      ),
    ).toMatch(/1\.0\.2/);
    expect(messages("<style", "thesis-test")).toMatch(/well-formed/);
    expect(messages(validCsl("Bad_Id"), "Bad_Id")).toMatch(/valid style id/);
  });

  it("resolves shipped styles first and workspace styles by id", () => {
    expect(resolveCitationStyle("apa-7", []).style?.file).toBe("apa.csl");
    const workspace = [{ id: "thesis-test", file: "styles/thesis-test.csl", text: validCsl() }];
    expect(resolveCitationStyle("thesis-test", workspace).style).toMatchObject({
      source: "workspace",
      file: "thesis-test.csl",
    });
    expect(resolveCitationStyle("missing", workspace).issues).toHaveLength(1);
  });
});

describe("presentation profiles (PRF-001)", () => {
  it("ships four fully resolved profiles; icontec carries run-in headings and the pag. column", () => {
    expect(shippedProfileIds()).toEqual(["apa-7", "generic", "icontec-ntc1486-2022", "ieee"]);
    for (const id of shippedProfileIds()) {
      const profile = loadShippedProfile(id);
      expect(profile?.headings).toHaveLength(4);
    }
    const icontec = loadShippedProfile("icontec-ntc1486-2022");
    expect(icontec?.headings[2]).toMatchObject({ runIn: true, endsWith: "." });
    expect(icontec?.headings[0]).toMatchObject({ case: "upper", align: "center" });
    expect(icontec?.toc).toMatchObject({ depth: 4, pageLabel: true });
    expect(icontec?.ruleIds).toContain("CO.NTC1486.2022.FORMAT.PAGINATION.01");
    expect(icontec?.extends).toBe("generic");
    expect(loadShippedProfile("apa-7")?.margins.inside).toBe("2.54cm");
  });

  const resolve = (text: string, id = "mine") =>
    resolveWorkspaceProfile({ id, file: `styles/${id}.profile.yaml`, text });

  it("merges a workspace profile over its parent: margins and heading case", () => {
    const { profile, issues } = resolve(
      "extends: apa-7\nmargins: { top: 3cm }\nheadings:\n  - { level: 2, case: upper }\n",
    );
    expect(issues).toEqual([]);
    expect(profile?.margins).toMatchObject({ top: "3cm", bottom: "2.54cm" });
    expect(profile?.headings[1]?.case).toBe("upper");
    expect(profile?.headings[0]?.align).toBe("center");
    expect(profile?.extends).toBe("apa-7");
    expect(profile?.id).toBe("mine");
  });

  it("PRF-001: unknown keys, bad values, shadowed ids, unknown parents, aliases", () => {
    const paths = (text: string, id?: string) =>
      resolve(text, id).issues.map((issue) => `${issue.path}|${issue.message}`);
    expect(paths("bogus: 1")[0]).toMatch(/^bogus\|Unknown key/);
    expect(paths("margins: { top: 3 }")[0]).toMatch(/^margins\.top\|Expected a length/);
    expect(paths("margins: { left: 3cm }")[0]).toMatch(/margins\.left\|Unknown key/);
    expect(paths("lineSpacing: 9")[0]).toMatch(/lineSpacing/);
    expect(paths("headings:\n  - { level: 5 }")[0]).toMatch(/level/);
    expect(paths("headings:\n  - { level: 1, color: red }")[0]).toMatch(/Unknown key "color"/);
    expect(paths('font: { body: "Arial; rm" }')[0]).toMatch(/font family/);
    expect(paths("extends: nope")[0]).toMatch(/not a shipped profile/);
    expect(paths("margins: { top: 2cm }", "apa-7")[0]).toMatch(/shadows/);
    expect(paths("a: &x 1\nb: *x")[0]).toBeTruthy();
    expect(paths("id: other")[0]).toMatch(/does not match/);
    expect(parseProfileText("{").issues[0]?.code).toBe("PRF-001");
  });

  it("records ruleId justifications on values", () => {
    const parsed = parseProfileText(
      "lineSpacing: { value: 1.5, ruleId: ORG.R.01 }\nmargins: { ruleId: ORG.R.02, top: 2cm }\n",
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.ruleIds).toEqual(["ORG.R.01", "ORG.R.02"]);
    expect(parsed.input?.lineSpacing).toBe(1.5);
  });

  it("the Typst adapter alone maps a profile to Typst settings", () => {
    const typst = typstProfile(loadShippedProfile("icontec-ntc1486-2022") as never);
    expect(typst).toContain("margins: (top: 2cm, bottom: 2cm, left: 2cm, right: 2cm)");
    expect(typst).toContain("run-in: true");
    expect(typst).toContain("toc-page-label: true");
    expect(typst).toContain('front: "1"');
    expect(typst).toMatch(/\/\/ Rules: .*CO\.NTC1486\.2022\.FORMAT\.PAGINATION\.01/);
    const mirrored = typstProfile({
      ...(loadShippedProfile("generic") as never),
      binding: "mirrored",
    });
    expect(mirrored).toContain("inside: 3cm, outside: 2.5cm");
  });
});

describe("workspace discovery, checks and listing", () => {
  const withStyles = async (files: Record<string, string>) => {
    const root = await sampleThesis();
    await mkdir(join(root, "styles"), { recursive: true });
    for (const [name, text] of Object.entries(files))
      await writeFile(join(root, "styles", name), text);
    return root;
  };
  const styleCodes = async (root: string) =>
    runChecks(await loadProject(root), { gates: ["G0"] }).findings.filter((f) =>
      /^(CSL|PRF)-/.test(f.code),
    );

  it("discovers valid styles and profiles; they appear in the listing", async () => {
    const root = await withStyles({
      "thesis-test.csl": validCsl(),
      "thesis-test.profile.yaml": "extends: generic\nmargins: { top: 3cm }\n",
    });
    const project = await loadProject(root);
    expect(project.styleFiles.map((f) => f.id)).toEqual(["thesis-test"]);
    expect(project.profileFiles.map((f) => f.id)).toEqual(["thesis-test"]);
    expect(await styleCodes(root)).toEqual([]);
    expect(
      resolvePresentationProfile("thesis-test", project.profileFiles).profile?.margins.top,
    ).toBe("3cm");
    const listing = listStyles(project);
    expect(listing).toContain("- thesis-test: Test, workspace");
    expect(listing).toContain("- thesis-test: workspace, extends generic");
    expect(listing).toContain("apa-7: APA Style 7th edition, author-date, shipped [selected]");
  });

  it("reports CSL-001 for a DOCTYPE style and a shadowed id, PRF-001 for an unknown key", async () => {
    const root = await withStyles({
      "evil.csl": '<!DOCTYPE style [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + validCsl("evil"),
      "apa-7.csl": validCsl("apa-7"),
      "bad.profile.yaml": "margins: { top: 2cm }\nzzz: 1\n",
    });
    const findings = await styleCodes(root);
    expect(findings.map((f) => `${f.code} ${f.file}`).sort()).toEqual([
      "CSL-001 styles/apa-7.csl",
      "CSL-001 styles/evil.csl",
      "PRF-001 styles/bad.profile.yaml",
    ]);
    expect(runChecks(await loadProject(root)).ok).toBe(false);
  });

  it("CSL-020 warns whenever the provisional ICONTEC style is selected; CSL-021 flags datasets", async () => {
    const root = await sampleThesis();
    const { readFile } = await import("node:fs/promises");
    const brief = await readFile(join(root, "thesis.yaml"), "utf8");
    await writeFile(
      join(root, "thesis.yaml"),
      brief.replace("citationStyle: apa-7", "citationStyle: icontec-ntc1486-2022"),
    );
    const findings = await styleCodes(root);
    expect(findings.map((f) => f.code)).toEqual(["CSL-020"]);
    const library = await readFile(join(root, "evidence", "library.jsonl"), "utf8");
    const record = JSON.parse(library.split("\n")[0] as string);
    const dataset = {
      ...record,
      id: "EVD-00099",
      citeKey: "dane2020",
      type: "dataset",
      doi: undefined,
    };
    await writeFile(
      join(root, "evidence", "library.jsonl"),
      `${library.trimEnd()}\n${JSON.stringify(dataset)}\n`,
    );
    expect((await styleCodes(root)).map((f) => f.code).sort()).toEqual(["CSL-020", "CSL-021"]);
    await rm(root, { recursive: true, force: true });
  });
});

describe("shared temp helper", () => {
  it("is available", async () => {
    expect((await mkdtemp(join(tmpdir(), "x-"))).length).toBeGreaterThan(0);
  });
});

describe("CLI style command", () => {
  it("lists styles and checks them; exits 1 on a CSL-001 error and 2 on bad usage", async () => {
    const { main } = await import("../src/cli.js");
    const run = async (args: string[]) => {
      let out = "";
      let err = "";
      const code = await main(args, {
        stdout: (t) => (out += t),
        stderr: (t) => (err += t),
        cwd: "/",
        env: { ALISIO_THESIS_TYPST: "/nonexistent/typst" },
      });
      return { code, out, err };
    };
    const root = await sampleThesis();
    const listed = await run(["style", "list", root]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("icontec-ntc1486-2022");
    expect((await run(["style", "check", root])).code).toBe(0);
    await mkdir(join(root, "styles"), { recursive: true });
    await writeFile(join(root, "styles", "evil.csl"), `<!DOCTYPE x>${validCsl("evil")}`);
    const failed = await run(["style", "check", root, "--json"]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out).findings[0]).toMatchObject({
      code: "CSL-001",
      file: "styles/evil.csl",
    });
    expect((await run(["style", "bogus"])).code).toBe(2);
  });
});
