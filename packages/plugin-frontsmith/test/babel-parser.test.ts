import { describe, expect, it } from "vitest";
import { languageForPath } from "../src/application/ports/source-parser.js";
import { babelSourceParser } from "../src/infrastructure/babel/parser.js";

const view = (code: string, path = "a.tsx") => {
  const result = babelSourceParser.parse(code, { path });
  if (!result.view) throw new Error(`parse failed: ${result.error?.message}`);
  return result.view;
};

describe("language selection", () => {
  it("derives the language from the extension", () => {
    expect(languageForPath("a.ts")).toBe("ts");
    expect(languageForPath("a.tsx")).toBe("tsx");
    expect(languageForPath("a.jsx")).toBe("jsx");
    expect(languageForPath("a.js")).toBe("js");
    expect(languageForPath("a.mjs")).toBe("js");
    expect(languageForPath("a.cts")).toBe("ts");
  });
});

describe("parse results", () => {
  it("parses the syntax families of the S-R2 corpus without throwing", () => {
    const corpus: Array<[string, string]> = [
      [
        "a.ts",
        `@Component({selector:"a"}) class A { @Input() x!: string; constructor(@Inject(T) private t: T) {} }`,
      ],
      ["a.ts", "const o = { a: 1 } satisfies Record<string, number>; export default o;"],
      [
        "a.ts",
        "export enum E { A = 1, B } declare const enum F { X } namespace N { export const a = 1 }",
      ],
      ["a.ts", "abstract class B { abstract m(): void; protected abstract readonly x: number; }"],
      ["a.tsx", "const f = <T,>(p: {v: T}) => <div>{String(p.v)}</div>;"],
      ["a.js", 'export const A = () => <div className="a">hi</div>;'],
      ["a.js", "class A { #p = 1; static s = 2; static { A.s = 4 } get p() { return this.#p } }"],
      ["a.mjs", "const r = await fetch('x'); export default r;"],
      ["a.js", "import data from './a.json' with { type: 'json' }; export { data };"],
    ];
    for (const [path, code] of corpus) {
      const result = babelSourceParser.parse(code, { path });
      expect(result.ok, `${path}: ${code}`).toBe(true);
      expect(result.view).toBeDefined();
    }
  });

  it("reports an unparsable file with a position instead of throwing", () => {
    const result = babelSourceParser.parse("const x: = ;", { path: "a.ts" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ line: 1 });
    expect(result.view).toBeUndefined();
    const flow = babelSourceParser.parse("// @flow\nfunction f(x: number): string { return ''; }", {
      path: "a.js",
    });
    expect(flow.ok).toBe(false);
  });

  it("surfaces recoverable errors but still returns a view", () => {
    const result = babelSourceParser.parse("let a = 1;\nlet a = 2;\n", { path: "a.js" });
    expect(result.ok).toBe(true);
    expect(result.recoverable.length).toBeGreaterThan(0);
    expect(result.view?.lineCount).toBe(2);
  });

  it("applies an origin offset to extracted text", () => {
    const result = babelSourceParser.parse("import a from 'x';", {
      path: "a.ts",
      origin: { line: 10, column: 5 },
    });
    expect(result.view?.imports[0]?.loc).toEqual({ line: 10, column: 5 });
  });
});

describe("imports and exports", () => {
  it("lists every import form with its names", () => {
    const v = view(
      `import a, { b as c, type D } from "./x";
import * as ns from "ns";
import type { T } from "types";
import "side-effect";
export { e } from "./e";
export * from "./all";
const l = await import("./lazy");
const r = require("req");`,
    );
    expect(v.imports.map((i) => [i.specifier, i.kind, i.typeOnly, i.names.join(",")])).toEqual([
      ["./x", "static", false, "default,b,D"],
      ["ns", "static", false, "*"],
      ["types", "static", true, "T"],
      ["side-effect", "static", false, ""],
      ["./e", "export-from", false, "e"],
      ["./all", "export-from", false, "*"],
      ["./lazy", "dynamic", false, ""],
      ["req", "require", false, ""],
    ]);
    expect(v.imports[0]?.loc).toEqual({ line: 1, column: 1 });
    expect(v.imports[3]?.loc.line).toBe(4);
  });

  it("collects exported names, directives and exported let props", () => {
    const v = view(
      `"use client";\nexport const a = 1;\nexport function b() {}\nexport default function C() { return <div/> }\nexport let name: string;\nexport let untyped;`,
    );
    expect(v.directives).toEqual(["use client"]);
    expect(v.exportedNames).toEqual(["a", "b", "default", "name", "untyped"]);
    expect(v.exportedLets).toMatchObject([
      { name: "name", typed: true },
      { name: "untyped", typed: false },
    ]);
  });
});

