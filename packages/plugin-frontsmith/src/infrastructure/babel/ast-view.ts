import type {
  AngularComponentRecord,
  CallArg,
  ComponentRecord,
  EffectRecord,
  ExportedLetRecord,
  JsxAttribute,
  JsxElementRecord,
  Loc,
  PropsInfo,
  SourceLanguage,
  SourceView,
} from "../../application/ports/source-parser.js";

/** Minimal structural view of a Babel node; the parser's own types are not imported. */
export interface Node {
  type: string;
  start?: number;
  end?: number;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
}

const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "range",
  "errors",
]);
const CLASS_CALLS = new Set(["clsx", "cn", "cx", "classnames", "classNames", "twMerge", "twJoin"]);
const VARIANT_CALLS = new Set(["cva", "tv"]);
const TEST_CALL = /^(?:it|test|specify)(?:\.(?:only|skip|todo|fixme|fails|concurrent|serial))*$/;
const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
  "history",
  "matchMedia",
  "IntersectionObserver",
  "ResizeObserver",
  "MutationObserver",
]);
const IDENTIFIER_NON_REFERENCE_KEYS = new Set([
  "property",
  "key",
  "id",
  "params",
  "label",
  "local",
  "imported",
  "exported",
]);
const PROPS_HELPER =
  /(?:ComponentProps(?:WithoutRef|WithRef)?|HTMLAttributes|PropsOf|JSX\.IntrinsicElements)\s*</;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

const asNode = (value: unknown): Node | undefined => (isNode(value) ? value : undefined);
const nodes = (value: unknown): Node[] => (Array.isArray(value) ? value.filter(isNode) : []);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function* childNodes(node: Node): Generator<{ key: string; node: Node }> {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) yield { key, node: item };
    } else if (isNode(value)) yield { key, node: value };
  }
}

const isFunction = (node: Node | undefined): boolean =>
  node?.type === "FunctionDeclaration" ||
  node?.type === "FunctionExpression" ||
  node?.type === "ArrowFunctionExpression";

/** Does `node` contain JSX that belongs to its own body (not to a nested function or class)? */
function containsOwnJsx(node: Node | undefined): boolean {
  if (!node) return false;
  if (node.type === "JSXElement" || node.type === "JSXFragment") return true;
  for (const { node: child } of childNodes(node)) {
    if (isFunction(child) || child.type === "ClassDeclaration" || child.type === "ClassExpression")
      continue;
    if (containsOwnJsx(child)) return true;
  }
  return false;
}

export interface ViewOptions {
  path: string;
  language: SourceLanguage;
  origin: Loc;
}

