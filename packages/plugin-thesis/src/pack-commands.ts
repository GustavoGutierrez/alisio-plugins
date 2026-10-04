import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginAPI } from "@alisio/sdk";
import { formatReport, type LoadedProject, runChecks } from "./checks/index.js";
import { slugify } from "./policy/context.js";
import { ruleRank } from "./policy/resolver.js";
import { atomicWrite, resolveInside } from "./storage.js";

const creatableScopes = [
  "international",
  "country",
  "region",
  "institution",
  "faculty",
  "program",
  "writing",
] as const;
type CreatableScope = (typeof creatableScopes)[number];

export function listPacks(project: LoadedProject): string {
  if (project.allPacks.length === 0) return "No policy packs were found.";
  const inactive = new Map(
    (project.selection?.inactive ?? []).map((entry) => [
      `${entry.location}:${entry.packId}`,
      entry.reason,
    ]),
  );
  const lines = ["Policy packs (shipped first, then workspace):"];
  const sorted = [...project.allPacks].sort(
    (a, b) =>
      Number(a.location === "workspace") - Number(b.location === "workspace") ||
      (a.id < b.id ? -1 : 1),
  );
  for (const pack of sorted) {
    const reason = inactive.get(`${pack.location}:${pack.id}`);
    const state = project.selection
      ? reason
        ? `inactive (${reason})`
        : "active"
      : "not evaluated (fix thesis.yaml first)";
    lines.push(
      `- ${pack.id} [${pack.scope}, ${pack.location}] v${pack.version}, ${pack.rules.length} rule(s): ${state}`,
    );
  }
  return lines.join("\n");
}

export function checkPacks(project: LoadedProject, now: () => Date): string {
  const report = runChecks(project, { gates: ["G0"], now });
  const relevant = report.findings.filter(
    (finding) => finding.code.startsWith("PCK-") || finding.code === "POL-001",
  );
  const filtered = {
    ...report,
    findings: relevant,
    ok: !relevant.some((finding) => finding.severity === "error"),
    counts: {
      error: relevant.filter((finding) => finding.severity === "error").length,
      warning: relevant.filter((finding) => finding.severity === "warning").length,
      info: relevant.filter((finding) => finding.severity === "info").length,
    },
  };
  const active = project.selection?.active ?? [];
  const summary = `${active.length} active pack(s), ${active.reduce((sum, pack) => sum + pack.rules.length, 0)} rule(s)`;
  return `${formatReport(filtered)}\n${summary}`;
}