describe("jsx", () => {
  it("records elements, attributes, parents and text children", () => {
    const v = view(
      `export const A = (p: { n: number }) => (
  <section className="a" {...p} data-x={p.n} title={\`t\`} hidden>
    <img src="x.png" />
    <button onClick={go}>{label}</button>
    <Icon.Mark />
    text
  </section>
);`,
    );
    expect(v.jsx.map((e) => [e.tag, e.isComponent, e.parent])).toEqual([
      ["section", false, -1],
      ["img", false, 0],
      ["button", false, 0],
      ["Icon.Mark", true, 0],
    ]);
    const section = v.jsx[0];
    expect(section?.attrs.map((a) => [a.name, a.valueKind, a.value])).toEqual([
      ["className", "string", "a"],
      ["...", "expression", undefined],
      ["data-x", "expression", undefined],
      ["title", "template", "t"],
      ["hidden", "none", undefined],
    ]);
    expect(section?.attrs[1]?.spread).toBe(true);
    expect(section?.hasTextChildren).toBe(true);
    expect(v.jsx[1]).toMatchObject({
      selfClosing: true,
      hasTextChildren: false,
      loc: { line: 3, column: 5 },
    });
    expect(v.jsx[2]?.hasTextChildren).toBe(true);
    expect(v.jsx[3]?.hasTextChildren).toBe(false);
    expect(section?.childTags).toEqual(["img", "button", "Icon.Mark"]);
  });

  it("flags an array index used as a key", () => {
    const v = view(
      `const L = ({ xs }) => xs.map((x, i) => <li key={i}>{x}</li>);
const M = ({ xs }) => xs.map((x) => <li key={x.id}>{x.name}</li>);
const N = ({ xs }) => xs.map((x, idx) => <li key={\`row-\${idx}\`}>{x}</li>);`,
      "a.jsx",
    );
    const keys = v.jsx.map((e) => e.attrs.find((a) => a.name === "key")?.keyIsIndex);
    expect(keys).toEqual([true, false, true]);
  });
});

describe("class strings", () => {
  it("finds static, dynamic and call-argument class text", () => {
    const v = view(
      `const a = <div className="p-4 flex" />;
const b = <div className={"text-sm"} />;
const c = <div className={\`bg-\${color}-500 p-2\`} />;
const d = <div className={"bg-" + color} />;
const e = <div className={clsx("a b", cond && "c", { d: on })} />;
const f = cva("base px-2", { variants: { tone: { x: "bg-red-500" } } });
const g = <div class="plain" />;`,
    );
    const rows = v.classStrings.map((c) => [
      c.value.replaceAll("\u0000", "$"),
      c.dynamic,
      c.origin,
      c.name,
    ]);
    expect(rows).toEqual([
      ["p-4 flex", false, "attribute", "className"],
      ["text-sm", false, "attribute", "className"],
      ["bg-$-500 p-2", true, "attribute", "className"],
      ["bg-$", true, "attribute", "className"],
      ["a b", false, "call", "clsx"],
      ["c", false, "call", "clsx"],
      ["base px-2", false, "call", "cva"],
      ["bg-red-500", false, "call", "cva"],
      ["plain", false, "attribute", "class"],
    ]);
    expect(v.classStrings[0]?.loc).toEqual({ line: 1, column: 26 });
  });
});

describe("calls", () => {
  it("builds dotted callees with intermediate calls and string arguments", () => {
    const v = view(
      `test.only("x", async () => {
  await page.locator("div > span:nth-child(2)").first().click();
  expect(await page.title()).toMatchSnapshot();
  screen.getByRole("button", { name: "Go" });
});
const p = defineProps<{ a: string }>();`,
      "a.ts",
    );
    const callees = v.calls.map((c) => c.callee);
    expect(callees).toContain("test.only");
    expect(callees).toContain("page.locator");
    expect(callees).toContain("page.locator().first().click");
    expect(callees).toContain("expect().toMatchSnapshot");
    expect(callees).toContain("screen.getByRole");
    const locator = v.calls.find((c) => c.callee === "page.locator");
    expect(locator?.args[0]).toEqual({ kind: "string", value: "div > span:nth-child(2)" });
    const defineProps = v.calls.find((c) => c.callee === "defineProps");
    expect(defineProps).toMatchObject({ typeArgCount: 1, argCount: 0 });
  });
});

