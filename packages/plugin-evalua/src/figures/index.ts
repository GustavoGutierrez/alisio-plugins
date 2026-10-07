/**
 * Deterministic math figures (spec: figures). Each figure is generated as a self-contained SVG in
 * grayscale for print, so items can embed diagrams without any external asset or network access.
 */

export type FigureKind =
  | "number-line"
  | "cartesian"
  | "venn"
  | "triangle"
  | "square"
  | "rectangle"
  | "polygon"
  | "circle"
  | "ellipse"
  | "prism"
  | "cylinder"
  | "cone"
  | "fraction-bar"
  | "bar-chart"
  | "angle";

export interface FigureSpec {
  kind: FigureKind;
  /** Accessible label; also used as the figure caption when present. */
  label?: string;
  params?: Record<string, unknown>;
}

const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function wrap(width: number, height: number, body: string, label?: string): string {
  const aria = label === undefined ? "" : ` aria-label="${esc(label)}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"${aria} class="figure-svg"><g fill="none" stroke="#000" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">${body}</g></svg>`;
}

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const text = (x: number, y: number, value: string, size = 12): string =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="#000" stroke="none" font-family="serif">${esc(value)}</text>`;

const line = (x1: number, y1: number, x2: number, y2: number): string =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;

function polygonPoints(
  cx: number,
  cy: number,
  r: number,
  sides: number,
  rotation = -Math.PI / 2,
): string {
  const points: string[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = rotation + (index * 2 * Math.PI) / sides;
    points.push(
      `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`,
    );
  }
  return points.join(" ");
}

const labels = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function numberLine(params: Record<string, unknown>): string {
  const min = num(params.min, -5);
  const max = num(params.max, 5);
  const step = Math.max(1, num(params.step, 1));
  const width = 460;
  const height = 70;
  const left = 30;
  const right = width - 30;
  const span = max - min || 1;
  const x = (value: number) => left + ((value - min) / span) * (right - left);
  let body = `${line(left, 45, right, 45)}<polygon points="${right},45 ${right - 8},41 ${right - 8},49" fill="#000" stroke="none"/>`;
  for (let value = min; value <= max; value += step) {
    body += `${line(x(value), 40, x(value), 50)}${text(x(value) - 4, 64, String(value), 11)}`;
  }
  for (const mark of Array.isArray(params.marks) ? params.marks : []) {
    if (typeof mark === "number") {
      body += `<circle cx="${x(mark)}" cy="45" r="4" fill="#000" stroke="none"/>`;
    }
  }
  return wrap(width, height, body, "Number line");
}

function cartesian(params: Record<string, unknown>): string {
  const size = 260;
  const pad = 30;
  const range = num(params.range, 5);
  const cx = pad + (size - 2 * pad) / 2;
  const cy = pad + (size - 2 * pad) / 2;
  const scale = (size - 2 * pad) / (2 * range);
  const px = (value: number) => cx + value * scale;
  const py = (value: number) => cy - value * scale;
  let body = "";
  for (let value = -range; value <= range; value += 1) {
    body += line(px(value), pad, px(value), size - pad);
    body += line(pad, py(value), size - pad, py(value));
  }
  body += `<polygon points="${size - pad},${cy} ${size - pad - 8},${cy - 4} ${size - pad - 8},${cy + 4}" fill="#000" stroke="none"/>`;
  body += `<polygon points="${cx},${pad} ${cx - 4},${pad + 8} ${cx + 4},${pad + 8}" fill="#000" stroke="none"/>`;
  body += text(size - pad - 12, cy + 16, "x") + text(cx + 8, pad + 12, "y");
  for (const point of Array.isArray(params.points) ? params.points : []) {
    if (Array.isArray(point) && point.length === 2) {
      const [x, y] = point as [number, number];
      body += `<circle cx="${px(x)}" cy="${py(y)}" r="3.5" fill="#000" stroke="none"/>`;
    }
  }
  return wrap(size, size, body, "Cartesian plane");
}

function venn(params: Record<string, unknown>): string {
  const three = params.sets === 3;
  const width = three ? 300 : 260;
  const height = 180;
  const r = 62;
  let body = "";
  if (three) {
    body += `<circle cx="110" cy="70" r="${r}"/>`;
    body += `<circle cx="190" cy="70" r="${r}"/>`;
    body += `<circle cx="150" cy="118" r="${r}"/>`;
    body += text(66, 40, "A") + text(226, 40, "B") + text(146, 172, "C");
  } else {
    body += `<circle cx="100" cy="90" r="${r}"/>`;
    body += `<circle cx="160" cy="90" r="${r}"/>`;
    body += text(58, 50, "A") + text(196, 50, "B");
  }
  const names = labels(params.labels);
  names.forEach((name, index) => {
    body += text(12, 20 + index * 14, name, 11);
  });
  return wrap(width, height, body, "Venn diagram");
}

function triangle(params: Record<string, unknown>): string {
  const variant = typeof params.variant === "string" ? params.variant : "equilateral";
  const width = 260;
  const height = 190;
  const a = [30, 160];
  let b = [230, 160];
  let c = [130, 40];
  if (variant === "right") c = [30, 40];
  if (variant === "isosceles") c = [130, 50];
  if (variant === "scalene") b = [210, 160];
  const body =
    `<polygon points="${a[0]},${a[1]} ${b[0]},${b[1]} ${c[0]},${c[1]}"/>` +
    text((a[0] ?? 0) - 14, (a[1] ?? 0) + 16, "A") +
    text((b[0] ?? 0) + 6, (b[1] ?? 0) + 16, "B") +
    text((c[0] ?? 0) - 4, (c[1] ?? 0) - 8, "C") +
    text(((a[0] ?? 0) + (c[0] ?? 0)) / 2 - 12, ((a[1] ?? 0) + (c[1] ?? 0)) / 2, "b") +
    text(((b[0] ?? 0) + (c[0] ?? 0)) / 2 + 6, ((b[1] ?? 0) + (c[1] ?? 0)) / 2, "a") +
    text(((a[0] ?? 0) + (b[0] ?? 0)) / 2 - 4, (a[1] ?? 0) + 16, "c");
  return wrap(width, height, body, "Triangle");
}

function quadrilateral(
  kind: "square" | "rectangle" | "polygon",
  params: Record<string, unknown>,
): string {
  const width = 240;
  const height = 180;
  if (kind === "square") {
    return wrap(
      width,
      height,
      `<rect x="60" y="35" width="120" height="120"/>` +
        text(52, 172, "A") +
        text(188, 172, "B") +
        text(188, 28, "C") +
        text(52, 28, "D"),
      "Square",
    );
  }
  if (kind === "rectangle") {
    return wrap(
      width,
      height,
      `<rect x="40" y="55" width="160" height="90"/>` +
        text(32, 162, "A") +
        text(208, 162, "B") +
        text(208, 48, "C") +
        text(32, 48, "D"),
      "Rectangle",
    );
  }
  const sides = Math.max(3, Math.min(12, num(params.sides, 5)));
  return wrap(
    width,
    height,
    `<polygon points="${polygonPoints(120, 90, 70, sides)}"/>`,
    `Regular polygon (${sides} sides)`,
  );
}

function circleFigure(params: Record<string, unknown>): string {
  const width = 200;
  const height = 180;
  const r = num(params.radius, 60);
  const body =
    `<circle cx="100" cy="90" r="${r}"/>` +
    line(100, 90, 100 + r, 90) +
    `<circle cx="100" cy="90" r="2.5" fill="#000" stroke="none"/>` +
    text(100 + r / 2 - 6, 84, "r");
  return wrap(width, height, body, "Circle");
}

function ellipseFigure(): string {
  return wrap(
    220,
    160,
    `<ellipse cx="110" cy="80" rx="80" ry="50"/>` + line(30, 80, 190, 80) + line(110, 30, 110, 130),
    "Ellipse",
  );
}

function prism(): string {
  const body =
    `<polygon points="40,150 160,150 200,120 80,120"/>` +
    `<polygon points="40,150 40,70 160,70 160,150"/>` +
    `<polygon points="160,70 200,40 200,120 160,150"/>` +
    `<polygon points="40,70 80,40 200,40 160,70"/>`;
  return wrap(240, 190, body, "Rectangular prism");
}

function cylinder(): string {
  const body =
    `<ellipse cx="110" cy="45" rx="60" ry="18"/>` +
    line(50, 45, 50, 150) +
    line(170, 45, 170, 150) +
    `<path d="M50 150 A60 18 0 0 0 170 150"/>`;
  return wrap(220, 190, body, "Cylinder");
}

function cone(): string {
  const body =
    line(110, 30, 40, 150) + line(110, 30, 180, 150) + `<path d="M40 150 A70 20 0 0 0 180 150"/>`;
  return wrap(220, 190, body, "Cone");
}

function fractionBar(params: Record<string, unknown>): string {
  const parts = Math.max(1, Math.min(20, num(params.parts, 4)));
  const shaded = Math.max(0, Math.min(parts, num(params.shaded, 1)));
  const width = 340;
  const height = 90;
  const left = 30;
  const top = 30;
  const barWidth = width - 60;
  const barHeight = 40;
  const cell = barWidth / parts;
  let body = `<rect x="${left}" y="${top}" width="${barWidth}" height="${barHeight}"/>`;
  for (let index = 1; index < parts; index += 1) {
    body += line(left + index * cell, top, left + index * cell, top + barHeight);
  }
  for (let index = 0; index < shaded; index += 1) {
    body += `<rect x="${left + index * cell}" y="${top}" width="${cell}" height="${barHeight}" fill="#cfcfcf" stroke="none"/>`;
  }
  body += `<rect x="${left}" y="${top}" width="${barWidth}" height="${barHeight}"/>`;
  return wrap(width, height, body, `${shaded} of ${parts}`);
}

function barChart(params: Record<string, unknown>): string {
  const values = (Array.isArray(params.values) ? params.values : [3, 5, 2, 6]).filter(
    (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
  );
  const width = 320;
  const height = 200;
  const left = 40;
  const base = 160;
  const max = Math.max(1, ...values);
  const slot = (width - left - 30) / Math.max(1, values.length);
  let body = line(left, base, width - 20, base) + line(left, 30, left, base);
  values.forEach((value, index) => {
    const barHeight = ((base - 30) * value) / max;
    const x = left + index * slot + slot * 0.2;
    const w = slot * 0.6;
    body += `<rect x="${x.toFixed(1)}" y="${(base - barHeight).toFixed(1)}" width="${w.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="#cfcfcf"/>`;
    body += `<rect x="${x.toFixed(1)}" y="${(base - barHeight).toFixed(1)}" width="${w.toFixed(1)}" height="${barHeight.toFixed(1)}"/>`;
  });
  return wrap(width, height, body, "Bar chart");
}

