#!/usr/bin/env node
/**
 * import-svg-asset.mjs — convert a simple flat SVG into a Cardsmith illustration asset.
 *
 * WHY. Third-party flat icons must become first-class assets: palette tokens instead of literal
 * paints, the asset operation subset instead of arbitrary SVG, and deterministic JSON instead of
 * hand-edited files. This tool accepts only the constructs the asset schema can represent and
 * REJECTS everything else loudly; it never guesses geometry or paint it does not understand.
 *
 * USAGE
 *   node tools/import-svg-asset.mjs \
 *     --input vendor/svgrepo/cherry-530361.svg \
 *     --out resources/illustrations/cherry.json \
 *     --id cherry \
 *     --label-es Cereza --label-en Cherry \
 *     --tags food \
 *     --map '#ff5252=$primary' --map '#ffcccc=$secondary' ...
 *
 * FLAGS
 *   --input     source SVG file (required)
 *   --out       destination asset JSON file (required)
 *   --id        asset id, must match the JSON file name (required)
 *   --label-es  Spanish label (required)
 *   --label-en  English label (required)
 *   --tags      comma-separated tags from the ILLUSTRATION_TAGS vocabulary (required)
 *   --map       literal=target paint mapping, repeatable (required when the source has paints)
 *
 * ACCEPTED SUBSET
 *   - `<svg>` with a numeric `viewBox` as the single root element; it may carry `fill`,
 *     `stroke` and `stroke-width`, which inherit down the tree like on `<g>`.
 *   - `<g>` groups, inheriting `fill`, `stroke` and `stroke-width` down the tree.
 *   - `<path d>` with M/L/H/V/C/S/Q/T/Z and A, absolute and relative.
 *   - `<circle>`, `<ellipse>` and `<rect>` converted to the equivalent asset operations.
 *   - `fill`/`stroke` values: `none`, empty string (invalid in SVG; maps to `$text`, the adaptive
 *     ink token), or a `#rgb`/`#rrggbb` literal covered by `--map`. An absent fill means the SVG
 *     default black, so `#000000` must be mapped too; an absent stroke means no stroke.
 *
 * REJECTED (always with an error, never by mangling the drawing)
 *   - `transform`, `<use>`, `<defs>`, `clipPath`, gradients, filters, masks, patterns, `<style>`,
 *     text, images, markers, dashes, opacities and any attribute that changes rendering in a way
 *     the asset schema cannot express.
 *   - Paints that are named colors, `rgb()`, `currentColor` or `url(#...)` references.
 *   - A paint literal missing from `--map`, or a `--map` entry the source never uses (typo guard).
 *   - Any element or attribute outside the accepted subset.
 *
 * OUTPUT. `{ id, version: 1, label: { es, en }, tags, viewBox, ops }` with every number rounded
 * to at most 3 decimals, in source document order so layer stacking is preserved.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseArgs } from "node:util";

/** Keep in sync with `src/core/palettes.ts` (PALETTE_TOKEN_NAMES). */
const PALETTE_TOKEN_NAMES = new Set([
  "background",
  "text",
  "primary",
  "secondary",
  "accent",
  "decorative",
]);

/** Keep in sync with `src/core/assets.ts` (ILLUSTRATION_TAGS). */
const ILLUSTRATION_TAGS = new Set([
  "kawaii",
  "birthday",
  "love",
  "formal",
  "technical",
  "decoration",
  "retro",
  "nature",
  "food",
]);

const SHAPE_ELEMENTS = new Set(["path", "circle", "ellipse", "rect"]);
const IGNORED_ELEMENTS = new Set(["title", "desc", "metadata"]);

