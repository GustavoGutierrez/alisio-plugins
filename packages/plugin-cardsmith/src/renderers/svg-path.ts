import { CardsmithError } from "../core/errors.js";

/**
 * Normalized SVG path command. Shorthand commands are expanded while parsing: `H`/`h` and `V`/`v`
 * become `L`, `S`/`s` becomes `C` and `T`/`t` becomes `Q`, so every coordinate is absolute.
 * Elliptical arcs stay as `A` until {@link toBezierPath} converts them to cubic segments.
 */
export interface MoveToCommand {
  type: "M";
  x: number;
  y: number;
}

export interface LineToCommand {
  type: "L";
  x: number;
  y: number;
}

export interface CubicCurveCommand {
  type: "C";
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  x: number;
  y: number;
}

export interface QuadraticCurveCommand {
  type: "Q";
  cpx: number;
  cpy: number;
  x: number;
  y: number;
}

export interface ArcCommand {
  type: "A";
  rx: number;
  ry: number;
  /** X-axis rotation in degrees. */
  rotation: number;
  largeArc: boolean;
  sweep: boolean;
  x: number;
  y: number;
}

export interface ClosePathCommand {
  type: "Z";
}

export type PathCommand =
  | MoveToCommand
  | LineToCommand
  | CubicCurveCommand
  | QuadraticCurveCommand
  | ArcCommand
  | ClosePathCommand;

/** One cubic Bezier segment of a flattened subpath. */
export interface CubicSegment {
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  x: number;
  y: number;
}

/** A subpath: a start point, the cubic segments that follow it and whether `Z` closed it. */
export interface BezierSubPath {
  x: number;
  y: number;
  segments: CubicSegment[];
  closed: boolean;
}

interface Parser {
  d: string;
  index: number;
}

const COMMAND_LETTERS = "MmLlHhVvCcSsQqTtAaZz";

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isCommandLetter(character: string): boolean {
  return COMMAND_LETTERS.includes(character);
}

function fail(d: string, index: number, reason: string): never {
  const token = index < d.length ? d.slice(index, index + 8) : "";
  throw new CardsmithError(
    "INVALID_SPEC",
    `Invalid SVG path data at index ${index}: ${reason}${token === "" ? "" : ` near "${token}"`}`,
    { d, index, token, reason },
  );
}

function skipSeparators(parser: Parser): void {
  const { d } = parser;
  while (parser.index < d.length) {
    const code = d.charCodeAt(parser.index);
    // space, tab, line feed, vertical tab/form feed, carriage return and comma
    if (
      code === 32 ||
      code === 9 ||
      code === 10 ||
      code === 11 ||
      code === 12 ||
      code === 13 ||
      code === 44
    ) {
      parser.index += 1;
    } else {
      break;
    }
  }
}

function parseNumber(parser: Parser): number {
  skipSeparators(parser);
  const { d } = parser;
  const start = parser.index;
  const length = d.length;
  let index = start;
  const sign = d.charAt(index);
  if (sign === "+" || sign === "-") index += 1;
  let hasDigits = false;
  while (index < length && isDigit(d.charAt(index))) {
    index += 1;
    hasDigits = true;
  }
  if (d.charAt(index) === ".") {
    index += 1;
    while (index < length && isDigit(d.charAt(index))) {
      index += 1;
      hasDigits = true;
    }
  }
  if (!hasDigits) fail(d, start, "expected a number");
  const exponent = d.charAt(index);
  if (exponent === "e" || exponent === "E") {
    const exponentStart = index;
    index += 1;
    const exponentSign = d.charAt(index);
    if (exponentSign === "+" || exponentSign === "-") index += 1;
    let hasExponentDigits = false;
    while (index < length && isDigit(d.charAt(index))) {
      index += 1;
      hasExponentDigits = true;
    }
    if (!hasExponentDigits) fail(d, exponentStart, "invalid number exponent");
  }
  const value = Number(d.slice(start, index));
  if (!Number.isFinite(value)) fail(d, start, "number is not finite");
  parser.index = index;
  return value;
}

function parseFlag(parser: Parser, name: string): boolean {
  skipSeparators(parser);
  const character = parser.d.charAt(parser.index);
  if (character !== "0" && character !== "1") {
    fail(parser.d, parser.index, `expected arc ${name} flag 0 or 1`);
  }
  parser.index += 1;
  return character === "1";
}

