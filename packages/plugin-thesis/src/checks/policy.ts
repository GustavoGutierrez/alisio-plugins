import { isExtensionKind } from "../policy/kinds.js";
import { canonicalJson } from "../storage.js";
import type { Finding } from "../types.js";
import type { LoadedProject } from "./project.js";

const dayMs = 24 * 60 * 60 * 1000;

/** G0: the compliance profile resolves from valid, sourced rules (POL-*, PCK-*). */
export function checkPolicy(project: LoadedProject): Finding[] {
  const findings: Finding[] = [];
  let packErrors = 0;
  for (const problem of project.policyProblems) {
    if (problem.severity === "error") packErrors += 1;
    findings.push({
      code: problem.code,
      gate: "G0",
      severity: problem.severity,
      file: problem.file,
      message: problem.message,
      ...(problem.code === "PCK-001"
        ? {
            hint: "Manifests need packId, scope and version; every rule needs ruleId, level, status, requirement, source.reference and verification.lastChecked.",
          }
        : problem.code === "PCK-002"
          ? { hint: "Set overrides: true on the rule that deliberately replaces a shipped rule." }
          : {}),
    });
  }

  const profile = project.profile;
  if (!profile) return findings;

  if (!project.selection?.active.some((pack) => pack.scope === "country")) {
    findings.push({
      code: "POL-003",
      gate: "G0",
      severity: "warning",
      message: `No policy pack for country ${profile.inputs.country}; only global rules apply`,
      hint: "Add a country pack under thesis/policy-packs/countries/<CC>/ (see /thesis:pack new).",
    });
  }

  if (packErrors > 0) {
    findings.push({
      code: "POL-001",
      gate: "G0",
      severity: "error",
      message: `The compliance profile cannot be trusted: ${packErrors} policy pack error(s) above`,
      hint: "Run /thesis:pack check for the full list.",
    });
  }

  if (project.profileOnDisk === undefined) {
    findings.push({
      code: "POL-002",
      gate: "G0",
      severity: "warning",
      file: "compliance-profile.json",
      message: "compliance-profile.json is missing",
      hint: "Run /thesis:check to write the resolved profile.",
    });
  } else if (project.profileOnDisk !== canonicalJson(profile)) {
    findings.push({
      code: "POL-002",
      gate: "G0",
      severity: "warning",
      file: "compliance-profile.json",
      message: "compliance-profile.json is stale or was edited by hand",
      hint: "Run /thesis:check to re-resolve it; it is generated from thesis.yaml, the packs and policy/.",
    });
  }

  for (const conflict of profile.conflicts) {
    findings.push({
      code: "PCK-003",
      gate: "G0",
      severity: "error",
      message: `${conflict.note}. Sources: ${conflict.files.join(", ")}`,
      hint: "Give one rule a higher level or pack scope, or mark one as superseded.",
    });
  }

  for (const pack of project.selection?.active ?? []) {
    for (const rule of pack.rules) {
      if (rule.verification.basis !== "secondary_source" || rule.status !== "active") continue;
      const checked = Date.parse(rule.verification.lastChecked);
      if (!Number.isNaN(checked) && project.now.getTime() - checked > 365 * dayMs) {
        findings.push({
          code: "PCK-004",
          gate: "G0",
          severity: "warning",
          file: rule.origin.file,
          message: `${rule.ruleId} rests on a secondary source last verified ${rule.verification.lastChecked}; re-verify it`,
        });
      }
    }
  }
  const extensions = [
    ...(project.selection?.active ?? []).flatMap((pack) => pack.rules),
    ...project.overrides,
  ].filter((rule) => isExtensionKind(rule.requirement.kind));
  if (extensions.length > 0) {
    findings.push({
      code: "PCK-010",
      gate: "G0",
      severity: "info",
      message: `${extensions.length} rule(s) use extension kinds (${[...new Set(extensions.map((rule) => rule.requirement.kind))].join(", ")}); no deterministic check consumes them, but agents read them`,
    });
  }

  if (profile.citationStyle.defaulted || profile.presentationStandard.defaulted) {
    findings.push({
      code: "POL-005",
      gate: "G0",
      severity: "warning",
      message: `No rule or answer fixes the citation style (${profile.citationStyle.value}) or the presentation standard (${profile.presentationStandard.value}); defaults are in use`,
      hint: "Confirm them with your program, then set citationStyle or presentation.standard in thesis.yaml.",
    });
  }
  if (profile.secondarySourceRuleIds.length > 0) {
    findings.push({
      code: "POL-006",
      gate: "G0",
      severity: "info",
      message: `${profile.secondarySourceRuleIds.length} applied rule(s) rest on secondary sources: ${profile.secondarySourceRuleIds.join(", ")}`,
      hint: "Confirm these rules with your program; an institution rule overrides them.",
    });
  }
  for (const warning of profile.warnings) {
    if (warning.includes("defaults to")) continue;
    findings.push({ code: "POL-007", gate: "G0", severity: "warning", message: warning });
  }
  return findings;
}