/** Elements that must fail closed because the asset schema cannot represent them faithfully. */
const REJECTED_ELEMENTS = new Map([
  ["defs", "<defs> is not supported; inline the referenced geometry"],
  ["use", "<use> is not supported; inline the referenced geometry"],
  ["clipPath", "<clipPath> is not supported"],
  ["linearGradient", "gradients are not supported; use flat fills"],
  ["radialGradient", "gradients are not supported; use flat fills"],
  ["pattern", "<pattern> is not supported"],
  ["filter", "<filter> is not supported"],
  ["mask", "<mask> is not supported"],
  ["style", "<style> is not supported; use presentation attributes"],
  ["image", "<image> is not supported"],
  ["text", "<text> is not supported"],
  ["tspan", "<tspan> is not supported"],
  ["symbol", "<symbol> is not supported"],
  ["switch", "<switch> is not supported"],
  ["marker", "<marker> is not supported"],
  ["line", "<line> is not supported; convert it to a path"],
  ["polyline", "<polyline> is not supported; convert it to a path"],
  ["polygon", "<polygon> is not supported; convert it to a path"],
]);

/** Attributes that must fail closed; each one changes rendering beyond the asset schema. */
const REJECTED_ATTRIBUTES = new Map([
  ["transform", "transform is not supported; bake it into the coordinates"],
  ["style", "style is not supported; use presentation attributes"],
  ["opacity", "opacity is not supported"],
  ["fill-opacity", "fill-opacity is not supported"],
  ["stroke-opacity", "stroke-opacity is not supported"],
  ["fill-rule", "fill-rule is not supported; the default nonzero rule is used"],
  ["clip-path", "clip-path is not supported"],
  ["clip-rule", "clip-rule is not supported"],
  ["mask", "mask is not supported"],
  ["filter", "filter is not supported"],
  ["stroke-dasharray", "dashed strokes are not supported"],
  ["stroke-dashoffset", "dashed strokes are not supported"],
  ["stroke-linecap", "stroke-linecap is not supported"],
  ["stroke-linejoin", "stroke-linejoin is not supported"],
  ["stroke-miterlimit", "stroke-miterlimit is not supported"],
  ["marker-start", "markers are not supported"],
  ["marker-mid", "markers are not supported"],
  ["marker-end", "markers are not supported"],
  ["paint-order", "paint-order is not supported"],
  ["vector-effect", "vector-effect is not supported"],
  ["xlink:href", "references are not supported"],
  ["href", "references are not supported"],
]);

/** Inert metadata attributes the converter accepts and ignores. */
const INERT_ATTRIBUTES = new Set([
  "id",
  "class",
  "role",
  "version",
  "xmlns",
  "xmlns:xlink",
  "viewBox",
  "preserveAspectRatio",
  "xml:space",
  "aria-hidden",
  "aria-label",
  "aria-labelledby",
  "focusable",
]);

const PAINT_ATTRIBUTES = new Set(["fill", "stroke", "stroke-width"]);

/** Per-element allow-lists; everything else fails closed. */
const ALLOWED_ATTRIBUTES = new Map([
  ["svg", new Set([...INERT_ATTRIBUTES, "width", "height", ...PAINT_ATTRIBUTES])],
  ["g", PAINT_ATTRIBUTES],
  ["path", new Set([...PAINT_ATTRIBUTES, "d"])],
  ["circle", new Set([...PAINT_ATTRIBUTES, "cx", "cy", "r"])],
  ["ellipse", new Set([...PAINT_ATTRIBUTES, "cx", "cy", "rx", "ry"])],
  ["rect", new Set([...PAINT_ATTRIBUTES, "x", "y", "width", "height", "rx", "ry"])],
]);

class ImportError extends Error {}

/* -------------------------------------------------------------------------------------------------
 * CLI
 * -----------------------------------------------------------------------------------------------*/

const USAGE =
  "usage: node tools/import-svg-asset.mjs --input <file.svg> --out <file.json> " +
  "--id <id> --label-es <label> --label-en <label> --tags <a,b> --map '#rrggbb=$token' " +
  "[--map ...]";

