import { compileGlob } from "../../domain/glob.js";
import type { ComponentRecord, SourceView } from "../ports/source-parser.js";
import { ParamReader } from "./params.js";
import type { Engine, EngineContext, RawFinding } from "./types.js";

const CHECKS = [
  "propsTyped",
  "noAnyProps",
  "maxBooleanProps",
  "polymorphicAsTyped",
  "forwardRefPrimitives",
  "oneExportedComponent",
  "noNestedComponentDefinition",
  "noIndexKey",
  // Owner extensions (B-10): framework component checks over the same Babel views.
  "noEffectOnlySetsState",
  "noUnneededUseClient",
  "definePropsTyped",
  "exportLetTyped",
  "noBypassSecurityTrust",
  "onPushRequired",
] as const;
type Check = (typeof CHECKS)[number];
const PARAMS = ["checks", "maxBooleanProps", "forwardRefPrimitives"] as const;

const majorOf = (version: string | undefined): number | undefined => {
  const match = version ? /(\d+)/.exec(version) : null;
  return match ? Number(match[1]) : undefined;
};

type Report = (line: number, column: number, detail: string) => void;

interface Scope {
  context: EngineContext;
  view: SourceView;
  path: string;
  report: Report;
  max: number;
  primitives: Array<(path: string) => boolean>;
}

const exportedComponents = (view: SourceView): ComponentRecord[] =>
  view.components.filter((c) => c.exported);

const RUNNERS: Record<Check, (scope: Scope) => void> = {
  propsTyped({ view, report }) {
    if (view.language !== "ts" && view.language !== "tsx") return;
    for (const component of exportedComponents(view))
      if (
        component.kind !== "class" &&
        component.props.declared &&
        component.props.typeKind === "none"
      )
        report(component.loc.line, component.loc.column, `${component.name} props are untyped`);
  },
  noAnyProps({ view, report }) {
    for (const component of exportedComponents(view))
      if (component.props.hasAny)
        report(component.loc.line, component.loc.column, `${component.name} props use any`);
  },
  maxBooleanProps({ view, report, max }) {
    for (const component of view.components)
      if (component.props.booleanProps.length > max)
        report(
          component.loc.line,
          component.loc.column,
          `${component.name} has ${component.props.booleanProps.length} boolean props (max ${max})`,
        );
  },
  polymorphicAsTyped({ view, report }) {
    for (const component of view.components) {
      const { as } = component.props;
      if (as.present && !(as.usesPropsHelper && as.typeParamConstraints.length > 0))
        report(
          component.loc.line,
          component.loc.column,
          `${component.name} has an untyped "as" prop`,
        );
    }
  },
  forwardRefPrimitives({ context, view, path, report, primitives }) {
    if ((majorOf(context.stack.frameworkVersion) ?? 0) >= 19) return;
    if (!primitives.some((test) => test(path))) return;
    for (const component of exportedComponents(view))
      if (component.kind !== "class" && !component.forwardsRef)
        report(
          component.loc.line,
          component.loc.column,
          `${component.name} does not forward its ref`,
        );
  },
  oneExportedComponent({ view, report }) {
    const exported = exportedComponents(view);
    const second = exported[1];
    if (second)
      report(
        second.loc.line,
        second.loc.column,
        `${exported.length} exported components in one file`,
      );
  },
  noNestedComponentDefinition({ view, report }) {
    for (const component of view.components)
      if (component.nestedIn)
        report(
          component.loc.line,
          component.loc.column,
          `${component.name} is defined inside ${component.nestedIn}`,
        );
  },
  noIndexKey({ view, report }) {
    for (const element of view.jsx)
      for (const attr of element.attrs)
        if (attr.keyIsIndex) report(attr.loc.line, attr.loc.column, "array index used as key");
  },
  noEffectOnlySetsState({ view, report }) {
    for (const effect of view.effects)
      if (
        effect.deps === "list" &&
        effect.setterCalls.length > 0 &&
        effect.otherCalls.length === 0 &&
        !effect.hasReturn &&
        !effect.hasAwait &&
        effect.statementCount <= 3
      )
        report(
          effect.loc.line,
          effect.loc.column,
          `${effect.hook} only calls ${effect.setterCalls.join(", ")}: derive the value during render`,
        );
  },
  noUnneededUseClient({ view, report }) {
    if (!view.directives.includes("use client")) return;
    const handlers = view.jsx.some((element) =>
      element.attrs.some((attr) => /^on[A-Z]/.test(attr.name) && attr.valueKind !== "none"),
    );
    if (view.hookCalls.length === 0 && !handlers && view.browserApis.length === 0)
      report(1, 1, '"use client" file uses no hooks, event handlers or browser APIs');
  },
  definePropsTyped({ view, report }) {
    for (const call of view.calls)
      if (
        call.callee === "defineProps" &&
        call.typeArgCount === 0 &&
        call.argTypes[0] !== "ObjectExpression"
      )
        report(
          call.loc.line,
          call.loc.column,
          "defineProps has neither a type argument nor runtime types",
        );
  },
  exportLetTyped({ view, report }) {
    if (view.language !== "ts" && view.language !== "tsx") return;
    for (const prop of view.exportedLets)
      if (!prop.typed)
        report(prop.loc.line, prop.loc.column, `export let ${prop.name} has no type`);
  },
  noBypassSecurityTrust({ view, report }) {
    for (const call of view.calls)
      if (/(?:^|\.)bypassSecurityTrust[A-Z]\w*$/.test(call.callee))
        report(call.loc.line, call.loc.column, `${call.callee}() disables Angular sanitisation`);
  },
  onPushRequired({ view, report }) {
    for (const component of view.angularComponents)
      if (
        !component.hasConstructorParams &&
        !component.usesInject &&
        !/OnPush/.test(component.changeDetection ?? "")
      )
        report(
          component.loc.line,
          component.loc.column,
          `${component.className} is presentational but not OnPush`,
        );
  },
};

export const componentApi: Engine = {
  id: "component-api",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    const checks = reader.strings("checks", true);
    if (checks)
      for (const check of checks)
        if (!(CHECKS as readonly string[]).includes(check))
          reader.errors.push(`checks: unknown check "${check}"`);
    reader.number("maxBooleanProps", 0);
    reader.globs("forwardRefPrimitives");
    if (checks?.includes("maxBooleanProps") && params.maxBooleanProps === undefined)
      reader.errors.push("maxBooleanProps: required by the maxBooleanProps check");
    if (checks?.includes("forwardRefPrimitives") && params.forwardRefPrimitives === undefined)
      reader.errors.push("forwardRefPrimitives: globs required by the forwardRefPrimitives check");
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, PARAMS);
    const checks = (reader.strings("checks", true) ?? []) as Check[];
    const max = reader.number("maxBooleanProps", 0) ?? 4;
    const primitives = (reader.globs("forwardRefPrimitives") ?? []).map((glob) =>
      compileGlob(glob),
    );
    const findings: RawFinding[] = [];
    for (const analysis of context.files)
      for (const piece of analysis.scripts) {
        const report: Report = (line, column, detail) => {
          findings.push({ file: analysis.path, line, column, detail });
        };
        for (const check of checks)
          RUNNERS[check]({
            context,
            view: piece.view,
            path: analysis.path,
            report,
            max,
            primitives,
          });
      }
    return { findings };
  },
};
