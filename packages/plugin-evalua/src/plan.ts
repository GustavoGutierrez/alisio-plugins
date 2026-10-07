import type { ItemType } from "./types.js";

/** The plan and version-control documents (spec 4.2, 9.5). Generated from state, never by an LLM. */

export interface GateRecord {
  decision: string;
  at: string;
}

export interface PhaseRecord {
  name: string;
  status: "pending" | "done" | "failed";
  at?: string;
}

export interface PlanInput {
  examId: string;
  title: string;
  theme: string;
  grade: string;
  level: string;
  questionCount: number;
  itemTypes: Record<ItemType, number>;
  packs: readonly string[];
  topics: readonly string[];
  schoolYear: number;
  revision: number;
  gates: Record<string, GateRecord>;
  phases: readonly PhaseRecord[];
  seeds: readonly string[];
  pluginVersion: string;
  itemsSha256: string;
  engine?: string;
  builtAt?: string;
}

/** The `00_plan_proyecto.md` plan: scope, schedule, responsibility matrix and the approval record. */
export function buildPlanProject(input: PlanInput): string {
  const types = Object.entries(input.itemTypes)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type} ${count}`)
    .join(", ");
  const schedule = input.phases
    .map((phase) => `| ${phase.name} | ${phase.status} | ${phase.at ?? "—"} |`)
    .join("\n");
  const gates = Object.entries(input.gates)
    .map(([gate, record]) => `| ${gate} | ${record.decision} | ${record.at} |`)
    .join("\n");
  return [
    `# Plan del proyecto — ${input.title}`,
    "",
    `- Examen: ${input.examId} (revisión ${input.revision})`,
    `- Tema: ${input.theme}`,
    `- Grado y nivel: ${input.grade}, ${input.level}`,
    `- Año lectivo: ${input.schoolYear}`,
    `- Preguntas: ${input.questionCount} (${types})`,
    `- Packs: ${input.packs.join(", ") || "—"}`,
    `- Temas: ${input.topics.join(", ") || "—"}`,
    "",
    "## Cronograma",
    "",
    "| Fase | Estado | Fecha |",
    "| --- | --- | --- |",
    schedule || "| — | — | — |",
    "",
    "## Matriz de responsabilidades",
    "",
    "| Rol | Ejecutor |",
    "| --- | --- |",
    "| Coordinador de evaluación | `evl-coordinator` + código |",
    "| Experto en matemáticas | solvers deterministas + `evl-math-reviewer` |",
    "| Didáctica y diseño | `evl-assessment-designer` |",
    "| Redacción y accesibilidad | `evl-language-reviewer` |",
    "| Autor de ítems | familias + `evl-item-author` |",
    "| Maquetación | motor de layout determinista |",
    "| Corrector independiente | comprobaciones deterministas + `evl-math-reviewer` |",
    "| Control de versiones | código |",
    "",
    "## Acta de aprobación",
    "",
    "| Puerta | Decisión | Fecha |",
    "| --- | --- | --- |",
    gates || "| — | — | — |",
    "",
  ].join("\n");
}

/** The `05_control_versiones.md` log: id, revision, seeds, packs, plugin, engine, hash and gates. */
export function buildVersionLog(input: PlanInput): string {
  return [
    `# Control de versiones — ${input.title}`,
    "",
    `- Examen: ${input.examId}`,
    `- Revisión: ${input.revision}`,
    `- Seeds: ${input.seeds.join(", ") || "—"}`,
    `- Packs: ${input.packs.join(", ") || "—"}`,
    `- Versión del plugin: ${input.pluginVersion}`,
    `- Motor: ${input.engine ?? "—"}`,
    `- SHA-256 de items.json: ${input.itemsSha256}`,
    `- Última construcción: ${input.builtAt ?? "—"}`,
    "",
    "## Puertas",
    "",
    "| Puerta | Decisión | Fecha |",
    "| --- | --- | --- |",
    Object.entries(input.gates)
      .map(([gate, record]) => `| ${gate} | ${record.decision} | ${record.at} |`)
      .join("\n") || "| — | — | — |",
    "",
  ].join("\n");
}