function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        input: { type: "string" },
        out: { type: "string" },
        id: { type: "string" },
        "label-es": { type: "string" },
        "label-en": { type: "string" },
        tags: { type: "string" },
        map: { type: "string", multiple: true },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    throw new ImportError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  }
  const required = ["input", "out", "id", "label-es", "label-en", "tags"];
  for (const key of required) {
    if (values[key] === undefined || values[key] === "") {
      throw new ImportError(`missing --${key}\n${USAGE}`);
    }
  }
  if (!/^[a-z][a-z0-9-]*$/.test(values.id)) {
    throw new ImportError(`--id "${values.id}" must be lowercase kebab-case`);
  }
  const tags = values.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  if (tags.length === 0) throw new ImportError("--tags must contain at least one tag");
  for (const tag of tags) {
    if (!ILLUSTRATION_TAGS.has(tag)) {
      throw new ImportError(
        `unknown tag "${tag}"; expected one of ${[...ILLUSTRATION_TAGS].join(", ")}`,
      );
    }
  }
  if (new Set(tags).size !== tags.length) throw new ImportError("--tags must not repeat");

  const colorMap = new Map();
  for (const entry of values.map ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new ImportError(`--map "${entry}" must look like '#rrggbb=$token'`);
    const literal = normalizeHex(entry.slice(0, separator));
    if (literal === null)
      throw new ImportError(`--map key "${entry.slice(0, separator)}" is not a hex color`);
    if (colorMap.has(literal)) throw new ImportError(`--map repeats the literal ${literal}`);
    const target = entry.slice(separator + 1).trim();
    if (!isPaletteToken(target) && normalizeHex(target) === null) {
      throw new ImportError(`--map target "${target}" must be a $paletteToken or a #rrggbb color`);
    }
    colorMap.set(literal, target);
  }
  return { ...values, tags, colorMap };
}

function isPaletteToken(value) {
  return value.startsWith("$") && PALETTE_TOKEN_NAMES.has(value.slice(1));
}

/* -------------------------------------------------------------------------------------------------
 * Numbers and colors
 * -----------------------------------------------------------------------------------------------*/

/** Deterministic number formatting: at most 3 decimals, no exponent, no `-0`. */
function formatNumber(value) {
  if (!Number.isFinite(value)) throw new ImportError(`non-finite number: ${value}`);
  const rounded = Math.round(value * 1000) / 1000;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  const text = String(normalized);
  if (!text.includes("e") && !text.includes("E")) return text;
  const fixed = normalized.toFixed(3).replace(/\.?0+$/, "");
  if (fixed.includes("e") || fixed.includes("E")) {
    throw new ImportError(`number ${value} is too large for a 3-decimal coordinate`);
  }
  return fixed;
}

/** Expand `#rgb`/`#rrggbb` to lowercase `#rrggbb`; anything else returns null. */
function normalizeHex(value) {
  const text = value.trim();
  const short = /^#([0-9a-fA-F]{3})$/.exec(text);
  if (short !== null) {
    const [r, g, b] = short[1];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const long = /^#([0-9a-fA-F]{6})$/.exec(text);
  return long === null ? null : `#${long[1].toLowerCase()}`;
}

/* -------------------------------------------------------------------------------------------------
 * Minimal XML scanner
 * -----------------------------------------------------------------------------------------------*/

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|quot|amp|apos|lt|gt);/g, (entity) => {
    const body = entity.slice(1, -1);
    switch (body) {
      case "quot":
        return '"';
      case "amp":
        return "&";
      case "apos":
        return "'";
      case "lt":
        return "<";
      case "gt":
        return ">";
      default:
        return String.fromCodePoint(
          body.startsWith("#x")
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10),
        );
    }
  });
}

function parseAttributes(text) {
  const attributes = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][\w:.-]*)\s*=\s*'([^']*)'/g;
  let lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const skipped = text.slice(lastIndex, match.index);
    if (skipped.trim() !== "") {
      throw new ImportError(`invalid attribute syntax near "${skipped.trim()}"`);
    }
    lastIndex = pattern.lastIndex;
    const name = match[1] ?? match[3];
    const value = match[1] !== undefined ? match[2] : match[4];
    if (Object.hasOwn(attributes, name)) {
      throw new ImportError(`duplicate attribute "${name}"`);
    }
    attributes[name] = decodeEntities(value);
    match = pattern.exec(text);
  }
  if (text.slice(lastIndex).trim() !== "") {
    const rest = text.slice(lastIndex).trim();
    if (/^[A-Za-z_:][\w:.-]*$/.test(rest)) {
      throw new ImportError(`attribute "${rest}" has no value`);
    }
    throw new ImportError(`invalid attribute syntax near "${rest}"`);
  }
  return attributes;
}