export function buildSourceView(program: Node, source: string, options: ViewOptions): SourceView {
  const slice = (node: Node | undefined): string =>
    node && node.start !== undefined && node.end !== undefined
      ? source.slice(node.start, node.end)
      : "";

  const locOf = (node: Node, offset = 0): Loc => {
    const start = node.loc?.start ?? { line: 1, column: 0 };
    void offset;
    const line = options.origin.line + start.line - 1;
    const column = start.line === 1 ? options.origin.column + start.column : start.column + 1;
    return { line, column };
  };
  const endLineOf = (node: Node): number => options.origin.line + (node.loc?.end.line ?? 1) - 1;

  const view: SourceView = {
    path: options.path,
    language: options.language,
    lineCount: source === "" ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0),
    directives: [],
    imports: [],
    exportedNames: [],
    exportLines: {},
    exportedLets: [],
    jsx: [],
    classStrings: [],
    calls: [],
    components: [],
    effects: [],
    testCases: [],
    customPropertyStrings: [],
    dataUris: [],
    stateSetters: [],
    angularComponents: [],
    hookCalls: [],
    browserApis: [],
    stringLiterals: 0,
    comments: [],
  };

  const addExport = (name: string, node: Node): void => {
    view.exportedNames.push(name);
    if (view.exportLines[name] === undefined) view.exportLines[name] = locOf(node).line;
  };

  // ---- pre-pass: same-file type declarations and state setters ---------------------------------
  const localTypes = new Map<string, Node>();
  const setters = new Set<string>();
  const prepass = (node: Node): void => {
    if (node.type === "TSInterfaceDeclaration" || node.type === "TSTypeAliasDeclaration") {
      const name = str(asNode(node.id)?.name);
      if (name) localTypes.set(name, node);
    }
    if (node.type === "VariableDeclarator") {
      const id = asNode(node.id);
      const init = asNode(node.init);
      if (id?.type === "ArrayPattern" && init?.type === "CallExpression") {
        const callee = calleeText(asNode(init.callee));
        const second = asNode(Array.isArray(id.elements) ? id.elements[1] : undefined);
        if (
          (callee === "useState" || callee === "React.useState") &&
          second?.type === "Identifier"
        ) {
          const name = str(second.name);
          if (name && !setters.has(name)) {
            setters.add(name);
            view.stateSetters.push(name);
          }
        }
      }
    }
    for (const { node: child } of childNodes(node)) prepass(child);
  };

  function calleeText(callee: Node | undefined): string {
    if (!callee) return "?";
    if (callee.type === "Identifier") return str(callee.name) ?? "?";
    if (callee.type === "Import") return "import";
    if (callee.type === "ThisExpression") return "this";
    if (callee.type === "Super") return "super";
    if (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") {
      const object = calleeText(asNode(callee.object));
      const property = asNode(callee.property);
      const name = callee.computed
        ? "[]"
        : (str(property?.name) ?? str(asNode(property)?.value) ?? "?");
      return `${object}.${name}`;
    }
    if (callee.type === "CallExpression" || callee.type === "OptionalCallExpression")
      return `${calleeText(asNode(callee.callee))}()`;
    if (callee.type === "TSNonNullExpression" || callee.type === "ParenthesizedExpression")
      return calleeText(asNode(callee.expression));
    if (callee.type === "AwaitExpression") return calleeText(asNode(callee.argument));
    return "?";
  }

  // ---- class text extraction --------------------------------------------------------------------
  const staticTemplate = (node: Node): string | undefined => {
    const quasis = nodes(node.quasis);
    if (nodes(node.expressions).length > 0) return undefined;
    const cooked = asNode(quasis[0]?.value as unknown)?.cooked;
    const value = quasis[0]?.value as { cooked?: string; raw?: string } | undefined;
    void cooked;
    return value?.cooked ?? value?.raw ?? "";
  };

  /** Static text of an expression with `\u0000` for every unknown part; `dynamic` when any exist. */
  const textOf = (node: Node): { value: string; dynamic: boolean } => {
    if (node.type === "StringLiteral") return { value: str(node.value) ?? "", dynamic: false };
    if (node.type === "TemplateLiteral") {
      const quasis = nodes(node.quasis);
      let value = "";
      quasis.forEach((quasi, index) => {
        const v = quasi.value as { cooked?: string; raw?: string };
        value += v.cooked ?? v.raw ?? "";
        if (index < quasis.length - 1) value += "\u0000";
      });
      return { value, dynamic: nodes(node.expressions).length > 0 };
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = asNode(node.left);
      const right = asNode(node.right);
      const a = left ? textOf(left) : { value: "\u0000", dynamic: true };
      const b = right ? textOf(right) : { value: "\u0000", dynamic: true };
      return { value: a.value + b.value, dynamic: a.dynamic || b.dynamic };
    }
    return { value: "\u0000", dynamic: true };
  };

  const pushClass = (
    node: Node,
    origin: "attribute" | "call",
    name: string,
    parts: { value: string; dynamic: boolean },
    tag?: string,
  ): void => {
    if (parts.value.replaceAll("\u0000", "").trim() === "" && !parts.dynamic) return;
    view.classStrings.push({
      value: parts.value,
      dynamic: parts.dynamic,
      origin,
      name,
      ...(tag !== undefined ? { tag } : {}),
      loc: locOf(node),
    });
  };

  /** Extract class strings from an expression used as a class value. */
  const extractClass = (
    node: Node,
    origin: "attribute" | "call",
    name: string,
    tag?: string,
  ): void => {
    switch (node.type) {
      case "StringLiteral":
      case "TemplateLiteral":
        pushClass(node, origin, name, textOf(node), tag);
        return;
      case "BinaryExpression":
        if (node.operator === "+") pushClass(node, origin, name, textOf(node), tag);
        return;
      case "ConditionalExpression":
        for (const key of ["consequent", "alternate"]) {
          const branch = asNode(node[key]);
          if (branch) extractClass(branch, origin, name, tag);
        }
        return;
      case "LogicalExpression": {
        if (node.operator === "&&" || node.operator === "||" || node.operator === "??") {
          const right = asNode(node.right);
          if (right) extractClass(right, origin, name, tag);
          if (node.operator !== "&&") {
            const left = asNode(node.left);
            if (left) extractClass(left, origin, name, tag);
          }
        }
        return;
      }
      case "ArrayExpression":
        for (const element of nodes(node.elements)) extractClass(element, origin, name, tag);
        return;
      case "ObjectExpression":
        if (origin === "call")
          for (const property of nodes(node.properties)) {
            const key = asNode(property.key);
            if (key?.type === "StringLiteral" && !property.computed)
              pushClass(key, origin, name, { value: str(key.value) ?? "", dynamic: false });
          }
        return;
      default:
        return;
    }
  };

  /** Strings found under the given keys of a cva/tv configuration object. */
  const extractVariantConfig = (node: Node, name: string): void => {
    const leafStrings = (value: Node): void => {
      if (value.type === "StringLiteral" || value.type === "TemplateLiteral")
        extractClass(value, "call", name);
      else if (value.type === "ObjectExpression")
        for (const property of nodes(value.properties)) {
          const inner = asNode(property.value);
          if (inner) leafStrings(inner);
        }
      else if (value.type === "ArrayExpression")
        for (const item of nodes(value.elements)) leafStrings(item);
    };
    for (const property of nodes(node.properties)) {
      const key = asNode(property.key);
      const keyName = str(key?.name) ?? str(key?.value);
      const value = asNode(property.value);
      if (!value) continue;
      if (keyName === "variants" || keyName === "base" || keyName === "slots") leafStrings(value);
      else if (keyName === "compoundVariants" && value.type === "ArrayExpression")
        for (const entry of nodes(value.elements))
          for (const field of nodes(entry.properties)) {
            const fieldKey = str(asNode(field.key)?.name) ?? str(asNode(field.key)?.value);
            const fieldValue = asNode(field.value);
            if ((fieldKey === "class" || fieldKey === "className") && fieldValue)
              extractClass(fieldValue, "call", name);
          }
    }
  };

  // ---- props analysis ---------------------------------------------------------------------------
  const typeMembers = (type: Node | undefined, seen = new Set<string>()): Node[] => {
    if (!type) return [];
    if (type.type === "TSTypeLiteral") return nodes(type.members);
    if (type.type === "TSInterfaceBody") return nodes(type.body);
    if (type.type === "TSIntersectionType" || type.type === "TSUnionType")
      return nodes(type.types).flatMap((member) => typeMembers(member, seen));
    if (type.type === "TSParenthesizedType") return typeMembers(asNode(type.typeAnnotation), seen);
    if (type.type === "TSTypeReference") {
      const name = str(asNode(type.typeName)?.name);
      const declaration = name ? localTypes.get(name) : undefined;
      if (name && declaration && !seen.has(name)) {
        seen.add(name);
        if (declaration.type === "TSInterfaceDeclaration")
          return typeMembers(asNode(declaration.body), seen);
        return typeMembers(asNode(declaration.typeAnnotation), seen);
      }
    }
    return [];
  };

  const memberName = (member: Node): string | undefined => {
    const key = asNode(member.key);
    return str(key?.name) ?? str(key?.value);
  };
  const memberType = (member: Node): Node | undefined =>
    asNode(asNode(member.typeAnnotation)?.typeAnnotation);

  const referencedSource = (type: Node | undefined, seen = new Set<string>()): string => {
    if (!type) return "";
    let text = slice(type);
    for (const { node: child } of childNodes(type)) void child;
    const visitRefs = (node: Node): void => {
      if (node.type === "TSTypeReference") {
        const name = str(asNode(node.typeName)?.name);
        const declaration = name ? localTypes.get(name) : undefined;
        if (name && declaration && !seen.has(name)) {
          seen.add(name);
          text += ` ${slice(declaration)}`;
          visitRefs(declaration);
        }
      }
      for (const { node: child } of childNodes(node)) visitRefs(child);
    };
    visitRefs(type);
    return text;
  };

  const analyseProps = (fn: Node | undefined, fallbackType?: Node): PropsInfo => {
    const info: PropsInfo = {
      declared: false,
      typeKind: "none",
      hasAny: false,
      booleanProps: [],
      names: [],
      spreadRest: false,
      as: { present: false, typeParamConstraints: [], usesPropsHelper: false },
    };
    const typeParams = nodes(asNode(fn?.typeParameters)?.params);
    info.as.typeParamConstraints = typeParams.map((param) => slice(param));
    const params = fn?.params;
    const first = asNode(Array.isArray(params) ? params[0] : undefined);
    if (!first) return info;
    info.declared = true;
    const annotated = asNode(asNode(first.typeAnnotation)?.typeAnnotation) ?? fallbackType;
    if (first.type === "ObjectPattern") {
      for (const property of nodes(first.properties)) {
        if (property.type === "RestElement") info.spreadRest = true;
        else {
          const key = memberName(property);
          if (key) info.names.push(key);
        }
      }
    }
    if (annotated) {
      if (annotated.type === "TSAnyKeyword") {
        info.typeKind = "any";
        info.hasAny = true;
      } else {
        info.typeKind = annotated.type === "TSTypeLiteral" ? "inline" : "reference";
        info.typeText = slice(annotated);
        const members = typeMembers(annotated);
        for (const member of members) {
          const name = memberName(member);
          const type = memberType(member);
          if (name && !info.names.includes(name)) info.names.push(name);
          if (name && type?.type === "TSBooleanKeyword" && !info.booleanProps.includes(name))
            info.booleanProps.push(name);
          if (type?.type === "TSAnyKeyword") info.hasAny = true;
          if (name === "as") {
            info.as.present = true;
            info.as.typeText = slice(type);
          }
        }
        if (PROPS_HELPER.test(referencedSource(annotated))) info.as.usesPropsHelper = true;
      }
    }
    if (info.names.includes("as")) info.as.present = true;
    return info;
  };

  // ---- main traversal ---------------------------------------------------------------------------
  const exportedDeclarations = new Set<Node>();
  interface Ctx {
    jsxParent: number;
    component?: ComponentRecord;
    indexNames: string[];
  }

  const recordComponent = (record: ComponentRecord): ComponentRecord => {
    view.components.push(record);
    return record;
  };

  const unwrapComponent = (
    init: Node,
  ):
    | { fn: Node; kind: ComponentRecord["kind"]; fallbackType?: Node; forwardRef: boolean }
    | undefined => {
    if (isFunction(init))
      return {
        fn: init,
        kind: init.type === "ArrowFunctionExpression" ? "arrow" : "function",
        forwardRef: false,
      };
    if (init.type !== "CallExpression") return undefined;
    const callee = calleeText(asNode(init.callee));
    const args = nodes(init.arguments);
    const fn = args[0];
    if (callee === "forwardRef" || callee === "React.forwardRef") {
      const typeArgs = nodes(asNode(init.typeParameters)?.params);
      if (fn && isFunction(fn))
        return {
          fn,
          kind: "forwardRef",
          ...(typeArgs[1] ? { fallbackType: typeArgs[1] } : {}),
          forwardRef: true,
        };
      return undefined;
    }
    if (callee === "memo" || callee === "React.memo") {
      if (!fn) return undefined;
      const inner = unwrapComponent(fn);
      if (inner) return { ...inner, kind: inner.forwardRef ? "forwardRef" : "memo" };
    }
    return undefined;
  };

  const startComponent = (
    name: string,
    fn: Node,
    kind: ComponentRecord["kind"],
    ctx: Ctx,
    extra: {
      exported: boolean;
      defaultExport: boolean;
      forwardRef: boolean;
      fallbackType?: Node;
      annotationType?: Node;
    },
  ): ComponentRecord => {
    const props = analyseProps(fn, extra.fallbackType ?? extra.annotationType);
    return recordComponent({
      name,
      kind,
      exported: extra.exported,
      defaultExport: extra.defaultExport,
      props,
      forwardsRef: extra.forwardRef || props.names.includes("ref"),
      ...(ctx.component ? { nestedIn: ctx.component.name } : {}),
      usesHooks: [],
      loc: locOf(fn),
      endLine: endLineOf(fn),
    });
  };

  const annotationProps = (id: Node | undefined): Node | undefined => {
    const annotation = asNode(asNode(id?.typeAnnotation)?.typeAnnotation);
    if (annotation?.type !== "TSTypeReference") return undefined;
    const name = slice(asNode(annotation.typeName));
    if (!/^(?:React\.)?(?:FC|FunctionComponent|VFC)$/.test(name)) return undefined;
    return nodes(asNode(annotation.typeParameters)?.params)[0];
  };

  const argSummary = (arg: Node): CallArg => {
    if (arg.type === "StringLiteral") return { kind: "string", value: str(arg.value) ?? "" };
    if (arg.type === "TemplateLiteral") {
      const value = staticTemplate(arg);
      return value === undefined ? { kind: "other" } : { kind: "template", value };
    }
    return { kind: "other" };
  };

  const visitCall = (node: Node, ctx: Ctx): void => {
    const calleeNode = asNode(node.callee);
    const callee = calleeText(calleeNode);
    const args = nodes(node.arguments);
    view.calls.push({
      callee,
      args: args.slice(0, 4).map(argSummary),
      argTypes: args.slice(0, 4).map((arg) => arg.type),
      argCount: args.length,
      typeArgCount: nodes(asNode(node.typeParameters)?.params).length,
      loc: locOf(node),
    });
    if (calleeNode?.type === "Import") {
      const first = args[0];
      if (first?.type === "StringLiteral")
        view.imports.push({
          specifier: str(first.value) ?? "",
          kind: "dynamic",
          typeOnly: false,
          names: [],
          loc: locOf(node),
        });
    } else if (callee === "require" && args[0]?.type === "StringLiteral") {
      view.imports.push({
        specifier: str(args[0].value) ?? "",
        kind: "require",
        typeOnly: false,
        names: [],
        loc: locOf(node),
      });
    }
    const last = callee.split(".").pop() ?? callee;
    if (/^use[A-Z0-9]/.test(last) && !callee.includes("()")) {
      if (!view.hookCalls.includes(last)) view.hookCalls.push(last);
      if (ctx.component && !ctx.component.usesHooks.includes(last))
        ctx.component.usesHooks.push(last);
    }
    if (CLASS_CALLS.has(callee)) for (const arg of args) extractClass(arg, "call", callee);
    if (VARIANT_CALLS.has(callee)) {
      const first = args[0];
      if (first) extractClass(first, "call", callee);
      const config = args[1];
      if (config?.type === "ObjectExpression") extractVariantConfig(config, callee);
    }
    if (EFFECT_HOOKS.has(last) && !callee.includes("()")) recordEffect(node, last);
    if (TEST_CALL.test(callee)) recordTestCase(node, callee, args);
  };

  const recordTestCase = (node: Node, callee: string, args: Node[]): void => {
    const body = args.find((arg) => isFunction(arg));
    const calls: string[] = [];
    if (body) {
      const collect = (n: Node): void => {
        if (n.type === "CallExpression") calls.push(calleeText(asNode(n.callee)));
        for (const { node: child } of childNodes(n)) collect(child);
      };
      collect(body);
    }
    const first = args[0];
    view.testCases.push({
      callee,
      name: first?.type === "StringLiteral" ? (str(first.value) ?? "") : "",
      hasBody: body !== undefined,
      calls,
      loc: locOf(node),
    });
  };

  const recordEffect = (node: Node, hook: string): void => {
    const args = nodes(node.arguments);
    const fn = args[0];
    if (!fn || !isFunction(fn)) return;
    const depsNode = args[1];
    const deps: EffectRecord["deps"] =
      depsNode === undefined
        ? "none"
        : depsNode.type === "ArrayExpression" && nodes(depsNode.elements).length === 0
          ? "empty"
          : "list";
    const body = asNode(fn.body);
    const statements = body?.type === "BlockStatement" ? nodes(body.body) : body ? [body] : [];
    const setterCalls: string[] = [];
    const otherCalls: string[] = [];
    let hasReturn = false;
    let hasAwait = fn.async === true;
    const scan = (n: Node, depth: number): void => {
      if (n.type === "AwaitExpression") hasAwait = true;
      if (n.type === "ReturnStatement" && depth === 0 && n.argument) hasReturn = true;
      if (n.type === "CallExpression") {
        const name = calleeText(asNode(n.callee));
        const target = setters.has(name) ? setterCalls : otherCalls;
        if (!target.includes(name)) target.push(name);
      }
      for (const { node: child } of childNodes(n))
        scan(child, isFunction(child) ? depth + 1 : depth);
    };
    if (body) scan(body, 0);
    view.effects.push({
      hook,
      deps,
      statementCount: statements.length,
      setterCalls,
      otherCalls,
      hasReturn,
      hasAwait,
      loc: locOf(node),
    });
  };

  const visitJsx = (node: Node, ctx: Ctx): number => {
    const opening = asNode(node.openingElement);
    const nameNode = asNode(opening?.name);
    const tag = jsxName(nameNode);
    const attrs: JsxAttribute[] = [];
    for (const attr of nodes(opening?.attributes)) {
      if (attr.type === "JSXSpreadAttribute") {
        attrs.push({ name: "...", spread: true, valueKind: "expression", loc: locOf(attr) });
        continue;
      }
      const name = jsxName(asNode(attr.name));
      const value = asNode(attr.value);
      const record: JsxAttribute = { name, spread: false, valueKind: "none", loc: locOf(attr) };
      if (value?.type === "StringLiteral") {
        record.valueKind = "string";
        record.value = str(value.value) ?? "";
      } else if (value?.type === "JSXExpressionContainer") {
        const expression = asNode(value.expression);
        if (expression?.type === "TemplateLiteral") {
          record.valueKind = "template";
          const staticText = staticTemplate(expression);
          if (staticText !== undefined) record.value = staticText;
        } else if (expression?.type === "StringLiteral") {
          record.valueKind = "string";
          record.value = str(expression.value) ?? "";
        } else if (expression?.type === "NumericLiteral" || expression?.type === "BooleanLiteral") {
          record.valueKind = "literal";
          record.value = String(expression.value);
        } else record.valueKind = "expression";
        if (name === "key" && expression) {
          let flagged = false;
          const walk = (n: Node): void => {
            if (n.type === "Identifier" && ctx.indexNames.includes(str(n.name) ?? ""))
              flagged = true;
            for (const { node: child } of childNodes(n)) walk(child);
          };
          walk(expression);
          record.keyIsIndex = flagged;
        }
        if (
          (name === "className" || name === "class") &&
          expression &&
          expression.type !== "CallExpression"
        )
          extractClass(expression, "attribute", name, tag);
      } else if (value === undefined && name === "key") record.keyIsIndex = false;
      if (value?.type === "StringLiteral" && (name === "className" || name === "class"))
        pushClass(value, "attribute", name, { value: str(value.value) ?? "", dynamic: false }, tag);
      attrs.push(record);
    }
    const children = nodes(node.children);
    const hasText = children.some(
      (child) =>
        (child.type === "JSXText" && (str(child.value) ?? "").trim() !== "") ||
        (child.type === "JSXExpressionContainer" &&
          asNode(child.expression)?.type !== "JSXEmptyExpression") ||
        child.type === "JSXSpreadChild",
    );
    const record: JsxElementRecord = {
      index: view.jsx.length,
      tag,
      isComponent: /^[A-Z]/.test(tag) || tag.includes("."),
      attrs,
      selfClosing: opening?.selfClosing === true,
      parent: ctx.jsxParent,
      hasTextChildren: hasText,
      childTags: children
        .filter((c) => c.type === "JSXElement")
        .map((c) => jsxName(asNode(asNode(c.openingElement)?.name))),
      loc: locOf(node),
    };
    view.jsx.push(record);
    return record.index;
  };

  function jsxName(node: Node | undefined): string {
    if (!node) return "";
    if (node.type === "JSXIdentifier") return str(node.name) ?? "";
    if (node.type === "JSXMemberExpression")
      return `${jsxName(asNode(node.object))}.${jsxName(asNode(node.property))}`;
    if (node.type === "JSXNamespacedName")
      return `${jsxName(asNode(node.namespace))}:${jsxName(asNode(node.name))}`;
    return "";
  }

  const visitAngular = (node: Node): void => {
    for (const decorator of nodes(node.decorators)) {
      const call = asNode(decorator.expression);
      if (call?.type !== "CallExpression" || calleeText(asNode(call.callee)) !== "Component")
        continue;
      const config = nodes(call.arguments)[0];
      const record: AngularComponentRecord = {
        className: str(asNode(node.id)?.name) ?? "default",
        hasConstructorParams: false,
        usesInject: false,
        loc: locOf(node),
      };
      for (const property of nodes(config?.properties)) {
        const key = str(asNode(property.key)?.name) ?? str(asNode(property.key)?.value);
        const value = asNode(property.value);
        if (!key || !value) continue;
        if (key === "selector" && value.type === "StringLiteral")
          record.selector = str(value.value) ?? "";
        else if (key === "templateUrl" && value.type === "StringLiteral")
          record.templateUrl = str(value.value) ?? "";
        else if (key === "changeDetection") record.changeDetection = slice(value);
        else if (
          key === "template" &&
          (value.type === "StringLiteral" || value.type === "TemplateLiteral") &&
          value.start !== undefined &&
          value.end !== undefined
        ) {
          const start = value.start + 1;
          const end = value.end - 1;
          const at = value.loc
            ? locOf({
                ...value,
                loc: {
                  start: { line: value.loc.start.line, column: value.loc.start.column + 1 },
                  end: value.loc.end,
                },
              })
            : locOf(value);
          record.template = {
            text: source.slice(start, end),
            line: at.line,
            column: at.column,
            start,
            end,
          };
        }
      }
      for (const member of nodes(asNode(node.body)?.body)) {
        if (
          member.type === "ClassMethod" &&
          member.kind === "constructor" &&
          nodes(member.params).length > 0
        )
          record.hasConstructorParams = true;
      }
      const findInject = (n: Node): void => {
        if (n.type === "CallExpression" && calleeText(asNode(n.callee)) === "inject")
          record.usesInject = true;
        for (const { node: child } of childNodes(n)) findInject(child);
      };
      findInject(node);
      view.angularComponents.push(record);
    }
  };

  const collectCustomProperties = (text: string): void => {
    for (const match of text.matchAll(/--[A-Za-z0-9_-]+/g))
      if (!view.customPropertyStrings.includes(match[0])) view.customPropertyStrings.push(match[0]);
  };

  const visit = (node: Node, ctx: Ctx, parentKey = "", parent?: Node): void => {
    switch (node.type) {
      case "Program": {
        for (const directive of nodes(node.directives)) {
          const value = asNode(directive.value);
          view.directives.push(str(value?.value) ?? "");
        }
        break;
      }
      case "ImportDeclaration": {
        const names: string[] = [];
        for (const specifier of nodes(node.specifiers)) {
          if (specifier.type === "ImportDefaultSpecifier") names.push("default");
          else if (specifier.type === "ImportNamespaceSpecifier") names.push("*");
          else {
            const imported = asNode(specifier.imported);
            names.push(str(imported?.name) ?? str(imported?.value) ?? "");
          }
        }
        view.imports.push({
          specifier: str(asNode(node.source)?.value) ?? "",
          kind: "static",
          typeOnly: node.importKind === "type",
          names,
          loc: locOf(node),
        });
        return;
      }
      case "ExportAllDeclaration":
        view.imports.push({
          specifier: str(asNode(node.source)?.value) ?? "",
          kind: "export-from",
          typeOnly: node.exportKind === "type",
          names: ["*"],
          loc: locOf(node),
        });
        return;
      case "ExportNamedDeclaration": {
        const declaration = asNode(node.declaration);
        const sourceNode = asNode(node.source);
        if (declaration) exportedDeclarations.add(declaration);
        if (sourceNode) {
          const names = nodes(node.specifiers).map(
            (s) => str(asNode(s.local)?.name) ?? str(asNode(s.local)?.value) ?? "",
          );
          view.imports.push({
            specifier: str(sourceNode.value) ?? "",
            kind: "export-from",
            typeOnly: node.exportKind === "type",
            names,
            loc: locOf(node),
          });
          for (const specifier of nodes(node.specifiers)) {
            const exported = asNode(specifier.exported);
            addExport(str(exported?.name) ?? str(exported?.value) ?? "", specifier);
          }
          return;
        }
        if (declaration) {
          if (declaration.type === "VariableDeclaration") {
            for (const declarator of nodes(declaration.declarations)) {
              const id = asNode(declarator.id);
              if (id?.type === "Identifier") {
                const name = str(id.name) ?? "";
                addExport(name, id);
                if (declaration.kind === "let")
                  view.exportedLets.push({
                    name,
                    typed: id.typeAnnotation !== undefined && id.typeAnnotation !== null,
                    loc: locOf(id),
                  } satisfies ExportedLetRecord);
              }
            }
          } else {
            const name = str(asNode(declaration.id)?.name);
            if (name) addExport(name, declaration);
          }
        }
        for (const specifier of nodes(node.specifiers)) {
          const exported = asNode(specifier.exported);
          addExport(str(exported?.name) ?? str(exported?.value) ?? "", specifier);
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        addExport("default", node);
        const declaration = asNode(node.declaration);
        if (
          declaration &&
          (declaration.type === "FunctionDeclaration" ||
            declaration.type === "ArrowFunctionExpression" ||
            declaration.type === "FunctionExpression") &&
          containsOwnJsx(asNode(declaration.body))
        ) {
          const name = str(asNode(declaration.id)?.name) ?? "default";
          const record = startComponent(
            name,
            declaration,
            declaration.type === "ArrowFunctionExpression" ? "arrow" : "function",
            ctx,
            { exported: true, defaultExport: true, forwardRef: false },
          );
          visitChildren(declaration, { ...ctx, component: record, indexNames: [] });
          return;
        }
        if (declaration?.type === "CallExpression") {
          const unwrapped = unwrapComponent(declaration);
          if (unwrapped) {
            const record = startComponent("default", unwrapped.fn, unwrapped.kind, ctx, {
              exported: true,
              defaultExport: true,
              forwardRef: unwrapped.forwardRef,
              ...(unwrapped.fallbackType ? { fallbackType: unwrapped.fallbackType } : {}),
            });
            visitChildren(declaration, { ...ctx, component: record, indexNames: [] });
            return;
          }
        }
        break;
      }
      case "FunctionDeclaration": {
        const name = str(asNode(node.id)?.name);
        const exported = parent?.type === "ExportNamedDeclaration";
        if (name && /^[A-Z]/.test(name) && containsOwnJsx(asNode(node.body))) {
          const record = startComponent(name, node, "function", ctx, {
            exported,
            defaultExport: false,
            forwardRef: false,
          });
          visitChildren(node, { ...ctx, component: record, indexNames: [] });
          return;
        }
        break;
      }
      case "VariableDeclarator": {
        const id = asNode(node.id);
        const init = asNode(node.init);
        const name = id?.type === "Identifier" ? str(id.name) : undefined;
        if (name && /^[A-Z]/.test(name) && init) {
          const unwrapped = unwrapComponent(init);
          const hasJsx = unwrapped
            ? unwrapped.kind !== "arrow" && unwrapped.kind !== "function"
              ? true
              : containsOwnJsx(asNode(unwrapped.fn.body))
            : false;
          if (unwrapped && hasJsx) {
            const annotationType = annotationProps(id);
            const record = startComponent(name, unwrapped.fn, unwrapped.kind, ctx, {
              exported: parent !== undefined && exportedDeclarations.has(parent),
              defaultExport: false,
              forwardRef: unwrapped.forwardRef,
              ...(unwrapped.fallbackType ? { fallbackType: unwrapped.fallbackType } : {}),
              ...(annotationType ? { annotationType } : {}),
            });
            visitChildren(init, { ...ctx, component: record, indexNames: [] });
            return;
          }
        }
        break;
      }
      case "ClassDeclaration": {
        visitAngular(node);
        const superClass = calleeText(asNode(node.superClass));
        const name = str(asNode(node.id)?.name);
        if (name && /^(?:React\.)?(?:Pure)?Component$/.test(superClass)) {
          const typeArgs = nodes(asNode(node.superTypeParameters)?.params);
          const record = startComponent(
            name,
            { ...node, params: [], type: "ClassDeclaration" },
            "class",
            ctx,
            {
              exported:
                parent?.type === "ExportNamedDeclaration" ||
                parent?.type === "ExportDefaultDeclaration",
              defaultExport: parent?.type === "ExportDefaultDeclaration",
              forwardRef: false,
            },
          );
          if (typeArgs[0]) {
            record.props = {
              ...record.props,
              declared: true,
              typeKind: "reference",
              typeText: slice(typeArgs[0]),
            };
          }
          visitChildren(node, { ...ctx, component: record, indexNames: [] });
          return;
        }
        break;
      }
      case "CallExpression":
      case "OptionalCallExpression": {
        visitCall(node, ctx);
        const callee = asNode(node.callee);
        const first = nodes(node.arguments)[0];
        if (
          callee?.type === "MemberExpression" &&
          !callee.computed &&
          str(asNode(callee.property)?.name) === "map" &&
          first &&
          isFunction(first)
        ) {
          const indexParam = asNode(
            Array.isArray(first.params) ? (first.params as unknown[])[1] : undefined,
          );
          const next: Ctx = {
            ...ctx,
            indexNames:
              indexParam?.type === "Identifier"
                ? [...ctx.indexNames, str(indexParam.name) ?? ""]
                : ctx.indexNames,
          };
          if (callee) visit(callee, ctx, "callee", node);
          for (const arg of nodes(node.arguments))
            visit(arg, arg === first ? next : ctx, "arguments", node);
          return;
        }
        break;
      }
      case "ImportExpression": {
        const first = asNode(node.source);
        if (first?.type === "StringLiteral")
          view.imports.push({
            specifier: str(first.value) ?? "",
            kind: "dynamic",
            typeOnly: false,
            names: [],
            loc: locOf(node),
          });
        break;
      }
      case "JSXElement": {
        const index = visitJsx(node, ctx);
        const next: Ctx = { ...ctx, jsxParent: index };
        const opening = asNode(node.openingElement);
        if (opening) visitChildren(opening, ctx);
        for (const child of nodes(node.children)) visit(child, next, "children", node);
        return;
      }
      case "JSXAttribute":
        // The name is a JSXIdentifier; only the value can hold nested expressions.
        {
          const value = asNode(node.value);
          if (value) visit(value, ctx, "value", node);
        }
        return;
      case "StringLiteral":
        view.stringLiterals += 1;
        collectCustomProperties(str(node.value) ?? "");
        if ((str(node.value) ?? "").startsWith("data:"))
          view.dataUris.push({ length: (str(node.value) ?? "").length, loc: locOf(node) });
        return;
      case "TemplateLiteral":
        for (const quasi of nodes(node.quasis))
          collectCustomProperties((quasi.value as { raw?: string }).raw ?? "");
        break;
      case "Identifier": {
        const name = str(node.name) ?? "";
        if (
          BROWSER_GLOBALS.has(name) &&
          !IDENTIFIER_NON_REFERENCE_KEYS.has(parentKey) &&
          !view.browserApis.includes(name)
        )
          view.browserApis.push(name);
        return;
      }
      default:
        break;
    }
    visitChildren(node, ctx);
  };

  const visitChildren = (node: Node, ctx: Ctx): void => {
    for (const { key, node: child } of childNodes(node)) {
      if (
        key === "property" &&
        (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
        !node.computed
      )
        continue;
      if (
        key === "key" &&
        node.computed !== true &&
        (node.type === "ObjectProperty" ||
          node.type === "ClassProperty" ||
          node.type === "ObjectMethod" ||
          node.type === "ClassMethod")
      )
        continue;
      visit(child, ctx, key, node);
    }
  };

  prepass(program);
  visit(program, { jsxParent: -1, indexNames: [] });

  // `export { Name }` or `export default Name` after the definition marks components exported.
  for (const component of view.components)
    if (!component.exported && view.exportedNames.includes(component.name))
      component.exported = true;
  return view;
}