/**
 * Parse SVG path data (absolute and relative `M L H V C S Q T Z A`, numbers with commas, spaces or
 * scientific notation) into a normalized command list. Invalid or unsupported syntax throws
 * `CardsmithError("INVALID_SPEC")` with `{ d, index, token, reason }` details.
 */
export function parsePath(d: string): PathCommand[] {
  if (typeof d !== "string" || d.trim() === "") {
    throw new CardsmithError("INVALID_SPEC", "Path data must be a non-empty string", {
      d,
      index: 0,
      token: "",
      reason: "empty path data",
    });
  }

  const parser: Parser = { d, index: 0 };
  const commands: PathCommand[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastCubicX = 0;
  let lastCubicY = 0;
  let lastQuadX = 0;
  let lastQuadY = 0;
  let previous: string | null = null;

  while (true) {
    skipSeparators(parser);
    if (parser.index >= d.length) break;
    const commandStart = parser.index;
    const character = d.charAt(parser.index);
    let command: string;
    if (isCommandLetter(character)) {
      command = character;
      parser.index += 1;
    } else {
      if (previous === null) {
        fail(d, commandStart, "path data must start with a moveto command");
      }
      if (previous === "Z" || previous === "z") {
        fail(d, commandStart, "a closepath must be followed by a command letter");
      }
      command = previous === "M" ? "L" : previous === "m" ? "l" : previous;
    }
    if (previous === null && command !== "M" && command !== "m") {
      fail(d, commandStart, "path data must start with a moveto command");
    }

    switch (command) {
      case "M":
      case "m": {
        const relative = command === "m";
        const rawX = parseNumber(parser);
        const rawY = parseNumber(parser);
        x = relative ? x + rawX : rawX;
        y = relative ? y + rawY : rawY;
        startX = x;
        startY = y;
        commands.push({ type: "M", x, y });
        lastCubicX = x;
        lastCubicY = y;
        lastQuadX = x;
        lastQuadY = y;
        break;
      }
      case "L":
      case "l": {
        const relative = command === "l";
        const rawX = parseNumber(parser);
        const rawY = parseNumber(parser);
        x = relative ? x + rawX : rawX;
        y = relative ? y + rawY : rawY;
        commands.push({ type: "L", x, y });
        lastCubicX = x;
        lastCubicY = y;
        lastQuadX = x;
        lastQuadY = y;
        break;
      }
      case "H":
      case "h": {
        const rawX = parseNumber(parser);
        x = command === "h" ? x + rawX : rawX;
        commands.push({ type: "L", x, y });
        lastCubicX = x;
        lastCubicY = y;
        lastQuadX = x;
        lastQuadY = y;
        break;
      }
      case "V":
      case "v": {
        const rawY = parseNumber(parser);
        y = command === "v" ? y + rawY : rawY;
        commands.push({ type: "L", x, y });
        lastCubicX = x;
        lastCubicY = y;
        lastQuadX = x;
        lastQuadY = y;
        break;
      }
      case "C":
      case "c": {
        const relative = command === "c";
        const cp1x = parseNumber(parser);
        const cp1y = parseNumber(parser);
        const cp2x = parseNumber(parser);
        const cp2y = parseNumber(parser);
        const rawX = parseNumber(parser);
        const rawY = parseNumber(parser);
        const segment: CubicCurveCommand = {
          type: "C",
          cp1x: relative ? x + cp1x : cp1x,
          cp1y: relative ? y + cp1y : cp1y,
          cp2x: relative ? x + cp2x : cp2x,
          cp2y: relative ? y + cp2y : cp2y,
          x: relative ? x + rawX : rawX,
          y: relative ? y + rawY : rawY,
        };
        commands.push(segment);
        x = segment.x;
        y = segment.y;
        lastCubicX = segment.cp2x;
        lastCubicY = segment.cp2y;
        lastQuadX = x;
        lastQuadY = y;
        break;
      }
      case "S":
      case "s": {
        const relative = command === "s";
        const cp2x = parseNumber(parser);
        const cp2y = parseNumber(parser);
        const rawX = parseNumber(parser);
        const rawY = parseNumber(parser);
        const segment: CubicCurveCommand = {
          type: "C",
          cp1x: 2 * x - lastCubicX,
          cp1y: 2 * y - lastCubicY,
          cp2x: relative ? x + cp2x : cp2x,
          cp2y: relative ? y + cp2y : cp2y,
          x: relative ? x + rawX : rawX,
          y: relative ? y + rawY : rawY,
        };
        commands.push(segment);
        x = segment.x;
        y = segment.y;
        lastCubicX = segment.cp2x;
        lastCubicY = segment.cp2y;
        lastQuadX = x;
        lastQuadY = y;
        break;
      }
      case "Q":
      case "q": {
        const relative = command === "q";
        const cpx = parseNumber(parser);
        const cpy = parseNumber(parser);
        const rawX = parseNumber(parser);
        const rawY = parseNumber(parser);
        const segment: QuadraticCurveCommand = {
          type: "Q",
          cpx: relative ? x + cpx : cpx,
          cpy: relative ? y + cpy : cpy,
          x: relative ? x + rawX : rawX,
          y: relative ? y + rawY : rawY,
        };
        commands.push(segment);
        x = segment.x;
        y = segment.y;
        lastQuadX = segment.cpx;
        lastQuadY = segment.cpy;
        lastCubicX = x;
        lastCubicY = y;
        break;
      }
      case "T":
      case "t": {
        const relative = command === "t";
        const rawX = parseNumber(parser);
        const rawY = parseNumber(parser);
        const cpx = 2 * x - lastQuadX;
        const cpy = 2 * y - lastQuadY;
        const segment: QuadraticCurveCommand = {
          type: "Q",
          cpx,
          cpy,
          x: relative ? x + rawX : rawX,
          y: relative ? y + rawY : rawY,
        };
        commands.push(segment);
        x = segment.x;
        y = segment.y;
        lastQuadX = cpx;
        lastQuadY = cpy;
        lastCubicX = x;
        lastCubicY = y;
        break;
      }
      case "A":
      case "a": {
        const relative = command === "a";
        const rx = Math.abs(parseNumber(parser));
        const ry = Math.abs(parseNumber(parser));
        const rotation = parseNumber(parser);
        const largeArc = parseFlag(parser, "large-arc");
        const sweep = parseFlag(parser, "sweep");
        const rawX = parseNumber(parser);
        const rawY = parseNumber(parser);
        const endX = relative ? x + rawX : rawX;
        const endY = relative ? y + rawY : rawY;
        if (rx === 0 || ry === 0) {
          // Per the SVG spec a degenerate arc is a straight line to the endpoint.
          commands.push({ type: "L", x: endX, y: endY });
        } else {
          commands.push({ type: "A", rx, ry, rotation, largeArc, sweep, x: endX, y: endY });
        }
        x = endX;
        y = endY;
        lastCubicX = x;
        lastCubicY = y;
        lastQuadX = x;
        lastQuadY = y;
        break;
      }
      case "Z":
      case "z": {
        commands.push({ type: "Z" });
        x = startX;
        y = startY;
        lastCubicX = x;
        lastCubicY = y;
        lastQuadX = x;
        lastQuadY = y;
        break;
      }
      default:
        fail(d, parser.index, `unsupported command "${character}"`);
    }
    previous = command;
  }

  return commands;
}

function cubicLine(x1: number, y1: number, x2: number, y2: number): CubicSegment {
  return { cp1x: x1, cp1y: y1, cp2x: x2, cp2y: y2, x: x2, y: y2 };
}

function quadraticToCubic(
  x0: number,
  y0: number,
  cpx: number,
  cpy: number,
  x1: number,
  y1: number,
): CubicSegment {
  return {
    cp1x: x0 + (2 / 3) * (cpx - x0),
    cp1y: y0 + (2 / 3) * (cpy - y0),
    cp2x: x1 + (2 / 3) * (cpx - x1),
    cp2y: y1 + (2 / 3) * (cpy - y1),
    x: x1,
    y: y1,
  };
}

function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
}