export function explain(project: LoadedProject, query: string): string {
  const profile = project.profile;
  if (!profile)
    return "Fix thesis.yaml first (/thesis:check); the policy cannot be resolved without a valid brief.";
  const named: Record<
    string,
    {
      label: string;
      value: {
        value: string;
        source: string;
        ruleIds: string[];
        defaulted: boolean;
        note?: string;
      };
    }
  > = {
    citationstyle: { label: "citationStyle", value: profile.citationStyle },
    presentationstandard: { label: "presentationStandard", value: profile.presentationStandard },
  };
  const direct = named[query.toLowerCase()];
  const byValue = Object.values(named).filter((entry) => entry.value.value === query);
  const rulesById = new Map(
    [...project.allPacks.flatMap((pack) => pack.rules), ...project.overrides].map(
      (rule) => [rule.ruleId, rule] as const,
    ),
  );
  const describeRule = (ruleId: string) => {
    const rule = rulesById.get(ruleId);
    if (!rule) return `  - ${ruleId} (not found)`;
    return `  - ${ruleId}: ${rule.level}, rank ${ruleRank(rule)}, ${rule.origin.packId ?? rule.origin.tier} (${rule.origin.file})`;
  };

  const resolved = direct ? [direct] : byValue;
  if (resolved.length > 0) {
    return resolved
      .map(({ label, value }) =>
        [
          `${label} = ${value.value} (source: ${value.source}${value.defaulted ? ", defaulted; confirm with your program" : ""})`,
          value.note ? `Note: ${value.note}` : "",
          value.ruleIds.length
            ? `Resolution trail, highest precedence first:\n${value.ruleIds.map(describeRule).join("\n")}`
            : "No rule contributed; the value comes from the brief or the fallback.",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");
  }
  if (query.toLowerCase() === "aideclaration") {
    const ai = profile.aiDeclaration;
    return [
      `aiDeclaration: required=${ai.required} (setting: ${ai.setting})`,
      ai.conflict ?? "",
      ai.ruleIds.map(describeRule).join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
  }

  const rule = rulesById.get(query);
  if (!rule)
    return `Nothing matches "${query}". Use a ruleId, citationStyle, presentationStandard, aiDeclaration or a resolved value.`;
  const applied = profile.rules.find((entry) => entry.ruleId === query);
  const inactive = project.selection?.inactive.find(
    (entry) => entry.packId === rule.origin.packId && entry.location === rule.origin.location,
  );
  const overriddenBy = profile.overridden.find((entry) => entry.ruleId === query);
  const supersededBy = profile.superseded.find((entry) => entry.ruleId === query);
  let outcome: string;
  if (overriddenBy && overriddenBy.overriddenFile === rule.origin.file)
    outcome = `replaced by ${overriddenBy.by} (${overriddenBy.byFile})`;
  else if (supersededBy)
    outcome = `superseded by ${supersededBy.supersededBy} (${supersededBy.reason})`;
  else if (inactive) outcome = `not applied: pack inactive (${inactive.reason})`;
  else if (rule.status !== "active") outcome = `not applied: status is ${rule.status}`;
  else if (applied) outcome = "applied";
  else outcome = "not applied: appliesWhen does not match this brief";
  return [
    `${rule.ruleId}: ${outcome}`,
    `Level ${rule.level}, rank ${ruleRank(rule)}, kind ${rule.requirement.kind}`,
    `Defined in ${rule.origin.packId ?? rule.origin.tier} (${rule.origin.file})`,
    `appliesWhen: ${JSON.stringify(rule.appliesWhen ?? {})}`,
    `Source: ${rule.source.reference}${rule.source.url ? ` <${rule.source.url}>` : ""}`,
    `Verified ${rule.verification.lastChecked} (${rule.verification.basis})`,
  ].join("\n");
}

function manifestText(options: {
  packId: string;
  scope: string;
  extendsId: string | undefined;
  appliesWhen: string;
  description: string;
}): string {
  return `# Policy pack manifest. Every field except the comments is checked by /thesis:pack check.
# packId must be unique across shipped and workspace packs.
packId: ${options.packId}
# scope: international | country | region | institution | faculty | program | writing
scope: ${options.scope}
version: "0.1.0"
description: ${JSON.stringify(options.description)}
${options.extendsId ? `# This pack adds rules to ${options.extendsId} and is active only while ${options.extendsId} is.\nextends: ${options.extendsId}\n` : "# extends: CO   # add rules to an existing pack\n"}# appliesWhen keys: country, language, workType, approach, studyDesign, domain, aiUse
# (all keys must match; a list value means any-of; {} means always).
appliesWhen: ${options.appliesWhen}
# maintainer: your name
`;
}

function exampleRuleText(packId: string, date: string): string {
  const id = `${packId.replace(/[^A-Za-z0-9.-]/g, "-").toUpperCase()}.EXAMPLE.01`;
  return `# Rule files hold a rule, a list of rules, or a mapping with a rules: list.
# This example is a draft (status: draft), so it is loaded but never applied. Replace it.
# To change a shipped rule, reuse its ruleId and add "overrides: true"; without that flag
# /thesis:pack check reports PCK-002.
rules:
  - ruleId: ${id}
    level: INSTITUTIONAL_RULE      # LAW | REGULATION | INSTITUTIONAL_RULE | PROGRAM_RULE | TECHNICAL_STANDARD | STYLE_GUIDE | METHODOLOGY_GUIDELINE | RECOMMENDATION
    status: draft                  # active | draft | superseded | withdrawn
    appliesWhen: {}
    requirement:
      kind: x-example              # use the closed vocabulary, or x-<name> for your own kinds
      values: { note: "Replace this example with a real requirement" }
    source:
      reference: "Where the rule is written, for example Regulation 12, art. 4"
      # url: https://example.org/regulation
    verification:
      lastChecked: "${date}"
      basis: secondary_source      # official_text | secondary_source
    supersedes: []
`;
}

export interface PackTarget {
  /** Directory under `thesis/policy-packs/`. */
  directory: string;
  packId: string;
  /** False when the rules join a pack that has its manifest already (faculty and program folders). */
  writeManifest: boolean;
  extendsId: string | undefined;
}

export const creatablePackScopes = creatableScopes;

/** Where a new workspace pack (or the rules of an existing institution pack) belongs. */
export function packTarget(project: LoadedProject, scopeText: string, idText: string): PackTarget {
  if (!(creatableScopes as readonly string[]).includes(scopeText)) {
    throw new Error(`Unknown scope "${scopeText}". Use one of: ${creatableScopes.join(", ")}`);
  }
  const scope = scopeText as CreatableScope;
  const brief = project.brief?.brief;
  if (!brief)
    throw new Error("Fix thesis.yaml first (/thesis:check); pack scaffolding needs a valid brief");
  const country = brief.institution.country;
  const slug = slugify(idText);
  if (!slug || (scope === "country" && !/^[A-Z]{2}$/.test(idText))) {
    throw new Error(
      scope === "country"
        ? "A country pack id must be an ISO code such as MX"
        : "The id needs letters or digits",
    );
  }
  const institutionSlug = slugify(brief.institution.name ?? "");
  const countryPackExists = project.allPacks.some(
    (pack) => pack.scope === "country" && pack.id === country,
  );
  switch (scope) {
    case "international":
    case "region":
      return {
        directory: `international/${slug}`,
        packId: slug,
        writeManifest: true,
        extendsId: undefined,
      };
    case "writing":
      return {
        directory: `writing/${slug}`,
        packId: slug,
        writeManifest: true,
        extendsId: undefined,
      };
    case "country":
      return {
        directory: `countries/${idText}`,
        packId: idText,
        writeManifest: true,
        extendsId: undefined,
      };
    case "institution":
      return {
        directory: `institutions/${country}/${slug}`,
        packId: `${country}-${slug}`,
        writeManifest: true,
        extendsId: countryPackExists ? country : undefined,
      };
    case "faculty":
    case "program": {
      if (!institutionSlug) throw new Error("Set institution.name in thesis.yaml first");
      const institutionDirectory = `institutions/${country}/${institutionSlug}`;
      const exists = project.allPacks.some(
        (pack) => pack.location === "workspace" && pack.dir === institutionDirectory,
      );
      if (!exists)
        throw new Error(
          `Create the institution pack first: /thesis:pack new institution ${institutionSlug}`,
        );
      const faculty = slugify(brief.institution.faculty ?? "");
      if (scope === "program" && !faculty)
        throw new Error("Set institution.faculty in thesis.yaml first");
      return {
        directory:
          scope === "faculty"
            ? `${institutionDirectory}/faculties/${slug}`
            : `${institutionDirectory}/faculties/${faculty}/programs/${slug}`,
        packId: `${country}-${institutionSlug}`,
        writeManifest: false,
        extendsId: undefined,
      };
    }
  }
}

/** Ask for the scope and id of a new pack when the command line gave none. */
async function askScopeAndId(
  api: PluginAPI,
  project: LoadedProject,
): Promise<[string, string] | undefined> {
  const brief = project.brief?.brief;
  const institution = brief?.institution.name ?? "";
  const answers = await api.ui.askQuestions({
    label: "New policy pack",
    questions: [
      {
        id: "scope",
        header: "Scope",
        question: "What does the new policy pack describe?",
        options: [
          {
            value: "institution",
            label: "My institution",
            description: "Rules of your university (regulations, templates, rubrics).",
            recommended: true,
          },
          {
            value: "program",
            label: "My program",
            description: "Rules of one program (needs the institution pack first).",
          },
          {
            value: "writing",
            label: "A writing guide",
            description: "A house style: voice, abbreviations, number formats.",
          },
          {
            value: "international",
            label: "An international rule set",
            description: "A funder or journal-family rule set.",
          },
        ],
      },
      {
        id: "id",
        header: "Id",
        question: "Which id should it have?",
        options: [
          {
            value: "derive",
            label: "Derive it from thesis.yaml",
            description: institution
              ? `Uses the institution, faculty or program name (now: ${institution}).`
              : "Uses the institution, faculty or program name from thesis.yaml.",
            recommended: Boolean(institution),
          },
          {
            value: "enter",
            label: "Enter an id",
            description: "Letters, digits and dashes.",
            textInput: { placeholder: "my-guide" },
            recommended: !institution,
          },
        ],
      },
    ],
  });
  const scope = answers.scope;
  if (typeof scope !== "string") return undefined;
  let id = answers["id:text"];
  if (answers.id === "derive" || typeof id !== "string" || !id.trim()) {
    id =
      scope === "program"
        ? (brief?.institution.program ?? "")
        : scope === "faculty"
          ? (brief?.institution.faculty ?? "")
          : (brief?.institution.name ?? "");
  }
  return typeof id === "string" && id.trim() ? [scope, id.trim()] : undefined;
}

export async function newPack(
  api: PluginAPI,
  project: LoadedProject,
  base: string,
  args: string[],
  now: () => Date,
): Promise<string> {
  let [scopeText, idText] = args;
  if ((!scopeText || !idText) && args.length === 0 && api.ui.interactive()) {
    const asked = await askScopeAndId(api, project);
    if (asked) [scopeText, idText] = asked;
  }
  if (!scopeText || !idText || args.length > 2) {
    throw new Error(`Usage: /thesis:pack new <${creatableScopes.join("|")}> <id>`);
  }
  const brief = project.brief?.brief;
  if (!brief)
    throw new Error("Fix thesis.yaml first (/thesis:check); pack scaffolding needs a valid brief");
  const country = brief.institution.country;
  const scope = scopeText as CreatableScope;
  const slug = slugify(idText);
  const { directory, packId, writeManifest, extendsId } = packTarget(project, scopeText, idText);

  const packsRoot = join(base, "policy-packs");
  const target = resolveInside(packsRoot, directory);
  const manifestPath = join(target, "manifest.yaml");
  const rulesPath = join(target, writeManifest ? "rules.yaml" : `${slug}.yaml`);
  for (const path of [manifestPath, rulesPath]) {
    try {
      await readFile(path);
      throw new Error(`${path.slice(base.length + 1)} already exists; nothing was written`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (project.allPacks.some((pack) => pack.id === packId) && writeManifest) {
    throw new Error(
      `packId ${packId} already exists; use extends in a new pack to add rules to it`,
    );
  }

  let when = scope === "institution" || scope === "country" ? "country" : "always";
  if (writeManifest && api.ui.interactive()) {
    const answer = await api.ui.askQuestions({
      label: "Policy pack",
      questions: [
        {
          id: "appliesWhen",
          header: "Applies when",
          question: `When should the ${scope} pack ${packId} apply?`,
          options: [
            {
              value: "always",
              label: "Always",
              description: "Every thesis in this workspace.",
              recommended: when === "always",
            },
            {
              value: "country",
              label: `Only when the country is ${country}`,
              description: "Matches institution.country.",
              recommended: when === "country",
            },
            {
              value: "workType",
              label: `Only for ${brief.workType}`,
              description: "Matches workType.",
            },
          ],
        },
      ],
    });
    const picked = answer.appliesWhen;
    if (picked === "always" || picked === "country" || picked === "workType") when = picked;
  }
  const appliesWhen =
    when === "country"
      ? `{ country: ${country} }`
      : when === "workType"
        ? `{ workType: ${brief.workType} }`
        : "{}";

  if (writeManifest) {
    await atomicWrite(
      manifestPath,
      manifestText({
        packId,
        scope,
        extendsId,
        appliesWhen,
        description: `${scope} policy pack ${packId}`,
      }),
    );
  }
  await atomicWrite(rulesPath, exampleRuleText(packId, now().toISOString().slice(0, 10)));
  return [
    `Created ${writeManifest ? `pack ${packId}` : `${scope} rules`} under policy-packs/${directory}/.`,
    writeManifest
      ? "Wrote manifest.yaml and rules.yaml (one draft example rule)."
      : `Wrote ${slug}.yaml (one draft example rule).`,
    "Next: edit the rules, then run /thesis:pack check and /thesis:pack list.",
  ].join("\n");
}
