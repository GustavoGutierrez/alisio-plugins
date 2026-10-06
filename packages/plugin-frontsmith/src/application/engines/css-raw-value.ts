import { compileGlob } from "../../domain/glob.js";
import { scansOf } from "./css-util.js";
import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const NAMED_COLORS = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  ),
);
const COLOR_FUNCTION = /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;
const LENGTH =
  /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|vw|vh|vmin|vmax|%|pt|pc|cm|mm|in|ch|ex|svh|dvh|lvh|svw|dvw|lvw|cqw|cqh)$/i;

interface RawLiteral {
  kind: "color" | "length" | "integer";
  text: string;
}

/** Literals of a declaration value, ignoring `url()`, strings and `var(--name)` references. */
export function rawLiterals(value: string): RawLiteral[] {
  const literals: RawLiteral[] = [];
  const stripped = value
    .replace(/url\([^)]*\)/gi, " ")
    .replace(/(["'])(?:\\.|(?!\1).)*\1/g, " ")
    .replace(/var\(\s*--[\w-]+\s*\)/g, " ")
    .replace(/var\(\s*--[\w-]+\s*,/g, "(");
  for (const hex of stripped.matchAll(/#[0-9a-fA-F]{3,8}\b/g))
    literals.push({ kind: "color", text: hex[0] });
  if (COLOR_FUNCTION.test(stripped))
    literals.push({ kind: "color", text: (COLOR_FUNCTION.exec(stripped) as RegExpExecArray)[0] });
  const withoutHex = stripped.replace(/#[0-9a-fA-F]{3,8}\b/g, " ");
  for (const word of withoutHex.split(/[\s,/()]+/)) {
    if (!word) continue;
    if (NAMED_COLORS.has(word.toLowerCase())) literals.push({ kind: "color", text: word });
    else if (LENGTH.test(word)) literals.push({ kind: "length", text: word });
  }
  if (/^-?\d+$/.test(stripped.trim())) literals.push({ kind: "integer", text: stripped.trim() });
  return literals;
}

const RAW_VALUE_PARAMS = ["properties", "kinds", "allow", "tokenFiles"] as const;

export const cssRawValue: Engine = {
  id: "css-raw-value",
  validateParams(params) {
    const reader = new ParamReader(params, RAW_VALUE_PARAMS);
    reader.regex("properties", true);
    const kinds = reader.strings("kinds", true);
    if (kinds)
      for (const kind of kinds)
        if (!["color", "length", "integer"].includes(kind))
          reader.errors.push(`kinds: unknown kind "${kind}"`);
    reader.strings("allow");
    reader.globs("tokenFiles");
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, RAW_VALUE_PARAMS);
    const properties = reader.regex("properties", true) as RegExp;
    const kinds = new Set(reader.strings("kinds", true));
    const allow = new Set((reader.strings("allow") ?? []).map((entry) => entry.toLowerCase()));
    const tokenGlobs = reader.globs("tokenFiles") ?? context.config.paths.tokenFiles;
    const tokenTests = tokenGlobs.map((glob) => compileGlob(glob));
    const findings: RawFinding[] = [];
    for (const analysis of context.files) {
      if (tokenTests.some((test) => test(analysis.path))) continue;
      for (const scan of scansOf(analysis))
        for (const declaration of scan.declarations) {
          if (!properties.test(declaration.property)) continue;
          if (declaration.atRules.some((a) => a.name === "font-face" || a.name === "keyframes"))
            continue;
          for (const literal of rawLiterals(declaration.value)) {
            if (!kinds.has(literal.kind) || allow.has(literal.text.toLowerCase())) continue;
            findings.push({
              file: analysis.path,
              line: declaration.line,
              column: declaration.column,
              detail: `${declaration.property}: ${literal.text}`,
            });
            break;
          }
        }
    }
    return { findings };
  },
};