/**
 * Endpoint-to-center parameterization (SVG spec appendix F.6) plus the standard cubic
 * approximation, splitting the sweep into pieces of at most 90 degrees. Identical endpoints
 * produce no segments; zero radii already became a line during parsing.
 */
function arcToCubics(x1: number, y1: number, arc: ArcCommand): CubicSegment[] {
  const { x: x2, y: y2, rotation, largeArc, sweep } = arc;
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(arc.rx);
  let ry = Math.abs(arc.ry);
  if (rx === 0 || ry === 0) return [cubicLine(x1, y1, x2, y2)];

  const phi = (rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const correction = Math.sqrt(lambda);
    rx *= correction;
    ry *= correction;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  const numerator = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2;
  const denominator = rx2 * y1p2 + ry2 * x1p2;
  const coefficient =
    (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (coefficient * rx * y1p) / ry;
  const cyp = (-coefficient * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const startAngle = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angleBetween(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;

  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / count;
  const pointAt = (theta: number): [number, number] => [
    cx + rx * Math.cos(theta) * cosPhi - ry * Math.sin(theta) * sinPhi,
    cy + rx * Math.cos(theta) * sinPhi + ry * Math.sin(theta) * cosPhi,
  ];
  const derivativeAt = (theta: number): [number, number] => [
    -rx * Math.sin(theta) * cosPhi - ry * Math.cos(theta) * sinPhi,
    -rx * Math.sin(theta) * sinPhi + ry * Math.cos(theta) * cosPhi,
  ];

  const segments: CubicSegment[] = [];
  let theta = startAngle;
  for (let index = 0; index < count; index += 1) {
    const next = theta + step;
    const alpha = (4 / 3) * Math.tan((next - theta) / 4);
    const [pointX, pointY] = pointAt(theta);
    const [endX, endY] = pointAt(next);
    const [derivativeX, derivativeY] = derivativeAt(theta);
    const [endDerivativeX, endDerivativeY] = derivativeAt(next);
    segments.push({
      cp1x: pointX + alpha * derivativeX,
      cp1y: pointY + alpha * derivativeY,
      cp2x: endX - alpha * endDerivativeX,
      cp2y: endY - alpha * endDerivativeY,
      x: endX,
      y: endY,
    });
    theta = next;
  }
  return segments;
}

/**
 * Flatten a normalized command list into subpaths of cubic segments, exactly what a raster
 * renderer needs (`moveTo` + `bezierCurveTo` + `closePath`). Lines and quadratics convert
 * losslessly; arcs become one or more cubics.
 */
export function toBezierPath(commands: PathCommand[]): BezierSubPath[] {
  const subpaths: BezierSubPath[] = [];
  let current: BezierSubPath | null = null;
  let x = 0;
  let y = 0;

  const openSubPath = (startX: number, startY: number): BezierSubPath => {
    const subpath: BezierSubPath = { x: startX, y: startY, segments: [], closed: false };
    subpaths.push(subpath);
    return subpath;
  };

  for (const command of commands) {
    switch (command.type) {
      case "M": {
        x = command.x;
        y = command.y;
        current = openSubPath(x, y);
        break;
      }
      case "L": {
        const subpath: BezierSubPath = current ?? openSubPath(x, y);
        current = subpath;
        subpath.segments.push(cubicLine(x, y, command.x, command.y));
        x = command.x;
        y = command.y;
        break;
      }
      case "C": {
        const subpath: BezierSubPath = current ?? openSubPath(x, y);
        current = subpath;
        subpath.segments.push({
          cp1x: command.cp1x,
          cp1y: command.cp1y,
          cp2x: command.cp2x,
          cp2y: command.cp2y,
          x: command.x,
          y: command.y,
        });
        x = command.x;
        y = command.y;
        break;
      }
      case "Q": {
        const subpath: BezierSubPath = current ?? openSubPath(x, y);
        current = subpath;
        subpath.segments.push(
          quadraticToCubic(x, y, command.cpx, command.cpy, command.x, command.y),
        );
        x = command.x;
        y = command.y;
        break;
      }
      case "A": {
        const subpath: BezierSubPath = current ?? openSubPath(x, y);
        current = subpath;
        subpath.segments.push(...arcToCubics(x, y, command));
        x = command.x;
        y = command.y;
        break;
      }
      case "Z": {
        const subpath = current;
        if (subpath !== null) {
          subpath.closed = true;
          x = subpath.x;
          y = subpath.y;
        }
        current = null;
        break;
      }
    }
  }

  return subpaths;
}