/** Index of the `>` closing the tag that starts at `lt`, honoring quoted attribute values. */
function findTagEnd(xml, lt) {
  let end = lt + 1;
  let quote = null;
  while (end < xml.length) {
    const character = xml[end];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return end;
    }
    end += 1;
  }
  throw new ImportError("unterminated tag");
}

/** Tokenize an SVG document into open/close/self-closing element records plus text positions. */
function scanElements(xml) {
  const elements = [];
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf("<", index);
    if (lt === -1) {
      if (xml.slice(index).trim() !== "") {
        throw new ImportError("unexpected text outside the root element");
      }
      break;
    }
    if (xml.slice(index, lt).trim() !== "") {
      throw new ImportError(`unexpected text outside a tag near "${xml.slice(index, lt).trim()}"`);
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new ImportError("unterminated comment");
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new ImportError("unterminated processing instruction");
      index = end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end === -1) throw new ImportError("unterminated declaration");
      index = end + 1;
      continue;
    }
    // Metadata elements are skipped whole, including their text content.
    const ignored = /^<([A-Za-z_][\w:.-]*)/.exec(xml.slice(lt));
    if (ignored !== null && IGNORED_ELEMENTS.has(ignored[1])) {
      const openEnd = findTagEnd(xml, lt);
      const openRaw = xml.slice(lt + 1, openEnd);
      if (openRaw.endsWith("/")) {
        index = openEnd + 1;
        continue;
      }
      const closeStart = xml.indexOf(`</${ignored[1]}`, openEnd);
      if (closeStart === -1) throw new ImportError(`unclosed <${ignored[1]}> element`);
      const closeEnd = xml.indexOf(">", closeStart);
      if (closeEnd === -1) throw new ImportError(`unterminated </${ignored[1]}> tag`);
      index = closeEnd + 1;
      continue;
    }
    const end = findTagEnd(xml, lt);
    const raw = xml.slice(lt + 1, end);
    index = end + 1;
    if (raw.startsWith("/")) {
      elements.push({ type: "close", name: raw.slice(1).trim() });
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = (selfClosing ? raw.slice(0, -1) : raw).trim();
    const nameMatch = /^([A-Za-z_][\w:.-]*)/.exec(body);
    if (nameMatch === null) throw new ImportError(`tag without a name near "<${raw}>"`);
    elements.push({
      type: selfClosing ? "self" : "open",
      name: nameMatch[1],
      attributes: parseAttributes(body.slice(nameMatch[0].length)),
    });
  }
  return elements;
}

/* -------------------------------------------------------------------------------------------------
 * Paint resolution
 * -----------------------------------------------------------------------------------------------*/

function parseRawNumber(raw, label) {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())) {
    throw new ImportError(`${label}="${raw}" is not a plain number`);
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) throw new ImportError(`${label}="${raw}" is not finite`);
  return value;
}

function parseNumberAttribute(attributes, name, fallback) {
  const raw = attributes[name];
  if (raw === undefined) {
    if (fallback === undefined) throw new ImportError(`missing required attribute "${name}"`);
    return fallback;
  }
  return parseRawNumber(raw, name);
}

function checkAttributes(element) {
  const allowed = ALLOWED_ATTRIBUTES.get(element.name) ?? new Set();
  for (const [name, value] of Object.entries(element.attributes)) {
    if (name.startsWith("on")) {
      throw new ImportError(`<${element.name}> has event attribute "${name}"`);
    }
    const rejected = REJECTED_ATTRIBUTES.get(name);
    if (rejected !== undefined) {
      throw new ImportError(`<${element.name}>: ${rejected} (attribute "${name}")`);
    }
    if (name.startsWith("data-") || name.startsWith("aria-")) continue;
    if (!allowed.has(name)) {
      throw new ImportError(`<${element.name}> has unsupported attribute "${name}"="${value}"`);
    }
  }
}

function inheritPaint(element, parent) {
  return {
    fill: element.attributes.fill ?? parent.fill,
    stroke: element.attributes.stroke ?? parent.stroke,
    strokeWidth: element.attributes["stroke-width"] ?? parent.strokeWidth,
  };
}

