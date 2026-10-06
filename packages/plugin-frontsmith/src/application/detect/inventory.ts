import { compileGlob } from "../../domain/glob.js";
import type { FileAnalysis } from "../ports/file-analyzer.js";

export type InventoryKind = "component" | "hook" | "store" | "token";
export type InventoryRequest = "components" | "hooks" | "stores" | "tokens" | "all";

export interface InventoryRow {
  name: string;
  path: string;
  /** Architecture layer, or `-` until a layer mapping is available. */
  layer: string;
  kind: InventoryKind;
  line: number;
}

export interface InventoryOptions {
  kinds: readonly InventoryRequest[];
  /** Globs of the token files (`paths.tokenFiles`). */
  tokenFiles: readonly string[];
  layerOf?: (path: string) => string | undefined;
}

const STATE_LIBRARIES = new Set([
  "zustand",
  "pinia",
  "jotai",
  "recoil",
  "@reduxjs/toolkit",
  "redux",
  "mobx",
  "valtio",
  "nanostores",
  "@ngrx/store",
  "xstate",
  "vuex",
]);
const SFC_EXTENSION = /\.(vue|svelte|astro)$/i;

const baseName = (path: string): string => {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.replace(/\.[^.]+$/, "");
};

/** Components, hooks, stores and design tokens found by the analysis (spec 10.5 `fs_inventory`). */
export function buildInventory(
  analyses: Iterable<FileAnalysis>,
  options: InventoryOptions,
): InventoryRow[] {
  const wanted = new Set<InventoryKind>();
  for (const request of options.kinds) {
    if (request === "all")
      for (const kind of ["component", "hook", "store", "token"] as const) wanted.add(kind);
    else wanted.add(request.slice(0, -1) as InventoryKind);
  }
  const tokenMatchers = options.tokenFiles.map((pattern) => compileGlob(pattern));
  const rows: InventoryRow[] = [];
  const layerOf = (path: string): string => options.layerOf?.(path) ?? "-";
  const add = (kind: InventoryKind, name: string, path: string, line: number): void => {
    if (wanted.has(kind)) rows.push({ name, path, layer: layerOf(path), kind, line });
  };

  for (const analysis of analyses) {
    const { path } = analysis;
    if (SFC_EXTENSION.test(path)) add("component", baseName(path), path, 1);
    for (const piece of analysis.scripts) {
      const view = piece.view;
      const componentNames = new Set(view.components.map((component) => component.name));
      for (const component of view.components)
        add("component", component.name, path, component.loc.line);
      for (const component of view.angularComponents)
        add("component", component.className, path, component.loc.line);
      for (const name of view.exportedNames)
        if (/^use[A-Z0-9]/.test(name)) add("hook", name, path, view.exportLines[name] ?? 1);
      if (view.imports.some((record) => STATE_LIBRARIES.has(record.specifier)))
        for (const name of view.exportedNames)
          if (name !== "default" && !componentNames.has(name))
            add("store", name, path, view.exportLines[name] ?? 1);
    }
    if (tokenMatchers.some((test) => test(path)))
      for (const style of analysis.styles)
        for (const property of style.scan.customProperties)
          add("token", property.name, path, property.line);
  }
  return rows.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name),
  );
}
