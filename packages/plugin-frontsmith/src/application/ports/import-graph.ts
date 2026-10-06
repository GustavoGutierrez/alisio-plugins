import type { ImportRecord } from "./source-parser.js";

export type ImportResolution =
  | { kind: "file"; path: string; via: "relative" | "paths" | "baseUrl" | "package-imports" }
  | { kind: "package"; name: string }
  | { kind: "builtin" }
  | { kind: "unresolved"; reason: string };

export interface ImportEdge {
  from: string;
  specifier: string;
  importKind: ImportRecord["kind"];
  typeOnly: boolean;
  names: string[];
  line: number;
  column: number;
  resolution: ImportResolution;
}

export interface ImportGraph {
  files: string[];
  edges: ImportEdge[];
  byFile: Map<string, ImportEdge[]>;
}