/** Resolve a raw paint attribute to a token/hex string (`none` becomes null). */
function resolvePaint(raw, position, colorMap, usedColors) {
  if (raw === undefined) return undefined;
  if (raw === "none") return null;
  if (raw.trim() === "") return "$text";
  const normalized = normalizeHex(raw);
  if (normalized === null) {
    throw new ImportError(
      `${position}: paint "${raw}" is not a #rgb/#rrggbb literal; ` +
        'only flat hex paints and "none" are supported',
    );
  }
  const target = colorMap.get(normalized);
  if (target === undefined) {
    throw new ImportError(
      `${position}: paint ${normalized} has no --map entry; every paint must be mapped`,
    );
  }
  usedColors.add(normalized);
  return target;
}

function paintFor(element, inherited, colorMap, usedColors) {
  const position = `<${element.name}>`;
  let fill = resolvePaint(inherited.fill, position, colorMap, usedColors);
  if (fill === undefined) {
    // SVG default fill is black; it must be mapped explicitly like any other paint.
    const target = colorMap.get("#000000");
    if (target === undefined) {
      throw new ImportError(
        `${position}: no fill and no inherited fill (SVG default is black); add "#000000=<target>" to --map`,
      );
    }
    usedColors.add("#000000");
    fill = target;
  }
  const stroke = resolvePaint(inherited.stroke, position, colorMap, usedColors) ?? null;
  let strokeWidth;
  if (stroke !== null) {
    strokeWidth =
      inherited.strokeWidth === undefined
        ? 1
        : parseRawNumber(inherited.strokeWidth, "stroke-width");
    if (!(strokeWidth > 0)) throw new ImportError(`${position}: stroke-width must be positive`);
  }
  return { fill, stroke, strokeWidth };
}

/* -------------------------------------------------------------------------------------------------
 * Path data
 * -----------------------------------------------------------------------------------------------*/

const PATH_PARAM_COUNTS = {
  M: 2,
  m: 2,
  L: 2,
  l: 2,
  H: 1,
  h: 1,
  V: 1,
  v: 1,
  C: 6,
  c: 6,
  S: 4,
  s: 4,
  Q: 4,
  q: 4,
  T: 2,
  t: 2,
  A: 7,
  a: 7,
  Z: 0,
  z: 0,
};

function tokenizePathData(d) {
  const tokens = [];
  const pattern = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let lastIndex = 0;
  let match = pattern.exec(d);
  while (match !== null) {
    if (!/^[\s,]*$/.test(d.slice(lastIndex, match.index))) {
      throw new ImportError(`path data has invalid syntax near "${match[0]}"`);
    }
    lastIndex = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push(match[1]);
    else tokens.push(formatNumber(Number(match[2])));
    match = pattern.exec(d);
  }
  if (!/^[\s,]*$/.test(d.slice(lastIndex))) {
    throw new ImportError(`path data has trailing invalid syntax in "${d}"`);
  }
  return tokens;
}

/** Validate command/parameter structure and return normalized path data with 3-decimal numbers. */
function normalizePathData(d) {
  if (typeof d !== "string" || d.trim() === "") {
    throw new ImportError("path has an empty d attribute");
  }
  const tokens = tokenizePathData(d);
  const output = [];
  let command = null;
  let values = [];
  const flush = () => {
    if (command === null) return;
    const expected = PATH_PARAM_COUNTS[command];
    if (values.length === 0) {
      if (expected === 0) output.push(command);
      return;
    }
    if (values.length !== expected) {
      throw new ImportError(
        `path command "${command}" expected ${expected} values, got ${values.length}`,
      );
    }
    if (command === "A" || command === "a") {
      if ((values[3] !== "0" && values[3] !== "1") || (values[4] !== "0" && values[4] !== "1")) {
        throw new ImportError(`path command "${command}" has invalid arc flags`);
      }
    }
    output.push(command, ...values);
    values = [];
  };
  for (const token of tokens) {
    if (PATH_PARAM_COUNTS[token] !== undefined) {
      flush();
      command = token;
      continue;
    }
    if (command === null)
      throw new ImportError("path data starts with a number before any command");
    values.push(token);
    const expected = PATH_PARAM_COUNTS[command];
    if (expected === 0) throw new ImportError(`path command "${command}" takes no parameters`);
    if (values.length === expected) {
      flush();
      if (command === "M") command = "L";
      else if (command === "m") command = "l";
    }
  }
  flush();
  if (output.length === 0) throw new ImportError("path has no drawable data");
  return output.join(" ");
}