function angle(): string {
  const body =
    line(40, 140, 220, 140) +
    line(40, 140, 190, 50) +
    `<path d="M90 140 A50 50 0 0 0 76 112" fill="none"/>` +
    text(96, 122, "α");
  return wrap(240, 170, body, "Angle");
}

/** Builds the SVG for a figure; unknown kinds fall back to a labelled placeholder. */
export function figureSvg(spec: FigureSpec): string {
  const params = spec.params ?? {};
  let svg: string;
  switch (spec.kind) {
    case "number-line":
      svg = numberLine(params);
      break;
    case "cartesian":
      svg = cartesian(params);
      break;
    case "venn":
      svg = venn(params);
      break;
    case "triangle":
      svg = triangle(params);
      break;
    case "square":
      svg = quadrilateral("square", params);
      break;
    case "rectangle":
      svg = quadrilateral("rectangle", params);
      break;
    case "polygon":
      svg = quadrilateral("polygon", params);
      break;
    case "circle":
      svg = circleFigure(params);
      break;
    case "ellipse":
      svg = ellipseFigure();
      break;
    case "prism":
      svg = prism();
      break;
    case "cylinder":
      svg = cylinder();
      break;
    case "cone":
      svg = cone();
      break;
    case "fraction-bar":
      svg = fractionBar(params);
      break;
    case "bar-chart":
      svg = barChart(params);
      break;
    case "angle":
      svg = angle();
      break;
    default:
      svg = wrap(200, 60, text(10, 35, `figure: ${String(spec.kind)}`), spec.label);
  }
  if (spec.label !== undefined && spec.label.trim() !== "") {
    svg = svg.replace(/aria-label="[^"]*"/, `aria-label="${esc(spec.label)}"`);
  }
  return svg;
}

export const figureKinds: readonly FigureKind[] = [
  "number-line",
  "cartesian",
  "venn",
  "triangle",
  "square",
  "rectangle",
  "polygon",
  "circle",
  "ellipse",
  "prism",
  "cylinder",
  "cone",
  "fraction-bar",
  "bar-chart",
  "angle",
];