describe("components", () => {
  it("detects function, arrow, forwardRef and memo components with props facts", () => {
    const v = view(
      `import { forwardRef, memo } from "react";
interface ButtonProps { primary?: boolean; disabled: boolean; label: string; as?: string }
export function Button({ primary, label }: ButtonProps) { return <button>{label}</button>; }
export const Card = ({ title }: { title: string; open: boolean }) => <div>{title}</div>;
export const Field = forwardRef<HTMLInputElement, { v: string }>(function Field(props, ref) { return <input ref={ref} />; });
const Memo = memo(function Memo(props: any) { return <i /> });
export default function Page(props) { return <Button label="x" />; }
function helper() { return 1; }`,
    );
    const byName = Object.fromEntries(v.components.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(["Button", "Card", "Field", "Memo", "Page"]);
    expect(byName.Button).toMatchObject({ kind: "function", exported: true, defaultExport: false });
    expect(byName.Button?.props).toMatchObject({
      typeKind: "reference",
      typeText: "ButtonProps",
      hasAny: false,
    });
    expect(byName.Button?.props.booleanProps.sort()).toEqual(["disabled", "primary"]);
    expect(byName.Card?.props).toMatchObject({ typeKind: "inline", booleanProps: ["open"] });
    expect(byName.Field).toMatchObject({ kind: "forwardRef", forwardsRef: true });
    expect(byName.Memo?.props).toMatchObject({ typeKind: "any", hasAny: true });
    expect(byName.Page).toMatchObject({ exported: true, defaultExport: true });
    expect(byName.Page?.props).toMatchObject({ declared: true, typeKind: "none" });
  });

  it("tracks nested component definitions and hooks", () => {
    const v = view(
      `export function Outer() {
  const [n, setN] = useState(0);
  const Inner = () => <span>{n}</span>;
  return <Inner />;
}`,
    );
    const inner = v.components.find((c) => c.name === "Inner");
    expect(inner?.nestedIn).toBe("Outer");
    expect(v.components.find((c) => c.name === "Outer")?.usesHooks).toEqual(["useState"]);
    expect(v.hookCalls).toEqual(["useState"]);
    expect(v.stateSetters).toEqual(["setN"]);
  });

  it("recognises polymorphic as props and a ref prop", () => {
    const v = view(
      `import type { ComponentPropsWithoutRef, ElementType } from "react";
type Props<T extends ElementType> = { as?: T } & ComponentPropsWithoutRef<T>;
export function Box<T extends ElementType = "div">({ as, ref }: Props<T>) { return <div />; }
export function Loose({ as }: { as?: string }) { return <div />; }`,
    );
    const box = v.components.find((c) => c.name === "Box");
    expect(box?.props.as).toMatchObject({ present: true, usesPropsHelper: true });
    expect(box?.props.as.typeParamConstraints[0]).toContain("ElementType");
    expect(box?.forwardsRef).toBe(true);
    const loose = v.components.find((c) => c.name === "Loose");
    expect(loose?.props.as).toMatchObject({
      present: true,
      usesPropsHelper: false,
      typeText: "string",
    });
  });
});

describe("effects, browser apis and angular", () => {
  it("summarises effect bodies", () => {
    const v = view(
      `function C({ value }) {
  const [x, setX] = useState(0);
  useEffect(() => { setX(value); }, [value]);
  useEffect(() => { fetch("/a").then(setX); return () => {}; }, []);
  useEffect(() => { document.title = "t"; });
  return null;
}`,
      "a.jsx",
    );
    expect(v.effects).toMatchObject([
      {
        hook: "useEffect",
        deps: "list",
        statementCount: 1,
        setterCalls: ["setX"],
        otherCalls: [],
        hasReturn: false,
      },
      { deps: "empty", hasReturn: true },
      { deps: "none", statementCount: 1 },
    ]);
    expect(v.effects[1]?.otherCalls).toContain("fetch");
    expect(v.browserApis).toEqual(["document"]);
  });

  it("reads angular component decorators", () => {
    const v = view(
      `@Component({
  selector: "app-x",
  template: \`<p [innerHTML]="h"></p>\`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class X { constructor(private s: S) {} }
@Component({ selector: "app-y", templateUrl: "./y.html" })
export class Y { v = inject(V); }`,
      "x.ts",
    );
    expect(v.angularComponents).toMatchObject([
      {
        className: "X",
        selector: "app-x",
        changeDetection: "ChangeDetectionStrategy.OnPush",
        hasConstructorParams: true,
        usesInject: false,
      },
      { className: "Y", templateUrl: "./y.html", hasConstructorParams: false, usesInject: true },
    ]);
    expect(v.angularComponents[0]?.template).toMatchObject({
      text: '<p [innerHTML]="h"></p>',
      line: 3,
    });
  });
});