/* -------------------------------------------------------------------------------------------------
 * Shape conversion
 * -----------------------------------------------------------------------------------------------*/

function shapeOperation(element, paint) {
  const attributes = element.attributes;
  switch (element.name) {
    case "path": {
      if (attributes.d === undefined) throw new ImportError("<path> is missing its d attribute");
      const operation = { kind: "path", d: normalizePathData(attributes.d) };
      assignPaints(operation, paint);
      return operation;
    }
    case "circle": {
      const cx = parseNumberAttribute(attributes, "cx", 0);
      const cy = parseNumberAttribute(attributes, "cy", 0);
      const r = parseNumberAttribute(attributes, "r");
      if (!(r > 0)) throw new ImportError("<circle> needs a positive r");
      const operation = {
        kind: "circle",
        cx: roundNumber(cx),
        cy: roundNumber(cy),
        r: roundNumber(r),
      };
      assignPaints(operation, paint);
      return operation;
    }
    case "ellipse": {
      const cx = parseNumberAttribute(attributes, "cx", 0);
      const cy = parseNumberAttribute(attributes, "cy", 0);
      const rx = parseNumberAttribute(attributes, "rx");
      const ry = parseNumberAttribute(attributes, "ry");
      if (!(rx > 0) || !(ry > 0)) throw new ImportError("<ellipse> needs positive rx and ry");
      const operation = {
        kind: "ellipse",
        cx: roundNumber(cx),
        cy: roundNumber(cy),
        rx: roundNumber(rx),
        ry: roundNumber(ry),
      };
      assignPaints(operation, paint);
      return operation;
    }
    case "rect": {
      if (paint.stroke !== null) {
        throw new ImportError("<rect> strokes are not supported by the asset schema");
      }
      const x = parseNumberAttribute(attributes, "x", 0);
      const y = parseNumberAttribute(attributes, "y", 0);
      const w = parseNumberAttribute(attributes, "width");
      const h = parseNumberAttribute(attributes, "height");
      if (!(w > 0) || !(h > 0)) throw new ImportError("<rect> needs a positive width and height");
      const hasRx = attributes.rx !== undefined;
      const hasRy = attributes.ry !== undefined;
      const rx = hasRx ? parseNumberAttribute(attributes, "rx") : undefined;
      const ry = hasRy ? parseNumberAttribute(attributes, "ry") : undefined;
      if (rx !== undefined && ry !== undefined && rx !== ry) {
        throw new ImportError("<rect> with different rx and ry cannot be represented");
      }
      const radius = rx ?? ry;
      const operation = {
        kind: "rect",
        x: roundNumber(x),
        y: roundNumber(y),
        w: roundNumber(w),
        h: roundNumber(h),
      };
      if (radius !== undefined && radius > 0) operation.radius = roundNumber(radius);
      assignPaints(operation, paint);
      return operation;
    }
    default:
      throw new ImportError(`unsupported shape <${element.name}>`);
  }
}

function assignPaints(operation, paint) {
  if (paint.fill !== null && paint.fill !== undefined) operation.fill = paint.fill;
  if (paint.stroke !== null && paint.stroke !== undefined) {
    operation.stroke = paint.stroke;
    operation.strokeWidth = roundNumber(paint.strokeWidth);
  }
}

function roundNumber(value) {
  return Math.round(value * 1000) / 1000;
}

/* -------------------------------------------------------------------------------------------------
 * Conversion
 * -----------------------------------------------------------------------------------------------*/

