import { PAPER } from "../style.js";
import { dot, figureRoot, label, labels, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";

const MAX_STAGES = 3;
const MAX_LEAVES = 16;
const ROW = 26;
const COLUMN = 110;

function stagesOf(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  const stages: string[][] = [];
  let leaves = 1;
  for (const entry of value.slice(0, MAX_STAGES)) {
    const outcomes = labels(entry).slice(0, 6);
    if (outcomes.length === 0 || leaves * outcomes.length > MAX_LEAVES) break;
    leaves *= outcomes.length;
    stages.push(outcomes);
  }
  return stages;
}

/**
 * A left-to-right tree diagram: each stage in `stages` lists its outcomes and every node of the
 * previous stage branches into all of them (up to three stages and sixteen leaves). `edgeLabels`,
 * in breadth-first order, writes a probability on each branch; `leafLabels: true` writes the full
 * outcome at every leaf.
 */
export const treeDiagram: FigureComponent = (params, title) => {
  const stages = stagesOf(params.stages);
  const edgeText = labels(params.edgeLabels);
  const leafCount = stages.reduce((total, stage) => total * stage.length, 1);
  const showLeaves = params.leafLabels === true;
  const last = stages[stages.length - 1] ?? [];
  const boxWidth = (outcome: string) => Math.max(16, outcome.length * 7 + 6);
  const leafX = 24 + stages.length * COLUMN - 13 + Math.max(16, ...last.map(boxWidth)) + 8;
  // The widest leaf text "(a, b, c)": the longest outcome of every stage plus the separators.
  const leafChars = stages.reduce(
    (total, stage) => total + Math.max(...stage.map((o) => o.length)) + 2,
    2,
  );
  const width = showLeaves ? leafX + leafChars * 6 + 12 : leafX + 10;
  const height = Math.max(80, leafCount * ROW + 30);
  // Leaves are evenly spaced; every inner node sits at the middle of its children.
  let level: Array<{ y: number; path: string[] }> = Array.from({ length: leafCount }, (_, i) => ({
    y: 20 + ROW / 2 + i * ROW,
    path: [],
  }));
  const columns: Array<Array<{ y: number }>> = [level];
  for (let stage = stages.length - 1; stage >= 0; stage -= 1) {
    const size = stages[stage]?.length ?? 1;
    const parents: Array<{ y: number; path: string[] }> = [];
    for (let start = 0; start < level.length; start += size) {
      const children = level.slice(start, start + size);
      const y = children.reduce((sum, child) => sum + child.y, 0) / children.length;
      parents.push({ y, path: [] });
    }
    level = parents;
    columns.unshift(level);
  }
  let body = "";
  let edgeIndex = 0;
  const x = (column: number) => 24 + column * COLUMN;
  for (let stage = 0; stage < stages.length; stage += 1) {
    const outcomes = stages[stage] ?? [];
    const parents = columns[stage] ?? [];
    const children = columns[stage + 1] ?? [];
    parents.forEach((parent, p) => {
      outcomes.forEach((outcome, o) => {
        const child = children[p * outcomes.length + o];
        if (child === undefined) return;
        const [x1, y1, x2, y2] = [x(stage) + 6, parent.y, x(stage + 1) - 14, child.y];
        body += segment(x1, y1, x2, y2);
        const text = edgeText[edgeIndex];
        if (text !== undefined && text !== "") {
          // Near the child end, where sibling branches are furthest apart.
          body += label(x1 + (x2 - x1) * 0.62, y1 + (y2 - y1) * 0.62 - 4, text, { size: 10 });
        }
        edgeIndex += 1;
        body += `<rect x="${x(stage + 1) - 13}" y="${child.y - 8}" width="${boxWidth(outcome)}" height="16" rx="3" fill="${PAPER}"/>`;
        body += label(x(stage + 1) - 10, child.y + 4, outcome, { size: 11, anchor: "start" });
      });
    });
  }
  body += dot(x(0), columns[0]?.[0]?.y ?? height / 2);
  if (showLeaves) {
    const outcomes: string[][] = [[]];
    let paths = outcomes;
    for (const stage of stages) paths = paths.flatMap((path) => stage.map((o) => [...path, o]));
    paths.forEach((path, index) => {
      const y = (columns[stages.length]?.[index]?.y ?? 0) + 4;
      body += label(leafX, y, `(${path.join(", ")})`, {
        size: 10,
        anchor: "start",
      });
    });
  }
  const desc = stages.map((stage, index) => `Etapa ${index + 1}: ${stage.join(", ")}`);
  return figureRoot(
    width,
    height,
    body,
    title ?? "Diagrama de árbol",
    `${desc.join(". ")}. ${leafCount} resultados.`,
  );
};
