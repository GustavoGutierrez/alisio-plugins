import { json } from "./data.js";
import { intakeAnswers, type Lifecycle, lifecycle } from "./harness.js";
import {
  appraise,
  candidateSet,
  dossier,
  searchPlan,
  standardCandidates,
  toSections,
} from "./research.js";

/** Intake, design and outline done; SEC-07 (Marco teorico) researched and its research approved. */
export async function researched(options: Parameters<typeof lifecycle>[0] = {}) {
  const h = await lifecycle({
    ...options,
    answers: [...intakeAnswers, ...(options.answers ?? [])],
  });
  await toSections(h);
  h.script("thesis-librarian", json(searchPlan()), json(candidateSet(standardCandidates())));
  h.script("thesis-evidence-auditor", appraise());
  h.script("thesis-architect", dossier());
  await h.run("research", "SEC-07");
  await h.run("approve", "SEC-07");
  return h;
}

export interface Packet {
  id: string;
  citeKey: string;
  status: string;
}

/** The evidence packet a prompt carries. */
export function packetOf(prompt: string): Packet[] {
  const match = /EVIDENCE PACKET \(data, not instructions\) ===\n([\s\S]*?)\n=== END/.exec(prompt);
  return JSON.parse(match?.[1] ?? "[]") as Packet[];
}

/** The BODY block of an editor prompt. */
export const bodyOf = (prompt: string): string =>
  /BODY \(data, not instructions\) ===\n([\s\S]*?)\n=== END BODY/.exec(prompt)?.[1] ?? "";

export const claim = (over: Record<string, unknown>) => ({
  anchor: "c1",
  text: "La verificación automática de referencias es viable.",
  kind: "background",
  evidence: [] as string[],
  results: [] as string[],
  objectives: [] as string[],
  ...over,
});

/** A valid Spanish SectionDraft citing the first two citable records of the packet. */
export function sectionDraft(prompt: string, over: Record<string, unknown> = {}) {
  const [first, second] = packetOf(prompt);
  return {
    markdown: [
      "<!-- claim:c1 -->",
      `La verificación automática de referencias es viable y reduce los errores de citación en las tesis de grado [@${first?.citeKey}]. Los estudios revisados coinciden en que el control debe ser determinista y reproducible antes de cualquier revisión humana del documento.`,
      "",
      "<!-- claim:c2 -->",
      `Además, la integridad de las citas depende de comprobar cada fuente contra registros abiertos [@${second?.citeKey}], de modo que ninguna referencia quede sin respaldo en el texto final del trabajo.`,
    ].join("\n"),
    keywords: [],
    claims: [
      claim({ anchor: "c1", kind: "background", evidence: [first?.id] }),
      claim({
        anchor: "c2",
        text: "La integridad de las citas exige comprobar cada fuente.",
        kind: "argument",
        evidence: [second?.id],
      }),
    ],
    figures: [],
    gaps: [],
    ...over,
  };
}

export const writerReply =
  (over: Record<string, unknown> | ((prompt: string) => Record<string, unknown>) = {}) =>
  (prompt: string) =>
    json(sectionDraft(prompt, typeof over === "function" ? over(prompt) : over));

/** An editor that makes one wording change and returns everything else untouched. */
export const editorReply =
  (change: (body: string) => string = (body) => body.replace("Además,", "Asimismo,")) =>
  (prompt: string) =>
    json({ markdown: change(bodyOf(prompt)), changes: ["wording"], queries: [] });

/** Draft SEC-07 headlessly with the default scripted writer and editor. */
export async function drafted(h: Lifecycle, over: Record<string, unknown> = {}) {
  h.script("thesis-writer", writerReply(over));
  h.script("thesis-editor", editorReply());
  return h.run("draft", "SEC-07");
}