function convert(xml, options) {
  const elements = scanElements(xml);
  if (elements.length === 0) throw new ImportError("the SVG document has no elements");

  const usedColors = new Set();
  const operations = [];
  const stack = [];
  let viewBox = null;
  let rootSeen = false;
  let rootClosed = false;

  for (const element of elements) {
    if (element.type === "close") {
      const top = stack.pop();
      if (top === undefined || top.name !== element.name) {
        throw new ImportError(`unexpected closing tag </${element.name}>`);
      }
      if (top.name === "svg") rootClosed = true;
      continue;
    }

    checkAttributes(element);
    const parentPaint = stack.length === 0 ? {} : stack[stack.length - 1].paint;

    if (element.name === "svg") {
      if (rootSeen || rootClosed) throw new ImportError("nested or repeated <svg> elements");
      rootSeen = true;
      const raw = element.attributes.viewBox;
      if (raw === undefined) throw new ImportError("<svg> must declare a viewBox");
      const parts = raw
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
        throw new ImportError(`<svg> viewBox "${raw}" must contain four numbers`);
      }
      if (!(parts[2] > 0) || !(parts[3] > 0)) {
        throw new ImportError(`<svg> viewBox "${raw}" must have a positive width and height`);
      }
      viewBox = parts.map(roundNumber);
      stack.push({ name: "svg", paint: inheritPaint(element, parentPaint) });
      if (element.type === "self") {
        stack.pop();
        rootClosed = true;
      }
      continue;
    }

    if (!rootSeen) throw new ImportError(`<${element.name}> found before the root <svg>`);
    if (rootClosed) throw new ImportError(`<${element.name}> found after the root <svg>`);

    const rejected = REJECTED_ELEMENTS.get(element.name);
    if (rejected !== undefined) {
      throw new ImportError(`<${element.name}>: ${rejected}`);
    }

    if (element.name === "g") {
      const parent = stack[stack.length - 1];
      if (parent === undefined || (parent.name !== "svg" && parent.name !== "g")) {
        throw new ImportError(`<g> cannot be nested inside <${parent?.name ?? "?"}>`);
      }
      stack.push({ name: "g", paint: inheritPaint(element, parentPaint) });
      if (element.type === "self") stack.pop();
      continue;
    }

    if (!SHAPE_ELEMENTS.has(element.name)) {
      throw new ImportError(`unsupported element <${element.name}>`);
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined || (parent.name !== "svg" && parent.name !== "g")) {
      throw new ImportError(`<${element.name}> cannot be nested inside <${parent?.name ?? "?"}>`);
    }
    const paint = paintFor(
      element,
      inheritPaint(element, parentPaint),
      options.colorMap,
      usedColors,
    );
    operations.push(shapeOperation(element, paint));
    // Shapes have no children; a non-self-closing shape still expects and requires its close tag.
    if (element.type === "open") {
      stack.push({ name: element.name, paint: parentPaint, shape: true });
    }
  }

  if (stack.length !== 0)
    throw new ImportError(`unclosed <${stack[stack.length - 1].name}> element`);
  if (!rootSeen) throw new ImportError("the SVG document has no <svg> root element");
  if (operations.length === 0)
    throw new ImportError("the SVG contains no supported shape elements");

  const missing = [...options.colorMap.keys()].filter((literal) => !usedColors.has(literal));
  if (missing.length > 0) {
    throw new ImportError(
      `--map declares unused colors: ${missing.join(", ")}; remove them or fix the map`,
    );
  }

  return {
    id: options.id,
    version: 1,
    label: { es: options["label-es"], en: options["label-en"] },
    tags: options.tags,
    viewBox,
    ops: operations,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Entry point
 * -----------------------------------------------------------------------------------------------*/

function main() {
  const options = parseCli(process.argv.slice(2));
  const expectedName = `${options.id}.json`;
  if (basename(options.out) !== expectedName) {
    throw new ImportError(`--out file name must be "${expectedName}" so it matches --id`);
  }
  let xml;
  try {
    xml = readFileSync(options.input, "utf8");
  } catch (error) {
    throw new ImportError(`cannot read --input ${options.input}: ${error.message}`);
  }
  const asset = convert(xml, options);
  const json = `${JSON.stringify(asset, null, 2)}\n`;
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, json);
  const pathOps = asset.ops.filter((operation) => operation.kind === "path").length;
  console.log(
    `${options.out}: ${asset.ops.length} ops (${pathOps} paths), viewBox ${asset.viewBox.join(" ")}`,
  );
}

try {
  main();
} catch (error) {
  if (error instanceof ImportError) {
    console.error(`import-svg-asset: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
