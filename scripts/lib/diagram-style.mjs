/**
 * Background and padding for rendered diagram SVGs.
 *
 * Mermaid CLI has no canvas padding option, so the render step post-processes
 * the generated SVG deterministically: a full-size background <rect> becomes
 * the first child of the root element and the viewBox (plus any numeric
 * width/height and the inline `max-width`) grows by the padding on every side.
 * The defaults are an opaque white background and 24px of padding, so a diagram
 * stays legible on dark themes. Both are configurable per target in
 * `diagrams/<target>/diagram.config.json` (`background`, `padding`).
 */

export const DEFAULT_BACKGROUND = "#ffffff";
export const DEFAULT_PADDING = 24;
export const MAX_PADDING = 200;

/** Hex, rgb()/hsl() functional notation, or a plain keyword; nothing that can break out of an attribute. */
const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(rgb|rgba|hsl|hsla)\([0-9.,%\s/-]+\))$/;

/** Validates the optional style keys of a target config and applies defaults. */
export function resolveDiagramStyle(config, name) {
  const source = config ?? {};
  let background = DEFAULT_BACKGROUND;
  let padding = DEFAULT_PADDING;
  if ("background" in source) {
    const value = source.background;
    if (typeof value !== "string" || !COLOR.test(value.trim()))
      throw new Error(
        `diagram.config.json for "${name}" "background" must be a CSS color (hex, rgb(), hsl(), keyword) or "transparent"`,
      );
    background = value.trim();
  }
  if ("padding" in source) {
    const value = source.padding;
    if (!Number.isInteger(value) || value < 0 || value > MAX_PADDING)
      throw new Error(
        `diagram.config.json for "${name}" "padding" must be an integer between 0 and ${MAX_PADDING} (pixels)`,
      );
    padding = value;
  }
  return { background, padding };
}

const num = (value) => String(Number(value.toFixed(4)));

/** Pure SVG post-processing; see the module header. */
export function applyDiagramStyle(svg, { background, padding }) {
  const transparent = background === "transparent";
  if (transparent && padding === 0) return svg;

  const open = /<svg\b[^>]*>/.exec(svg);
  const viewBox = open && /\sviewBox="([^"]*)"/.exec(open[0]);
  if (!open || !viewBox) throw new Error("Rendered SVG has no root viewBox; cannot apply padding.");
  const parts = viewBox[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)))
    throw new Error(`Rendered SVG has an unparsable viewBox: "${viewBox[1]}"`);

  const [minX, minY, width, height] = parts;
  const x = minX - padding;
  const y = minY - padding;
  const w = width + 2 * padding;
  const h = height + 2 * padding;

  let tag = open[0].replace(viewBox[0], ` viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}"`);
  tag = tag.replace(
    /(\swidth=")(\d+(?:\.\d+)?)(")/,
    (_m, a, v, c) => `${a}${num(Number(v) + 2 * padding)}${c}`,
  );
  tag = tag.replace(
    /(\sheight=")(\d+(?:\.\d+)?)(")/,
    (_m, a, v, c) => `${a}${num(Number(v) + 2 * padding)}${c}`,
  );
  tag = tag.replace(
    /max-width:\s*([\d.]+)px/,
    (_m, v) => `max-width: ${num(Number(v) + 2 * padding)}px`,
  );
  tag = tag.replace(/background-color:\s*[^;"]*/, `background-color: ${background}`);

  const rect = transparent
    ? ""
    : `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="${background}"/>`;
  return svg.slice(0, open.index) + tag + rect + svg.slice(open.index + open[0].length);
}
